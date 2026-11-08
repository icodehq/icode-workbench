import type { SessionService } from '../sessions/session-service'
import type { RepositoryStore } from '../persistence/repository-store'
import type { AppError } from '../../shared/domain/errors'
import { makeAppError } from '../../shared/domain/errors'
import type { HarnessId } from '../../shared/domain/harness'
import type { RepoId, SessionId } from '../../shared/domain/ids'
import { repositoryPreparationBlocksSessions } from '../../shared/domain/repository'
import {
  isTerminalTaskStatus,
  TASK_LIMITS,
  type ReviewRecommendation,
  type TaskApproval,
  type TaskListFilter,
  type TaskOrigin,
  type TaskRecord,
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
  /** Who created the task. Internal; the UI never supplies this. */
  origin?: TaskOrigin
  /** The supervisor session that proposed the task. */
  createdBySessionId?: string | null
  /**
   * Accurate non-session provenance. Mira uses `'mira'` and leaves
   * `createdBySessionId` null; the renderer never supplies this.
   */
  createdByActor?: string | null
  /** The assistant run that created the task, when applicable. */
  assistantRunId?: string | null
  /** The policy that auto-approved the task, when applicable. */
  approvalPolicy?: string | null
  /**
   * Internal only: a retry carries the original approval forward. Renderer and
   * control-plane payloads never expose this field.
   */
  approval?: TaskApproval
  /** Internal only: who approved it, e.g. `mira-policy` or `human`. */
  approvedBy?: string | null
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
    const origin: TaskOrigin = input.origin ?? (input.scheduleId ? 'schedule' : 'human')
    if (
      origin === 'supervisor' &&
      !input.createdBySessionId &&
      input.createdByActor !== 'mira'
    ) {
      return {
        ok: false,
        error: fail('INVALID_ARGUMENT', 'A supervisor proposal needs its supervisor session.').error
      }
    }
    const approval: TaskApproval =
      input.approval ?? (origin === 'supervisor' ? 'pending' : 'approved')
    const approvedAt = approval === 'approved' ? now : null
    const approvedBy = approval === 'approved' ? (input.approvedBy ?? 'human') : null

    if (input.dedupeKey) {
      const existing = this.deps.tasks.findByDedupeKey(input.dedupeKey)
      if (existing) return ok(existing)
    }

    if (approval === 'pending' && this.deps.tasks.countPending(input.repoId) >= TASK_LIMITS.maxPendingProposals) {
      return {
        ok: false,
        error: fail(
          'INVALID_ARGUMENT',
          'There are too many proposals waiting for approval.',
          `Approve or reject the existing proposals before adding more (limit ${String(TASK_LIMITS.maxPendingProposals)}).`
        ).error
      }
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
        dedupeKey: input.dedupeKey ?? null,
        origin,
        createdBySessionId: (input.createdBySessionId as SessionId | null | undefined) ?? null,
        createdByActor: input.createdByActor ?? null,
        assistantRunId: input.assistantRunId ?? null,
        approvalPolicy: input.approvalPolicy ?? null,
        approval,
        approvedAt,
        approvedBy
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

  list(filter: TaskListFilter = {}): TaskView[] {
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
   * Approves a queued proposal so the dispatcher may claim it.
   *
   * Approval is a human decision recorded on the task, not a second queue: the
   * dispatcher still owns the launch, and the task still waits for a slot.
   */
  approve(taskId: string): TaskOutcome<TaskRecord> {
    const task = this.deps.tasks.findById(taskId)
    if (!task) return { ok: false, error: fail('INVALID_ARGUMENT', 'That task no longer exists.').error }
    if (task.approval === 'approved') return ok(task)
    if (task.approval === 'rejected') {
      return { ok: false, error: fail('INVALID_ARGUMENT', 'That proposal was already rejected.').error }
    }
    if (task.status !== 'queued') {
      return {
        ok: false,
        error: fail('INVALID_ARGUMENT', 'That proposal is no longer waiting for approval.').error
      }
    }
    const now = this.deps.now()
    if (!this.deps.tasks.approvePending(taskId, 'human', now)) {
      const current = this.deps.tasks.findById(taskId)
      if (current?.approval === 'approved') return ok(current)
      return { ok: false, error: fail('INVALID_ARGUMENT', 'That proposal changed while it was being approved.').error }
    }
    this.deps.onQueueChanged()
    return ok(this.deps.tasks.findById(taskId)!)
  }

  /**
   * Rejects a queued proposal. The work never starts; the row keeps why.
   */
  reject(taskId: string, note?: string | null): TaskOutcome<TaskRecord> {
    const task = this.deps.tasks.findById(taskId)
    if (!task) return { ok: false, error: fail('INVALID_ARGUMENT', 'That task no longer exists.').error }
    if (task.approval === 'rejected') return ok(task)
    if (task.approval === 'approved') {
      return { ok: false, error: fail('INVALID_ARGUMENT', 'That proposal was already approved.').error }
    }
    if (task.status !== 'queued') {
      return {
        ok: false,
        error: fail('INVALID_ARGUMENT', 'That proposal is no longer waiting for approval.').error
      }
    }
    const now = this.deps.now()
    const detail = note?.trim() ? note.trim().slice(0, 2000) : null
    if (!this.deps.tasks.rejectPending(taskId, detail, now)) {
      const current = this.deps.tasks.findById(taskId)
      if (current?.approval === 'rejected') return ok(current)
      return { ok: false, error: fail('INVALID_ARGUMENT', 'That proposal changed while it was being rejected.').error }
    }
    this.deps.onQueueChanged()
    return ok(this.deps.tasks.findById(taskId)!)
  }

  /**
   * Records a supervisor's non-binding recommendation on a finished task.
   *
   * This never writes `reviewDecision`. A person still owns the verdict; the
   * recommendation is evidence shown next to their Accept/Reject buttons.
   */
  recommendReview(
    taskId: string,
    recommendation: ReviewRecommendation,
    note?: string | null,
    sessionId?: string | null
  ): TaskOutcome<TaskRecord> {
    const task = this.deps.tasks.findById(taskId)
    if (!task) return { ok: false, error: fail('INVALID_ARGUMENT', 'That task no longer exists.').error }
    if (!isTerminalTaskStatus(task.status)) {
      return {
        ok: false,
        error: fail('INVALID_ARGUMENT', 'This task has not finished, so there is no result to review yet.').error
      }
    }
    if (task.reviewDecision !== 'pending') {
      return {
        ok: false,
        error: fail('INVALID_ARGUMENT', 'A human already decided this task; the recommendation is history.').error
      }
    }
    const now = this.deps.now()
    const detail = note?.trim() ? note.trim().slice(0, 2000) : null
    if (!this.deps.tasks.setReviewRecommendation(
      taskId,
      recommendation,
      detail,
      (sessionId as SessionId | null | undefined) ?? null,
      now
    )) {
      return {
        ok: false,
        error: fail('INVALID_ARGUMENT', 'The review decision changed while the recommendation was being saved.').error
      }
    }
    // The recommendation is part of the task payload; a window showing this
    // task must re-read it even though the lifecycle did not change.
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
  retry(
    taskId: string,
    options: { assistantRunId?: string | null } = {}
  ): TaskOutcome<TaskRecord> {
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
      .list({ limit: 500, includeArchived: true, includeAttempts: true })
      .find((candidate) => candidate.previousTaskId === taskId)
    if (existingRetry) return ok(existingRetry)

    return this.create({
      repoId: task.repoId,
      title: task.title,
      prompt: task.prompt,
      harness: task.harness,
      origin: task.origin,
      createdBySessionId: task.createdBySessionId,
      createdByActor: task.createdByActor,
      assistantRunId: options.assistantRunId ?? task.assistantRunId,
      approvalPolicy: task.approvalPolicy,
      // A retry is a new attempt at work a human already allowed to start.
      approval: task.approval === 'approved' ? 'approved' : undefined,
      ...(task.approval === 'approved' && task.approvedBy
        ? { approvedBy: task.approvedBy }
        : {}),
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

  /**
   * Hides one terminal task from the working list. Archive is reversible and
   * never removes the review, retry chain, session or worktree.
   */
  archive(taskId: string): TaskOutcome<TaskRecord> {
    const task = this.deps.tasks.findById(taskId)
    if (!task) return { ok: false, error: fail('INVALID_ARGUMENT', 'That task no longer exists.').error }
    if (task.archivedAt !== null) return ok(this.toView(task))
    if (!isTerminalTaskStatus(task.status)) {
      return {
        ok: false,
        error: fail('INVALID_ARGUMENT', 'Only a finished task can move to history.').error
      }
    }
    if (!this.deps.tasks.archive(taskId, this.deps.now())) {
      const current = this.deps.tasks.findById(taskId)
      if (current !== null && current.archivedAt !== null) return ok(this.toView(current))
      return { ok: false, error: fail('INVALID_ARGUMENT', 'That task changed while it was being archived.').error }
    }
    this.deps.onQueueChanged()
    return ok(this.toView(this.deps.tasks.findById(taskId)!))
  }

  unarchive(taskId: string): TaskOutcome<TaskRecord> {
    const task = this.deps.tasks.findById(taskId)
    if (!task) return { ok: false, error: fail('INVALID_ARGUMENT', 'That task no longer exists.').error }
    if (task.archivedAt === null) return ok(this.toView(task))
    if (!this.deps.tasks.unarchive(taskId, this.deps.now())) {
      const current = this.deps.tasks.findById(taskId)
      if (current?.archivedAt === null) return ok(this.toView(current))
      return { ok: false, error: fail('INVALID_ARGUMENT', 'That task changed while it was being restored.').error }
    }
    this.deps.onQueueChanged()
    return ok(this.toView(this.deps.tasks.findById(taskId)!))
  }

  /** Archives only reviewed completions and cancellations, never pending work. */
  archiveFinished(repoId?: RepoId): TaskOutcome<number> {
    const count = this.deps.tasks.archiveFinished(repoId, this.deps.now())
    if (count > 0) this.deps.onQueueChanged()
    return ok(count)
  }

  /** Startup/daily retention: same conservative rule, after a grace period. */
  archiveStale(days = 7): number {
    const now = this.deps.now()
    const count = this.deps.tasks.archiveStale(now - days * 24 * 60 * 60 * 1000, now)
    if (count > 0) this.deps.onQueueChanged()
    return count
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
      this.deps.tasks
        .list({ limit: 500, includeArchived: true, includeAttempts: true })
        .some((candidate) => candidate.previousTaskId === task.id)
    return {
      ...task,
      sessionLive,
      canRetry: isTerminalTaskStatus(task.status) && task.status === 'failed' && !alreadyRetried,
      canReview: Boolean(task.sessionId || task.worktreePath),
      canApprove: task.approval === 'pending' && task.status === 'queued',
      canReject: task.approval === 'pending' && task.status === 'queued',
      canArchive: task.archivedAt === null && isTerminalTaskStatus(task.status),
      canUnarchive: task.archivedAt !== null,
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
