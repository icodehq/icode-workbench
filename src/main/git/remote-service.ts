/**
 * Git remotes for one registered repository.
 *
 * Git's configuration is the source of truth: this service never stores a
 * remote in SQLite. It reads `git remote -v`, parses the URLs for display and
 * provider recognition, and performs the explicit mutations a user asks for.
 *
 * Raw URLs never leave this process. A URL can embed a token, so the wire type
 * carries only redacted display values plus a boolean that says credentials are
 * present; the editor requires a fresh value instead of round-tripping `***`.
 */

import type { RepoId } from '../../shared/domain/ids'
import type { RepositoryStore } from '../persistence/repository-store'
import type { GitWorktreeService } from '../worktrees/git-worktree-service'
import type { ExecutionTarget } from '../../shared/domain/repository'
import type { AppError } from '../../shared/domain/errors'
import { makeAppError } from '../../shared/domain/errors'
import type { MessageKey } from '../../shared/i18n/messages'
import {
  containsRedactionPlaceholder,
  isCloneableRemoteInput,
  parseRemoteUrl,
  redactRemoteUrlCredentials,
  type RemoteProvider
} from '../../shared/domain/remote-url'
import { classifyRemoteFailure } from './remote-failure'

const READ_TIMEOUT_MS = 10_000
const MUTATE_TIMEOUT_MS = 30_000
const FETCH_TIMEOUT_MS = 300_000
const MAX_NAME = 255
const MAX_URL = 2_048

export class RemoteServiceError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.message)
    this.name = 'RemoteServiceError'
  }
}

export type RemoteSummary = {
  name: string
  displayFetchUrl: string
  /** Present only when the push URL differs from the fetch URL. */
  displayPushUrl: string | null
  provider: RemoteProvider
  webUrl: string | null
  hasCredentials: boolean
}

export type RemoteMutationResult = { status: 'ok'; name: string }

type RemoteServiceDeps = {
  repositories: Pick<RepositoryStore, 'findById'>
  gitWorktrees: Pick<GitWorktreeService, 'gitFor' | 'gitResultFor' | 'runRepositoryExclusive'>
}

type RawRemote = {
  name: string
  fetchUrl: string | null
  pushUrl: string | null
}

function fail(
  code: AppError['code'],
  message: string,
  detail?: string,
  messageKey?: MessageKey
): RemoteServiceError {
  return new RemoteServiceError(
    makeAppError(code, message, {
      ...(detail ? { detail } : {}),
      ...(messageKey === undefined ? {} : { messageKey })
    })
  )
}

/**
 * Local Git's own rules for a remote name, before Git is asked.
 *
 * The list is deliberately strict: names travel as argv values and later appear
 * in refspecs, so whitespace, control characters and ref syntax have no place
 * in one. `git check-ref-format --allow-onelevel` is still the authority.
 */
export function isValidRemoteName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_NAME) return false
  if (name !== name.trim()) return false
  if (name.startsWith('-') || name.startsWith('refs/')) return false
  if (name === '.' || name === '..' || name.includes('..') || name.includes('@{')) return false
  if (/[\u0000- \u007f~^:?*[\\]/u.test(name)) return false
  if (name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false
  return true
}

export function isValidRemoteUrl(url: string): boolean {
  return url.length > 0 && url.length <= MAX_URL && isCloneableRemoteInput(url)
}

function parseRemotes(output: string): RawRemote[] {
  const byName = new Map<string, RawRemote>()
  for (const line of output.split('\n')) {
    const trimmed = line.replace(/\r$/u, '')
    if (trimmed.length === 0) continue
    const match = /^(.*?)\t(.*) \((fetch|push)\)$/u.exec(trimmed)
    if (match === null) continue
    const name = match[1]
    const url = match[2]
    const kind = match[3]
    if (name === undefined || url === undefined || kind === undefined) continue
    const current = byName.get(name) ?? { name, fetchUrl: null, pushUrl: null }
    if (kind === 'fetch') {
      current.fetchUrl ??= url
    } else {
      current.pushUrl ??= url
    }
    byName.set(name, current)
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name))
}

function summarize(raw: RawRemote): RemoteSummary {
  const fetch = raw.fetchUrl === null ? null : parseRemoteUrl(raw.fetchUrl)
  const push = raw.pushUrl === null ? null : parseRemoteUrl(raw.pushUrl)
  const pushDiffers =
    raw.pushUrl !== null && raw.pushUrl !== raw.fetchUrl && push !== null && fetch !== null
  return {
    name: raw.name,
    displayFetchUrl:
      fetch === null
        ? redactRemoteUrlCredentials(raw.fetchUrl ?? '')
        : fetch.displayUrl,
    displayPushUrl: pushDiffers ? push!.displayUrl : null,
    provider: fetch?.provider ?? 'generic',
    webUrl: fetch?.webUrl ?? null,
    hasCredentials: fetch?.hasCredentials === true || push?.hasCredentials === true
  }
}

/**
 * One registered repository's remotes.
 *
 * Mutations share the repository lock with worktree add/remove and merge ref
 * updates. A fetch is long-running but still writes remote-tracking refs, so it
 * takes the same lock and is bounded by its own timeout.
 */
export class RemoteService {
  constructor(private readonly deps: RemoteServiceDeps) {}

  async list(repoId: RepoId): Promise<RemoteSummary[]> {
    const repository = this.repository(repoId)
    const git = await this.deps.gitWorktrees.gitFor(repository.executionTarget)
    const output = await git(repository.path, ['remote', '-v'], READ_TIMEOUT_MS)
    return parseRemotes(output).map(summarize)
  }

  async add(repoId: RepoId, input: { name: string; url: string }): Promise<RemoteMutationResult> {
    const repository = this.repository(repoId)
    const name = this.validateName(input.name)
    const url = this.validateUrl(input.url)
    await this.validateNameWithGit(repository.path, repository.executionTarget, name)
    if ((await this.list(repoId)).some((remote) => remote.name === name)) {
      throw fail('INVALID_ARGUMENT', 'A remote with that name already exists.', name, 'remotes.exists')
    }
    await this.mutate(repository.path, repository.executionTarget, url, 'The remote could not be saved.', [
      'remote',
      'add',
      '--',
      name,
      url
    ])
    return { status: 'ok', name }
  }

  async setUrl(repoId: RepoId, input: { name: string; url: string }): Promise<RemoteMutationResult> {
    const repository = this.repository(repoId)
    const name = this.validateName(input.name)
    const url = this.validateUrl(input.url)
    await this.requireExisting(repoId, name)
    await this.mutate(repository.path, repository.executionTarget, url, 'The remote could not be saved.', [
      'remote',
      'set-url',
      '--',
      name,
      url
    ])
    return { status: 'ok', name }
  }

  async remove(repoId: RepoId, nameInput: string): Promise<RemoteMutationResult> {
    const repository = this.repository(repoId)
    const name = this.validateName(nameInput)
    await this.requireExisting(repoId, name)
    await this.deps.gitWorktrees.runRepositoryExclusive(
      repository.path,
      repository.executionTarget,
      async () => {
        const git = await this.deps.gitWorktrees.gitFor(repository.executionTarget)
        try {
          await git(repository.path, ['remote', 'remove', '--', name], MUTATE_TIMEOUT_MS)
        } catch (error) {
          throw new RemoteServiceError(
            classifyRemoteFailure({
              error,
              operation: 'remote',
              target: repository.executionTarget,
              fallback: 'The remote could not be removed.'
            })
          )
        }
      }
    )
    return { status: 'ok', name }
  }

  async fetch(
    repoId: RepoId,
    input: { name: string; prune?: boolean }
  ): Promise<RemoteMutationResult> {
    const repository = this.repository(repoId)
    const name = this.validateName(input.name)
    await this.requireExisting(repoId, name)
    const git = await this.deps.gitWorktrees.gitResultFor(repository.executionTarget)
    return this.deps.gitWorktrees.runRepositoryExclusive(
      repository.path,
      repository.executionTarget,
      async () => {
        let result
        try {
          result = await git(
            repository.path,
            ['fetch', ...(input.prune === false ? [] : ['--prune']), '--', name],
            FETCH_TIMEOUT_MS
          )
        } catch (error) {
          throw new RemoteServiceError(
            classifyRemoteFailure({
              error,
              operation: 'fetch',
              target: repository.executionTarget,
              fallback: 'The remote could not be fetched.'
            })
          )
        }
        if (result.timedOut) {
          throw fail('GIT_REMOTE_FAILED', 'The remote did not respond in time.')
        }
        if (result.spawnFailure !== undefined) {
          throw fail(
            'WSL_UNAVAILABLE',
            'The WSL distro could not run Git.',
            undefined,
            'errors.WSL_UNAVAILABLE'
          )
        }
        if (result.exitCode !== 0) {
          throw new RemoteServiceError(
            classifyRemoteFailure({
              stderr: result.stderr.toString('utf8'),
              operation: 'fetch',
              target: repository.executionTarget,
              fallback: 'The remote could not be fetched.'
            })
          )
        }
        return { status: 'ok', name }
      }
    )
  }

  private repository(repoId: RepoId) {
    const repository = this.deps.repositories.findById(repoId)
    if (repository === null) {
      throw fail('INVALID_ARGUMENT', 'Repository is not registered.', repoId)
    }
    return repository
  }

  private validateName(value: string): string {
    const name = value.trim()
    if (!isValidRemoteName(name)) {
      throw fail(
        'INVALID_ARGUMENT',
        'Enter a remote name without spaces, control characters, or a leading dash.',
        value.slice(0, 200),
        'remotes.invalidName'
      )
    }
    return name
  }

  private validateUrl(value: string): string {
    const url = value.trim()
    if (!isValidRemoteUrl(url) || containsRedactionPlaceholder(url)) {
      throw fail(
        'INVALID_ARGUMENT',
        'Enter a supported Git URL.',
        value.slice(0, 200),
        'remotes.invalidUrl'
      )
    }
    return url
  }

  /** Git is the authority for names; this also catches a repository-side refusal. */
  private async validateNameWithGit(
    path: string,
    target: ExecutionTarget,
    name: string
  ): Promise<void> {
    const git = await this.deps.gitWorktrees.gitResultFor(target)
    // `check-ref-format` has no `--` end-of-options marker; a leading dash is
    // already refused by `isValidRemoteName`, so the value is safe as the ref.
    const result = await git(path, ['check-ref-format', '--allow-onelevel', name], READ_TIMEOUT_MS)
    if (result.timedOut) {
      throw fail('GIT_REMOTE_FAILED', 'Git did not answer while validating the remote name.')
    }
    if (result.spawnFailure !== undefined) {
      throw fail(
        'WSL_UNAVAILABLE',
        'The WSL distro could not run Git.',
        undefined,
        'errors.WSL_UNAVAILABLE'
      )
    }
    if (result.exitCode !== 0) {
      throw fail('INVALID_ARGUMENT', 'Git rejected that remote name.', name)
    }
  }

  private async requireExisting(repoId: RepoId, name: string): Promise<void> {
    if (!(await this.list(repoId)).some((remote) => remote.name === name)) {
      throw fail(
        'INVALID_ARGUMENT',
        'That remote is no longer configured.',
        name,
        'remotes.missing'
      )
    }
  }

  private async mutate(
    path: string,
    target: ExecutionTarget,
    url: string,
    fallback: string,
    args: string[]
  ): Promise<void> {
    await this.deps.gitWorktrees.runRepositoryExclusive(path, target, async () => {
      const git = await this.deps.gitWorktrees.gitFor(target)
      try {
        await git(path, args, MUTATE_TIMEOUT_MS)
      } catch (error) {
        throw new RemoteServiceError(
          classifyRemoteFailure({
            error,
            operation: 'remote',
            target,
            remoteUrl: url,
            fallback
          })
        )
      }
    })
  }
}
