import type { RepositoryStore } from '../persistence/repository-store'
import type { WorktreeStore } from '../persistence/worktree-store'
import type { GitWorktreeService } from '../worktrees/git-worktree-service'
import { describeWorktree } from '../worktrees/worktree-status'
import type { SessionService } from '../sessions/session-service'
import { SessionServiceError } from '../sessions/session-errors'
import { ReviewReadError, GitReviewReader } from './git-review-reader'
import { makeAppError } from '../../shared/domain/errors'
import type {
  ReviewAvailability,
  ReviewDiff,
  ReviewList,
  ReviewUnavailableReason
} from '../../shared/domain/review'

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
  | { status: 'available'; worktreePath: string; baseOid: string; sessionId: string }
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
    const list = await this.read(() =>
      this.reader.list({
        worktreePath: target.worktreePath,
        baseOid: target.baseOid,
        sessionId: target.sessionId
      })
    )
    const outcome: ReviewListOutcome = { status: 'available', ...list }
    return outcome
  }

  async diff(
    sessionId: string,
    path: string,
    oldPath: string | null = null
  ): Promise<ReviewDiffOutcome> {
    const target = await this.resolveTarget(sessionId)
    if (target.status === 'unavailable') return target

    // The renderer may only select from the validated listing, so re-read it and
    // refuse a path Git does not actually report as changed.
    const list = await this.read(() =>
      this.reader.list({
        worktreePath: target.worktreePath,
        baseOid: target.baseOid,
        sessionId: target.sessionId
      })
    )
    const file = list.files.find(
      (entry) => entry.path === path && (oldPath === null || entry.oldPath === oldPath)
    )
    if (!file) {
      throw new SessionServiceError(
        makeAppError('INVALID_ARGUMENT', 'That file is not part of this session review.', {
          context: { path }
        })
      )
    }

    const diff = await this.read(() =>
      this.reader.diff({
        worktreePath: target.worktreePath,
        baseOid: target.baseOid,
        sessionId: target.sessionId,
        path: file.path,
        oldPath: file.oldPath,
        status: file.status,
        origin: file.origin,
        binary: file.binary,
        symlink: file.symlink,
        additions: file.additions,
        deletions: file.deletions
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

    const described = describeWorktree(record, summary.state, null)
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

    const repository = this.deps.repositories.findById(record.repoId)
    if (!repository) {
      return {
        status: 'unavailable',
        reason: 'worktree-inconsistent',
        detail: 'The session repository is no longer registered.'
      }
    }

    const inspection = await this.deps.gitWorktrees
      .inspect({ primaryRoot: repository.path, path: record.path, branch: record.branch })
      .catch(() => null)
    if (!inspection || !inspection.pathExists) {
      return {
        status: 'unavailable',
        reason: 'worktree-missing',
        detail: 'The session worktree directory is missing. Re-create it from its branch first.'
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
      await this.reader.assertBaseline(record.path, record.baseOid)
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
      sessionId: record.sessionId
    }
  }

  private async read<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      if (error instanceof ReviewReadError) throw new SessionServiceError(error.appError)
      throw error
    }
  }
}
