/**
 * Adaptive project onboarding.
 *
 * Registration alone can stay non-mutating: an existing Git checkout is added
 * exactly as before. This service answers the question the Add project sheet
 * needs before that call — is this a repository, an unborn repository, a plain
 * folder, or a container of repositories? — and starts the one explicit
 * mutation users may choose: creating a baseline repository and first commit so
 * isolated session worktrees become possible.
 *
 * The flow keeps the important boundary: a normal registration never writes to
 * the folder. `initialize` creates `.git` when needed and registers, then hands
 * the slow staging/commit to the durable preparation service so the dialog does
 * not wait for it.
 */

import { constants as fsConstants, realpathSync } from 'node:fs'
import { access, lstat, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, parse as parsePath } from 'node:path'
import { homedir } from 'node:os'
import type { AppError } from '../../shared/domain/errors'
import { makeAppError } from '../../shared/domain/errors'
import { isAbsolutePathLike } from '../../shared/domain/paths'
import type {
  ExecutionTarget,
  RepositoryPreparation,
  RepositoryRecord,
  WslExecutionTarget
} from '../../shared/domain/repository'
import type {
  InitializeRepositoryInput,
  ProjectFolderInspection,
  ProjectIdentityState,
  ProjectRepositoryCandidate
} from '../../shared/schemas/ipc'
import type { TargetValidator } from '../wsl/repository-target'
import type { WslCommandRunner } from '../wsl/exec'
import type { GuestGitResult } from '../wsl/git/guest-git'
import { guestPathKind, guestRealpath } from '../wsl/git/guest-path'
import { readGuestHome } from '../wsl/host/lifecycle'
import { isTransportFailure, runIdempotentGuest } from '../wsl/probe'
import { parseWslUnc } from '../wsl/unc-path'
import type { GitWorktreeService } from '../worktrees/git-worktree-service'
import type { AddRepositoryOutcome, RepositoryService } from './repository-service'
import { resolveRepositoryRootFor } from './repository-path'

const PATH_READ_TIMEOUT_MS = 10_000
const INIT_TIMEOUT_MS = 30_000
const WRITE_CHECK_TIMEOUT_MS = 6_000
const MAX_CANDIDATES = 200

export class ProjectFolderError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.message)
    this.name = 'ProjectFolderError'
  }
}

type GitRunner = (
  cwd: string,
  args: string[],
  timeoutMs?: number
) => Promise<GuestGitResult>

/**
 * The narrow slice of preparation that onboarding needs.
 *
 * Starting is synchronous and durable: it writes the preparing state before
 * returning, then lets the expensive Git work continue without the dialog.
 */
export interface RepositoryPreparationStarter {
  start(repository: RepositoryRecord): RepositoryPreparation
}

type ProjectFolderServiceDeps = {
  runner: WslCommandRunner
  gitWorktrees: Pick<GitWorktreeService, 'gitResultFor'>
  repositoryService: Pick<RepositoryService, 'addRepository'> &
    Partial<Pick<RepositoryService, 'addInitializedRepository'>>
  preparations: RepositoryPreparationStarter
  validateTarget: TargetValidator
  /** Injectable for tests and for the composition root's platform. */
  platform?: NodeJS.Platform
  localHome?: string
  readGuestHome?: (distro: string) => Promise<string | null>
}

export type InitializeProjectOutcome = AddRepositoryOutcome & {
  /**
   * True when this call set up (or resumed) a repository that needed a first
   * commit. The commit itself may still be running in the background; the
   * authoritative status is `repository.preparation`.
   */
  initialized: boolean
  /** Files committed synchronously; always 0 for the background flow. */
  committedFiles: number
}

/**
 * A project location after target-aware resolution.
 *
 * `translatedFrom` is present only when the user supplied a Windows spelling for
 * a WSL target. The path itself is always the canonical path the target can use.
 */
export type ResolvedProjectLocation = {
  path: string
  translatedFrom?: string
}

function failure(
  code:
    | 'PATH_NOT_FOUND'
    | 'NOT_A_DIRECTORY'
    | 'INVALID_ARGUMENT'
    | 'GIT_READ_FAILED'
    | 'GIT_IDENTITY_MISSING'
    | 'GIT_INIT_FAILED'
    | 'GIT_COMMIT_FAILED'
    | 'WSL_UNAVAILABLE',
  message: string,
  detail?: string,
  path?: string
): ProjectFolderError {
  return new ProjectFolderError(
    makeAppError(code, message, {
      ...(detail === undefined || detail.length === 0 ? {} : { detail: detail.slice(0, 2_000) }),
      ...(path === undefined ? {} : { context: { path } })
    })
  )
}

function detailOf(result: GuestGitResult): string {
  return result.stderr.toString('utf8').trim().slice(0, 2_000)
}

function isNotGitRepository(detail: string): boolean {
  return /not a git repository|not a git work tree/iu.test(detail)
}

function normalizeLocal(value: string, platform: NodeJS.Platform): string {
  let resolved = value
  try {
    // Expand Windows short names/casing before comparing; `RUNNER~1` and
    // `runneradmin` are the same directory.
    resolved = realpathSync.native(value)
  } catch {
    // Non-existent paths still compare by their normalized spelling.
  }
  const withoutTrailing = resolved.replace(/[\\/]+$/u, '') || resolved
  return platform === 'win32'
    ? withoutTrailing.replace(/\\/gu, '/').toLowerCase()
    : withoutTrailing
}

function normalizePosix(value: string): string {
  const trimmed = value.replace(/\/+$/u, '')
  return trimmed.length === 0 ? '/' : trimmed
}

function emptyIdentity(): ProjectIdentityState {
  return { configured: false, name: null, email: null }
}

/**
 * The target-aware inspector plus the explicit first-commit operation.
 *
 * Every filesystem/Git call is routed by `ExecutionTarget`; no guest path ever
 * reaches node:fs and no Windows path reaches guest Git.
 */
export class ProjectFolderService {
  private readonly platform: NodeJS.Platform
  private readonly localHome: string
  private readonly guestHome: (distro: string) => Promise<string | null>

  constructor(private readonly deps: ProjectFolderServiceDeps) {
    this.platform = deps.platform ?? process.platform
    this.localHome = deps.localHome ?? homedir()
    this.guestHome = deps.readGuestHome ?? ((distro) => readGuestHome(deps.runner, distro))
  }

  /**
   * Resolves a path without inspecting its Git state.
   *
   * The folder picker uses this after a native dialog returns a spelling. Typed
   * paths go through the same method inside `inspect`/`initialize`, so every
   * entry point agrees on what a Windows path means for a WSL target.
   */
  async resolveLocation(input: {
    path: string
    target: ExecutionTarget
  }): Promise<ResolvedProjectLocation> {
    const target = await this.deps.validateTarget(input.target)
    return this.resolveLocationForTarget(input.path, target)
  }

  async inspect(input: {
    path: string
    target: ExecutionTarget
  }): Promise<ProjectFolderInspection> {
    const target = await this.deps.validateTarget(input.target)
    const location = await this.resolveLocationForTarget(input.path, target)
    const git = await this.deps.gitWorktrees.gitResultFor(target)
    const inspection = await this.inspectAt(location.path, target, git)
    return location.translatedFrom === undefined
      ? inspection
      : { ...inspection, translatedFrom: location.translatedFrom }
  }

  async initialize(input: InitializeRepositoryInput): Promise<InitializeProjectOutcome> {
    const target = await this.deps.validateTarget(input.target)
    const location = await this.resolveLocationForTarget(input.path, target)
    const git = await this.deps.gitWorktrees.gitResultFor(target)
    const inspection = await this.inspectAt(location.path, target, git)

    if (inspection.kind === 'repository') {
      const outcome = await this.deps.repositoryService.addRepository(
        inspection.path,
        target,
        { targetAlreadyValidated: true }
      )
      return { ...outcome, initialized: false, committedFiles: 0 }
    }
    if (inspection.kind === 'parent') {
      throw failure(
        'INVALID_ARGUMENT',
        'Choose one of the Git repositories in that folder, not the folder itself.',
        inspection.blockedReason ?? undefined,
        inspection.path
      )
    }
    if (!inspection.canInitialize) {
      throw failure(
        'INVALID_ARGUMENT',
        inspection.blockedReason ?? 'This folder cannot be initialized here.',
        undefined,
        inspection.path
      )
    }

    const root = inspection.root ?? inspection.path
    if (!inspection.identity.configured && input.identity === undefined) {
      throw failure(
        'GIT_IDENTITY_MISSING',
        'Git needs an author name and email before iCode can create the first commit.',
        'Set them in the dialog, or configure user.name and user.email in Git.',
        root
      )
    }

    if (inspection.kind === 'gitless') {
      await this.mutateGit(
        git,
        root,
        ['init', '-q'],
        INIT_TIMEOUT_MS,
        'GIT_INIT_FAILED',
        'Could not initialize Git in this folder.'
      )
    }

    if (input.identity !== undefined && !inspection.identity.configured) {
      await this.setIdentity(git, root, input.identity)
    }

    /*
     * Register before the first commit. The project is real as soon as Git
     * exists, and the session service already refuses an unborn repository.
     * This is what lets the Add dialog close before staging begins; the
     * background service owns the expensive part and its retry state.
     */
    const outcome =
      inspection.kind === 'gitless' &&
      this.deps.repositoryService.addInitializedRepository !== undefined
        ? await this.deps.repositoryService.addInitializedRepository(
            inspection.path,
            target,
            { targetAlreadyValidated: true }
          )
        : await this.deps.repositoryService.addRepository(
            inspection.path,
            target,
            { targetAlreadyValidated: true }
          )
    const preparation = this.deps.preparations.start(outcome.repository)
    return {
      ...outcome,
      repository: { ...outcome.repository, preparation },
      initialized: true,
      committedFiles: 0
    }
  }

  private async inspectAt(
    canonical: string,
    target: ExecutionTarget,
    git: GitRunner
  ): Promise<ProjectFolderInspection> {
    const probe = await this.gitProbe(git, canonical, target)
    if (probe.exitCode === 0) {
      return this.inspectRepository(canonical, target, git)
    }
    const detail = detailOf(probe)
    if (!isNotGitRepository(detail)) {
      throw failure(
        'GIT_READ_FAILED',
        'Git could not inspect this folder.',
        detail || 'git rev-parse failed',
        canonical
      )
    }
    return this.inspectGitless(canonical, target, git)
  }

  private async inspectRepository(
    canonical: string,
    target: ExecutionTarget,
    git: GitRunner
  ): Promise<ProjectFolderInspection> {
    let resolved
    try {
      resolved = await resolveRepositoryRootFor(canonical, target, {
        wsl: { runner: this.deps.runner }
      })
    } catch (error) {
      const appError =
        error && typeof error === 'object' && 'appError' in error
          ? (error as { appError: AppError }).appError
          : null
      if (appError !== null) throw new ProjectFolderError(appError)
      throw failure(
        'GIT_READ_FAILED',
        'The repository root could not be resolved.',
        error instanceof Error ? error.message : String(error),
        canonical
      )
    }

    const head = await git(resolved.root, ['rev-parse', '--verify', 'HEAD'], PATH_READ_TIMEOUT_MS)
    if (head.timedOut) {
      throw failure(
        'GIT_READ_FAILED',
        'Git did not answer while reading the repository.',
        undefined,
        resolved.root
      )
    }
    const hasCommit = head.exitCode === 0 && head.stdout.toString('utf8').trim().length > 0
    /*
     * A registered checkout needs neither identity nor a writable-folder probe
     * to be added. Only an unborn repository needs those questions, and they
     * are independent of each other; asking them sequentially made the WSL
     * onboarding path pay one guest round-trip after another.
     */
    const [blockedReason, identity] = hasCommit
      ? [null, emptyIdentity()] as const
      : await Promise.all([
          this.initializationBlock(resolved.root, target),
          this.readIdentity(git, resolved.root)
        ])

    /*
     * The old recursive preview was a gate in practice: it walked 14,000+
     * dependency files, timed out, and returned null just before the user was
     * told "Git timed out". Add project now starts work immediately; the
     * background preparation reports what it actually staged.
     */
    return {
      kind: hasCommit ? 'repository' : 'unborn',
      path: resolved.root,
      root: resolved.root,
      currentBranch: resolved.currentBranch,
      hasCommit,
      repositories: [],
      preview: null,
      identity,
      canInitialize: !hasCommit && blockedReason === null,
      blockedReason
    }
  }

  private async inspectGitless(
    canonical: string,
    target: ExecutionTarget,
    git: GitRunner
  ): Promise<ProjectFolderInspection> {
    const [repositories, blockedReason, identity] = await Promise.all([
      this.findNestedRepositories(canonical, target),
      this.initializationBlock(canonical, target),
      this.readIdentity(git, canonical)
    ])
    if (repositories.length > 0) {
      return {
        kind: 'parent',
        path: canonical,
        root: null,
        currentBranch: null,
        hasCommit: false,
        repositories,
        preview: null,
        identity: emptyIdentity(),
        canInitialize: false,
        blockedReason: 'This folder contains Git repositories. Choose one of them instead.'
      }
    }

    return {
      kind: 'gitless',
      path: canonical,
      root: null,
      currentBranch: null,
      hasCommit: false,
      repositories: [],
      preview: null,
      identity,
      canInitialize: blockedReason === null,
      blockedReason
    }
  }

  /**
   * Turns a user-supplied spelling into the path the target can actually use.
   *
   * A WSL target is an execution environment, not a storage boundary. Windows
   * drives mounted into the distro are reached through their Windows spelling
   * (`D:\...`) or the Linux mount path (`/mnt/d/...`); the former is translated
   * by `wslpath` so custom automount roots are respected.
   */
  private async resolveLocationForTarget(
    inputPath: string,
    target: ExecutionTarget
  ): Promise<ResolvedProjectLocation> {
    const trimmed = inputPath.trim()
    if (trimmed.length === 0) {
      throw failure('PATH_NOT_FOUND', 'Enter a repository folder path.', 'The path is empty.', trimmed)
    }
    if (target.kind === 'local') {
      return { path: await this.canonicalDirectory(trimmed, target) }
    }

    const unc = parseWslUnc(trimmed)
    if (unc !== null) {
      if (unc.distro.trim().toLowerCase() !== target.distro.trim().toLowerCase()) {
        throw failure(
          'INVALID_ARGUMENT',
          `That folder is inside ${unc.distro}, not ${target.distro}.`,
          'Choose a folder in the selected distro.',
          trimmed
        )
      }
      return {
        path: await this.canonicalDirectory(unc.path, target),
        translatedFrom: trimmed
      }
    }

    if (trimmed.startsWith('/')) {
      return { path: await this.canonicalDirectory(trimmed, target) }
    }

    if (/^[A-Za-z]:[\\/]/u.test(trimmed) || trimmed.startsWith('\\\\')) {
      const translated = await this.translateWindowsPath(trimmed, target)
      try {
        return {
          path: await this.canonicalDirectory(translated, target),
          translatedFrom: trimmed
        }
      } catch (error) {
        if (error instanceof ProjectFolderError && error.appError.code === 'PATH_NOT_FOUND') {
          throw failure(
            'PATH_NOT_FOUND',
            `That Windows folder is not reachable inside ${target.distro}.`,
            `${trimmed} maps to ${translated}, but the folder could not be read. Check that the drive is mounted in the distro.`,
            trimmed
          )
        }
        throw error
      }
    }

    throw failure(
      'INVALID_ARGUMENT',
      'Enter an absolute path inside the WSL distro.',
      'WSL paths start with "/", for example /home/you/project. A Windows drive path such as D:\\project is also supported.',
      trimmed
    )
  }

  /**
   * Asks the selected distro to spell a Windows path.
   *
   * `wslpath` is deliberately run in the guest, not implemented with a
   * `/mnt/<letter>` rule here: the automount root is configurable, and a
   * translation that is merely plausible is worse than an explicit failure.
   */
  private async translateWindowsPath(
    path: string,
    target: WslExecutionTarget
  ): Promise<string> {
    let result
    try {
      result = await runIdempotentGuest(this.deps.runner, {
        scope: 'guest',
        distro: target.distro,
        argv: ['wslpath', '-u', path],
        timeoutMs: PATH_READ_TIMEOUT_MS
      })
    } catch (error) {
      throw this.mapGuestError(error, path)
    }
    if ('status' in result || isTransportFailure(result)) {
      throw this.mapGuestFailure(result)
    }
    if (result.code !== 0) {
      const detail = result.stderr.toString('utf8').trim()
      throw failure(
        'PATH_NOT_FOUND',
        `That Windows folder could not be mapped into ${target.distro}.`,
        detail || 'The drive may not be mounted in the distro. Enter the Linux path instead.',
        path
      )
    }
    const translated = result.stdout.toString('utf8').trim()
    if (!translated.startsWith('/') || /[\u0000-\u001f\u007f]/u.test(translated)) {
      throw failure(
        'PATH_NOT_FOUND',
        `That Windows folder could not be mapped into ${target.distro}.`,
        'wslpath did not return an absolute Linux path.',
        path
      )
    }
    return translated
  }

  private async canonicalDirectory(path: string, target: ExecutionTarget): Promise<string> {
    const trimmed = path.trim()
    if (trimmed.length === 0) {
      throw failure('PATH_NOT_FOUND', 'Enter a repository folder path.', 'The path is empty.', trimmed)
    }
    if (!isAbsolutePathLike(trimmed)) {
      throw failure(
        'INVALID_ARGUMENT',
        'Project paths must be absolute.',
        target.kind === 'wsl'
          ? 'A WSL path starts with "/", for example /home/you/project.'
          : trimmed,
        trimmed
      )
    }

    if (target.kind === 'local') {
      if (!isAbsolute(trimmed)) {
        throw failure('INVALID_ARGUMENT', 'That is not an absolute path on this machine.', trimmed, trimmed)
      }
      let resolved: string
      try {
        resolved = await realpath(trimmed)
      } catch {
        throw failure(
          'PATH_NOT_FOUND',
          'That folder does not exist.',
          'Check the path or use the folder picker.',
          trimmed
        )
      }
      const info = await stat(resolved).catch(() => null)
      if (info === null || !info.isDirectory()) {
        throw failure(
          'NOT_A_DIRECTORY',
          'That path is not a folder.',
          'Choose a directory that contains the repository.',
          resolved
        )
      }
      return resolved
    }

    if (!trimmed.startsWith('/')) {
      throw failure(
        'INVALID_ARGUMENT',
        'Enter an absolute path inside the WSL distro.',
        'WSL paths start with "/", for example /home/you/project.',
        trimmed
      )
    }
    let resolved: string | null
    try {
      resolved = await guestRealpath(this.deps.runner, target.distro, trimmed)
    } catch (error) {
      throw this.mapGuestError(error, trimmed)
    }
    if (resolved === null) {
      throw failure(
        'PATH_NOT_FOUND',
        'That folder does not exist in the WSL distro.',
        `Checked ${trimmed} inside ${target.distro}.`,
        trimmed
      )
    }
    let kind
    try {
      kind = await guestPathKind(this.deps.runner, target.distro, resolved)
    } catch (error) {
      throw this.mapGuestError(error, resolved)
    }
    if (kind !== 'dir') {
      throw failure(
        'NOT_A_DIRECTORY',
        'That path is not a folder.',
        'Choose a directory that contains the repository.',
        resolved
      )
    }
    return resolved
  }

  private async gitProbe(
    git: GitRunner,
    cwd: string,
    target: ExecutionTarget
  ): Promise<GuestGitResult> {
    try {
      const result = await git(cwd, ['rev-parse', '--git-common-dir'], PATH_READ_TIMEOUT_MS)
      if (result.timedOut) {
        throw failure(
          target.kind === 'wsl' ? 'WSL_UNAVAILABLE' : 'GIT_READ_FAILED',
          'Git did not answer while inspecting this folder.',
          undefined,
          cwd
        )
      }
      if (result.spawnFailure !== undefined) {
        throw failure(
          target.kind === 'wsl' ? 'WSL_UNAVAILABLE' : 'GIT_READ_FAILED',
          'Git could not be started.',
          result.spawnFailure,
          cwd
        )
      }
      return result
    } catch (error) {
      if (error instanceof ProjectFolderError) throw error
      throw failure(
        target.kind === 'wsl' ? 'WSL_UNAVAILABLE' : 'GIT_READ_FAILED',
        target.kind === 'wsl'
          ? 'The WSL distro could not run Git.'
          : 'Git could not be started.',
        error instanceof Error ? error.message : String(error),
        cwd
      )
    }
  }

  private async readIdentity(git: GitRunner, cwd: string): Promise<ProjectIdentityState> {
    const [name, email] = await Promise.all([
      this.readConfig(git, cwd, 'user.name'),
      this.readConfig(git, cwd, 'user.email')
    ])
    return {
      configured: name !== null && email !== null,
      name,
      email
    }
  }

  private async readConfig(git: GitRunner, cwd: string, key: string): Promise<string | null> {
    try {
      const result = await git(cwd, ['config', '--get', key], PATH_READ_TIMEOUT_MS)
      if (result.timedOut || result.spawnFailure !== undefined || result.exitCode !== 0) return null
      const value = result.stdout.toString('utf8').trim()
      return value.length > 0 ? value.slice(0, 320) : null
    } catch {
      return null
    }
  }

  private async setIdentity(
    git: GitRunner,
    cwd: string,
    identity: { name: string; email: string }
  ): Promise<void> {
    await this.mutateGit(
      git,
      cwd,
      ['config', 'user.name', identity.name],
      INIT_TIMEOUT_MS,
      'GIT_IDENTITY_MISSING',
      'The Git author name could not be saved.'
    )
    await this.mutateGit(
      git,
      cwd,
      ['config', 'user.email', identity.email],
      INIT_TIMEOUT_MS,
      'GIT_IDENTITY_MISSING',
      'The Git author email could not be saved.'
    )
  }

  private async mutateGit(
    git: GitRunner,
    cwd: string,
    args: string[],
    timeoutMs: number,
    code: 'GIT_INIT_FAILED' | 'GIT_COMMIT_FAILED' | 'GIT_IDENTITY_MISSING',
    message: string
  ): Promise<GuestGitResult> {
    try {
      const result = await git(cwd, args, timeoutMs)
      if (result.timedOut) {
        throw failure(code, message, 'Git timed out.', cwd)
      }
      if (result.spawnFailure !== undefined || result.exitCode !== 0) {
        throw failure(
          code,
          message,
          detailOf(result) || result.spawnFailure || 'git exited with a failure',
          cwd
        )
      }
      return result
    } catch (error) {
      if (error instanceof ProjectFolderError) throw error
      throw failure(
        code,
        message,
        error instanceof Error ? error.message : String(error),
        cwd
      )
    }
  }

  private async initializationBlock(path: string, target: ExecutionTarget): Promise<string | null> {
    const protectedReason = await this.protectedReason(path, target)
    if (protectedReason !== null) return protectedReason
    if (!(await this.isWritable(path, target))) return 'This folder is not writable.'
    return null
  }

  private async protectedReason(path: string, target: ExecutionTarget): Promise<string | null> {
    if (target.kind === 'local') {
      if (normalizeLocal(path, this.platform) === normalizeLocal(parsePath(path).root, this.platform)) {
        return 'Choose a project folder, not a filesystem root.'
      }
      if (normalizeLocal(path, this.platform) === normalizeLocal(this.localHome, this.platform)) {
        return 'Choose a project folder, not your home directory.'
      }
      return null
    }
    const posix = normalizePosix(path)
    if (posix === '/' || posix === '/home' || posix === '/root' || posix === '/mnt' || /^\/mnt\/[a-z]$/iu.test(posix)) {
      return 'Choose a project folder, not a filesystem root or home directory.'
    }
    const home = await this.guestHome(target.distro).catch(() => null)
    if (home !== null && normalizePosix(home) === posix) {
      return 'Choose a project folder, not your home directory.'
    }
    return null
  }

  private async isWritable(path: string, target: ExecutionTarget): Promise<boolean> {
    if (target.kind === 'local') {
      try {
        await access(path, fsConstants.W_OK)
        return true
      } catch {
        return false
      }
    }
    const result = await runIdempotentGuest(this.deps.runner, {
      scope: 'guest',
      distro: target.distro,
      argv: ['sh', '-c', 'test -w "$1"', 'icode-writable', path],
      timeoutMs: WRITE_CHECK_TIMEOUT_MS
    })
    if ('status' in result || isTransportFailure(result)) {
      throw this.mapGuestFailure(result)
    }
    return result.code === 0
  }

  private async findNestedRepositories(
    parent: string,
    target: ExecutionTarget
  ): Promise<ProjectRepositoryCandidate[]> {
    if (target.kind === 'local') {
      let entries
      try {
        entries = await readdir(parent, { withFileTypes: true })
      } catch {
        return []
      }
      const candidates: ProjectRepositoryCandidate[] = []
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const path = join(parent, entry.name)
        if (await this.hasGitEntry(path)) {
          candidates.push({ path, displayName: entry.name })
        }
        if (candidates.length >= MAX_CANDIDATES) break
      }
      return candidates.sort((left, right) => left.displayName.localeCompare(right.displayName))
    }

    const script = [
      'for d in "$1"/* "$1"/.[!.]* "$1"/..?*; do',
      '  [ -d "$d" ] || continue',
      '  case "$d" in */.git) continue ;; esac',
      '  [ -e "$d/.git" ] || continue',
      '  printf "%s\\0" "$d"',
      'done',
      'exit 0'
    ].join('\n')
    const result = await runIdempotentGuest(this.deps.runner, {
      scope: 'guest',
      distro: target.distro,
      argv: ['sh', '-c', script, 'icode-nested', parent],
      timeoutMs: WRITE_CHECK_TIMEOUT_MS
    })
    if ('status' in result || isTransportFailure(result) || result.code !== 0) {
      throw this.mapGuestFailure(result)
    }
    const paths = result.stdout
      .toString('utf8')
      .split('\0')
      .filter((value) => value.length > 0)
      .slice(0, MAX_CANDIDATES)
    return paths
      .map((path) => ({
        path,
        displayName: path.slice(path.lastIndexOf('/') + 1)
      }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName))
  }

  private async hasGitEntry(path: string): Promise<boolean> {
    try {
      await lstat(`${path}/.git`)
      return true
    } catch {
      return false
    }
  }

  private mapGuestError(error: unknown, path: string): ProjectFolderError {
    if (error instanceof ProjectFolderError) return error
    if (error && typeof error === 'object' && 'appError' in error) {
      return new ProjectFolderError((error as { appError: AppError }).appError)
    }
    return failure(
      'WSL_UNAVAILABLE',
      'The WSL distro could not inspect this folder.',
      error instanceof Error ? error.message : String(error),
      path
    )
  }

  private mapGuestFailure(
    result: { status: 'wsl_missing' } | { code: number | null; stdout: Buffer; stderr: Buffer; timedOut: boolean }
  ): ProjectFolderError {
    if ('status' in result) {
      return failure('WSL_UNAVAILABLE', 'WSL is not available.', 'wsl.exe could not be started.')
    }
    const detail = result.stderr.toString('utf8').trim().slice(0, 2_000)
    return failure(
      'WSL_UNAVAILABLE',
      'The WSL distro did not answer.',
      detail || (result.timedOut ? 'The request timed out.' : `exit ${String(result.code)}`)
    )
  }
}
