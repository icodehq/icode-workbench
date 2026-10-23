import { execFile } from 'node:child_process'
import { mkdirSync, readdirSync, rmdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { makeAppError, type AppError } from '../../shared/domain/errors'
import type {
  RepositoryGitState,
  WorktreeInspection
} from '../../shared/domain/worktree'
import { SessionServiceError } from '../sessions/session-errors'
import { samePathResolved } from './worktree-status'

const execFileAsync = promisify(execFile)
const READ_TIMEOUT_MS = 10_000
const MUTATE_TIMEOUT_MS = 30_000

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
}

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

  constructor(private readonly deps: GitWorktreeServiceDeps) {}

  get worktreeRoot(): string {
    return this.deps.worktreeRoot
  }

  worktreePathFor(repoId: string, sessionId: string): string {
    return `${this.deps.worktreeRoot.replace(/\/+$/u, '')}/${repoId}/${sessionId}`
  }

  /** Refuses paths outside the managed root so a corrupted row cannot target arbitrary directories. */
  assertManagedPath(path: string): void {
    const root = this.deps.worktreeRoot.replace(/\/+$/u, '')
    if (!(path === root || path.startsWith(`${root}/`))) {
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

  async inspectRepository(primaryRoot: string): Promise<RepositoryGitState> {
    const unborn = await this.isUnborn(primaryRoot)
    const headOid = unborn ? null : await this.git(primaryRoot, ['rev-parse', 'HEAD'], READ_TIMEOUT_MS).catch(() => null)
    const headRef = unborn
      ? null
      : await this.git(primaryRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], READ_TIMEOUT_MS).catch(() => null)
    const commonDir = await this.git(primaryRoot, ['rev-parse', '--git-common-dir'], READ_TIMEOUT_MS)
      .then((value) => this.resolveGitPath(primaryRoot, value))
      .catch(() => null)
    let inProgressOperation: string | null = null
    if (commonDir !== null) {
      for (const marker of IN_PROGRESS_MARKERS) {
        try {
          statSync(`${commonDir}/${marker}`)
          inProgressOperation = marker
          break
        } catch {
          // Absent markers are the normal case.
        }
      }
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
  }): Promise<void> {
    this.assertManagedPath(input.path)
    await this.runExclusive(input.primaryRoot, async () => {
      if (this.isDirectory(input.path)) {
        throw new SessionServiceError(
          makeAppError('WORKTREE_CREATE_FAILED', 'The worktree directory already exists.', {
            detail: input.path
          })
        )
      }
      this.ensureParentDirectory(input.path)
      try {
        await this.git(
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
      await this.assertMatches({
        path: input.path,
        branch: input.branch,
        baseOid: input.baseOid,
        registerRoot: input.primaryRoot
      })
    })
  }

  /** Re-creates a worktree directory for an existing owned branch at its recorded path. */
  async recover(input: { primaryRoot: string; path: string; branch: string }): Promise<void> {
    this.assertManagedPath(input.path)
    await this.runExclusive(input.primaryRoot, async () => {
      if (this.isDirectory(input.path)) {
        const registered = await this.listWorktrees(input.primaryRoot).catch(() => [])
        if (registered.some((entry) => samePathResolved(entry.path, input.path))) {
          throw new SessionServiceError(
            makeAppError('WORKTREE_INCONSISTENT', 'The worktree already exists; nothing to recover.', {
              detail: input.path
            })
          )
        }
        // A failed `worktree add` can leave an empty, unregistered directory.
        // Removing an empty leftover is safe; anything else is preserved for
        // the user to inspect.
        if (readdirSync(input.path).length > 0) {
          throw new SessionServiceError(
            makeAppError(
              'WORKTREE_INCONSISTENT',
              'The directory exists but is not a registered worktree, and it is not empty.',
              { detail: input.path }
            )
          )
        }
        rmdirSync(input.path)
      }
      this.ensureParentDirectory(input.path)
      // Explicit recovery may clear stale registration for a vanished directory;
      // this is never done implicitly by deletion or reconciliation.
      await this.git(input.primaryRoot, ['worktree', 'prune'], MUTATE_TIMEOUT_MS).catch(() => '')
      const branchOid = await this.git(
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
        await this.git(
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
      await this.assertMatches({
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
  }): Promise<WorktreeInspection> {
    const pathExists = this.isDirectory(input.path)
    const registeredWorktrees = await this.listWorktrees(input.primaryRoot).catch(() => [])
    const registered = registeredWorktrees.some((entry) => samePathResolved(entry.path, input.path))
    if (!pathExists) {
      return { pathExists, registered, headOid: null, dirtyFiles: [], unmergedCommits: null }
    }
    const headOid = await this.git(input.path, ['rev-parse', 'HEAD'], READ_TIMEOUT_MS).catch(() => null)
    const status = await this.git(input.path, ['status', '--porcelain'], READ_TIMEOUT_MS).catch(() => null)
    const dirtyFiles = status === null ? [] : parseStatusLines(status)
    const unmergedCommits = await this.countUnmerged(input.primaryRoot, input.branch).catch(() => null)
    return { pathExists, registered, headOid, dirtyFiles, unmergedCommits }
  }

  async remove(input: { primaryRoot: string; path: string; force: boolean }): Promise<void> {
    this.assertManagedPath(input.path)
    await this.runExclusive(input.primaryRoot, async () => {
      const args = ['worktree', 'remove', input.path]
      if (input.force) args.splice(2, 0, '--force')
      try {
        await this.git(input.primaryRoot, args, MUTATE_TIMEOUT_MS)
      } catch (error) {
        throw new SessionServiceError(
          makeAppError('WORKTREE_DIRTY', 'Git refused to remove the worktree.', {
            detail: errorDetail(error)
          })
        )
      }
      await this.git(input.primaryRoot, ['worktree', 'prune'], MUTATE_TIMEOUT_MS).catch(() => '')
    })
  }

  async countUnmerged(primaryRoot: string, branch: string): Promise<number | null> {
    const headOid = await this.git(primaryRoot, ['rev-parse', '--verify', 'HEAD'], READ_TIMEOUT_MS).catch(
      () => null
    )
    if (headOid === null) return null
    const output = await this.git(
      primaryRoot,
      ['rev-list', '--count', branch, '--not', headOid],
      READ_TIMEOUT_MS
    )
    const value = Number(output.trim())
    return Number.isInteger(value) && value >= 0 ? value : null
  }

  async branchExists(primaryRoot: string, branch: string): Promise<boolean> {
    const oid = await this.git(
      primaryRoot,
      ['rev-parse', '--verify', `refs/heads/${branch}`],
      READ_TIMEOUT_MS
    ).catch(() => null)
    return oid !== null && oid.length > 0
  }

  async deleteBranch(input: { primaryRoot: string; branch: string; force: boolean }): Promise<void> {
    await this.runExclusive(input.primaryRoot, async () => {
      try {
        await this.git(
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

  async listWorktrees(primaryRoot: string): Promise<RegisteredWorktree[]> {
    const output = await this.git(primaryRoot, ['worktree', 'list', '--porcelain'], READ_TIMEOUT_MS)
    return parseWorktreeList(output)
  }

  private async assertMatches(input: {
    path: string
    branch: string
    baseOid: string
    registerRoot: string
  }): Promise<void> {
    const topLevel = await this.git(input.path, ['rev-parse', '--show-toplevel'], READ_TIMEOUT_MS)
    if (!samePathResolved(topLevel, input.path)) {
      throw new SessionServiceError(
        makeAppError('WORKTREE_INCONSISTENT', 'The created worktree does not resolve to its recorded path.', {
          detail: topLevel
        })
      )
    }
    const head = await this.git(input.path, ['rev-parse', 'HEAD'], READ_TIMEOUT_MS).catch(() => null)
    if (head !== null && head !== input.baseOid) {
      throw new SessionServiceError(
        makeAppError('WORKTREE_INCONSISTENT', 'The created worktree is not at its recorded baseline.', {
          detail: `${head} != ${input.baseOid}`
        })
      )
    }
    const registered = await this.listWorktrees(input.registerRoot).catch(() => [])
    if (!registered.some((entry) => samePathResolved(entry.path, input.path))) {
      throw new SessionServiceError(
        makeAppError('WORKTREE_INCONSISTENT', 'Git did not register the created worktree.', {
          detail: input.path
        })
      )
    }
  }

  private async isUnborn(cwd: string): Promise<boolean> {
    try {
      await this.git(cwd, ['rev-parse', '--verify', 'HEAD'], READ_TIMEOUT_MS)
      return false
    } catch {
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

  private resolveGitPath(cwd: string, value: string): string {
    const trimmed = value.trim()
    if (trimmed.startsWith('/')) return trimmed
    return `${cwd.replace(/\/+$/u, '')}/${trimmed}`
  }

  private async git(cwd: string, args: string[], timeout: number): Promise<string> {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    })
    // Why: Git answers with a trailing newline. Passing an untrimmed OID back to
    // Git fails as `invalid reference`.
    return stdout.trim()
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

export function parseStatusLines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => {
      const payload = line.slice(3)
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
