/**
 * A Task is a unit of *work*, not a Session.
 *
 * The distinction is the whole point: a Session is one interactive process you
 * sit in front of, while a Task survives the process. It is created before any
 * terminal exists, kept while a workflow runs unattended, and still readable
 * after that process is gone — including after ADE restarts.
 *
 * A Task therefore records two different things and never conflates them:
 *  - what was asked (`prompt`, `harness`, `repoId`)
 *  - what happened (`status`, `attempt`, `resultSummary`, `error`).
 *
 * A retry is a NEW task row pointing at its predecessor. History is never
 * rewritten to make a later attempt look like the first one.
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
  'cancelled'
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
  /** 1 for the first attempt; a retry is a new row with attempt + 1. */
  attempt: number
  /** The task this one retries, so the chain is walkable. */
  previousTaskId: string | null
  /** Provenance: the schedule and occurrence that created this task. */
  scheduleId: string | null
  occurrenceAt: number | null
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
}

/**
 * What the UI shows a user. Derived from the record, never stored separately,
 * so a task cannot display "running" while its row says otherwise.
 */
export type TaskView = TaskRecord & {
  /** True when the linked Session still exists and is live right now. */
  sessionLive: boolean
  /** True when a retry is possible (terminal, and not already retried). */
  canRetry: boolean
  /** True when a linked session or worktree can be opened for review. */
  canReview: boolean
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

export type TaskListFilter = {
  repoId?: RepoId
  statuses?: readonly TaskStatus[]
  limit?: number
}

export const TASK_LIMITS = {
  maxTitleLength: 200,
  maxPromptLength: 20_000,
  maxConcurrent: 4,
  minConcurrent: 1
} as const
