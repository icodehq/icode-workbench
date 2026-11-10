/**
 * A Task is a unit of *work*, not a Session.
 *
 * The distinction is the whole point: a Session is one interactive process you
 * sit in front of, while a Task survives the process. It is created before any
 * terminal exists, kept while a workflow runs unattended, and still readable
 * after that process is gone — including after iCode restarts.
 *
 * A Task therefore records two different things and never conflates them:
 *  - what was asked (`prompt`, `harness`, `repoId`)
 *  - what happened (`status`, `attempt`, `resultSummary`, `error`).
 *
 * A retry or continuation is a NEW task row pointing at its predecessor.
 * History is never rewritten to make a later attempt look like the first one.
 */

import type { HarnessId } from './harness'
import type { RepoId, SessionId, WorkspaceId } from './ids'

/**
 * The lifecycle. `dispatching` is a real, observable state rather than an
 * implementation detail: it is the window between "claimed a slot" and "a
 * session exists". Persisting it is what lets a restart tell "we never started
 * anything" (safe to re-queue) from "a terminal may exist" (must be reconciled).
 */
export const TASK_STATUSES = [
  'queued',
  'dispatching',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled'
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

/**
 * Who created the task.
 *
 * `supervisor` tasks are proposals: they are recorded in the same queue but do
 * not occupy a slot or launch until a human approves them. The distinction is
 * provenance, not lifecycle; a supervisor task still becomes an ordinary task
 * once approved.
 */
export const TASK_ORIGINS = ['human', 'schedule', 'supervisor'] as const
export type TaskOrigin = (typeof TASK_ORIGINS)[number]

/**
 * Whether a task may be dispatched.
 *
 * Kept separate from `TaskStatus` for the same reason review is separate:
 * "queued" answers where the task is, while "pending" answers whether a human
 * has allowed it to start. Rejection ends the task as cancelled, but the
 * approval value preserves why it ended.
 */
export const TASK_APPROVALS = ['approved', 'pending', 'rejected'] as const
export type TaskApproval = (typeof TASK_APPROVALS)[number]

/**
 * How an attempt started.
 *
 * `fresh` is a new session and worktree. `resume` continues the predecessor's
 * session and worktree, so the harness conversation and uncommitted work
 * survive a quota, auth, network or interruption failure.
 */
export const TASK_ATTEMPT_MODES = ['fresh', 'resume'] as const
export type TaskAttemptMode = (typeof TASK_ATTEMPT_MODES)[number]

/** States that occupy a concurrency slot. */
export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = ['dispatching', 'running', 'waiting']

/** States a task can never leave. */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'cancelled']

export function isActiveTaskStatus(status: TaskStatus): boolean {
  return ACTIVE_TASK_STATUSES.includes(status)
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status)
}

/**
 * Whether a human has judged the task's result.
 *
 * Deliberately not part of `TaskStatus`: execution and judgement are different
 * questions. A `completed` task is normally `pending`, and accepting one records
 * a decision — it does not merge, commit, push or delete anything.
 */
export const REVIEW_DECISIONS = ['pending', 'accepted', 'rejected'] as const
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number]

/**
 * A non-binding recommendation from a supervisor.
 *
 * It deliberately does not reuse `ReviewDecision`: `accepted`/`rejected` are
 * human judgements, while a recommendation is evidence for that judgement. The
 * UI can show both side by side, and only a person can settle the decision.
 */
export const REVIEW_RECOMMENDATIONS = ['accept', 'reject'] as const
export type ReviewRecommendation = (typeof REVIEW_RECOMMENDATIONS)[number]

/**
 * Why a task stopped without finishing.
 *
 * The reasons are separate because the user's next action is different: a
 * missing harness needs a detection run, an unavailable worktree needs the
 * distro brought back, and an interruption needs a decision about the work that
 * may still be sitting in the worktree.
 */
export const TASK_FAILURE_REASONS = [
  'harness-unavailable',
  'session-create-failed',
  'prompt-write-failed',
  'harness-failed',
  'interrupted',
  'cancelled',
  'approval-rejected',
  'resume-failed'
] as const
export type TaskFailureReason = (typeof TASK_FAILURE_REASONS)[number]

export type TaskRecord = {
  id: string
  workspaceId: WorkspaceId
  repoId: RepoId
  /** Short label for the queue. */
  title: string
  /** The instruction handed to the harness. Stored because it is the work. */
  prompt: string
  harness: HarnessId
  status: TaskStatus
  /** Set once a Session exists. `null` means nothing was launched. */
  sessionId: SessionId | null
  /**
   * The worktree the session was given, recorded so review still works if the
   * session row is pruned. Never used to delete anything.
   */
  worktreePath: string | null
  /** 1 for the first attempt; a new execution episode is a new row with attempt + 1. */
  attempt: number
  /** Whether this episode started fresh or continued the predecessor's workspace. */
  attemptMode: TaskAttemptMode
  /** The task this one retries or continues, so the chain is walkable. */
  previousTaskId: string | null
  /** Provenance: the schedule and occurrence that created this task. */
  scheduleId: string | null
  occurrenceAt: number | null
  /** Who created the task. */
  origin: TaskOrigin
  /** The supervisor session that proposed this task, when it has one. */
  createdBySessionId: SessionId | null
  /**
   * Accurate provenance for a non-session actor. `origin` remains the
   * queue/approval class; this field says who actually asked for the work.
   * Mira tasks use `'mira'` and leave `createdBySessionId` null.
   */
  createdByActor: string | null
  /** The assistant run that created the task, when applicable. */
  assistantRunId: string | null
  /** The policy that approved the task automatically, when applicable. */
  approvalPolicy: string | null
  /** Whether the task may be dispatched. */
  approval: TaskApproval
  approvedAt: number | null
  approvedBy: string | null
  /** Hidden from the working list, but still queryable as history. */
  archivedAt: number | null
  /** Idempotency key; the database enforces uniqueness. */
  dedupeKey: string | null
  createdAt: number
  updatedAt: number
  startedAt: number | null
  finishedAt: number | null
  /** How it ended, in the harness's own terms. Never a guess at quality. */
  resultSummary: string | null
  error: string | null
  errorDetail: string | null
  failureReason: TaskFailureReason | null
  /** Last host-confirmed session state, for display after the session is gone. */
  lastObservedState: string | null
  exitCode: number | null
  /** A human's judgement of the result. Independent of `status`. */
  reviewDecision: ReviewDecision
  reviewedAt: number | null
  reviewNote: string | null
  /** A supervisor's non-binding recommendation. Never sets `reviewDecision`. */
  reviewRecommendation: ReviewRecommendation | null
  reviewRecommendationNote: string | null
  reviewRecommendedAt: number | null
  reviewRecommendedBySessionId: SessionId | null
  /**
   * Whether tasks that run after this one wait for acceptance.
   *
   * This is a property of the result, not of a particular edge: every dependent
   * sees the same gate. Completion alone satisfies an ungated blocker.
   */
  holdDependents: boolean
}

/**
 * One blocker, as shown beside a task.
 *
 * `satisfied` is derived from the same predicate the dispatcher uses, so the
 * UI cannot show "starts when finished" for an edge the scheduler still blocks.
 */
export type TaskDependencySummary = {
  id: string
  title: string
  status: TaskStatus
  reviewDecision: ReviewDecision
  holdDependents: boolean
  satisfied: boolean
}

/** One task that runs after another, for the detail pane's dependents list. */
export type TaskDependentSummary = {
  id: string
  title: string
  status: TaskStatus
  archivedAt: number | null
}

/**
 * Whether one blocker has satisfied its ordering constraint.
 *
 * Kept pure and shared so the dispatcher-facing store predicate, the service's
 * view flags and the renderer's chips cannot drift. A missing blocker is
 * unsatisfied; callers only pass a record when it exists.
 */
export function dependencySatisfied(
  blocker: Pick<TaskRecord, 'status' | 'reviewDecision' | 'holdDependents'>
): boolean {
  return (
    blocker.status === 'completed' &&
    (!blocker.holdDependents || blocker.reviewDecision === 'accepted')
  )
}

/**
 * What the UI shows a user. Derived from the record, never stored separately,
 * so a task cannot display "running" while its row says otherwise.
 */
export type TaskView = TaskRecord & {
  /** True when the linked Session still exists and is live right now. */
  sessionLive: boolean
  /** Every blocker, in edge-creation order, with whether the gate is open. */
  dependencies: TaskDependencySummary[]
  /** Tasks that will not start until this one satisfies its gate. */
  dependents: TaskDependentSummary[]
  /**
   * True when this queued task could be dispatched now: approved, and every
   * blocker satisfied. A blocked task is still `queued`; this flag is derived.
   */
  ready: boolean
  /** True when a retry is possible (terminal, and not already retried). */
  canRetry: boolean
  /**
   * True when the same session and worktree can be continued.
   *
   * Only a stopped, reviewed-pending, unarchived failed or cancelled attempt
   * with a recorded session qualifies. A shell task has no conversation to
   * resume, and a task with a successor is already continued by that row.
   */
  canResume: boolean
  /** True when a linked session or worktree can be opened for review. */
  canReview: boolean
  /** True when this is a queued proposal a human may approve. */
  canApprove: boolean
  /** True when this is a queued proposal a human may reject. */
  canReject: boolean
  /** True when a terminal task can move into history. */
  canArchive: boolean
  /** True when an archived task can return to the working list. */
  canUnarchive: boolean
  /**
   * True when a decision can be recorded now.
   *
   * Only a finished task has a result to judge. A queued or running task is
   * still producing one, so the UI must not offer Accept/Reject for it.
   */
  canDecideReview: boolean
  /** True when a previous decision must be explicitly replaced to change it. */
  reviewDecisionFinal: boolean
}

/**
 * Whether an attempt may be continued in place.
 *
 * Kept as a pure predicate so the task service, the view flags and the
 * assistant notifier cannot drift on the eligibility rules. Nullish checks are
 * deliberate: legacy rows and partial test fixtures may omit the fields.
 */
export function taskCanResume(
  task: Pick<
    TaskRecord,
    'status' | 'sessionId' | 'harness' | 'reviewDecision' | 'archivedAt'
  >,
  hasSuccessor: boolean
): boolean {
  return (
    (task.status === 'failed' || task.status === 'cancelled') &&
    task.sessionId != null &&
    task.harness !== 'shell' &&
    task.reviewDecision === 'pending' &&
    task.archivedAt == null &&
    !hasSuccessor
  )
}

/**
 * Whether this task's gate can still be changed.
 *
 * The gate describes how a result should be judged, so it is meaningful only
 * while the result is not yet settled. An archived task is history.
 */
export function taskCanHoldDependents(
  task: Pick<TaskRecord, 'reviewDecision' | 'archivedAt'>
): boolean {
  return task.reviewDecision === 'pending' && task.archivedAt == null
}

export type TaskListFilter = {
  repoId?: RepoId
  statuses?: readonly TaskStatus[]
  approvals?: readonly TaskApproval[]
  /** Archived rows are history; only an explicit request returns them. */
  includeArchived?: boolean
  /** Retry predecessors are hidden from working lists by default. */
  includeAttempts?: boolean
  limit?: number
}

export const TASK_LIMITS = {
  maxTitleLength: 200,
  maxPromptLength: 20_000,
  maxConcurrent: 4,
  minConcurrent: 1,
  maxPendingProposals: 20,
  /** Enough for a real fan-in without turning the picker into a directory. */
  maxDependencies: 20
} as const
