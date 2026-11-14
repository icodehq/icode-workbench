import { posix, win32 } from 'node:path'
import type { AppError } from '../../shared/domain/errors'
import { appErrorFromUnknown, makeAppError } from '../../shared/domain/errors'
import type { ExecutionTarget } from '../../shared/domain/repository'
import type { RepoRemovalJobRecord, RepoRemovalPurgeCounts } from '../persistence/repo-removal-job-store'
import { DatabaseError } from '../persistence/database'
import { GitUnavailableError } from '../git/executor'
import { SessionServiceError } from '../sessions/session-errors'
import type { RepositoryRemovalDeps } from './repository-removal-types'
import { snapshotWorktree, WorktreeSnapshotError } from './worktree-snapshot'

const STAGE_TIMEOUT_MS = 30_000
const RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 5 * 60_000, 15 * 60_000] as const

const TRANSIENT_CODES = new Set<AppError['code']>([
  'HOST_UNREACHABLE',
  'WSL_UNAVAILABLE',
  'WSL_DISTRO_NOT_FOUND',
  'WSL_GUEST_PROBE_FAILED',
  'WSL_HOST_START_FAILED',
  'WSL_HOST_UNVERIFIABLE',
  'GIT_READ_TIMEOUT'
])

function pathApi(target: ExecutionTarget): typeof posix | typeof win32 {
  return target.kind === 'wsl' || process.platform !== 'win32' ? posix : win32
}

export function removalAttentionCount(job: RepoRemovalJobRecord): number {
  return job.manifest.worktrees.filter(
    (worktree) => worktree.attention !== null || worktree.snapshotState === 'attention'
  ).length
}

export function removalNeedsWorktreeWork(job: RepoRemovalJobRecord): boolean {
  return job.manifest.worktrees.some((worktree) => !worktree.removed)
}

export function removalAppError(error: unknown): AppError {
  if (error instanceof SessionServiceError) return error.appError
  if (error instanceof DatabaseError) return error.appError
  if (error instanceof WorktreeSnapshotError) {
    return makeAppError('GIT_READ_FAILED', error.message, {
      ...(error.detail ? { detail: error.detail } : {})
    })
  }
  if (error instanceof GitUnavailableError) {
    return makeAppError('WSL_UNAVAILABLE', error.message, {
      ...(error.detail ? { detail: error.detail } : {})
    })
  }
  if (error !== null && typeof error === 'object' && 'appError' in error) {
    return (error as { appError: AppError }).appError
  }
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    'message' in error &&
    'retryable' in error
  ) {
    return error as AppError
  }
  return appErrorFromUnknown(error, 'INTERNAL')
}

function isTransient(error: AppError): boolean {
  return TRANSIENT_CODES.has(error.code)
}

function retryDelay(attempts: number): number {
  const index = Math.min(Math.max(attempts - 1, 0), RETRY_DELAYS_MS.length - 1)
  return RETRY_DELAYS_MS[index]!
}

function mergePurgeCounts(
  current: Record<string, number>,
  next: RepoRemovalPurgeCounts
): Record<string, number> {
  const merged = { ...current }
  for (const [key, value] of Object.entries(next)) {
    merged[key] = (merged[key] ?? 0) + value
  }
  return merged
}

/**
 * Runs one durable removal job. Every stage is idempotent and persists the
 * manifest before moving on, so a crash or a host outage resumes instead of
 * starting over.
 *
 * The project is already hidden when this runs. The only gate before deleting
 * the repository row is `mergesSettled && sessionsStopped`: a live process must
 * never outlive its metadata. Worktree snapshot/removal failures are recorded
 * as per-worktree attention and retried later; they do not block the row.
 */
export class RepositoryRemovalWorker {
  private readonly active = new Set<string>()
  private disposed = false

  constructor(private readonly deps: RepositoryRemovalDeps) {}

  stop(): void {
    this.disposed = true
  }

  async run(jobId: string): Promise<void> {
    if (this.disposed || this.active.has(jobId)) return
    this.active.add(jobId)
    try {
      await this.runInner(jobId)
    } catch (error) {
      // findById/save failures escape runInner's stage handler. Leave the job
      // `running`; the next resume requeues it.
      process.stderr.write(
        `[removal] job ${jobId} stopped unexpectedly: ${
          error instanceof Error ? error.message : String(error)
        }\n`
      )
    } finally {
      this.active.delete(jobId)
    }
  }

  private now(): number {
    return this.deps.now()
  }

  private persist(job: RepoRemovalJobRecord): void {
    if (this.disposed) return
    job.updatedAt = this.now()
    this.deps.jobs.save(job)
    this.deps.onChanged()
  }

  private async runInner(jobId: string): Promise<void> {
    if (this.disposed) return
    const job = this.deps.jobs.findById(jobId)
    if (job === null || job.status === 'completed' || job.status === 'failed') return
    if (
      job.status === 'waiting_host' &&
      job.nextAttemptAt !== null &&
      job.nextAttemptAt > this.now()
    ) {
      return
    }

    job.status = 'running'
    job.nextAttemptAt = null
    this.persist(job)

    try {
      if (!job.manifest.mergesSettled) await this.abortMerges(job)
      if (!job.manifest.sessionsStopped) await this.stopSessions(job)
      // Explicit gate: no stage may delete the repo row while a merge is
      // unsettled or a session may still be live. A disposed worker returns
      // without setting a flag; leaving the job `running` lets resume retry.
      if (!job.manifest.mergesSettled || !job.manifest.sessionsStopped) return
      if (removalNeedsWorktreeWork(job)) {
        await this.snapshotWorktrees(job)
        await this.removeWorktrees(job)
        await this.pruneWorktrees(job)
      }
      if (!job.manifest.repoRowRemoved) await this.removeRepository(job)
      await this.cleanup(job)
      this.complete(job)
    } catch (error) {
      if (this.disposed) return
      const appError = removalAppError(error)
      job.lastError = appError
      job.attempts += 1
      job.updatedAt = this.now()
      if (isTransient(appError)) {
        job.status = 'waiting_host'
        job.nextAttemptAt = job.updatedAt + retryDelay(job.attempts)
      } else {
        job.status = 'failed'
        job.nextAttemptAt = null
      }
      this.deps.jobs.save(job)
      this.deps.onChanged()
    }
  }

  private async abortMerges(job: RepoRemovalJobRecord): Promise<void> {
    if (this.disposed) return
    job.stage = 'abort_merges'
    this.persist(job)
    const records = this.deps.merges.listActiveForRepo(job.repoId)
    for (const record of records) {
      if (this.disposed) return
      if (this.deps.worktrees.findBySession(record.sessionId) === null) {
        this.deps.merges.markInterrupted(record.id, this.now())
        continue
      }
      try {
        await this.deps.mergeService.abort(record.sessionId)
      } catch (error) {
        const appError = removalAppError(error)
        if (
          appError.code === 'WORKTREE_MISSING' ||
          appError.code === 'MERGE_IN_PROGRESS' ||
          appError.code === 'SESSION_NOT_FOUND'
        ) {
          this.deps.merges.markInterrupted(record.id, this.now())
          continue
        }
        throw error
      }
    }
    job.manifest.mergesSettled = true
    this.persist(job)
  }

  private async stopSessions(job: RepoRemovalJobRecord): Promise<void> {
    if (this.disposed) return
    job.stage = 'stop_sessions'
    this.persist(job)
    const sessions = this.deps.sessions.listForRepo(job.repoId)
    job.manifest.sessions = sessions.map((session) => ({
      id: session.id,
      harness: session.harness
    }))

    let firstError: unknown = null
    for (let index = 0; index < sessions.length; index += 4) {
      const batch = sessions.slice(index, index + 4)
      const results = await Promise.allSettled(
        batch.map(async (session) => {
          await this.deps.gitStatusWatcher.setActive(session.id, false).catch(() => undefined)
          await this.deps.filesWatcher.setActive(session.id, false).catch(() => undefined)
          try {
            await this.deps.sessionService.stopAndWait(session.id)
          } catch (error) {
            const appError = removalAppError(error)
            if (appError.code === 'SESSION_NOT_FOUND') return
            throw error
          }
        })
      )
      for (const result of results) {
        if (result.status === 'rejected' && firstError === null) firstError = result.reason
      }
      if (firstError !== null) break
    }
    if (firstError !== null) throw firstError
    if (this.disposed) return
    job.manifest.sessionsStopped = true
    this.persist(job)
  }

  private async snapshotWorktrees(job: RepoRemovalJobRecord): Promise<void> {
    if (this.disposed) return
    job.stage = 'snapshot_worktrees'
    this.persist(job)
    const target = job.manifest.target
    if (job.manifest.worktreeRoot === null) {
      job.manifest.worktreeRoot = await this.deps.gitWorktrees.worktreeRootFor(target)
      this.persist(job)
    }
    const worktreeRoot = job.manifest.worktreeRoot
    if (worktreeRoot === null) return
    const hostFs = await this.deps.gitWorktrees.hostFsFor(target)

    for (const worktree of job.manifest.worktrees) {
      if (this.disposed) return
      if (worktree.removed) continue
      if (worktree.snapshotState === 'saved' || worktree.snapshotState === 'clean') continue
      try {
        if (!(await hostFs.isDirectory(worktree.path))) {
          worktree.snapshotState = 'clean'
          worktree.snapshot = null
          worktree.attention = null
          this.persist(job)
          continue
        }
        this.deps.gitWorktrees.assertManagedPath(worktree.path, worktreeRoot)
        const outcome = await snapshotWorktree(
          {
            gitWorktrees: this.deps.gitWorktrees,
            hostFs,
            now: this.deps.now
          },
          {
            worktreePath: worktree.path,
            worktreeRoot,
            jobId: job.id,
            sessionId: worktree.sessionId,
            branch: worktree.branch,
            target
          }
        )
        if (outcome.state === 'saved') {
          worktree.snapshot = outcome.snapshot
          worktree.snapshotState = 'saved'
          job.manifest.snapshots = [
            ...job.manifest.snapshots.filter((entry) => entry.sessionId !== worktree.sessionId),
            outcome.snapshot
          ]
        } else {
          worktree.snapshot = null
          worktree.snapshotState = 'clean'
        }
        worktree.attention = null
      } catch (error) {
        worktree.snapshot = null
        worktree.snapshotState = 'attention'
        worktree.attention = removalAppError(error)
      }
      this.persist(job)
    }
  }

  private async removeWorktrees(job: RepoRemovalJobRecord): Promise<void> {
    if (this.disposed) return
    job.stage = 'remove_worktrees'
    this.persist(job)
    const target = job.manifest.target
    const hostFs = await this.deps.gitWorktrees.hostFsFor(target)
    for (const worktree of job.manifest.worktrees) {
      if (this.disposed) return
      if (worktree.removed) continue
      if (worktree.snapshotState === 'attention' || worktree.snapshotState === 'pending') continue
      try {
        if (!(await hostFs.isDirectory(worktree.path))) {
          worktree.removed = true
          this.persist(job)
          continue
        }
        await this.deps.gitWorktrees.remove({
          primaryRoot: job.repoPath,
          path: worktree.path,
          force: true,
          target
        })
        worktree.removed = true
      } catch (error) {
        const appError = removalAppError(error)
        if (isTransient(appError)) throw error
        worktree.attention = appError
        worktree.snapshotState = 'attention'
      }
      this.persist(job)
    }
  }

  private async pruneWorktrees(job: RepoRemovalJobRecord): Promise<void> {
    if (this.disposed || job.manifest.worktrees.length === 0) return
    job.stage = 'prune_worktrees'
    this.persist(job)
    try {
      await this.deps.gitWorktrees.runRepositoryExclusive(
        job.repoPath,
        job.manifest.target,
        async () => {
          const git = await this.deps.gitWorktrees.gitResultFor(job.manifest.target)
          const result = await git(job.repoPath, ['worktree', 'prune'], STAGE_TIMEOUT_MS)
          if (result.spawnFailure !== undefined) {
            throw new GitUnavailableError('Git could not run while pruning worktrees.')
          }
          if (result.timedOut) {
            throw new SessionServiceError(
              makeAppError('GIT_READ_TIMEOUT', 'Git timed out while pruning worktrees.')
            )
          }
          // An exit failure is not fatal: metadata cleanup is best-effort.
        }
      )
    } catch (error) {
      if (error instanceof GitUnavailableError) throw error
      const appError = removalAppError(error)
      if (isTransient(appError)) throw error
      // A missing primary root or a Git lock is not worth failing removal for.
    }
  }

  private async removeRepository(job: RepoRemovalJobRecord): Promise<void> {
    if (this.disposed) return
    job.stage = 'remove_repository'
    this.persist(job)
    // Catch rows created while the earlier stages ran (for example a task that
    // was already in flight when the tombstone landed).
    const purged = this.deps.jobs.purgeOwnedRows(job.repoId)
    job.manifest.purged = mergePurgeCounts(job.manifest.purged, purged)
    this.persist(job)
    const outcome = this.deps.repositoryService.removeRepository(job.repoId, {
      acknowledgeDependentSessions: true
    })
    if (outcome.status !== 'deleted' && outcome.status !== 'not_found') {
      throw makeAppError('INTERNAL', 'Repository removal did not complete.')
    }
    job.manifest.repoRowRemoved = true
    this.persist(job)
  }

  private async cleanup(job: RepoRemovalJobRecord): Promise<void> {
    if (this.disposed) return
    job.stage = 'cleanup'
    this.persist(job)
    const target = job.manifest.target
    const api = pathApi(target)
    const hostFs = await this.deps.gitWorktrees.hostFsFor(target)
    const worktreeRoot = job.manifest.worktreeRoot

    if (worktreeRoot !== null) {
      const removalRoot = api.join(worktreeRoot, '.icode-removal')
      const tempRoot = api.join(removalRoot, job.id)
      try {
        await hostFs.removeTree(tempRoot)
        if (
          (await hostFs.isDirectory(removalRoot)) &&
          (await hostFs.isEmptyDirectory(removalRoot))
        ) {
          await hostFs.removeDirectory(removalRoot)
        }
      } catch (error) {
        const appError = removalAppError(error)
        if (isTransient(appError)) throw error
        // A leftover temp index is not worth failing the whole job.
      }
    }

    // `git worktree remove` does not delete the sibling file-trash directory.
    // Only touch paths inside the managed root: a corrupt/foreign row must not
    // turn removal into a delete of arbitrary user data.
    const trashEntries: Array<{
      sessionId: string
      worktreePath: string
      target: typeof target
    }> = []
    if (worktreeRoot !== null) {
      for (const worktree of job.manifest.worktrees) {
        try {
          this.deps.gitWorktrees.assertManagedPath(worktree.path, worktreeRoot)
          // Each attached session keeps its own trash subdirectory beside the
          // shared checkout; clean every one, not just the representative.
          for (const sessionId of worktree.sessionIds ?? [worktree.sessionId]) {
            trashEntries.push({ sessionId, worktreePath: worktree.path, target })
          }
        } catch {
          // Never touch a path outside the managed worktree root.
        }
      }
    }
    try {
      await this.deps.workspaceFiles.discardTrashForSessions(trashEntries)
    } catch (error) {
      // A host outage keeps the job waiting; a real file failure becomes a
      // retryable failed job. Both are handled by the outer catch.
      throw error
    }
    const sessionIds = job.manifest.sessions.map((session) => session.id)
    this.deps.workspaceFiles.disposeSessions(sessionIds)
    this.deps.sessionService.forgetSessions?.(sessionIds)

    if (worktreeRoot !== null) {
      const repoWorktreeDir = api.join(worktreeRoot, job.repoId)
      try {
        if (
          (await hostFs.isDirectory(repoWorktreeDir)) &&
          (await hostFs.isEmptyDirectory(repoWorktreeDir))
        ) {
          await hostFs.removeDirectory(repoWorktreeDir)
        }
      } catch {
        // Best-effort empty-directory cleanup.
      }
    }
  }

  private complete(job: RepoRemovalJobRecord): void {
    if (this.disposed) return
    const attention = removalAttentionCount(job)
    const now = this.now()
    job.status = 'completed'
    job.stage = 'done'
    job.completedAt = now
    job.nextAttemptAt = null
    job.lastError = null
    job.updatedAt = now
    if (job.manifest.snapshots.length === 0 && attention === 0) {
      this.deps.jobs.delete(job.id)
    } else {
      this.deps.jobs.save(job)
    }
    this.deps.onChanged()
  }
}
