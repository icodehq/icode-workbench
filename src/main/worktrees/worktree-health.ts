import { mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { posix, win32 } from 'node:path'
import { makeAppError, type AppError } from '../../shared/domain/errors'
import type { RepositoryRecord } from '../../shared/domain/repository'
import type { WorktreeRecord } from '../../shared/domain/worktree'
import type { RepositoryStore } from '../persistence/repository-store'
import type { WorktreeStore } from '../persistence/worktree-store'
import { SessionServiceError } from '../sessions/session-errors'
import {
  IN_PROGRESS_MARKERS,
  isPathInside,
  isWindowsStylePath,
  worktreeGitArgs,
  type GitWorktreeService
} from './git-worktree-service'
import { samePathResolved } from './worktree-status'

const MUTATE_TIMEOUT_MS = 30_000
const MAX_GIT_FILE_BYTES = 4_096
const DEFAULT_HEALTHY_TTL_MS = 60_000

/**
 * What a cheap probe learned about one checkout.
 *
 * `unknown` is deliberately separate from `unregistered`: a permission error or
 * a transport failure says nothing about the checkout, and treating it as
 * broken would invite a repair that deletes or re-creates user files.
 */
export type WorktreeProbe =
  | { kind: 'healthy' }
  | { kind: 'reindex'; adminDir: string }
  | { kind: 'absent' }
  | {
      kind: 'unregistered'
      /** The worktree's own `.git` file names a directory inside this repository. */
      gitFile: boolean
      /** The admin directory named by that file (may not exist yet). */
      adminDir: string | null
      adminExists: boolean
      /** The `.git` file points at another repository; never touch it. */
      foreign: boolean
      /** Re-creating the directory would discard files. */
      nonEmpty: boolean
    }
  | { kind: 'blocked'; detail: string; adminDir: string }
  | { kind: 'unknown'; detail: string }

export type WorktreeRepairAction =
  | 'repair-links'
  | 'rebuild-index'
  | 'reconstruct-admin'
  | 'readd'

export type WorktreeEnsureResult =
  | { kind: 'healthy' }
  | { kind: 'repaired'; actions: WorktreeRepairAction[] }
  | { kind: 'unknown'; detail: string }
  | { kind: 'fatal'; error: AppError }

export type WorktreeRepairJournalEntry = {
  at: number
  action: WorktreeRepairAction
  detail?: string
}

export type WorktreeHealthDeps = {
  worktrees: Pick<WorktreeStore, 'updateStateById' | 'findBranch'>
  repositories: Pick<RepositoryStore, 'findById'>
  gitWorktrees: GitWorktreeService
  now?: () => number
  platform?: NodeJS.Platform
  healthyTtlMs?: number
}

type CacheEntry = {
  probe: WorktreeProbe
  checkedAt: number
}

/**
 * Probes and repairs session checkouts.
 *
 * The common path is intentionally Git-free: a worktree's `.git` file points at
 * an admin directory inside the repository's common dir, that directory's
 * `gitdir` file must point back, and `HEAD`/`index` must exist. Three small file
 * reads answer "is this usable?" in about a millisecond. Git itself is only
 * consulted when that evidence disagrees or a repair is actually attempted.
 */
export class WorktreeHealthService {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly journals = new Map<string, WorktreeRepairJournalEntry[]>()
  private readonly inFlight = new Map<string, Promise<WorktreeEnsureResult>>()
  private readonly platform: NodeJS.Platform
  private readonly now: () => number
  private readonly healthyTtlMs: number

  constructor(private readonly deps: WorktreeHealthDeps) {
    this.platform = deps.platform ?? process.platform
    this.now = deps.now ?? Date.now
    this.healthyTtlMs = deps.healthyTtlMs ?? DEFAULT_HEALTHY_TTL_MS
  }

  /** Drops a cached verdict after an event that could invalidate it. */
  invalidate(worktreeId: string): void {
    this.cache.delete(worktreeId)
  }

  journalFor(worktreeId: string): WorktreeRepairJournalEntry[] {
    return [...(this.journals.get(worktreeId) ?? [])]
  }

  /**
   * Cheap verdict. `deep` asks Git as well when the local evidence is
   * inconclusive, or when the checkout lives on another host.
   */
  async probe(record: WorktreeRecord, options: { deep?: boolean } = {}): Promise<WorktreeProbe> {
    if (this.isFreshHealthy(record.id)) return { kind: 'healthy' }
    const repository = this.deps.repositories.findById(record.repoId)
    if (repository === null) {
      return { kind: 'unknown', detail: 'The session repository is no longer registered.' }
    }
    let result: WorktreeProbe
    if (repository.executionTarget.kind === 'local') {
      result = await this.probeLocal(record, repository)
      if (options.deep === true && result.kind === 'unknown') {
        const viaGit = await this.probeRegistered(record, repository)
        if (viaGit.kind === 'healthy') result = viaGit
      }
    } else if (options.deep === true) {
      result = await this.probeRegistered(record, repository)
    } else {
      result = {
        kind: 'unknown',
        detail: 'The remote checkout is not probed on the fast path.'
      }
    }
    this.cache.set(record.id, { probe: result, checkedAt: this.now() })
    return result
  }

  /**
   * Repairs the checkout if needed and returns the outcome. Fatal outcomes are
   * persisted as the worktree's last error, because the renderer needs to know
   * whether the user can choose to start a fresh workspace.
   */
  async ensureHealthy(
    record: WorktreeRecord,
    options: { onRepair?: () => void } = {}
  ): Promise<WorktreeEnsureResult> {
    if (this.isFreshHealthy(record.id)) return { kind: 'healthy' }
    const pending = this.inFlight.get(record.id)
    if (pending !== undefined) return pending
    const task = this.repair(record, options).finally(() => {
      this.inFlight.delete(record.id)
    })
    this.inFlight.set(record.id, task)
    return task
  }

  private async repair(
    record: WorktreeRecord,
    options: { onRepair?: () => void }
  ): Promise<WorktreeEnsureResult> {
    const repository = this.deps.repositories.findById(record.repoId)
    if (repository === null) {
      return this.fatal(
        record,
        makeAppError('DB_CORRUPT', 'The session repository is missing.', {
          context: { sessionWorktreeId: record.id }
        })
      )
    }
    const probe = await this.probe(record, {
      deep: repository.executionTarget.kind !== 'local'
    })
    if (
      probe.kind === 'reindex' ||
      probe.kind === 'absent' ||
      probe.kind === 'unregistered'
    ) {
      // Reported before any Git work starts, so the UI can show progress while
      // a large checkout is being re-created or repaired.
      options.onRepair?.()
    }
    switch (probe.kind) {
      case 'healthy':
        return this.markHealthy(record)
      case 'unknown':
        return { kind: 'unknown', detail: probe.detail }
      case 'blocked':
        return this.fatal(
          record,
          makeAppError('WORKTREE_REPAIR_FAILED', 'The workspace needs attention before it can start.', {
            detail: probe.detail
          })
        )
      case 'reindex':
        return this.repairIndex(record, repository, probe.adminDir)
      case 'absent':
        return this.recover(record, repository, [])
      case 'unregistered':
        return this.repairRegistration(record, repository, probe)
    }
  }

  // ─── Cheap probe ─────────────────────────────────────────────────────

  private async probeLocal(
    record: WorktreeRecord,
    repository: RepositoryRecord
  ): Promise<WorktreeProbe> {
    let entry: Stats
    try {
      entry = await stat(record.path)
    } catch (error) {
      return isMissingError(error)
        ? { kind: 'absent' }
        : { kind: 'unknown', detail: errorText(error) }
    }
    if (!entry.isDirectory()) {
      // A file at the managed path cannot become a checkout without removing it.
      return {
        kind: 'unregistered',
        gitFile: false,
        adminDir: null,
        adminExists: false,
        foreign: false,
        nonEmpty: true
      }
    }

    const worktreeGitPath = joinFor(record.path, '.git')
    let gitText: string
    try {
      const info = await stat(worktreeGitPath)
      if (!info.isFile() || info.size > MAX_GIT_FILE_BYTES) {
        return this.unregistered(record, { gitFile: false })
      }
      gitText = await readFile(worktreeGitPath, 'utf8')
    } catch (error) {
      if (isMissingError(error)) return this.unregistered(record, { gitFile: false })
      return { kind: 'unknown', detail: errorText(error) }
    }

    const adminRaw = parseWorktreeGitFile(gitText)
    if (adminRaw === null) return this.unregistered(record, { gitFile: false })
    const adminDir = resolveAgainst(record.path, adminRaw)

    const commonDir = repository.gitCommonDir
    if (commonDir === null || commonDir.trim().length === 0) {
      return { kind: 'unknown', detail: 'The repository common directory is not recorded.' }
    }
    const worktreesRoot = joinFor(commonDir, 'worktrees')
    const adminState = await directoryState(adminDir)
    if (adminState === null) {
      return { kind: 'unknown', detail: 'The worktree registration could not be read.' }
    }
    if (!isPathInside(worktreesRoot, adminDir)) {
      return this.unregistered(record, {
        gitFile: true,
        adminDir,
        adminExists: adminState,
        foreign: true
      })
    }
    if (!adminState) {
      return this.unregistered(record, {
        gitFile: true,
        adminDir,
        adminExists: false,
        foreign: false
      })
    }

    const backlink = await readTextFile(joinFor(adminDir, 'gitdir'))
    if (backlink.kind === 'unknown') {
      return { kind: 'unknown', detail: backlink.detail }
    }
    if (backlink.kind === 'missing') {
      return this.unregistered(record, {
        gitFile: true,
        adminDir,
        adminExists: true
      })
    }
    const backTarget = firstLine(backlink.text)
    if (
      backTarget === null ||
      !samePathResolved(worktreeGitPath, resolveAgainst(adminDir, backTarget), this.platform)
    ) {
      return this.unregistered(record, {
        gitFile: true,
        adminDir,
        adminExists: true
      })
    }

    const markers = await this.inProgressMarkers(adminDir)
    const head = await filePresence(joinFor(adminDir, 'HEAD'))
    const index = await filePresence(joinFor(adminDir, 'index'))
    if (head === null || index === null) {
      return { kind: 'unknown', detail: 'The worktree registration could not be read.' }
    }
    if ((!head || !index) && markers.length > 0) {
      return {
        kind: 'blocked',
        detail: `A Git operation is in progress (${markers.join(', ')}).`,
        adminDir
      }
    }
    if (!index) return { kind: 'reindex', adminDir }
    if (!head) {
      return this.unregistered(record, {
        gitFile: true,
        adminDir,
        adminExists: true
      })
    }
    return { kind: 'healthy' }
  }

  /** Git is the only authority for a checkout on another host. */
  private async probeRegistered(
    record: WorktreeRecord,
    repository: RepositoryRecord
  ): Promise<WorktreeProbe> {
    const fs = await this.deps.gitWorktrees.hostFsFor(repository.executionTarget)
    let exists: boolean
    try {
      exists = await fs.isDirectory(record.path)
    } catch (error) {
      return { kind: 'unknown', detail: errorText(error) }
    }
    let entries: Awaited<ReturnType<GitWorktreeService['listWorktrees']>>
    try {
      entries = await this.deps.gitWorktrees.listWorktrees(
        repository.path,
        repository.executionTarget
      )
    } catch (error) {
      return { kind: 'unknown', detail: errorText(error) }
    }
    const registered = entries.some((entry) =>
      samePathResolved(entry.path, record.path, comparisonPlatform(repository, this.platform))
    )
    if (exists && registered) return { kind: 'healthy' }
    if (!exists) return { kind: 'absent' }
    let nonEmpty = true
    try {
      nonEmpty = !(await fs.isEmptyDirectory(record.path))
    } catch {
      // A listing failure must never authorize deleting the directory.
      nonEmpty = true
    }
    return {
      kind: 'unregistered',
      gitFile: false,
      adminDir: null,
      adminExists: false,
      foreign: false,
      nonEmpty
    }
  }

  // ─── Repairs ─────────────────────────────────────────────────────────

  private async repairIndex(
    record: WorktreeRecord,
    repository: RepositoryRecord,
    adminDir: string
  ): Promise<WorktreeEnsureResult> {
    const markers = await this.inProgressMarkers(adminDir)
    if (markers.length > 0) {
      return this.fatal(
        record,
        makeAppError('WORKTREE_REPAIR_FAILED', 'The workspace index cannot be rebuilt yet.', {
          detail: `A Git operation is in progress (${markers.join(', ')}).`
        })
      )
    }
    const git = await this.deps.gitWorktrees.gitFor(repository.executionTarget)
    try {
      await this.deps.gitWorktrees.runRepositoryExclusive(
        repository.path,
        repository.executionTarget,
        async () => {
          // Mixed reset rebuilds the index from HEAD without touching files.
          await git(
            record.path,
            worktreeGitArgs(repository.executionTarget, ['reset'], this.platform),
            MUTATE_TIMEOUT_MS
          )
        }
      )
    } catch (error) {
      return this.fatal(
        record,
        makeAppError('WORKTREE_REPAIR_FAILED', 'The workspace index could not be rebuilt.', {
          detail: errorText(error)
        })
      )
    }
    return this.verifyRepaired(record, ['rebuild-index'])
  }

  private async repairRegistration(
    record: WorktreeRecord,
    repository: RepositoryRecord,
    probe: Extract<WorktreeProbe, { kind: 'unregistered' }>
  ): Promise<WorktreeEnsureResult> {
    if (probe.foreign) {
      return this.fatal(
        record,
        makeAppError('WORKTREE_UNRECOVERABLE', 'The workspace belongs to a different repository.', {
          detail: probe.adminDir ?? record.path,
          context: { path: record.path, branch: record.branch }
        })
      )
    }

    // A moved checkout or a stale backlink is what `git worktree repair` owns.
    if (probe.gitFile && probe.adminExists) {
      if (await this.tryRepairLinks(record, repository)) {
        const after = await this.probe(record, { deep: true })
        if (after.kind === 'healthy') return this.repaired(record, ['repair-links'])
        if (after.kind === 'reindex') {
          return this.repairIndex(record, repository, after.adminDir)
        }
      }
    }

    // A deleted admin entry cannot be restored by `repair`; the worktree's own
    // `.git` file still names the right directory, so the three files can be
    // rebuilt. Only for a local checkout: a guest link cannot be written here.
    if (
      probe.gitFile &&
      probe.adminDir !== null &&
      repository.executionTarget.kind === 'local'
    ) {
      const rebuilt = await this.rebuildAdmin(record, repository, probe)
      if (rebuilt !== null) return rebuilt
    }

    // An empty directory carries no work; removing it and re-adding is safe and
    // is exactly what the existing recovery path does.
    if (!probe.nonEmpty) return this.recover(record, repository, [])

    return this.fatal(
      record,
      makeAppError(
        'WORKTREE_UNRECOVERABLE',
        'The workspace directory cannot be reconnected to Git without removing files.',
        {
          detail: probe.adminDir ?? record.path,
          context: { path: record.path, branch: record.branch }
        }
      )
    )
  }

  private async rebuildAdmin(
    record: WorktreeRecord,
    repository: RepositoryRecord,
    probe: Extract<WorktreeProbe, { kind: 'unregistered' }>
  ): Promise<WorktreeEnsureResult | null> {
    const adminDir = probe.adminDir
    if (adminDir === null) return null
    if (!this.branchOwned(record)) {
      return this.fatal(
        record,
        makeAppError('BRANCH_NOT_OWNED', 'That branch is not owned by this worktree.', {
          context: { path: record.path, branch: record.branch }
        })
      )
    }
    if (await this.branchMissing(record, repository)) {
      return this.fatal(
        record,
        makeAppError('WORKTREE_MISSING', 'The workspace branch no longer exists.', {
          detail: record.branch,
          context: { path: record.path }
        })
      )
    }

    const created: string[] = []
    try {
      await mkdir(adminDir, { recursive: true })
      const worktreeGitPath = joinFor(record.path, '.git')
      await writeIfMissing(joinFor(adminDir, 'gitdir'), `${worktreeGitPath}\n`, created)
      await writeIfMissing(joinFor(adminDir, 'commondir'), '../..\n', created)
      await writeIfMissing(joinFor(adminDir, 'HEAD'), `ref: refs/heads/${record.branch}\n`, created)
      const git = await this.deps.gitWorktrees.gitFor(repository.executionTarget)
      await this.deps.gitWorktrees.runRepositoryExclusive(
        repository.path,
        repository.executionTarget,
        async () => {
          // Without an index Git reports every tracked file as deleted.
          await git(
            record.path,
            worktreeGitArgs(repository.executionTarget, ['reset'], this.platform),
            MUTATE_TIMEOUT_MS
          )
          await git(
            repository.path,
            worktreeGitArgs(
              repository.executionTarget,
              ['worktree', 'repair', record.path],
              this.platform
            ),
            MUTATE_TIMEOUT_MS
          )
        }
      )
    } catch (error) {
      await rollbackCreated(created, adminDir, probe.adminExists)
      return this.fatal(
        record,
        makeAppError('WORKTREE_REPAIR_FAILED', 'The workspace registration could not be rebuilt.', {
          detail: errorText(error)
        })
      )
    }

    const after = await this.probe(record, { deep: true })
    if (after.kind === 'healthy') {
      return this.repaired(record, ['reconstruct-admin', 'rebuild-index', 'repair-links'])
    }
    await rollbackCreated(created, adminDir, probe.adminExists)
    return this.fatal(
      record,
      makeAppError('WORKTREE_REPAIR_FAILED', 'The rebuilt workspace registration did not verify.', {
        detail: describeProbe(after)
      })
    )
  }

  private async recover(
    record: WorktreeRecord,
    repository: RepositoryRecord,
    actions: WorktreeRepairAction[]
  ): Promise<WorktreeEnsureResult> {
    // Rebuilding from a branch that iCode does not own could resurrect unrelated
    // work; the same guard the explicit recovery path uses applies here.
    if (!this.branchOwned(record)) {
      return this.fatal(
        record,
        makeAppError('BRANCH_NOT_OWNED', 'That branch is not owned by this worktree.', {
          context: { path: record.path, branch: record.branch }
        })
      )
    }
    try {
      await this.deps.gitWorktrees.recover({
        primaryRoot: repository.path,
        path: record.path,
        branch: record.branch,
        target: repository.executionTarget
      })
    } catch (error) {
      return this.fatal(record, recoveryFailure(error))
    }
    const after = await this.probe(record, { deep: true })
    if (after.kind === 'healthy') {
      return this.repaired(record, [...actions, 'readd'])
    }
    return this.fatal(
      record,
      makeAppError('WORKTREE_REPAIR_FAILED', 'The re-created workspace did not verify.', {
        detail: describeProbe(after)
      })
    )
  }

  private async tryRepairLinks(
    record: WorktreeRecord,
    repository: RepositoryRecord
  ): Promise<boolean> {
    const git = await this.deps.gitWorktrees.gitFor(repository.executionTarget)
    try {
      await this.deps.gitWorktrees.runRepositoryExclusive(
        repository.path,
        repository.executionTarget,
        async () => {
          await git(
            repository.path,
            worktreeGitArgs(
              repository.executionTarget,
              ['worktree', 'repair', record.path],
              this.platform
            ),
            MUTATE_TIMEOUT_MS
          )
        }
      )
      return true
    } catch {
      return false
    }
  }

  // ─── Outcomes and bookkeeping ────────────────────────────────────────

  private async verifyRepaired(
    record: WorktreeRecord,
    actions: WorktreeRepairAction[]
  ): Promise<WorktreeEnsureResult> {
    const after = await this.probe(record, { deep: true })
    if (after.kind === 'healthy') return this.repaired(record, actions)
    return this.fatal(
      record,
      makeAppError('WORKTREE_REPAIR_FAILED', 'The workspace could not be repaired.', {
        detail: describeProbe(after)
      })
    )
  }

  private markHealthy(record: WorktreeRecord): WorktreeEnsureResult {
    if (record.state === 'failed') this.clearFailed(record)
    this.cache.set(record.id, { probe: { kind: 'healthy' }, checkedAt: this.now() })
    return { kind: 'healthy' }
  }

  private repaired(
    record: WorktreeRecord,
    actions: WorktreeRepairAction[]
  ): WorktreeEnsureResult {
    const unique = [...new Set(actions)]
    if (record.state === 'failed') this.clearFailed(record)
    this.cache.set(record.id, { probe: { kind: 'healthy' }, checkedAt: this.now() })
    const journal = this.journals.get(record.id) ?? []
    for (const action of unique) {
      journal.push({ at: this.now(), action })
    }
    this.journals.set(record.id, journal)
    return { kind: 'repaired', actions: unique }
  }

  private fatal(record: WorktreeRecord, error: AppError): WorktreeEnsureResult {
    this.cache.delete(record.id)
    this.deps.worktrees.updateStateById(record.id, 'failed', error, this.now())
    return { kind: 'fatal', error }
  }

  private clearFailed(record: WorktreeRecord): void {
    this.deps.worktrees.updateStateById(record.id, 'created', null, this.now())
  }

  // ─── Small filesystem questions ──────────────────────────────────────

  private async unregistered(
    record: WorktreeRecord,
    input: {
      gitFile: boolean
      adminDir?: string
      adminExists?: boolean
      foreign?: boolean
    }
  ): Promise<WorktreeProbe> {
    return {
      kind: 'unregistered',
      gitFile: input.gitFile,
      adminDir: input.adminDir ?? null,
      adminExists: input.adminExists ?? false,
      foreign: input.foreign ?? false,
      nonEmpty: await this.isNonEmpty(record.path)
    }
  }

  private async isNonEmpty(path: string): Promise<boolean> {
    try {
      return (await readdir(path)).length > 0
    } catch {
      // Unreadable is not empty: an automatic re-create could destroy data.
      return true
    }
  }

  private async inProgressMarkers(adminDir: string): Promise<string[]> {
    const found: string[] = []
    for (const marker of IN_PROGRESS_MARKERS) {
      try {
        await stat(joinFor(adminDir, marker))
        found.push(marker)
      } catch (error) {
        if (!isMissingError(error)) found.push(marker)
      }
    }
    return found
  }

  private branchOwned(record: WorktreeRecord): boolean {
    const owned = this.deps.worktrees.findBranch(record.branch)
    return owned !== null && String(owned.worktreeId) === String(record.id)
  }

  private async branchMissing(
    record: WorktreeRecord,
    repository: RepositoryRecord
  ): Promise<boolean> {
    try {
      const exists = await this.deps.gitWorktrees.branchExists(
        repository.path,
        record.branch,
        repository.executionTarget
      )
      return !exists
    } catch {
      // "Could not ask" must not authorize reconstruction.
      return true
    }
  }

  private isFreshHealthy(worktreeId: string): boolean {
    const cached = this.cache.get(worktreeId)
    return (
      cached !== undefined &&
      cached.probe.kind === 'healthy' &&
      this.now() - cached.checkedAt <= this.healthyTtlMs
    )
  }
}

// ─── Path and file helpers ─────────────────────────────────────────────

function comparisonPlatform(
  repository: RepositoryRecord,
  platform: NodeJS.Platform
): NodeJS.Platform {
  return repository.executionTarget.kind === 'local' ? platform : 'linux'
}

function pathApi(value: string): typeof posix | typeof win32 {
  return isWindowsStylePath(value) ? win32 : posix
}

function joinFor(base: string, ...parts: string[]): string {
  return pathApi(base).join(base, ...parts)
}

function resolveAgainst(base: string, value: string): string {
  const api = isWindowsStylePath(base) || isWindowsStylePath(value) ? win32 : posix
  return api.resolve(base, value)
}

function parseWorktreeGitFile(text: string): string | null {
  const first = firstLine(text)
  if (first === null || !first.startsWith('gitdir:')) return null
  const value = first.slice('gitdir:'.length).trim()
  return value.length > 0 ? value : null
}

function firstLine(text: string): string | null {
  const value = text.split(/\r?\n/u)[0]?.trim() ?? ''
  return value.length > 0 ? value : null
}

function isMissingError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    ((error as { code?: unknown }).code === 'ENOENT' ||
      (error as { code?: unknown }).code === 'ENOTDIR')
  )
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `true` = directory, `false` = absent, `null` = could not ask. */
async function directoryState(path: string): Promise<boolean | null> {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    return isMissingError(error) ? false : null
  }
}

/** `true` = present, `false` = missing, `null` = could not ask. */
async function filePresence(path: string): Promise<boolean | null> {
  try {
    await stat(path)
    return true
  } catch (error) {
    return isMissingError(error) ? false : null
  }
}

type ReadTextResult =
  | { kind: 'text'; text: string }
  | { kind: 'missing' }
  | { kind: 'unknown'; detail: string }

async function readTextFile(path: string): Promise<ReadTextResult> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_GIT_FILE_BYTES) return { kind: 'missing' }
    return { kind: 'text', text: await readFile(path, 'utf8') }
  } catch (error) {
    return isMissingError(error)
      ? { kind: 'missing' }
      : { kind: 'unknown', detail: errorText(error) }
  }
}

async function writeIfMissing(
  path: string,
  content: string,
  created: string[]
): Promise<void> {
  try {
    await writeFile(path, content, { flag: 'wx' })
    created.push(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

async function rollbackCreated(
  created: string[],
  adminDir: string,
  adminExisted: boolean
): Promise<void> {
  if (!adminExisted) {
    // The directory did not exist before this attempt; everything in it was
    // created here (including Git's own index/log files).
    await rm(adminDir, { recursive: true, force: true }).catch(() => undefined)
    return
  }
  for (const path of created) {
    await rm(path, { force: true }).catch(() => undefined)
  }
  // Keep a pre-existing admin directory; only our incomplete files are removed.
  await rmdir(adminDir).catch(() => undefined)
}

function describeProbe(probe: WorktreeProbe): string {
  switch (probe.kind) {
    case 'healthy':
      return 'The checkout is healthy.'
    case 'reindex':
      return 'The checkout index is missing.'
    case 'absent':
      return 'The checkout directory is missing.'
    case 'unregistered':
      return probe.foreign
        ? 'The checkout belongs to a different repository.'
        : 'The checkout is not registered with this repository.'
    case 'blocked':
      return probe.detail
    case 'unknown':
      return probe.detail
  }
}

function recoveryFailure(error: unknown): AppError {
  if (error instanceof SessionServiceError) {
    if (error.appError.code === 'WORKTREE_MISSING') return error.appError
    if (error.appError.code === 'WORKTREE_INCONSISTENT') {
      return makeAppError(
        'WORKTREE_UNRECOVERABLE',
        'The workspace could not be rebuilt automatically.',
        {
          detail: error.appError.detail ?? error.appError.message,
          context: error.appError.context
        }
      )
    }
    return makeAppError('WORKTREE_REPAIR_FAILED', 'The workspace could not be rebuilt.', {
      detail: error.appError.detail ?? error.appError.message,
      context: error.appError.context
    })
  }
  return makeAppError('WORKTREE_REPAIR_FAILED', 'The workspace could not be rebuilt.', {
    detail: errorText(error)
  })
}
