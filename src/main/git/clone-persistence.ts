/**
 * Persisting a credential after an authenticated clone.
 *
 * The clone itself is one attempt; later fetch/push commands are unattended and
 * must never prompt. Persistence therefore has to land in the environment's own
 * Git credential helper, not in iCode. An existing helper receives the
 * credential through `git credential approve`; when there is none, the user must
 * explicitly choose the plaintext `store` helper (or SSH).
 */

import type { AppError } from '../../shared/domain/errors'
import { makeAppError } from '../../shared/domain/errors'
import { parseRemoteUrl } from '../../shared/domain/remote-url'
import type { ExecutionTarget } from '../../shared/domain/repository'
import type { GitWorktreeService } from '../worktrees/git-worktree-service'

const CONFIG_TIMEOUT_MS = 10_000
const APPROVE_TIMEOUT_MS = 20_000

export class ClonePersistenceError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.message)
    this.name = 'ClonePersistenceError'
  }
}

type GitResult = Awaited<ReturnType<GitWorktreeService['gitResultFor']>>
type GitInput = Awaited<ReturnType<GitWorktreeService['gitInputFor']>>

export type ClonePersistenceDeps = {
  gitWorktrees: Pick<GitWorktreeService, 'gitResultFor' | 'gitInputFor'>
}

function bindingOf(url: string): { host: string; path: string } {
  const parsed = parseRemoteUrl(url)
  if (
    parsed === null ||
    parsed.kind !== 'url' ||
    parsed.scheme !== 'https' ||
    parsed.host === null ||
    parsed.path === null
  ) {
    throw new ClonePersistenceError(
      makeAppError('INVALID_ARGUMENT', 'A credential can only be saved for an HTTPS remote.')
    )
  }
  let pathname: string
  try {
    pathname = new URL(url).pathname.replace(/^\/+/u, '').replace(/\/+$/u, '')
  } catch {
    throw new ClonePersistenceError(
      makeAppError('INVALID_ARGUMENT', 'A credential can only be saved for an HTTPS remote.')
    )
  }
  if (pathname.length === 0 || /[\u0000\r\n]/u.test(pathname) || /[\u0000\r\n]/u.test(parsed.host)) {
    throw new ClonePersistenceError(
      makeAppError('INVALID_ARGUMENT', 'A credential can only be saved for an HTTPS remote.')
    )
  }
  return { host: parsed.host, path: pathname }
}

function credentialInput(
  host: string,
  path: string,
  username: string,
  password: Buffer
): Buffer {
  if (
    username.length === 0 ||
    /[\u0000\r\n]/u.test(username) ||
    password.length === 0 ||
    password.includes(0) ||
    password.includes(0x0a) ||
    password.includes(0x0d)
  ) {
    throw new ClonePersistenceError(
      makeAppError('INVALID_ARGUMENT', 'The credential cannot be saved in this form.')
    )
  }
  return Buffer.concat([
    Buffer.from(`protocol=https\nhost=${host}\npath=${path}\nusername=${username}\npassword=`),
    password,
    Buffer.from('\n\n')
  ])
}

export class ClonePersistenceService {
  constructor(private readonly deps: ClonePersistenceDeps) {}

  /** True when the environment has an ordinary or URL-scoped helper. */
  async hasHelper(target: ExecutionTarget, cwd: string, url: string): Promise<boolean> {
    const git: GitResult = await this.deps.gitWorktrees.gitResultFor(target)
    const scoped = await git(
      cwd,
      ['config', '--get-urlmatch', 'credential.helper', url],
      CONFIG_TIMEOUT_MS
    )
    if (scoped.exitCode === 0 && scoped.stdout.toString('utf8').trim().length > 0) return true
    const all = await git(cwd, ['config', '--get-all', 'credential.helper'], CONFIG_TIMEOUT_MS)
    return all.exitCode === 0 && all.stdout.toString('utf8').trim().length > 0
  }

  /**
   * Lets the environment's existing helper store the credential. The helper
   * list is deliberately not reset: the user's own configuration decides where
   * the credential goes.
   */
  async approve(
    target: ExecutionTarget,
    cwd: string,
    url: string,
    username: string,
    password: Buffer
  ): Promise<void> {
    const binding = bindingOf(url)
    const input = credentialInput(binding.host, binding.path, username, password)
    const run: GitInput = await this.deps.gitWorktrees.gitInputFor(target)
    const result = await run(
      cwd,
      ['-c', 'credential.useHttpPath=true', 'credential', 'approve'],
      input,
      APPROVE_TIMEOUT_MS
    )
    if (result.timedOut || result.exitCode !== 0) {
      throw new ClonePersistenceError(
        makeAppError('GIT_REMOTE_FAILED', 'The credential could not be saved.')
      )
    }
  }

  /**
   * Explicit opt-in only: installs the plaintext `store` helper globally, then
   * proves the write through a helper list that contains only `store`.
   */
  async store(
    target: ExecutionTarget,
    cwd: string,
    url: string,
    username: string,
    password: Buffer
  ): Promise<void> {
    const binding = bindingOf(url)
    const input = credentialInput(binding.host, binding.path, username, password)
    const git: GitResult = await this.deps.gitWorktrees.gitResultFor(target)
    const configured = await git(
      cwd,
      ['config', '--global', '--add', 'credential.helper', 'store'],
      CONFIG_TIMEOUT_MS
    )
    if (configured.timedOut || configured.exitCode !== 0) {
      throw new ClonePersistenceError(
        makeAppError('GIT_REMOTE_FAILED', 'The credential helper could not be configured.')
      )
    }
    const run: GitInput = await this.deps.gitWorktrees.gitInputFor(target)
    const stored = await run(
      cwd,
      [
        '-c',
        'credential.helper=',
        '-c',
        'credential.helper=store',
        '-c',
        'credential.useHttpPath=true',
        'credential',
        'approve'
      ],
      input,
      APPROVE_TIMEOUT_MS
    )
    if (stored.timedOut || stored.exitCode !== 0) {
      throw new ClonePersistenceError(
        makeAppError('GIT_REMOTE_FAILED', 'The credential could not be saved.')
      )
    }
  }

  /** Switches the new checkout's origin to SSH, so later operations need no secret. */
  async switchRemoteToSsh(
    target: ExecutionTarget,
    cwd: string,
    httpsUrl: string,
    sshUrl: string
  ): Promise<void> {
    const original = parseRemoteUrl(httpsUrl)
    const next = parseRemoteUrl(sshUrl)
    if (
      original === null ||
      next === null ||
      next.kind !== 'url' ||
      next.isLocalPath ||
      (next.scheme !== 'ssh' && next.scheme !== 'git+ssh') ||
      original.host === null ||
      next.host === null ||
      original.host !== next.host
    ) {
      throw new ClonePersistenceError(
        makeAppError('INVALID_ARGUMENT', 'The SSH URL must name the same host as the clone.')
      )
    }
    const git: GitResult = await this.deps.gitWorktrees.gitResultFor(target)
    const result = await git(
      cwd,
      ['remote', 'set-url', 'origin', sshUrl],
      CONFIG_TIMEOUT_MS
    )
    if (result.timedOut || result.exitCode !== 0) {
      throw new ClonePersistenceError(
        makeAppError('GIT_REMOTE_FAILED', 'The remote could not be switched to SSH.')
      )
    }
  }
}
