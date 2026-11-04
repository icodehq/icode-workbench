import type { AppError } from '../../shared/domain/errors'
import { makeAppError } from '../../shared/domain/errors'
import type { RepoId } from '../../shared/domain/ids'
import type {
  RepositoryPreparation,
  RepositoryRecord
} from '../../shared/domain/repository'
import type { RepositoryStore } from '../persistence/repository-store'
import type { FirstCommitResult } from './first-commit'
import { RepositoryPreparationError } from './first-commit'

export type RepositoryPreparationDeps = {
  repositories: Pick<RepositoryStore, 'list' | 'updatePreparation' | 'updateBranch'>
  prepare: (
    repository: RepositoryRecord,
    isCancelled: () => boolean
  ) => Promise<FirstCommitResult>
  now: () => number
  /** Called after every persisted state transition, so a window can re-read. */
  onChange: () => void
}

/**
 * Owns the background half of Add project.
 *
 * The service is deliberately separate from the Add-project request: it starts
 * after registration and can outlive the dialog, the renderer, or even a window
 * reload. State lives in the repository row, so a restart can resume it instead
 * of leaving a project stuck in "preparing" forever.
 */
export class RepositoryPreparationService {
  private readonly active = new Map<RepoId, Promise<void>>()
  private readonly cancelled = new Set<RepoId>()

  constructor(private readonly deps: RepositoryPreparationDeps) {}

  /**
   * Starts preparation for an existing repository row and returns immediately.
   * A running job is joined, not duplicated.
   */
  start(repository: RepositoryRecord): RepositoryPreparation {
    const existing = this.active.get(repository.id)
    if (existing !== undefined) {
      return repository.preparation ?? this.preparingState(Date.now())
    }

    this.cancelled.delete(repository.id)
    const preparation: RepositoryPreparation = {
      state: 'preparing',
      startedAt: this.deps.now(),
      finishedAt: null,
      committedFiles: null,
      skippedFolders: [],
      error: null
    }
    this.persist(repository.id, preparation)
    this.emit()
    let job: Promise<void>
    job = this.run(repository, preparation).finally(() => {
      if (this.active.get(repository.id) === job) this.active.delete(repository.id)
    })
    this.active.set(repository.id, job)
    return preparation
  }

  /**
   * Resumes work that was interrupted by a previous application exit. A row
   * that is already ready or failed is left alone.
   */
  resume(): void {
    for (const repository of this.deps.repositories.list()) {
      if (repository.preparation?.state === 'preparing') this.start(repository)
    }
  }

  /**
   * Cancels a queued commit before it reaches the commit step. The active
   * `git add` cannot be interrupted safely, so removal does not wait for it;
   * the job simply stops before changing the repository history.
   */
  cancel(repoId: RepoId): void {
    this.cancelled.add(repoId)
  }

  /** Test and shutdown seam: wait for every active job to settle. */
  async waitForIdle(): Promise<void> {
    await Promise.all([...this.active.values()])
  }

  private preparingState(at: number): RepositoryPreparation {
    return {
      state: 'preparing',
      startedAt: at,
      finishedAt: null,
      committedFiles: null,
      skippedFolders: [],
      error: null
    }
  }

  private async run(
    repository: RepositoryRecord,
    started: RepositoryPreparation
  ): Promise<void> {
    try {
      const result = await this.deps.prepare(repository, () =>
        this.cancelled.has(repository.id)
      )
      if (this.cancelled.has(repository.id)) return
      const ready: RepositoryPreparation = {
        state: 'ready',
        startedAt: started.startedAt,
        finishedAt: this.deps.now(),
        committedFiles: result.committedFiles,
        skippedFolders: result.skippedFolders,
        error: null
      }
      this.persist(repository.id, ready)
      if (result.branch !== null) this.deps.repositories.updateBranch(repository.id, result.branch)
      this.emit()
    } catch (error) {
      if (this.cancelled.has(repository.id)) return
      const failed: RepositoryPreparation = {
        state: 'failed',
        startedAt: started.startedAt,
        finishedAt: this.deps.now(),
        committedFiles: null,
        skippedFolders: [],
        error: toAppError(error)
      }
      this.persist(repository.id, failed)
      this.emit()
    }
  }

  /**
   * Persistence may already be closed during application shutdown. A missing
   * row is also normal after the user removes a project; neither should turn
   * into an unhandled rejection inside a background job.
   */
  private persist(id: RepoId, preparation: RepositoryPreparation): void {
    try {
      this.deps.repositories.updatePreparation(id, preparation)
    } catch {
      // The job's outcome is best-effort once persistence is gone.
    }
  }

  private emit(): void {
    try {
      this.deps.onChange()
    } catch {
      // A closed window must not stop preparation.
    }
  }
}

function toAppError(error: unknown): AppError {
  if (error instanceof RepositoryPreparationError) return error.appError
  if (error !== null && typeof error === 'object' && 'appError' in error) {
    const appError = (error as { appError?: unknown }).appError
    if (
      appError !== null &&
      typeof appError === 'object' &&
      'code' in appError &&
      'message' in appError &&
      'retryable' in appError
    ) {
      return appError as AppError
    }
  }
  return makeAppError('INTERNAL', 'The first commit could not be prepared.', {
    detail: error instanceof Error ? error.message : String(error)
  })
}
