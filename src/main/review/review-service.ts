import type { RepositoryStore } from '../persistence/repository-store'
import type { WorktreeStore } from '../persistence/worktree-store'
import type { GitWorktreeService } from '../worktrees/git-worktree-service'
import { describeWorktree } from '../worktrees/worktree-status'
import type { SessionService } from '../sessions/session-service'
import { SessionServiceError } from '../sessions/session-errors'
import { ReviewReadError, GitReviewReader } from './git-review-reader'
import { makeAppError } from '../../shared/domain/errors'
import type { ExecutionTarget } from '../../shared/domain/repository'
import type {
  ReviewAvailability,
  ReviewDiff,
  ReviewList,
  ReviewUnavailableReason
} from '../../shared/domain/review'
import type { ReviewAreaDiffInput } from '../../shared/schemas/review'

export type ReviewServiceDeps = {
  sessions: SessionService
  repositories: RepositoryStore
  worktrees: WorktreeStore
  gitWorktrees: GitWorktreeService
  reader?: GitReviewReader
}

type Unavailable = Extract<ReviewAvailability, { status: 'unavailable' }>

export type ReviewListOutcome = ({ status: 'available' } & ReviewList) | Unavailable
export type ReviewDiffOutcome = ({ status: 'available' } & ReviewDiff) | Unavailable


type Target =
  | {
      status: 'available'
      worktreePath: string
      baseOid: string
      sessionId: string
      /**
       * The repository's routing authority. Review reads must run where the
       * checkout lives, so the reader is selected from this, never from the path.
       */
      executionTarget: ExecutionTarget
    }
  | { status: 'unavailable'; reason: ReviewUnavailableReason; detail: string }

/**
 * Read-only review of one session's changes.
 *
 * This never asks the Host anything: a stopped or exited session still has
 * changes worth reviewing. Destructive session/worktree rules from Work 12 are
 * untouched, and a missing worktree is reported instead of falling back.
 */
export class ReviewService {
  private readonly reader: GitReviewReader

  constructor(private readonly deps: ReviewServiceDeps) {
    this.reader = deps.reader ?? new GitReviewReader()
  }

  async list(sessionId: string): Promise<ReviewListOutcome> {
    const target = await this.resolveTarget(sessionId)
    if (target.status === 'unavailable') return target
    const reader = this.readerFor(target.executionTarget)
    const list = await this.read(() =>
      reader.list({
        worktreePath: target.worktreePath,
        baseOid: target.baseOid,
        sessionId: target.sessionId
      })
    )
    const outcome: ReviewListOutcome = { status: 'available', ...list }
    return outcome
  }

  async diffArea(input: ReviewAreaDiffInput): Promise<ReviewDiffOutcome> {
    const target = await this.resolveTarget(input.sessionId)
    if (target.status === 'unavailable') return target
    const reader = this.readerFor(target.executionTarget)
    const diff = await this.read(() =>
      reader.diffArea({
        worktreePath: target.worktreePath,
        sessionId: target.sessionId,
        path: input.path,
        oldPath: input.oldPath ?? null,
        scope: input.scope,
        status: input.status,
        binary: input.binary,
        symlink: input.symlink,
        additions: input.additions,
        deletions: input.deletions
      })
    )
    const outcome: ReviewDiffOutcome = { status: 'available', ...diff }
    return outcome
  }

  private async resolveTarget(sessionId: string): Promise<Target> {
    let summary
    try {
      summary = await this.deps.sessions.get(sessionId)
    } catch (error) {
      if (error instanceof SessionServiceError) throw error
      throw new SessionServiceError(
        makeAppError('INTERNAL', 'The session could not be read.', {
          detail: error instanceof Error ? error.message : String(error)
        })
      )
    }

    const record = this.deps.worktrees.findBySession(sessionId)
    if (!record) {
      // Legacy sessions predate isolation, so the primary checkout contains work
      // that is not attributable to this session. Never invent a baseline.
      return {
        status: 'unavailable',
        reason: 'primary-checkout',
        detail: 'This session runs in the primary checkout, so it has no session baseline.'
      }
    }

    const repository = this.deps.repositories.findById(record.repoId)
    if (!repository) {
      return {
        status: 'unavailable',
        reason: 'worktree-inconsistent',
        detail: 'The session repository is no longer registered.'
      }
    }

    // Existence is a question about where the checkout lives. The host's
    // `statSync` answers it for a local worktree, but a WSL worktree path is a
    // guest path that never exists on Windows: asking locally would report every
    // healthy guest checkout as missing. For a distro the question is therefore
    // deferred to the target-aware inspection below, which asks the distro.
    const executionTarget = repository.executionTarget
    const isLocal = executionTarget.kind === 'local'

    const described = isLocal
      ? describeWorktree(record, summary.state, null)
      : describeWorktree(record, summary.state, null, true)
    if (described.status === 'missing') {
      return {
        status: 'unavailable',
        reason: 'worktree-missing',
        detail: 'The session worktree directory is missing. Re-create it from its branch first.'
      }
    }
    if (described.status === 'inconsistent' || described.status === 'incomplete') {
      return {
        status: 'unavailable',
        reason: 'worktree-inconsistent',
        detail: 'The session worktree does not match its records, so nothing is shown.'
      }
    }
    if (described.status === 'failed') {
      return {
        status: 'unavailable',
        reason: 'worktree-failed',
        detail: record.error?.message ?? 'Session worktree creation failed.'
      }
    }

    let inspection
    try {
      inspection = await this.deps.gitWorktrees.inspect({
        primaryRoot: repository.path,
        path: record.path,
        branch: record.branch,
        target: executionTarget
      })
    } catch {
      // A check that could not run is not a missing worktree. Permissions, an
      // unreachable distro and a broken repository all arrive here, and calling
      // any of them "missing" would invite the user to recreate a healthy tree.
      return {
        status: 'unavailable',
        reason: 'worktree-inconsistent',
        detail: isLocal
          ? 'The session worktree could not be inspected.'
          : 'The session worktree could not be inspected inside its distro.'
      }
    }
    if (!inspection.pathExists) {
      return {
        status: 'unavailable',
        reason: 'worktree-missing',
        detail: isLocal
          ? 'The session worktree directory is missing. Re-create it from its branch first.'
          : 'The session worktree directory is missing inside its distro. Re-create it from its branch first.'
      }
    }
    if (!inspection.registered) {
      return {
        status: 'unavailable',
        reason: 'worktree-inconsistent',
        detail: 'Git does not recognise this directory as the session worktree.'
      }
    }

    try {
      await this.reader
        .forTarget(repository.executionTarget)
        .assertBaseline(record.path, record.baseOid)
    } catch (error) {
      if (error instanceof ReviewReadError && error.appError.code === 'GIT_READ_FAILED') {
        return {
          status: 'unavailable',
          reason: 'invalid-baseline',
          detail: 'The commit this session started from is no longer available.'
        }
      }
      throw error
    }

    return {
      status: 'available',
      worktreePath: record.path,
      baseOid: record.baseOid,
      sessionId: record.sessionId,
      executionTarget: repository.executionTarget
    }
  }

  /**
   * Error mapping for a read, selected by target.
   *
   * The target parameter is not decoration: a WSL read must be produced by the
   * guest reader, and the reader refuses rather than silently falling back when
   * no guest reader is wired (see `GitReviewReader.forTarget`).
   */
  private async read<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      if (error instanceof ReviewReadError) throw new SessionServiceError(error.appError)
      throw error
    }
  }

  /**
   * The reader for one repository's host.
   *
   * Selection is by execution target, so a WSL checkout is always read by the
   * distro's Git. A WSL target with no guest reader wired gets a reader that
   * refuses — never the local one.
   */
  private readerFor(target: ExecutionTarget): GitReviewReader {
    return this.reader.forTarget(target)
  }
}
