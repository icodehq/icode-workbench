import type { SessionService } from '../sessions/session-service'
import type { RepositoryStore } from '../persistence/repository-store'
import type { AppError } from '../../shared/domain/errors'
import { makeAppError } from '../../shared/domain/errors'
import type { HarnessId } from '../../shared/domain/harness'
import type { RepoId, SessionId } from '../../shared/domain/ids'
import { repositoryPreparationBlocksSessions } from '../../shared/domain/repository'
import {
  dependencySatisfied,
  isTerminalTaskStatus,
  taskCanHoldDependents,
  taskCanResume,
  TASK_LIMITS,
  type ReviewRecommendation,
  type TaskApproval,
  type TaskAttemptMode,
  type TaskChainGate,
  type TaskDependencySummary,
  type TaskDependentSummary,
  type TaskListFilter,
  type TaskOrigin,
  type TaskRecord,
  type TaskView
} from '../../shared/domain/task'
import type { TaskRelations, TaskStore } from './task-store'
import type { ReviewDecision } from '../../shared/domain/task'
import type { MergeState } from '../../shared/domain/merge'
import type { MergeStore } from '../persistence/merge-store'
import { chainBranchNameForTask, isValidBranchName } from '../../shared/domain/branch'

export type TaskServiceError = { kind: 'app'; error: AppError }

function fail(code: AppError['code'], message: string, detail?: string): TaskServiceError {
  return { kind: 'app', error: makeAppError(code, message, detail ? { detail } : {}) }
}

function repositoryRemovingError(repoId: string): AppError {
  return makeAppError(
    'REPOSITORY_REMOVING',
    'This project is still being cleaned up. Try again in a moment.',
    {
      messageKey: 'errors.REPOSITORY_REMOVING',
      context: { repoId }
    }
  )
}

export type TaskOutcome<T> = { ok: true; value: T } | { ok: false; error: AppError }

type MergeFacts = {
  mergedByRepo: Map<string, Map<string, Set<string>>>
  states: Map<string, MergeState>
}

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
  /**
   * Internal only: how this episode starts. `resume` is set by
   * `TaskService.resume` and carries the predecessor's session/worktree.
   */
  attemptMode?: TaskAttemptMode
  /** Internal only: the session a resumed episode continues. */
  sessionId?: SessionId | null
  /** Internal only: the worktree a resumed episode continues. */
  worktreePath?: string | null
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
  /** Blockers this task waits for. Internal: the renderer supplies IDs. */
  dependsOn?: readonly string[]
  /** Whether tasks queued after this one wait for acceptance. */
  holdDependents?: boolean
  /** Local branch a chain root should start from. Renderer-supplied. */
  startFrom?: string | null
  /** Optional chain branch name. Renderer-supplied for a chain root. */
  branchName?: string | null
  /** Internal: preserves the predecessor's gate on retry/resume. */
  chainGate?: TaskChainGate
  /** Internal: preserves the predecessor's chain on retry/resume. */
  chainBranch?: string | null
  /**
   * Internal only: the predecessor whose dependents move to this successor in
   * the same transaction. Set by retry/resume, never by a caller.
   */
  repointDependentsFrom?: string | null
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
  /** Merge facts used to decide whether a blocker has landed on the chain. */
  merges?: MergeStore
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
    if (repository.removingAt !== undefined && repository.removingAt !== null) {
      return { ok: false, error: repositoryRemovingError(repository.id) }
    }
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
    const startFrom = input.startFrom?.trim() || null
    const branchName = input.branchName?.trim() || null
    if (startFrom !== null && !isValidBranchName(startFrom)) {
      return {
        ok: false,
        error: fail('INVALID_ARGUMENT', 'The start-from branch name is not valid.').error
      }
    }
    if (branchName !== null && !isValidBranchName(branchName)) {
      return {
        ok: false,
        error: fail('INVALID_ARGUMENT', 'The chain branch name is not valid.').error
      }
    }

    if (input.dedupeKey) {
      const existing = this.deps.tasks.findByDedupeKey(input.dedupeKey)
      if (existing) return ok(existing)
    }

    const taskId = this.deps.newId()
    const dependsOn = [...new Set(input.dependsOn ?? [])].filter((id) => id.length > 0)
    if (dependsOn.length > TASK_LIMITS.maxDependencies) {
      return {
        ok: false,
        error: fail(
          'INVALID_ARGUMENT',
          'That task waits on too many blockers.',
          `A task can wait for at most ${String(TASK_LIMITS.maxDependencies)} blockers.`
        ).error
      }
    }
    for (const blockerId of dependsOn) {
      if (blockerId === taskId) {
        return { ok: false, error: fail('INVALID_ARGUMENT', 'A task cannot wait for itself.').error }
      }
      const blocker = this.deps.tasks.findById(blockerId)
      if (!blocker) {
        return {
          ok: false,
          error: fail('INVALID_ARGUMENT', 'A blocker no longer exists.', blockerId).error
        }
      }
      if (blocker.repoId !== input.repoId) {
        return {
          ok: false,
          error: fail(
            'INVALID_ARGUMENT',
            'Blockers must belong to the same project.',
            'Task dependencies only order work inside one project.'
          ).error
        }
      }
    }

    let chainGate: TaskChainGate = input.chainGate ?? 'merge'
    let chainBranch: string | null = input.chainBranch ?? null
    let assignChainTo: string[] = []
    if (chainGate === 'merge') {
      const blockers = dependsOn.map((blockerId) => this.deps.tasks.findById(blockerId)!)
      if (blockers.some((blocker) => blocker.chainGate === 'legacy')) {
        chainGate = 'legacy'
        chainBranch = null
      } else {
        const distinct = [
          ...new Set(
            blockers
              .map((blocker) => blocker.chainBranch)
              .filter((branch): branch is string => branch !== null)
          )
        ]
        if (chainBranch !== null) {
          if (distinct.some((branch) => branch !== chainBranch)) {
            return {
              ok: false,
              error: fail(
                'CHAIN_BRANCH_MISMATCH',
                'That chain branch does not match the blockers.'
              ).error
            }
          }
        } else if (distinct.length === 0) {
          // A lone root has no shared branch until a dependent joins it. That
          // keeps independent roots able to fan in later without a conflict.
          chainBranch =
            branchName ?? (dependsOn.length > 0 ? chainBranchNameForTask(taskId) : null)
        } else if (distinct.length === 1) {
          if (branchName !== null && branchName !== distinct[0]) {
            return {
              ok: false,
              error: fail(
                'CHAIN_BRANCH_MISMATCH',
                'That chain branch does not match the blockers.'
              ).error
            }
          }
          chainBranch = distinct[0]!
        } else {
          return {
            ok: false,
            error: fail(
              'CHAIN_BRANCH_CONFLICT',
              'Blockers already belong to different chain branches.',
              'Merge them onto one chain branch before adding this dependent.'
            ).error
          }
        }
        assignChainTo = blockers.flatMap((blocker) =>
          this.deps.tasks.chainComponentIds(blocker.id)
        )
      }
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

    const created = this.deps.tasks.insertWithDependencies(
      {
        id: taskId,
        workspaceId: workspace.id,
        repoId: input.repoId,
        title,
        prompt,
        harness: input.harness,
        attempt: input.attempt ?? 1,
        attemptMode: input.attemptMode ?? 'fresh',
        sessionId: input.sessionId ?? null,
        worktreePath: input.worktreePath ?? null,
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
        approvedBy,
        holdDependents: input.holdDependents === true,
        chainBranch,
        chainGate,
        startFrom
      },
      dependsOn,
      now,
      {
        repointDependentsFrom: input.repointDependentsFrom ?? null,
        assignChainTo
      }
    )
    if (!created) {
      if (this.deps.repositories.isRemoving(input.repoId)) {
        return { ok: false, error: repositoryRemovingError(input.repoId) }
      }
      // Lost a race on the dedupe key: the winner's row is the truth.
      const existing = input.dedupeKey ? this.deps.tasks.findByDedupeKey(input.dedupeKey) : null
      if (existing) return ok(existing)
      return { ok: false, error: fail('INTERNAL', 'The task could not be recorded.').error }
    }
    this.deps.onQueueChanged()
    return ok(created)
  }

  list(filter: TaskListFilter = {}): TaskView[] {
    return this.toViews(this.deps.tasks.list(filter))
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
   * Adds a blocker to a queued task.
   *
   * Rewiring is allowed only before the dependent starts: once a slot is
   * claimed, "wait for this" would be a lie. The store repeats the checks in the
   * same transaction as the insert, so a concurrent claim cannot slip between.
   */
  addDependency(taskId: string, blockerId: string): TaskOutcome<TaskRecord> {
    const task = this.deps.tasks.findById(taskId)
    const blocker = this.deps.tasks.findById(blockerId)
    if (!task) {
      return { ok: false, error: fail('INVALID_ARGUMENT', 'That task no longer exists.').error }
    }
    if (!blocker) {
      return { ok: false, error: fail('INVALID_ARGUMENT', 'That blocker no longer exists.').error }
    }
    let result: ReturnType<TaskStore['addDependency']>
    if (task.chainGate === 'legacy' || blocker.chainGate === 'legacy') {
      result = this.deps.tasks.addDependency(taskId, blockerId, this.deps.now())
    } else {
      if (
        task.chainBranch !== null &&
        blocker.chainBranch !== null &&
        task.chainBranch !== blocker.chainBranch
      ) {
        return {
          ok: false,
          error: fail(
            'CHAIN_BRANCH_CONFLICT',
            'Those tasks belong to different chain branches.'
          ).error
        }
      }
      const chainBranch =
        task.chainBranch ?? blocker.chainBranch ?? chainBranchNameForTask(task.id)
      result = this.deps.tasks.addDependencyWithChain(
        taskId,
        blockerId,
        chainBranch,
        this.deps.now()
      )
    }
    switch (result) {
      case 'ok':
      case 'duplicate':
        this.deps.onQueueChanged()
        return ok(this.deps.tasks.findById(taskId)!)
      case 'dependent-missing':
        return { ok: false, error: fail('INVALID_ARGUMENT', 'That task no longer exists.').error }
      case 'blocker-missing':
        return { ok: false, error: fail('INVALID_ARGUMENT', 'That blocker no longer exists.').error }
      case 'self':
        return { ok: false, error: fail('INVALID_ARGUMENT', 'A task cannot wait for itself.').error }
      case 'cross-project':
        return {
          ok: false,
          error: fail('INVALID_ARGUMENT', 'Blockers must belong to the same project.').error
        }
      case 'dependent-not-queued':
        return {
          ok: false,
          error: fail(
            'INVALID_ARGUMENT',
            'Dependencies are locked once a task starts.',
            'Only a queued task can be rewired.'
          ).error
        }
      case 'cycle':
        return {
          ok: false,
          error: fail(
            'INVALID_ARGUMENT',
            'That blocker would create a cycle.',
            'Choose a task that does not already run after this one.'
          ).error
        }
      case 'chain-conflict':
        return {
          ok: false,
          error: fail(
            'CHAIN_BRANCH_CONFLICT',
            'Those tasks belong to different chain branches.'
          ).error
        }
    }
  }

  /** Removes a blocker from a queued task. */
  removeDependency(taskId: string, blockerId: string): TaskOutcome<TaskRecord> {
    const task = this.deps.tasks.findById(taskId)
    if (!task) return { ok: false, error: fail('INVALID_ARGUMENT', 'That task no longer exists.').error }
    if (task.status !== 'queued') {
      return {
        ok: false,
        error: fail(
          'INVALID_ARGUMENT',
          'Dependencies are locked once a task starts.',
          'Only a queued task can be rewired.'
        ).error
      }
    }
    const removed = this.deps.tasks.removeDependency(taskId, blockerId, this.deps.now())
    if (removed) this.deps.onQueueChanged()
    const current = this.deps.tasks.findById(taskId)
    if (!current) return { ok: false, error: fail('INVALID_ARGUMENT', 'That task no longer exists.').error }
    // An absent edge is idempotent: two removes do not fail the second click.
    return ok(current)
  }

  /**
   * Sets whether dependent tasks wait for this task's acceptance.
   *
   * The flag may change while the review is pending, including after completion:
   * that is how a person releases (or holds) queued dependents without retrying
   * anything.
   */
  setHoldDependents(taskId: string, hold: boolean): TaskOutcome<TaskRecord> {
    const task = this.deps.tasks.findById(taskId)
    if (!task) return { ok: false, error: fail('INVALID_ARGUMENT', 'That task no longer exists.').error }
    if (!taskCanHoldDependents(task)) {
      return {
        ok: false,
        error: fail(
          'INVALID_ARGUMENT',
          'This task already has a settled review.',
          'The gate can change only while its review is pending.'
        ).error
      }
    }
    if (task.holdDependents === hold) return ok(task)
    if (!this.deps.tasks.setHoldDependents(taskId, hold, this.deps.now())) {
      return {
        ok: false,
        error: fail('INVALID_ARGUMENT', 'That task changed while the gate was being saved.').error
      }
    }
    this.deps.onQueueChanged()
    return ok(this.deps.tasks.findById(taskId)!)
  }

  /**
   * Retries a finished task as a fresh attempt.
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
    const existingRetry = this.deps.tasks.findSuccessor(taskId)
    if (existingRetry) return ok(existingRetry)

    return this.createSuccessor(task, 'fresh', options)
  }

  /**
   * Continues a stopped task in its existing session and worktree.
   *
   * This is the recovery path for environmental failures — quota, auth,
   * network, harness crash, host restart — where the conversation and the
   * uncommitted worktree changes are worth keeping. The new row carries the
   * predecessor's `sessionId` and `worktreePath`; the dispatcher restarts the
   * session with the harness's resume command instead of creating a new one.
   */
  resume(
    taskId: string,
    options: { assistantRunId?: string | null } = {}
  ): TaskOutcome<TaskRecord> {
    const task = this.deps.tasks.findById(taskId)
    if (!task) return { ok: false, error: fail('INVALID_ARGUMENT', 'That task no longer exists.').error }
    if (!isTerminalTaskStatus(task.status)) {
      return {
        ok: false,
        error: fail('INVALID_ARGUMENT', 'Only a finished task can be continued.').error
      }
    }
    if (task.status === 'completed') {
      return {
        ok: false,
        error: fail('INVALID_ARGUMENT', 'That task already succeeded; create a new task instead.').error
      }
    }
    const existing = this.deps.tasks.findSuccessor(taskId)
    if (existing) return ok(existing)
    if (task.sessionId === null) {
      return {
        ok: false,
        error: fail(
          'INVALID_ARGUMENT',
          'This task has no session to continue.',
          'Start a new attempt instead.'
        ).error
      }
    }
    if (task.harness === 'shell') {
      return {
        ok: false,
        error: fail(
          'INVALID_ARGUMENT',
          'A shell task has no conversation to continue.',
          'Start a new attempt instead.'
        ).error
      }
    }
    if (task.reviewDecision !== 'pending') {
      return {
        ok: false,
        error: fail(
          'INVALID_ARGUMENT',
          'This attempt was already reviewed; start a new attempt instead.'
        ).error
      }
    }
    if (task.archivedAt != null) {
      return {
        ok: false,
        error: fail('INVALID_ARGUMENT', 'Restore this task from history before continuing it.').error
      }
    }
    return this.createSuccessor(task, 'resume', options)
  }

  /** The one place a retry or continuation is copied from its predecessor. */
  private createSuccessor(
    task: TaskRecord,
    attemptMode: TaskAttemptMode,
    options: { assistantRunId?: string | null }
  ): TaskOutcome<TaskRecord> {
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
      previousTaskId: task.id,
      attemptMode,
      // The successor inherits the predecessor's ordering and gate, and the
      // store moves the predecessor's dependents onto it in the same commit.
      dependsOn: this.deps.tasks.dependenciesOf(task.id),
      holdDependents: task.holdDependents,
      startFrom: task.startFrom,
      chainGate: task.chainGate,
      chainBranch: task.chainBranch,
      branchName: task.chainBranch,
      repointDependentsFrom: task.id,
      ...(attemptMode === 'resume'
        ? { sessionId: task.sessionId, worktreePath: task.worktreePath }
        : {})
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

  setMaxConcurrentPerProject(value: number): TaskOutcome<number> {
    const bounded = Math.max(
      TASK_LIMITS.minConcurrent,
      Math.min(TASK_LIMITS.maxConcurrent, Math.trunc(value))
    )
    if (!Number.isFinite(bounded)) {
      return {
        ok: false,
        error: fail('INVALID_ARGUMENT', 'That project concurrency limit is not a number.').error
      }
    }
    this.deps.tasks.setMaxConcurrentPerProject(bounded)
    this.deps.onQueueChanged()
    return ok(bounded)
  }

  maxConcurrentPerProject(): number {
    return this.deps.tasks.maxConcurrentPerProject()
  }

  /** The retry chain, newest first, for the history panel. */
  history(taskId: string): TaskView[] {
    return this.toViews(this.deps.tasks.chainOf(taskId))
  }

  /**
   * One batched read of the merge facts the dependency chips need. Grouping by
   * repo keeps `mergedSessionIdsForChains` from scanning the whole table.
   */
  private mergeFacts(
    tasks: readonly TaskRecord[],
    relations: TaskRelations
  ): MergeFacts {
    const branchesByRepo = new Map<string, Set<string>>()
    const sessionIds = new Set<string>()
    for (const task of tasks) {
      if (task.chainGate === 'merge' && task.chainBranch !== null) {
        const set = branchesByRepo.get(task.repoId) ?? new Set<string>()
        set.add(task.chainBranch)
        branchesByRepo.set(task.repoId, set)
      }
      for (const blocker of relations.dependencies.get(task.id) ?? []) {
        if (blocker.sessionId) sessionIds.add(blocker.sessionId)
      }
    }
    const mergedByRepo = new Map<string, Map<string, Set<string>>>()
    if (this.deps.merges) {
      for (const [repoId, branches] of branchesByRepo) {
        mergedByRepo.set(
          repoId,
          this.deps.merges.mergedSessionIdsForChains(repoId as RepoId, [...branches])
        )
      }
    }
    return {
      mergedByRepo,
      states: this.deps.merges
        ? this.deps.merges.latestStatesForSessions([...sessionIds])
        : new Map<string, MergeState>()
    }
  }

  /** Loads both directions of the relation once for a whole page of tasks. */
  private toViews(tasks: readonly TaskRecord[]): TaskView[] {
    const relations = this.deps.tasks.relationsFor(tasks.map((task) => task.id))
    const facts = this.mergeFacts(tasks, relations)
    return tasks.map((task) => this.toView(task, relations, facts))
  }

  private toView(
    task: TaskRecord,
    relations?: TaskRelations,
    facts?: MergeFacts
  ): TaskView {
    // Only a host-confirmed state counts; a persisted `live` proves nothing.
    const sessionLive = task.sessionId ? this.deps.isSessionLive(task.sessionId) : false
    const successor = this.deps.tasks.findSuccessor(task.id)
    const relation = relations ?? this.deps.tasks.relationsFor([task.id])
    const mergeFacts = facts ?? this.mergeFacts([task], relation)
    const blockers = relation.dependencies.get(task.id) ?? []
    const dependents = relation.dependents.get(task.id) ?? []
    const dependencies: TaskDependencySummary[] = blockers.map((blocker) => {
      const mergedIntoChain =
        task.chainGate === 'legacy' || task.chainBranch === null
          ? true
          : mergeFacts.mergedByRepo
              .get(task.repoId)
              ?.get(task.chainBranch)
              ?.has(blocker.sessionId ?? '') === true
      return {
        id: blocker.id,
        title: blocker.title,
        status: blocker.status,
        reviewDecision: blocker.reviewDecision,
        holdDependents: blocker.holdDependents,
        satisfied: dependencySatisfied(blocker, mergedIntoChain),
        mergedIntoChain,
        mergeState: blocker.sessionId
          ? (mergeFacts.states.get(blocker.sessionId) ?? null)
          : null
      }
    })
    const dependentViews: TaskDependentSummary[] = dependents.map((dependent) => ({
      id: dependent.id,
      title: dependent.title,
      status: dependent.status,
      archivedAt: dependent.archivedAt
    }))
    return {
      ...task,
      sessionLive,
      dependencies,
      dependents: dependentViews,
      ready:
        task.status === 'queued' &&
        task.approval === 'approved' &&
        dependencies.every((dependency) => dependency.satisfied),
      canRetry:
        isTerminalTaskStatus(task.status) && task.status === 'failed' && successor === null,
      canResume: taskCanResume(task, successor !== null),
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
