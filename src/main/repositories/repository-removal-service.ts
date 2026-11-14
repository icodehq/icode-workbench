import { randomUUID } from 'node:crypto'
import type { AppError } from '../../shared/domain/errors'
import { makeAppError } from '../../shared/domain/errors'
import { parseRepoId } from '../../shared/domain/ids'
import type {
  DiscardRepoRemovalSnapshotsResult,
  RemovalManifest,
  RepoRemovalJobSummary,
  RetryRepoRemovalJobResult
} from '../../shared/schemas/repo-removal'
import { SessionServiceError } from '../sessions/session-errors'
import type { RepoRemovalJobRecord } from '../persistence/repo-removal-job-store'
import type { RepositoryRemovalDeps } from './repository-removal-types'
import {
  removalAppError,
  removalAttentionCount,
  removalNeedsWorktreeWork,
  RepositoryRemovalWorker
} from './repository-removal-worker'

export type RepositoryRemovalStartResult = {
  status: 'removing'
  jobId: string
}

/** Keeps the dispatcher's `{ appError }` wrapper convention. */
export class RepositoryRemovalServiceError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.message)
    this.name = 'RepositoryRemovalServiceError'
  }
}

function failure(code: AppError['code'], message: string, detail?: string): RepositoryRemovalServiceError {
  return new RepositoryRemovalServiceError(
    makeAppError(code, message, {
      ...(detail ? { detail } : {}),
      ...(code === 'REPOSITORY_REMOVING'
        ? { messageKey: 'errors.REPOSITORY_REMOVING' as const }
        : {})
    })
  )
}

export class RepositoryRemovalService {
  private readonly worker: RepositoryRemovalWorker
  private timer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  private resumed = false

  constructor(private readonly deps: RepositoryRemovalDeps) {
    this.worker = new RepositoryRemovalWorker(deps)
  }

  /**
   * Starts removal and returns immediately.
   *
   * The DB transaction tombstones the repo, captures the manifest, purges
   * repo-owned rows, and clears active UI state. Nothing here touches a host, a
   * checkout, or a Git process; those are the worker's job.
   */
  async start(repoIdInput: string): Promise<RepositoryRemovalStartResult> {
    const repoId = parseRepoId(repoIdInput)
    if (repoId === null) throw failure('INVALID_ARGUMENT', 'Invalid repository ID.')
    const repository = this.deps.repositories.findById(repoId)
    if (!repository) throw failure('INVALID_ARGUMENT', 'Repository is not registered.')

    if (repository.removingAt !== undefined && repository.removingAt !== null) {
      const existing = this.deps.jobs.findByRepo(repository.id)
      if (existing === null) {
        throw failure(
          'DB_CORRUPT',
          'The repository is marked for removal but its cleanup job is missing.'
        )
      }
      void this.worker.run(existing.id)
      return { status: 'removing', jobId: existing.id }
    }

    const now = this.deps.now()
    const jobId = randomUUID()
    const startedAt = Date.now()
    const result = this.deps.database.transaction(() => {
      if (!this.deps.repositories.markRemoving(repository.id, now)) {
        const existing = this.deps.jobs.findByRepo(repository.id)
        if (existing === null) {
          throw failure(
            'DB_CORRUPT',
            'The repository is marked for removal but its cleanup job is missing.'
          )
        }
        return existing.id
      }

      // Read after the tombstone inside the same write transaction: a session
      // or worktree created just before the tombstone is included; one created
      // after it is rejected by the create guards.
      const sessions = this.deps.sessions.listForRepo(repository.id)
      const worktrees = this.deps.worktrees.listByRepo(repository.id)
      const purged = this.deps.jobs.purgeOwnedRows(repository.id)
      const manifest: RemovalManifest = {
        v: 1,
        repoId: repository.id,
        repoName: repository.displayName,
        repoPath: repository.path,
        target: repository.executionTarget,
        worktreeRoot: null,
        sessions: sessions.map((session) => ({
          id: String(session.id),
          harness: session.harness
        })),
        mergesSettled: false,
        sessionsStopped: false,
        worktrees: worktrees.flatMap((worktree) => {
          const sessionIds = this.deps.worktrees
            .sessionIdsForWorktree(worktree.id)
            .map((sessionId) => String(sessionId))
          const representative = sessionIds[0]
          // A worktree with no attached session is not a state iCode creates;
          // without a session id the manifest cannot name its snapshot.
          if (representative === undefined) return []
          return [
            {
              sessionId: representative,
              sessionIds,
              path: worktree.path,
              branch: worktree.branch,
              snapshot: null,
              snapshotState: 'pending' as const,
              attention: null,
              removed: false
            }
          ]
        }),
        snapshots: [],
        repoRowRemoved: false,
        purged
      }
      this.deps.jobs.insert({
        id: jobId,
        repoId: repository.id,
        repoName: repository.displayName,
        repoPath: repository.path,
        target: repository.executionTarget,
        status: 'queued',
        stage: 'abort_merges',
        manifest,
        now
      })

      if (this.deps.uiState.getActiveRepository() === repository.id) {
        this.deps.uiState.setActiveRepository(null)
      }
      const activeSession = this.deps.uiState.getActiveSession()
      if (
        activeSession !== null &&
        sessions.some((session) => session.id === activeSession)
      ) {
        this.deps.uiState.setActiveSession(null)
      }
      return jobId
    })

    const elapsed = Date.now() - startedAt
    if (elapsed >= 50) {
      process.stderr.write(
        `[removal] sync path took ${String(elapsed)}ms for ${repository.id}\n`
      )
    }

    this.deps.preparations.cancel(repository.id)
    this.deps.onTasksPurged()
    this.deps.onRepoChanged()
    this.deps.onChanged()
    void this.worker.run(result)
    return { status: 'removing', jobId: result }
  }

  listJobs(): RepoRemovalJobSummary[] {
    return this.deps.jobs
      .listAll()
      .filter(
        (job) =>
          job.status !== 'completed' ||
          job.manifest.snapshots.length > 0 ||
          removalAttentionCount(job) > 0
      )
      .map((job) => this.toSummary(job))
  }

  retry(jobId: string): RetryRepoRemovalJobResult {
    const job = this.deps.jobs.findById(jobId)
    if (job === null) throw failure('INVALID_ARGUMENT', 'That cleanup job no longer exists.')
    const retryable =
      job.status === 'waiting_host' ||
      job.status === 'failed' ||
      (job.status === 'completed' && removalAttentionCount(job) > 0)
    if (!retryable) throw failure('INVALID_ARGUMENT', 'That cleanup job is not retryable.')
    job.status = 'queued'
    job.stage = this.nextStage(job)
    job.attempts = 0
    job.nextAttemptAt = null
    job.lastError = null
    job.completedAt = null
    job.updatedAt = this.deps.now()
    this.deps.jobs.save(job)
    this.deps.onChanged()
    void this.worker.run(job.id)
    return { status: 'retrying' }
  }

  async discardSnapshots(jobId: string): Promise<DiscardRepoRemovalSnapshotsResult> {
    const job = this.deps.jobs.findById(jobId)
    if (job === null) throw failure('INVALID_ARGUMENT', 'That cleanup job no longer exists.')
    if (job.status === 'queued' || job.status === 'running' || job.status === 'waiting_host') {
      throw failure('INVALID_ARGUMENT', 'The cleanup job is still running.')
    }
    const snapshots = job.manifest.snapshots
    if (snapshots.length === 0) return { discarded: 0 }

    let discarded = 0
    try {
      const hostFs = await this.deps.gitWorktrees.hostFsFor(job.manifest.target)
      if (await hostFs.exists(job.repoPath)) {
        const git = await this.deps.gitWorktrees.gitResultFor(job.manifest.target)
        for (const snapshot of snapshots) {
          const result = await git(job.repoPath, ['update-ref', '-d', snapshot.ref], 30_000)
          if (
            result.timedOut ||
            result.spawnFailure !== undefined ||
            result.exitCode !== 0
          ) {
            throw new SessionServiceError(
              makeAppError('GIT_READ_FAILED', 'Git could not delete a recovery snapshot.', {
                detail: result.stderr.toString('utf8').trim().slice(0, 1000)
              })
            )
          }
          discarded += 1
        }
      } else {
        // The primary repository is gone; its refs went with it.
        discarded = snapshots.length
      }
    } catch (error) {
      throw new RepositoryRemovalServiceError(removalAppError(error))
    }

    job.manifest.snapshots = []
    for (const worktree of job.manifest.worktrees) {
      worktree.snapshot = null
      if (worktree.snapshotState === 'saved') worktree.snapshotState = 'clean'
    }
    job.updatedAt = this.deps.now()
    if (job.status === 'completed' && removalAttentionCount(job) === 0) {
      this.deps.jobs.delete(job.id)
    } else {
      this.deps.jobs.save(job)
    }
    this.deps.onChanged()
    return { discarded }
  }

  /**
   * Boot recovery: requeue interrupted work, retry due host waits, and clear a
   * tombstone that lost its job (which can only come from manual DB editing).
   */
  resume(): void {
    if (this.disposed || this.resumed) return
    this.resumed = true
    try {
      for (const repository of this.deps.repositories.listRemoving()) {
        if (this.deps.jobs.findByRepo(repository.id) === null) {
          this.deps.repositories.clearRemoving(repository.id)
          process.stderr.write(
            `[removal] cleared a tombstone without a job: ${repository.id}\n`
          )
        }
      }
    } catch (error) {
      process.stderr.write(
        `[removal] tombstone self-heal failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`
      )
    }

    try {
      const now = this.deps.now()
      for (const job of this.deps.jobs.listAll()) {
        if (job.status === 'running') {
          job.status = 'queued'
          job.updatedAt = now
          this.deps.jobs.save(job)
          void this.worker.run(job.id)
        } else if (job.status === 'queued') {
          void this.worker.run(job.id)
        } else if (
          job.status === 'waiting_host' &&
          (job.nextAttemptAt === null || job.nextAttemptAt <= now)
        ) {
          void this.worker.run(job.id)
        }
      }
    } catch (error) {
      process.stderr.write(
        `[removal] resume failed: ${error instanceof Error ? error.message : String(error)}\n`
      )
    }

    this.timer = setInterval(() => this.kickDue(), 60_000)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  stop(): void {
    this.disposed = true
    this.worker.stop()
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private kickDue(): void {
    if (this.disposed) return
    try {
      for (const job of this.deps.jobs.listDue(this.deps.now())) {
        void this.worker.run(job.id)
      }
    } catch (error) {
      process.stderr.write(
        `[removal] due-job scan failed: ${error instanceof Error ? error.message : String(error)}\n`
      )
    }
  }

  private nextStage(job: RepoRemovalJobRecord): RepoRemovalJobRecord['stage'] {
    if (!job.manifest.mergesSettled) return 'abort_merges'
    if (!job.manifest.sessionsStopped) return 'stop_sessions'
    if (removalNeedsWorktreeWork(job)) return 'snapshot_worktrees'
    if (!job.manifest.repoRowRemoved) return 'remove_repository'
    return 'cleanup'
  }

  private toSummary(job: RepoRemovalJobRecord): RepoRemovalJobSummary {
    const attentionCount = removalAttentionCount(job)
    return {
      id: job.id,
      repoId: job.repoId,
      repoName: job.repoName,
      repoPath: job.repoPath,
      status: job.status,
      stage: job.stage,
      worktreeCount: job.manifest.worktrees.length,
      snapshotCount: job.manifest.snapshots.length,
      attentionCount,
      attempts: job.attempts,
      error: job.lastError,
      canRetry:
        job.status === 'waiting_host' ||
        job.status === 'failed' ||
        (job.status === 'completed' && attentionCount > 0),
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    }
  }
}
