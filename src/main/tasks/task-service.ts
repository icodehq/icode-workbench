import type { SessionService } from '../sessions/session-service'
import type { RepositoryStore } from '../persistence/repository-store'
import type { AppError } from '../../shared/domain/errors'
import { makeAppError } from '../../shared/domain/errors'
import type { HarnessId } from '../../shared/domain/harness'
import type { RepoId } from '../../shared/domain/ids'
import { repositoryPreparationBlocksSessions } from '../../shared/domain/repository'
import {
  isTerminalTaskStatus,
  TASK_LIMITS,
  type TaskRecord,
  type TaskStatus,
  type TaskView
} from '../../shared/domain/task'
import type { TaskStore } from './task-store'
import type { ReviewDecision } from '../../shared/domain/task'

export type TaskServiceError = { kind: 'app'; error: AppError }

function fail(code: AppError['code'], message: string, detail?: string): TaskServiceError {
  return { kind: 'app', error: makeAppError(code, message, detail ? { detail } : {}) }
}

export type TaskOutcome<T> = { ok: true; value: T } | { ok: false; error: AppError }

/**
 * A task's changes, as reported by the session change listing.
 *
 * `unavailable` is a first-class answer: a task whose worktree is gone must say
 * so rather than falling back to whatever checkout happens to be open.
 */
export type TaskChangesOutcome = {
  status: 'available' | 'unavailable'
  files?: Array<{
    path: string
    oldPath: string | null
    status: string
    origin: 'tracked' | 'untracked'
    additions: number | null
    deletions: number | null
    binary: boolean
    symlink: boolean | null
  }>
  baselineOid?: string
  listTruncated?: boolean
  reason?: string
  detail?: string
}

function ok<T>(value: T): TaskOutcome<T> {
  return { ok: true, value }
}

export type CreateTaskInput = {
  repoId: RepoId
  title?: string
  prompt: string
  harness: HarnessId
  /** Provenance, set by the scheduler. Not accepted from the UI. */
  scheduleId?: string | null
  occurrenceAt?: number | null
  dedupeKey?: string | null
  attempt?: number
  previousTaskId?: string | null
}

export type TaskServiceDeps = {
  tasks: TaskStore
  repositories: RepositoryStore
  sessions: SessionService
  now: () => number
  newId: () => string
  /**
   * Host-confirmed liveness for a session, from the runtime's last
   * reconciliation. A persisted record cannot answer this.
   */
  isSessionLive: (sessionId: string) => boolean
  /**
   * The session-scoped change listing.
   *
   * Injected rather than reimplemented: the comparison baseline, untracked
   * handling, WSL path semantics and truncation rules all live in the Git
   * engine, and a second implementation here is how two views of the same diff
   * start disagreeing.
   */
  listChanges: (sessionId: string) => Promise<TaskChangesOutcome>
  /** Called after a mutation that should make the dispatcher look at the queue. */
  onQueueChanged: () => void
}

/**
 * Task lifecycle decisions.
 *
 * This service owns *what a task is*; the dispatcher owns *when it starts*. The
 * split matters because creation must be safe to call from a schedule tick, an
 * IPC request or a retry without any of them being able to start work directly:
 * they all end at the same durable queue.
 */
export class TaskService {
  constructor(private readonly deps: TaskServiceDeps) {}

  /**
   * Creates a queued task.
   *
   * Idempotent when a dedupe key is supplied: a second identical call returns
   * the task that already exists instead of creating a sibling. That is what
   * makes a duplicate schedule trigger harmless rather than merely unlikely.
   */
  create(input: CreateTaskInput): TaskOutcome<TaskRecord> {
    const now = this.deps.now()
    const repository = this.deps.repositories.findById(input.repoId)
    if (!repository) return { ok: false, error: fail('INVALID_ARGUMENT', 'That repository is not registered.').error }
    const workspace = this.deps.repositories.workspaceForRepo(input.repoId)
    if (!workspace) {
      return { ok: false, error: fail('INVALID_ARGUMENT', 'That repository has no workspace.').error }
    }
    if (repositoryPreparationBlocksSessions(repository.preparation)) {
      return {
        ok: false,
        error: fail(
          'UNBORN_REPOSITORY',
          'This project is still preparing its first commit.',
          repository.preparation?.state === 'failed'
            ? 'Retry the first commit from Projects before creating a task.'
            : 'Wait for preparation to finish, then create the task.'
        ).error
      }
    }

    const prompt = input.prompt.trim()
    if (prompt.length === 0) {
      return { ok: false, error: fail('INVALID_ARGUMENT', 'A task needs an instruction.').error }
    }
    if (prompt.length > TASK_LIMITS.maxPromptLength) {
      return {
        ok: false,
        error: fail('INVALID_ARGUMENT', 'That instruction is too long for a task.').error
      }
    }
    const title = (input.title?.trim() || firstLine(prompt)).slice(0, TASK_LIMITS.maxTitleLength)

    if (input.dedupeKey) {
      const existing = this.deps.tasks.findByDedupeKey(input.dedupeKey)
      if (existing) return ok(existing)
    }

    const created = this.deps.tasks.insert(
      {
        id: this.deps.newId(),
        workspaceId: workspace.id,
        repoId: input.repoId,
        title,
        prompt,
        harness: input.harness,
        attempt: input.attempt ?? 1,
        previousTaskId: input.previousTaskId ?? null,
        scheduleId: input.scheduleId ?? null,
        occurrenceAt: input.occurrenceAt ?? null,
        dedupeKey: input.dedupeKey ?? null
      },
      now
    )
    if (!created) {
      // Lost a race on the dedupe key: the winner's row is the truth.
      const existing = input.dedupeKey ? this.deps.tasks.findByDedupeKey(input.dedupeKey) : null
      if (existing) return ok(existing)
      return { ok: false, error: fail('INTERNAL', 'The task could not be recorded.').error }
    }
    this.deps.onQueueChanged()
    return ok(created)
  }

  list(filter: { repoId?: RepoId; statuses?: readonly TaskStatus[]; limit?: number } = {}): TaskView[] {
    return this.deps.tasks.list(filter).map((task) => this.toView(task))
  }

  get(taskId: string): TaskView | null {
    const task = this.deps.tasks.findById(taskId)
    return task ? this.toView(task) : null
  }

  /**
   * Cancels a task.
   *
   * A queued task is simply taken out of the queue. A live one is asked to stop
   * and is marked cancelled at once — the user's decision is not contingent on
   * the harness cooperating. The worktree is deliberately left alone: whatever
   * the agent already wrote is unreviewed work, and deleting it would destroy
   * the user's only copy of it.
   */
  async cancel(taskId: string): Promise<TaskOutcome<TaskRecord>> {
    const task = this.deps.tasks.findById(taskId)
    if (!task) return { ok: false, error: fail('INVALID_ARGUMENT', 'That task no longer exists.').error }
    if (isTerminalTaskStatus(task.status)) {
      return { ok: false, error: fail('INVALID_ARGUMENT', 'That task has already finished.').error }
    }
    const now = this.deps.now()

    if (task.status === 'queued') {
      const cancelled = this.deps.tasks.updateIfStatus(
        taskId,
        ['queued'],
        { status: 'cancelled', finishedAt: now, failureReason: 'cancelled', error: 'Cancelled before it started.' },
        now
      )
      if (!cancelled) {
        return { ok: false, error: fail('INVALID_ARGUMENT', 'That task started a moment ago; try again.').error }
      }
      this.deps.onQueueChanged()
      return ok(this.deps.tasks.findById(taskId)!)
    }

    // Mark first, stop second: a failed stop must not leave the row saying
    // "running" while nothing is running.
    const marked = this.deps.tasks.updateIfStatus(
      taskId,
      ['dispatching', 'running', 'waiting'],
      { status: 'cancelled', finishedAt: now, failureReason: 'cancelled', error: 'Cancelled by you.' },
      now
    )
    if (!marked) {
      return { ok: false, error: fail('INVALID_ARGUMENT', 'That task has already finished.').error }
    }
    if (task.sessionId) {
      // A failed stop is surfaced through the session, not by un-cancelling.
      await this.deps.sessions.stop(task.sessionId).catch(() => undefined)
    }
    this.deps.onQueueChanged()
    return ok(this.deps.tasks.findById(taskId)!)
  }

  /**
   * Retries a finished task as a new attempt.
   *
   * The previous attempt keeps its row, its error and its worktree link, so the
   * chain shows what was tried. Only a terminal task can be retried, and only
   * once per attempt, which is what stops a double-click from queueing two
   * identical retries.
   */
  retry(taskId: string): TaskOutcome<TaskRecord> {
    const task = this.deps.tasks.findById(taskId)
    if (!task) return { ok: false, error: fail('INVALID_ARGUMENT', 'That task no longer exists.').error }
    if (!isTerminalTaskStatus(task.status)) {
      return {
        ok: false,
        error: fail('INVALID_ARGUMENT', 'Only a finished task can be retried.').error
      }
    }
    if (task.status === 'completed') {
      return {
        ok: false,
        error: fail('INVALID_ARGUMENT', 'That task already succeeded; create a new task instead.').error
      }
    }
    const existingRetry = this.deps.tasks
      .list({ limit: 500 })
      .find((candidate) => candidate.previousTaskId === taskId)
    if (existingRetry) return ok(existingRetry)

    return this.create({
      repoId: task.repoId,
      title: task.title,
      prompt: task.prompt,
      harness: task.harness,
      attempt: task.attempt + 1,
      previousTaskId: task.id
    })
  }

  /**
   * Records an Accept or Reject verdict on a finished task.
   *
   * Rules, all deliberate:
   *  - only a task that has stopped has a result to judge;
   *  - the same verdict twice is idempotent and keeps the original timestamp;
   *  - a *different* verdict needs `replace: true`, so a mis-click cannot
   *    silently overwrite a decision the user already made;
   *  - nothing here touches Git. Acceptance is a recorded judgement, and the
   *    message says so, because merging is a separate act with its own review.
   */
  decideReview(
    taskId: string,
    decision: Exclude<ReviewDecision, 'pending'>,
    options: { note?: string | null; replace?: boolean } = {}
  ): TaskOutcome<TaskRecord> {
    const task = this.deps.tasks.findById(taskId)
    if (!task) return { ok: false, error: fail('INVALID_ARGUMENT', 'That task no longer exists.').error }
    if (!isTerminalTaskStatus(task.status)) {
      return {
        ok: false,
        error: fail(
          'INVALID_ARGUMENT',
          'This task has not finished, so there is no result to review yet.',
          'Wait for it to complete or fail, or cancel it first.'
        ).error
      }
    }
    const now = this.deps.now()
    const note = options.note?.trim() ? options.note.trim().slice(0, 2000) : null

    if (task.reviewDecision === decision) {
      // Idempotent: keep the first decision's timestamp and note, so a repeated
      // click does not rewrite history.
      return ok(task)
    }
    if (task.reviewDecision !== 'pending' && options.replace !== true) {
      return {
        ok: false,
        error: fail(
          'INVALID_ARGUMENT',
          `This task was already ${task.reviewDecision}. Confirm to change that decision.`,
          'The previous decision and its time are replaced only when you confirm.'
        ).error
      }
    }

    const written = this.deps.tasks.setReview(task.id, task.reviewDecision, decision, note, now)
    if (!written) {
      // Lost a race with another decision; report the stored truth.
      const current = this.deps.tasks.findById(task.id)
      if (current?.reviewDecision === decision) return ok(current)
      return {
        ok: false,
        error: fail(
          'INVALID_ARGUMENT',
          'The review decision changed while this was being saved.',
          'Re-read the task and try again.'
        ).error
      }
    }
    this.deps.onQueueChanged()
    return ok(this.deps.tasks.findById(task.id)!)
  }

  /**
   * The changes belonging to THIS task's session.
   *
   * The worktree recorded on the task is checked against the one the review
   * layer resolves for that session. If they disagree, nothing is shown: a
   * stale task row must never open another session's diff.
   */
  async changes(taskId: string): Promise<TaskOutcome<TaskChangesOutcome & { taskId: string; sessionId: string | null }>> {
    const task = this.deps.tasks.findById(taskId)
    if (!task) return { ok: false, error: fail('INVALID_ARGUMENT', 'That task no longer exists.').error }
    if (!task.sessionId) {
      return ok({
        taskId,
        sessionId: null,
        status: 'unavailable',
        reason: 'no-session',
        detail:
          task.status === 'queued' || task.status === 'dispatching'
            ? 'This task has not started yet, so it has produced no changes.'
            : 'No session was recorded for this task, so there are no changes to review.'
      })
    }
    const listing = await this.deps.listChanges(task.sessionId)
    if (listing.status === 'unavailable') {
      return ok({
        taskId,
        sessionId: task.sessionId,
        status: 'unavailable',
        reason: listing.reason,
        detail: listing.detail
      })
    }
    return ok({ taskId, sessionId: task.sessionId, ...listing })
  }

  setMaxConcurrent(value: number): TaskOutcome<number> {
    const bounded = Math.max(
      TASK_LIMITS.minConcurrent,
      Math.min(TASK_LIMITS.maxConcurrent, Math.trunc(value))
    )
    if (!Number.isFinite(bounded)) {
      return { ok: false, error: fail('INVALID_ARGUMENT', 'That concurrency limit is not a number.').error }
    }
    this.deps.tasks.setMaxConcurrent(bounded)
    this.deps.onQueueChanged()
    return ok(bounded)
  }

  maxConcurrent(): number {
    return this.deps.tasks.maxConcurrent()
  }

  /** The retry chain, newest first, for the history panel. */
  history(taskId: string): TaskView[] {
    return this.deps.tasks.chainOf(taskId).map((task) => this.toView(task))
  }

  private toView(task: TaskRecord): TaskView {
    // Only a host-confirmed state counts; a persisted `live` proves nothing.
    const sessionLive = task.sessionId ? this.deps.isSessionLive(task.sessionId) : false
    const alreadyRetried =
      isTerminalTaskStatus(task.status) &&
      task.status !== 'completed' &&
      this.deps.tasks.list({ limit: 500 }).some((candidate) => candidate.previousTaskId === task.id)
    return {
      ...task,
      sessionLive,
      canRetry: isTerminalTaskStatus(task.status) && task.status === 'failed' && !alreadyRetried,
      canReview: Boolean(task.sessionId || task.worktreePath),
      // A result can only be judged once it exists.
      canDecideReview: isTerminalTaskStatus(task.status),
      reviewDecisionFinal: task.reviewDecision !== 'pending'
    }
  }
}

/** A one-line title from an instruction, without inventing one. */
function firstLine(prompt: string): string {
  const line = prompt.split('\n').find((candidate) => candidate.trim().length > 0) ?? 'Task'
  return line.trim()
}
