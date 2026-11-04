import { existsSync, mkdirSync, readdirSync, rmdirSync, statSync } from 'node:fs'
import { dirname, posix, win32 } from 'node:path'
import type { ExecutionTarget } from '../../shared/domain/repository'
import {
  createLocalGitExecutor,
  GitUnavailableError,
  type GitExecutor,
  type GitExecutorRouter
} from '../git/executor'
import { makeAppError, type AppError } from '../../shared/domain/errors'
import type {
  RepositoryGitState,
  WorktreeInspection
} from '../../shared/domain/worktree'
import { SessionServiceError } from '../sessions/session-errors'
import type { GuestGitResult } from '../wsl/git/guest-git'
import { samePathResolved } from './worktree-status'

const READ_TIMEOUT_MS = 10_000
const MUTATE_TIMEOUT_MS = 30_000

function isWindowsStylePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\')
}

/**
 * Platform-aware containment.
 *
 * The service handles both local paths and POSIX guest paths, so the separator
 * and case rules must follow the path's own shape, not the host OS. A Windows
 * drive/UNC path uses win32 semantics (case-insensitive, backslashes); anything
 * else uses POSIX semantics.
 */
function isPathInside(root: string, candidate: string): boolean {
  const windows = isWindowsStylePath(root) || isWindowsStylePath(candidate)
  const api = windows ? win32 : posix
  const normalizedRoot = windows ? root.toLowerCase() : root
  const normalizedCandidate = windows ? candidate.toLowerCase() : candidate
  const relative = api.relative(api.resolve(normalizedRoot), api.resolve(normalizedCandidate))
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative))
  )
}

const IN_PROGRESS_MARKERS = [
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'rebase-merge',
  'rebase-apply',
  'BISECT_LOG'
] as const

export type GitWorktreeServiceDeps = {
  /** Root that owns every session worktree, e.g. `<userData>/worktrees`. */
  worktreeRoot: string
  now?: () => number
  /**
   * Routes Git and the managed worktree root by execution target. Absent means
   * "local only", which is exactly the pre-W6 behaviour.
   */
  router?: GitExecutorRouter
}

/**
 * Everything one call needs from the host that owns the repository.
 *
 * `isDirectory`, `ensureParentDirectory` and `exists` are part of the contract
 * rather than node:fs calls at the call site: for a WSL repository they must run
 * in the distro, and a `statSync` on a guest path would answer about the
 * controller's filesystem instead.
 */
type WorktreeContext = {
  target: ExecutionTarget
  worktreeRoot: string
  /**
   * The filesystem semantics of the paths in this context: the controller's
   * platform for a local target, POSIX for a WSL target even when the
   * controller is Windows.
   */
  comparisonPlatform: NodeJS.Platform
  git(cwd: string, args: string[], timeoutMs: number): Promise<string>
  isDirectory(path: string): Promise<boolean>
  ensureParentDirectory(path: string): Promise<void>
  exists(path: string): Promise<boolean>
}

const LOCAL_TARGET: ExecutionTarget = { kind: 'local' }

export type RegisteredWorktree = {
  path: string
  head: string | null
  branch: string | null
}

/**
 * Narrow Git wrapper for session worktrees.
 *
 * Mutations are serialized per repository: Git writes worktree metadata and the
 * index, and two concurrent creates in one repository otherwise race on
 * `index.lock`. Reads are not serialized.
 */
export class GitWorktreeService {
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly localExecutor: GitExecutor = createLocalGitExecutor()

  constructor(private readonly deps: GitWorktreeServiceDeps) {}

  get worktreeRoot(): string {
    return this.deps.worktreeRoot
  }

  /**
   * Resolves the host context for a target.
   *
   * Local keeps the pre-W6 code path exactly: node:fs, and `execFile('git', ...)`
   * with the Windows path. WSL resolves a guest executor and the guest managed
   * root, so every later call in the same method runs in the distro.
   */
  private async contextFor(target: ExecutionTarget = LOCAL_TARGET): Promise<WorktreeContext> {
    const resolved =
      target.kind === 'local' || !this.deps.router
        ? {
            executor: this.localExecutor,
            // Local keeps the pre-W6 root and filesystem exactly.
            worktreeRoot: this.deps.worktreeRoot,
            fs: {
              isDirectory: async (value: string) => this.isDirectory(value),
              exists: async (value: string) => this.exists(value),
              ensureParentDirectory: async (value: string) => this.ensureParentDirectory(value)
            }
          }
        : await this.deps.router.resolve(target)

    return {
      target: target.kind === 'local' || !this.deps.router ? LOCAL_TARGET : target,
      worktreeRoot: resolved.worktreeRoot,
      comparisonPlatform:
        target.kind === 'local' || !this.deps.router ? process.platform : 'linux',
      git: (cwd, args, timeoutMs) => this.trimmed(resolved.executor, cwd, args, timeoutMs),
      isDirectory: resolved.fs.isDirectory,
      ensureParentDirectory: resolved.fs.ensureParentDirectory,
      exists: resolved.fs.exists
    }
  }

  private async trimmed(
    executor: GitExecutor,
    cwd: string,
    args: string[],
    timeoutMs: number
  ): Promise<string> {
    const result = await executor.exec({ cwd, args, timeoutMs })
    /**
     * A timed-out Git call has not answered.
     *
     * Without this, the empty stdout fell through as an ordinary Git failure and
     * `isUnborn` reported "this repository has no commit yet" about a repository
     * that plainly has one — a wrong statement about the user's data caused by a
     * transport stall.
     */
    if (result.timedOut) {
      throw new GitUnavailableError(
        'The WSL distro did not answer in time, so the repository could not be read.',
        cwd
      )
    }
    if (result.exitCode !== 0) {
      const detail = result.stderr.toString('utf8').trim()
      throw new Error(detail.length > 0 ? detail : `git exited ${String(result.exitCode)}`)
    }
    // Why: Git answers with a trailing newline. Passing an untrimmed OID back to
    // Git fails as `invalid reference`.
    return result.stdout.toString('utf8').trim()
  }

  worktreePathFor(repoId: string, sessionId: string, worktreeRoot = this.deps.worktreeRoot): string {
    return `${worktreeRoot.replace(/\/+$/u, '')}/${repoId}/${sessionId}`
  }

  /** Resolves the managed root WorktreePaths are built from, for one target. */
  async worktreeRootFor(target: ExecutionTarget = LOCAL_TARGET): Promise<string> {
    return (await this.contextFor(target)).worktreeRoot
  }

  /**
   * Filesystem questions for one target.
   *
   * Exposed so a caller that must stat a session path (session create, removal)
   * asks the host that owns the repository instead of `node:fs`. There is exactly
   * one implementation — the router's — so a guest path can never reach a local
   * `statSync`.
   */
  async hostFsFor(
    target: ExecutionTarget = LOCAL_TARGET
  ): Promise<{ isDirectory(path: string): Promise<boolean>; exists(path: string): Promise<boolean> }> {
    const resolved =
      target.kind === 'local' || !this.deps.router
        ? {
            isDirectory: async (value: string) => this.isDirectory(value),
            exists: async (value: string) => this.exists(value)
          }
        : await this.deps.router.resolve(target).then((entry) => entry.fs)
    return { isDirectory: resolved.isDirectory, exists: resolved.exists }
  }

  /**
   * Runs read-only Git against one target's checkout.
   *
   * The Git panel needs status and branch questions that are not worktree
   * bookkeeping, and it must ask them where the checkout lives. This exposes the
   * already-resolved context instead of a second router: one implementation of
   * "which host owns this repository" is the whole point.
   */
  async gitFor(
    target: ExecutionTarget = LOCAL_TARGET
  ): Promise<(cwd: string, args: string[], timeoutMs?: number) => Promise<string>> {
    const ctx = await this.contextFor(target)
    return (cwd, args, timeoutMs = READ_TIMEOUT_MS) => ctx.git(cwd, args, timeoutMs)
  }

  /**
   * Runs Git and returns its stdout *verbatim*.
   *
   * Porcelain output starts with a significant space for an unstaged change
   * (` M path`). `trimmed()` strips it, which shifts the first entry's path by
   * one character — measured in Work 81 as a Git panel listing `rc/app.ts`. Any
   * caller that parses a fixed-width format must use this instead.
   */
  async gitRawFor(
    target: ExecutionTarget = LOCAL_TARGET
  ): Promise<(cwd: string, args: string[], timeoutMs?: number) => Promise<{ stdout: string; exitCode: number | null }>> {
    const executor = await this.executorFor(target)
    return async (cwd, args, timeoutMs = READ_TIMEOUT_MS) => {
      const result = await executor.exec({ cwd, args, timeoutMs })
      return { stdout: result.stdout.toString('utf8'), exitCode: result.exitCode }
    }
  }

  /**
   * Runs a Git mutation with a payload on stdin.
   *
   * Hunk staging uses this for `git apply -`; the patch must not travel as an
   * argument, and it must reach guest Git byte-for-byte. Stderr is returned as
   * text so the caller can quote Git's own rejection instead of inventing one.
   */
  async gitInputFor(
    target: ExecutionTarget = LOCAL_TARGET
  ): Promise<
    (
      cwd: string,
      args: string[],
      input: string,
      timeoutMs?: number
    ) => Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }>
  > {
    const executor = await this.executorFor(target)
    return async (cwd, args, input, timeoutMs = MUTATE_TIMEOUT_MS) => {
      const result = await executor.exec({ cwd, args, stdin: input, timeoutMs })
      return {
        stdout: result.stdout.toString('utf8'),
        stderr: result.stderr.toString('utf8'),
        exitCode: result.exitCode,
        timedOut: result.timedOut
      }
    }
  }

  /**
   * Streams read-only Git output for one target.
   *
   * Returns null when the target's executor cannot stream (the guest path today,
   * because `wsl.exe` buffers the guest process). Callers must have a buffered
   * fallback; they must not assume local and guest behave the same here.
   */
  async streamGitFor(
    target: ExecutionTarget = LOCAL_TARGET
  ): Promise<
    | ((
        cwd: string,
        args: string[],
        onStdout: (chunk: Buffer) => void,
        options?: { timeoutMs?: number; signal?: AbortSignal }
      ) => Promise<GuestGitResult>)
    | null
  > {
    const executor = await this.executorFor(target)
    const stream = executor.stream
    if (!stream) return null
    return (cwd, args, onStdout, options = {}) =>
      stream(
        {
          cwd,
          args,
          timeoutMs: options.timeoutMs ?? READ_TIMEOUT_MS,
          ...(options.signal ? { signal: options.signal } : {})
        },
        { onStdout }
      )
  }

  private async executorFor(target: ExecutionTarget): Promise<GitExecutor> {
    if (target.kind === 'local' || !this.deps.router) return this.localExecutor
    return (await this.deps.router.resolve(target)).executor
  }

  /**
   * Raw Git results for a target.
   *
   * Project initialization needs stdout, stderr and the exit status so it can
   * distinguish "not a repository" from a real Git failure. It uses the same
   * executor as every other operation; there is no second target router.
   */
  async gitResultFor(
    target: ExecutionTarget = LOCAL_TARGET
  ): Promise<(cwd: string, args: string[], timeoutMs?: number) => Promise<GuestGitResult>> {
    const executor = await this.executorFor(target)
    return (cwd, args, timeoutMs = READ_TIMEOUT_MS) =>
      executor.exec({ cwd, args, timeoutMs })
  }

  /** Refuses paths outside the managed root so a corrupted row cannot target arbitrary directories. */
  assertManagedPath(path: string, worktreeRoot = this.deps.worktreeRoot): void {
    if (!isPathInside(worktreeRoot, path)) {
      throw new SessionServiceError(
        makeAppError('WORKTREE_INCONSISTENT', 'That path is outside the managed worktree directory.', {
          detail: path
        })
      )
    }
  }

  private ensureParentDirectory(path: string): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  }

  async inspectRepository(
    primaryRoot: string,
    target: ExecutionTarget = LOCAL_TARGET
  ): Promise<RepositoryGitState> {
    const ctx = await this.contextFor(target)
    const git = ctx.git
    const unborn = await this.isUnborn(git, primaryRoot)
    const headOid = unborn ? null : await git(primaryRoot, ['rev-parse', 'HEAD'], READ_TIMEOUT_MS).catch(() => null)
    const headRef = unborn
      ? null
      : await git(primaryRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], READ_TIMEOUT_MS).catch(() => null)
    const commonDir = await git(primaryRoot, ['rev-parse', '--git-common-dir'], READ_TIMEOUT_MS)
      .then((value) => this.resolveGitPath(primaryRoot, value))
      .catch(() => null)
    // Worktree-scoped operations (merge, cherry-pick, revert, rebase) write their
    // marker into the worktree's own git dir, not only the shared common dir.
    const worktreeGitDir = await git(primaryRoot, ['rev-parse', '--git-dir'], READ_TIMEOUT_MS)
      .then((value) => this.resolveGitPath(primaryRoot, value))
      .catch(() => null)
    const markerDirs = [...new Set([worktreeGitDir, commonDir].filter((dir): dir is string => dir !== null))]
    let inProgressOperation: string | null = null
    for (const marker of IN_PROGRESS_MARKERS) {
      let found = false
      for (const dir of markerDirs) {
        // A guest git dir is probed in the guest; a local one with statSync, as
        // before. Never the other way around.
        if (await ctx.exists(`${dir}/${marker}`)) {
          inProgressOperation = marker
          found = true
          break
        }
      }
      if (found) break
    }
    return {
      headOid: headOid && headOid.length > 0 ? headOid : null,
      headRef: headRef && headRef.length > 0 && headRef !== 'HEAD' ? headRef : null,
      unborn,
      inProgressOperation
    }
  }

  async create(input: {
    primaryRoot: string
    path: string
    branch: string
    baseOid: string
    target?: ExecutionTarget
  }): Promise<void> {
    const ctx = await this.contextFor(input.target)
    this.assertManagedPath(input.path, ctx.worktreeRoot)
    await this.runExclusive(`${this.queueKey(ctx)}${input.primaryRoot}`, async () => {
      if (await ctx.isDirectory(input.path)) {
        throw new SessionServiceError(
          makeAppError('WORKTREE_CREATE_FAILED', 'The worktree directory already exists.', {
            detail: input.path
          })
        )
      }
      await ctx.ensureParentDirectory(input.path)
      try {
        await ctx.git(
          input.primaryRoot,
          ['worktree', 'add', '-b', input.branch, input.path, input.baseOid],
          MUTATE_TIMEOUT_MS
        )
      } catch (error) {
        throw new SessionServiceError(
          makeAppError('WORKTREE_CREATE_FAILED', 'The isolated worktree could not be created.', {
            detail: errorDetail(error)
          })
        )
      }
      await this.assertMatches(ctx, {
        path: input.path,
        branch: input.branch,
        baseOid: input.baseOid,
        registerRoot: input.primaryRoot
      })
    })
  }

  /** Re-creates a worktree directory for an existing owned branch at its recorded path. */
  async recover(input: {
    primaryRoot: string
    path: string
    branch: string
    target?: ExecutionTarget
  }): Promise<void> {
    const ctx = await this.contextFor(input.target)
    this.assertManagedPath(input.path, ctx.worktreeRoot)
    await this.runExclusive(`${this.queueKey(ctx)}${input.primaryRoot}`, async () => {
      if (await ctx.isDirectory(input.path)) {
        const registered = await this.listWorktrees(input.primaryRoot, ctx.target).catch(() => [])
        if (registered.some((entry) => samePathResolved(entry.path, input.path, ctx.comparisonPlatform))) {
          throw new SessionServiceError(
            makeAppError('WORKTREE_INCONSISTENT', 'The worktree already exists; nothing to recover.', {
              detail: input.path
            })
          )
        }
        // A failed `worktree add` can leave an empty, unregistered directory.
        // Removing an empty leftover is safe; anything else is preserved for
        // the user to inspect.
        if (!(await this.isEmptyDirectory(ctx, input.path))) {
          throw new SessionServiceError(
            makeAppError(
              'WORKTREE_INCONSISTENT',
              'The directory exists but is not a registered worktree, and it is not empty.',
              { detail: input.path }
            )
          )
        }
        await this.removeEmptyDirectory(ctx, input.path)
      }
      await ctx.ensureParentDirectory(input.path)
      // Explicit recovery may clear stale registration for a vanished directory;
      // this is never done implicitly by deletion or reconciliation.
      await ctx.git(input.primaryRoot, ['worktree', 'prune'], MUTATE_TIMEOUT_MS).catch(() => '')
      const branchOid = await ctx.git(
        input.primaryRoot,
        ['rev-parse', '--verify', `refs/heads/${input.branch}`],
        READ_TIMEOUT_MS
      ).catch(() => null)
      if (branchOid === null) {
        throw new SessionServiceError(
          makeAppError('WORKTREE_MISSING', 'The owned branch no longer exists, so the worktree cannot be recovered.', {
            detail: input.branch
          })
        )
      }
      try {
        await ctx.git(
          input.primaryRoot,
          ['worktree', 'add', input.path, input.branch],
          MUTATE_TIMEOUT_MS
        )
      } catch (error) {
        throw new SessionServiceError(
          makeAppError('WORKTREE_CREATE_FAILED', 'The worktree could not be re-created.', {
            detail: errorDetail(error)
          })
        )
      }
      await this.assertMatches(ctx, {
        path: input.path,
        branch: input.branch,
        baseOid: branchOid,
        registerRoot: input.primaryRoot
      })
    })
  }

  async inspect(input: {
    primaryRoot: string
    path: string
    branch: string
    target?: ExecutionTarget
  }): Promise<WorktreeInspection> {
    const ctx = await this.contextFor(input.target)
    const pathExists = await ctx.isDirectory(input.path)
    const registeredWorktrees = await this.listWorktrees(input.primaryRoot, ctx.target).catch(() => [])
    const registered = registeredWorktrees.some((entry) =>
      samePathResolved(entry.path, input.path, ctx.comparisonPlatform)
    )
    if (!pathExists) {
      return { pathExists, registered, headOid: null, dirtyFiles: [], unmergedCommits: null }
    }
    const headOid = await ctx.git(input.path, ['rev-parse', 'HEAD'], READ_TIMEOUT_MS).catch(() => null)
    const status = await ctx.git(input.path, ['status', '--porcelain'], READ_TIMEOUT_MS).catch(() => null)
    const dirtyFiles = status === null ? [] : parseStatusLines(status)
    const unmergedCommits = await this.countUnmerged(input.primaryRoot, input.branch, ctx.target).catch(
      () => null
    )
    return { pathExists, registered, headOid, dirtyFiles, unmergedCommits }
  }

  async remove(input: {
    primaryRoot: string
    path: string
    force: boolean
    target?: ExecutionTarget
  }): Promise<void> {
    const ctx = await this.contextFor(input.target)
    this.assertManagedPath(input.path, ctx.worktreeRoot)
    await this.runExclusive(`${this.queueKey(ctx)}${input.primaryRoot}`, async () => {
      const args = ['worktree', 'remove', input.path]
      if (input.force) args.splice(2, 0, '--force')
      try {
        await ctx.git(input.primaryRoot, args, MUTATE_TIMEOUT_MS)
      } catch (error) {
        throw new SessionServiceError(
          makeAppError('WORKTREE_DIRTY', 'Git refused to remove the worktree.', {
            detail: errorDetail(error)
          })
        )
      }
      await ctx.git(input.primaryRoot, ['worktree', 'prune'], MUTATE_TIMEOUT_MS).catch(() => '')
    })
  }

  async countUnmerged(
    primaryRoot: string,
    branch: string,
    target: ExecutionTarget = LOCAL_TARGET
  ): Promise<number | null> {
    const ctx = await this.contextFor(target)
    const git = ctx.git
    const headOid = await git(primaryRoot, ['rev-parse', '--verify', 'HEAD'], READ_TIMEOUT_MS).catch(
      () => null
    )
    if (headOid === null) return null
    const output = await git(
      primaryRoot,
      ['rev-list', '--count', branch, '--not', headOid],
      READ_TIMEOUT_MS
    )
    const value = Number(output.trim())
    return Number.isInteger(value) && value >= 0 ? value : null
  }

  async branchExists(
    primaryRoot: string,
    branch: string,
    target: ExecutionTarget = LOCAL_TARGET
  ): Promise<boolean> {
    const ctx = await this.contextFor(target)
    const oid = await ctx.git(
      primaryRoot,
      ['rev-parse', '--verify', `refs/heads/${branch}`],
      READ_TIMEOUT_MS
    ).catch(() => null)
    return oid !== null && oid.length > 0
  }

  async deleteBranch(input: {
    primaryRoot: string
    branch: string
    force: boolean
    target?: ExecutionTarget
  }): Promise<void> {
    const ctx = await this.contextFor(input.target)
    await this.runExclusive(`${this.queueKey(ctx)}${input.primaryRoot}`, async () => {
      try {
        await ctx.git(
          input.primaryRoot,
          ['branch', input.force ? '-D' : '-d', input.branch],
          MUTATE_TIMEOUT_MS
        )
      } catch (error) {
        throw new SessionServiceError(
          makeAppError('WORKTREE_UNMERGED', 'Git refused to delete the branch.', {
            detail: errorDetail(error)
          })
        )
      }
    })
  }

  async listWorktrees(
    primaryRoot: string,
    target: ExecutionTarget = LOCAL_TARGET
  ): Promise<RegisteredWorktree[]> {
    const ctx = await this.contextFor(target)
    const output = await ctx.git(primaryRoot, ['worktree', 'list', '--porcelain'], READ_TIMEOUT_MS)
    const entries = parseWorktreeList(output)
    // Git prints forward slashes on Windows. Return the controller's spelling
    // for local worktrees; guest paths are always POSIX.
    if (process.platform === 'win32' && ctx.target.kind === 'local') {
      for (const entry of entries) entry.path = win32.normalize(entry.path)
    }
    return entries
  }

  private async assertMatches(
    ctx: WorktreeContext,
    input: {
      path: string
      branch: string
      baseOid: string
      registerRoot: string
    }
  ): Promise<void> {
    const git = ctx.git
    const topLevel = await git(input.path, ['rev-parse', '--show-toplevel'], READ_TIMEOUT_MS)
    if (!samePathResolved(topLevel, input.path, ctx.comparisonPlatform)) {
      throw new SessionServiceError(
        makeAppError('WORKTREE_INCONSISTENT', 'The created worktree does not resolve to its recorded path.', {
          detail: topLevel
        })
      )
    }
    const head = await git(input.path, ['rev-parse', 'HEAD'], READ_TIMEOUT_MS).catch(() => null)
    if (head !== null && head !== input.baseOid) {
      throw new SessionServiceError(
        makeAppError('WORKTREE_INCONSISTENT', 'The created worktree is not at its recorded baseline.', {
          detail: `${head} != ${input.baseOid}`
        })
      )
    }
    const registered = await this.listWorktrees(input.registerRoot, ctx.target).catch(() => [])
    if (!registered.some((entry) => samePathResolved(entry.path, input.path, ctx.comparisonPlatform))) {
      throw new SessionServiceError(
        makeAppError('WORKTREE_INCONSISTENT', 'Git did not register the created worktree.', {
          detail: input.path
        })
      )
    }
  }

  private async isUnborn(
    git: (cwd: string, args: string[], timeoutMs: number) => Promise<string>,
    cwd: string
  ): Promise<boolean> {
    try {
      await git(cwd, ['rev-parse', '--verify', 'HEAD'], READ_TIMEOUT_MS)
      return false
    } catch (error) {
      // "We could not ask" is not "there is no commit".
      if (error instanceof GitUnavailableError) throw error
      return true
    }
  }

  private isDirectory(path: string): boolean {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  }

  /**
   * Existence is not directory-ness. Operation markers such as `MERGE_HEAD`
   * are files in the common Git directory; asking `isDirectory` here made every
   * local merge/rebase look finished.
   */
  private exists(path: string): boolean {
    try {
      return existsSync(path)
    } catch {
      return false
    }
  }

  private resolveGitPath(cwd: string, value: string): string {
    const trimmed = value.trim()
    // Absolute POSIX guest path, Windows drive path, or UNC path.
    if (
      trimmed.startsWith('/') ||
      /^[A-Za-z]:[\\/]/u.test(trimmed) ||
      trimmed.startsWith('\\\\')
    ) {
      return trimmed
    }
    return isWindowsStylePath(cwd)
      ? win32.join(cwd, trimmed)
      : `${cwd.replace(/\/+$/u, '')}/${trimmed}`
  }

  /**
   * Mutations are serialized per repository per host. Two hosts that spell the
   * same guest path are different repositories, so the key carries the target.
   */
  private queueKey(ctx: WorktreeContext): string {
    return ctx.target.kind === 'wsl'
      ? `wsl:${ctx.target.distroId ?? ctx.target.distro}\u0000`
      : 'local\u0000'
  }

  /** Guest emptiness probe, so recovery never reads a guest dir with node:fs. */
  private async isEmptyDirectory(ctx: WorktreeContext, path: string): Promise<boolean> {
    if (ctx.target.kind === 'local') {
      try {
        return readdirSync(path).length === 0
      } catch {
        return false
      }
    }
    const resolved = await this.deps.router!.resolve(ctx.target)
    const probe = (resolved.fs as unknown as {
      isEmptyDirectory?: (path: string) => Promise<boolean>
    }).isEmptyDirectory
    if (!probe) throw new Error('The guest filesystem cannot list a directory.')
    return probe(path)
  }

  private async removeEmptyDirectory(ctx: WorktreeContext, path: string): Promise<void> {
    if (ctx.target.kind === 'local') {
      rmdirSync(path)
      return
    }
    const resolved = await this.deps.router!.resolve(ctx.target)
    const remove = (resolved.fs as unknown as {
      removeDirectory?: (path: string) => Promise<void>
    }).removeDirectory
    if (!remove) throw new Error('The guest filesystem cannot remove a directory.')
    await remove(path)
  }

  private runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.queues.set(
      key,
      next.catch(() => undefined)
    )
    return next
  }
}

export function parseWorktreeList(output: string): RegisteredWorktree[] {
  const entries: RegisteredWorktree[] = []
  let current: RegisteredWorktree | null = null
  for (const raw of output.split('\n')) {
    const line = raw.trimEnd()
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current)
      current = { path: line.slice('worktree '.length), head: null, branch: null }
      continue
    }
    if (!current) continue
    if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length)
    if (line.startsWith('branch ')) current.branch = line.slice('branch '.length).replace(/^refs\/heads\//u, '')
    if (line === '') {
      entries.push(current)
      current = null
    }
  }
  if (current) entries.push(current)
  return entries
}

/**
 * Parses `git status --porcelain`.
 *
 * The `XY ` prefix is two status columns plus one space, and the *first* column is
 * a space for an unstaged modification (`" M a.txt"`). Callers trim stdout before
 * this runs, which drops that space — and a fixed `slice(3)` then reported
 * `".txt"`. The prefix is therefore measured, not assumed: two status characters,
 * then a separating space only if one is still there.
 */
export function parseStatusLines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => {
      const payload = line.charAt(2) === ' ' ? line.slice(3) : line.slice(2)
      const renameTarget = payload.includes(' -> ') ? payload.split(' -> ').pop() : undefined
      return renameTarget ?? payload
    })
}

function errorDetail(error: unknown): string {
  if (error && typeof error === 'object' && 'stderr' in error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim()
    if (stderr.length > 0) return stderr.slice(0, 2000)
  }
  return error instanceof Error ? error.message : String(error)
}

export type { AppError }
