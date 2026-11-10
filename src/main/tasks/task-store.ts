import type { Database } from '../persistence/database'
import type { HarnessId } from '../../shared/domain/harness'
import type { RepoId, SessionId, WorkspaceId } from '../../shared/domain/ids'
import type {
  ReviewDecision,
  ReviewRecommendation,
  TaskApproval,
  TaskAttemptMode,
  TaskFailureReason,
  TaskListFilter,
  TaskOrigin,
  TaskRecord,
  TaskStatus
} from '../../shared/domain/task'
import { isActiveTaskStatus } from '../../shared/domain/task'
import type {
  ScheduleOccurrenceRecord,
  TaskSchedule,
  TaskScheduleShape
} from '../../shared/domain/task-schedule'

/**
 * Durable tasks and schedules.
 *
 * Every method that moves a task between states is a conditional UPDATE whose
 * `WHERE` clause encodes the allowed source state, and reports whether it
 * actually changed a row. That is the whole duplicate-dispatch defence: two
 * callers racing for the same task both run the statement, exactly one sees
 * `changes === 1`, and only that one may launch a process. An in-memory lock
 * would not survive the second caller, a second window, or a restart.
 */

const TASK_COLUMNS = `id, workspace_id, repo_id, title, prompt, harness, status, session_id,
  worktree_path, attempt, attempt_mode, previous_task_id, schedule_id, occurrence_at, dedupe_key,
  origin, created_by_session_id, created_by_actor, assistant_run_id, approval_policy,
  approval, approved_at, approved_by, archived_at,
  review_recommendation, review_recommendation_note, review_recommended_at,
  review_recommended_by_session_id,
  created_at, updated_at, started_at, finished_at, result_summary, error, error_detail,
  failure_reason, last_observed_state, exit_code, review_decision, reviewed_at, review_note,
  hold_dependents`

/**
 * The one readiness predicate.
 *
 * Used verbatim by the ready-task query and by the conditional claim, so a
 * blocked task cannot be launched by a pump that read an older queue. The inner
 * `NOT EXISTS` deliberately treats a dangling edge as unsatisfied: a blocker
 * row that no longer resolves must never be read as "done".
 */
export const TASK_READY_SQL = `tasks.status = 'queued'
  AND tasks.approval = 'approved'
  AND NOT EXISTS (
    SELECT 1 FROM task_dependencies AS dep
    WHERE dep.task_id = tasks.id
      AND NOT EXISTS (
        SELECT 1 FROM tasks AS blocker
        WHERE blocker.id = dep.depends_on_task_id
          AND blocker.status = 'completed'
          AND (blocker.hold_dependents = 0 OR blocker.review_decision = 'accepted')
      )
  )`

/** Both directions of the dependency relation for a set of tasks. */
export type TaskRelations = {
  dependencies: Map<string, TaskRecord[]>
  dependents: Map<string, TaskRecord[]>
}

export type AddDependencyResult =
  | 'ok'
  | 'duplicate'
  | 'dependent-missing'
  | 'blocker-missing'
  | 'dependent-not-queued'
  | 'self'
  | 'cross-project'
  | 'cycle'

type TaskRow = {
  id: string
  workspace_id: string
  repo_id: string
  title: string
  prompt: string
  harness: string
  status: string
  session_id: string | null
  worktree_path: string | null
  attempt: number
  attempt_mode: string
  previous_task_id: string | null
  schedule_id: string | null
  occurrence_at: number | null
  dedupe_key: string | null
  origin: string
  created_by_session_id: string | null
  created_by_actor: string | null
  assistant_run_id: string | null
  approval_policy: string | null
  approval: string
  approved_at: number | null
  approved_by: string | null
  archived_at: number | null
  review_recommendation: string | null
  review_recommendation_note: string | null
  review_recommended_at: number | null
  review_recommended_by_session_id: string | null
  created_at: number
  updated_at: number
  started_at: number | null
  finished_at: number | null
  result_summary: string | null
  error: string | null
  error_detail: string | null
  failure_reason: string | null
  last_observed_state: string | null
  exit_code: number | null
  review_decision: string
  reviewed_at: number | null
  review_note: string | null
  hold_dependents: number
}

function taskFromRow(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id as WorkspaceId,
    repoId: row.repo_id as RepoId,
    title: row.title,
    prompt: row.prompt,
    harness: row.harness as HarnessId,
    status: row.status as TaskStatus,
    sessionId: row.session_id as SessionId | null,
    worktreePath: row.worktree_path,
    attempt: row.attempt,
    attemptMode: row.attempt_mode as TaskAttemptMode,
    previousTaskId: row.previous_task_id,
    scheduleId: row.schedule_id,
    occurrenceAt: row.occurrence_at,
    origin: row.origin as TaskOrigin,
    createdBySessionId: row.created_by_session_id as SessionId | null,
    createdByActor: row.created_by_actor,
    assistantRunId: row.assistant_run_id,
    approvalPolicy: row.approval_policy,
    approval: row.approval as TaskApproval,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    archivedAt: row.archived_at,
    dedupeKey: row.dedupe_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    resultSummary: row.result_summary,
    error: row.error,
    errorDetail: row.error_detail,
    failureReason: row.failure_reason as TaskFailureReason | null,
    lastObservedState: row.last_observed_state,
    exitCode: row.exit_code,
    reviewDecision: row.review_decision as ReviewDecision,
    reviewedAt: row.reviewed_at,
    reviewNote: row.review_note,
    reviewRecommendation: row.review_recommendation as ReviewRecommendation | null,
    reviewRecommendationNote: row.review_recommendation_note,
    reviewRecommendedAt: row.review_recommended_at,
    reviewRecommendedBySessionId: row.review_recommended_by_session_id as SessionId | null,
    holdDependents: row.hold_dependents === 1
  }
}

export type NewTaskRow = {
  id: string
  workspaceId: WorkspaceId
  repoId: RepoId
  title: string
  prompt: string
  harness: HarnessId
  attempt: number
  /** Internal only: how this episode started; defaults to `fresh`. */
  attemptMode?: TaskAttemptMode
  /** Internal only: the session a resumed episode continues. */
  sessionId?: SessionId | null
  /** Internal only: the worktree a resumed episode continues. */
  worktreePath?: string | null
  previousTaskId: string | null
  scheduleId: string | null
  occurrenceAt: number | null
  dedupeKey: string | null
  origin?: TaskOrigin
  createdBySessionId?: SessionId | null
  createdByActor?: string | null
  assistantRunId?: string | null
  approvalPolicy?: string | null
  approval?: TaskApproval
  approvedAt?: number | null
  approvedBy?: string | null
  /** Whether tasks queued after this one wait for acceptance. */
  holdDependents?: boolean
}

export type TaskPatch = {
  status?: TaskStatus
  sessionId?: SessionId | null
  worktreePath?: string | null
  startedAt?: number | null
  finishedAt?: number | null
  resultSummary?: string | null
  error?: string | null
  errorDetail?: string | null
  failureReason?: TaskFailureReason | null
  lastObservedState?: string | null
  exitCode?: number | null
}

export class TaskStore {
  constructor(private readonly db: Database) {}

  /**
   * Inserts a queued task.
   *
   * Returns `null` when the dedupe key already exists, so the caller can
   * distinguish "already created" from a failure without parsing an SQLite
   * error message.
   */
  insert(draft: NewTaskRow, now: number): TaskRecord | null {
    const result = this.db.raw
      .prepare(
        `INSERT INTO tasks (
           id, workspace_id, repo_id, title, prompt, harness, status, session_id,
           worktree_path, attempt, attempt_mode, previous_task_id, schedule_id, occurrence_at, dedupe_key,
           origin, created_by_session_id, created_by_actor, assistant_run_id, approval_policy,
           approval, approved_at, approved_by,
           review_recommendation, review_recommendation_note, review_recommended_at,
           review_recommended_by_session_id,
           created_at, updated_at, started_at, finished_at, result_summary, error, error_detail,
           failure_reason, last_observed_state, exit_code, review_decision, reviewed_at, review_note,
           hold_dependents
         )
         VALUES (
           ?, ?, ?, ?, ?, ?, 'queued', ?,
           ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?,
           ?, ?, ?,
           NULL, NULL, NULL, NULL,
           ?, ?, NULL, NULL, NULL, NULL, NULL,
           NULL, NULL, NULL, 'pending', NULL, NULL,
           ?
         )
         ON CONFLICT (dedupe_key) DO NOTHING`
      )
      .run(
        draft.id,
        draft.workspaceId,
        draft.repoId,
        draft.title,
        draft.prompt,
        draft.harness,
        draft.sessionId ?? null,
        draft.worktreePath ?? null,
        draft.attempt,
        draft.attemptMode ?? 'fresh',
        draft.previousTaskId,
        draft.scheduleId,
        draft.occurrenceAt,
        draft.dedupeKey,
        draft.origin ?? 'human',
        draft.createdBySessionId ?? null,
        draft.createdByActor ?? null,
        draft.assistantRunId ?? null,
        draft.approvalPolicy ?? null,
        draft.approval ?? 'approved',
        draft.approvedAt !== undefined ? draft.approvedAt : now,
        draft.approvedBy !== undefined ? draft.approvedBy : 'human',
        now,
        now,
        draft.holdDependents === true ? 1 : 0
      )
    if (Number(result.changes) === 0) return null
    return this.findById(draft.id)
  }

  /**
   * Inserts a task and its ordering edges in one transaction.
   *
   * `repointDependentsFrom` is used by retry/resume: the predecessor's
   * dependents are copied to the successor and the old edges are removed in the
   * same commit, so a dependent can never observe a half-moved chain.
   */
  insertWithDependencies(
    draft: NewTaskRow,
    dependsOn: readonly string[],
    now: number,
    options: { repointDependentsFrom?: string | null } = {}
  ): TaskRecord | null {
    return this.db.transaction(() => {
      const created = this.insert(draft, now)
      if (!created) return null
      const insertEdge = this.db.raw.prepare(
        `INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT (task_id, depends_on_task_id) DO NOTHING`
      )
      for (const blockerId of dependsOn) insertEdge.run(draft.id, blockerId, now)
      if (options.repointDependentsFrom) {
        const predecessorId = options.repointDependentsFrom
        this.db.raw
          .prepare(
            `INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id, created_at)
             SELECT task_id, ?, created_at FROM task_dependencies
             WHERE depends_on_task_id = ?`
          )
          .run(draft.id, predecessorId)
        this.db.raw
          .prepare(`DELETE FROM task_dependencies WHERE depends_on_task_id = ?`)
          .run(predecessorId)
      }
      return this.findById(draft.id)
    })
  }

  findById(id: string): TaskRecord | null {
    const row = this.db.raw
      .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`)
      .get(id) as TaskRow | undefined
    return row ? taskFromRow(row) : null
  }

  /** Batch lookup used by dependency facts; keeps the list query free of N+1. */
  findByIds(ids: readonly string[]): TaskRecord[] {
    const unique = [...new Set(ids)]
    if (unique.length === 0) return []
    const placeholders = unique.map(() => '?').join(', ')
    const rows = this.db.raw
      .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id IN (${placeholders})`)
      .all(...unique) as TaskRow[]
    return rows.map(taskFromRow)
  }

  findByDedupeKey(key: string): TaskRecord | null {
    const row = this.db.raw
      .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE dedupe_key = ?`)
      .get(key) as TaskRow | undefined
    return row ? taskFromRow(row) : null
  }

  /**
   * The task that currently owns a session, if any.
   *
   * Used by notifications to tell a task session from a direct session without
   * scanning every task in memory.
   */
  findBySessionId(sessionId: SessionId): TaskRecord | null {
    const row = this.db.raw
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM tasks
         WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`
      )
      .get(sessionId) as TaskRow | undefined
    return row ? taskFromRow(row) : null
  }

  /**
   * The row that retries or continues this one, when it exists.
   *
   * A linear chain expects at most one successor. Ordering matches `chainOf`
   * in case a race ever produced more than one.
   */
  findSuccessor(taskId: string): TaskRecord | null {
    const row = this.db.raw
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM tasks
         WHERE previous_task_id = ?
         ORDER BY attempt ASC, created_at ASC, id ASC LIMIT 1`
      )
      .get(taskId) as TaskRow | undefined
    return row ? taskFromRow(row) : null
  }

  /** How many Mira auto-dispatch tasks were created since a local timestamp. */
  countAutoDispatchedSince(actor: string, since: number, repoId?: RepoId): number {
    const row = repoId
      ? (this.db.raw
          .prepare(
            `SELECT COUNT(*) AS n FROM tasks
             WHERE created_by_actor = ? AND approved_by = 'mira-policy'
               AND created_at >= ? AND repo_id = ?`
          )
          .get(actor, since, repoId) as { n: number })
      : (this.db.raw
          .prepare(
            `SELECT COUNT(*) AS n FROM tasks
             WHERE created_by_actor = ? AND approved_by = 'mira-policy' AND created_at >= ?`
          )
          .get(actor, since) as { n: number })
    return Number(row.n)
  }

  list(filter: TaskListFilter = {}): TaskRecord[] {
    const clauses: string[] = []
    const params: Array<string | number> = []
    if (filter.repoId) {
      clauses.push('repo_id = ?')
      params.push(filter.repoId)
    }
    if (filter.statuses && filter.statuses.length > 0) {
      clauses.push(`status IN (${filter.statuses.map(() => '?').join(', ')})`)
      params.push(...filter.statuses)
    }
    if (filter.approvals && filter.approvals.length > 0) {
      clauses.push(`approval IN (${filter.approvals.map(() => '?').join(', ')})`)
      params.push(...filter.approvals)
    }
    if (!filter.includeArchived) clauses.push('archived_at IS NULL')
    if (!filter.includeAttempts) {
      clauses.push(
        'NOT EXISTS (SELECT 1 FROM tasks AS retry WHERE retry.previous_task_id = tasks.id)'
      )
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    // Newest first: a queue is read from the work that was just submitted.
    const limit = filter.limit ?? 200
    const rows = this.db.raw
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM tasks ${where}
         ORDER BY CASE WHEN archived_at IS NULL THEN 0 ELSE 1 END,
                  created_at DESC, id DESC
         LIMIT ?`
      )
      .all(...params, limit) as TaskRow[]
    return rows.map(taskFromRow)
  }

  /** Hides a terminal task from working lists; the row is not deleted. */
  archive(id: string, now: number): boolean {
    const result = this.db.raw
      .prepare(
        `UPDATE tasks SET archived_at = ?
         WHERE id = ? AND archived_at IS NULL
           AND status IN ('completed', 'failed', 'cancelled')`
      )
      .run(now, id)
    return Number(result.changes) === 1
  }

  unarchive(id: string, now: number): boolean {
    const result = this.db.raw
      .prepare(
        `UPDATE tasks SET archived_at = NULL, updated_at = ?
         WHERE id = ? AND archived_at IS NOT NULL`
      )
      .run(now, id)
    return Number(result.changes) === 1
  }

  /**
   * Bulk-archives only finished work that no longer needs a person: reviewed
   * completions and cancellations. A completion still awaiting review and a
   * failed task stay in Needs by design.
   */
  archiveFinished(repoId: RepoId | undefined, now: number): number {
    const result = repoId
      ? this.db.raw
          .prepare(
            `UPDATE tasks SET archived_at = ?
             WHERE archived_at IS NULL AND repo_id = ?
               AND (
                 (status = 'completed' AND review_decision <> 'pending')
                 OR status = 'cancelled'
               )`
          )
          .run(now, repoId)
      : this.db.raw
          .prepare(
            `UPDATE tasks SET archived_at = ?
             WHERE archived_at IS NULL
               AND (
                 (status = 'completed' AND review_decision <> 'pending')
                 OR status = 'cancelled'
               )`
          )
          .run(now)
    return Number(result.changes)
  }

  /** The boot-time retention sweep; the same rule as the manual bulk action. */
  archiveStale(cutoff: number, now: number): number {
    const result = this.db.raw
      .prepare(
        `UPDATE tasks SET archived_at = ?
         WHERE archived_at IS NULL
           AND updated_at < ?
           AND (
             (status = 'completed' AND review_decision <> 'pending')
             OR status = 'cancelled'
           )`
      )
      .run(now, cutoff)
    return Number(result.changes)
  }

  /** Tasks that would occupy a slot right now; optionally within one project. */
  countActive(repoId?: RepoId): number {
    const sql = repoId
      ? `SELECT COUNT(*) AS n FROM tasks
         WHERE status IN ('dispatching', 'running', 'waiting') AND repo_id = ?`
      : `SELECT COUNT(*) AS n FROM tasks
         WHERE status IN ('dispatching', 'running', 'waiting')`
    const row = (
      repoId ? this.db.raw.prepare(sql).get(repoId) : this.db.raw.prepare(sql).get()
    ) as { n: number }
    return Number(row.n)
  }

  /**
   * The oldest ready task, optionally excluding projects already at their cap.
   *
   * Readiness is the shared predicate, so a blocked task never reaches the pump.
   * Exclusions are how the pump gives other projects a turn without persisting a
   * round-robin cursor.
   */
  nextReady(excludeRepoIds: readonly string[] = []): TaskRecord | null {
    const excluded = [...new Set(excludeRepoIds)]
    const exclusion =
      excluded.length > 0
        ? ` AND tasks.repo_id NOT IN (${excluded.map(() => '?').join(', ')})`
        : ''
    const row = this.db.raw
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM tasks
         WHERE ${TASK_READY_SQL}${exclusion}
         ORDER BY created_at ASC, id ASC LIMIT 1`
      )
      .get(...excluded) as TaskRow | undefined
    return row ? taskFromRow(row) : null
  }

  /**
   * Claims a ready task for dispatch.
   *
   * The shared predicate is the duplicate-start, approval and dependency guard:
   * a task already claimed, not yet approved, or still blocked by an edge cannot
   * be claimed no matter how many callers race.
   */
  claim(id: string, now: number): boolean {
    const result = this.db.raw
      .prepare(
        `UPDATE tasks SET status = 'dispatching', started_at = ?, updated_at = ?
         WHERE tasks.id = ? AND ${TASK_READY_SQL}`
      )
      .run(now, now, id)
    return Number(result.changes) === 1
  }

  /** Blocker IDs for one task, in edge-creation order. */
  dependenciesOf(taskId: string): string[] {
    const rows = this.db.raw
      .prepare(
        `SELECT depends_on_task_id FROM task_dependencies
         WHERE task_id = ? ORDER BY created_at ASC, rowid ASC`
      )
      .all(taskId) as Array<{ depends_on_task_id: string }>
    return rows.map((row) => row.depends_on_task_id)
  }

  /**
   * Both directions of the relation for a page of tasks.
   *
   * Three queries regardless of page size: the outgoing edges, the incoming
   * edges, and one lookup of every referenced task. Blockers outside the listed
   * page are still resolved, which is what keeps a truncated list honest.
   */
  relationsFor(taskIds: readonly string[]): TaskRelations {
    const dependencies = new Map<string, TaskRecord[]>()
    const dependents = new Map<string, TaskRecord[]>()
    const ids = [...new Set(taskIds)]
    if (ids.length === 0) return { dependencies, dependents }

    const placeholders = ids.map(() => '?').join(', ')
    const outgoing = this.db.raw
      .prepare(
        `SELECT task_id, depends_on_task_id FROM task_dependencies
         WHERE task_id IN (${placeholders})
         ORDER BY created_at ASC, rowid ASC`
      )
      .all(...ids) as Array<{ task_id: string; depends_on_task_id: string }>
    const incoming = this.db.raw
      .prepare(
        `SELECT task_id, depends_on_task_id FROM task_dependencies
         WHERE depends_on_task_id IN (${placeholders})
         ORDER BY created_at ASC, rowid ASC`
      )
      .all(...ids) as Array<{ task_id: string; depends_on_task_id: string }>

    const referenced = new Set<string>()
    for (const row of outgoing) referenced.add(row.depends_on_task_id)
    for (const row of incoming) referenced.add(row.task_id)
    const byId = new Map(this.findByIds([...referenced]).map((task) => [task.id, task]))

    for (const row of outgoing) {
      const blocker = byId.get(row.depends_on_task_id)
      if (!blocker) continue
      const list = dependencies.get(row.task_id) ?? []
      list.push(blocker)
      dependencies.set(row.task_id, list)
    }
    for (const row of incoming) {
      const dependent = byId.get(row.task_id)
      if (!dependent) continue
      const list = dependents.get(row.depends_on_task_id) ?? []
      list.push(dependent)
      dependents.set(row.depends_on_task_id, list)
    }
    return { dependencies, dependents }
  }

  /**
   * Whether adding `taskId → blockerId` would close a cycle.
   *
   * Walking up from the proposed blocker: if the dependent is already an
   * ancestor, the new edge makes the graph cyclic. `UNION` (not `UNION ALL`)
   * also makes malformed existing data terminate.
   */
  wouldCreateCycle(taskId: string, blockerId: string): boolean {
    if (taskId === blockerId) return true
    const row = this.db.raw
      .prepare(
        `WITH RECURSIVE upstream(id) AS (
           SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?
           UNION
           SELECT d.depends_on_task_id
           FROM task_dependencies d JOIN upstream u ON d.task_id = u.id
         )
         SELECT 1 AS found FROM upstream WHERE id = ? LIMIT 1`
      )
      .get(blockerId, taskId) as { found?: number } | undefined
    return row !== undefined
  }

  /**
   * Adds an edge while the dependent is still queued.
   *
   * The checks and the insert share one transaction so a task cannot start
   * between "is queued" and "edge written". Returns why the write was refused
   * rather than throwing, because the service turns each case into a different
   * message.
   */
  addDependency(taskId: string, blockerId: string, now: number): AddDependencyResult {
    return this.db.transaction(() => {
      const dependent = this.findById(taskId)
      if (!dependent) return 'dependent-missing'
      const blocker = this.findById(blockerId)
      if (!blocker) return 'blocker-missing'
      if (taskId === blockerId) return 'self'
      if (dependent.repoId !== blocker.repoId) return 'cross-project'
      if (dependent.status !== 'queued') return 'dependent-not-queued'
      if (this.wouldCreateCycle(taskId, blockerId)) return 'cycle'
      const result = this.db.raw
        .prepare(
          `INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at)
           VALUES (?, ?, ?)
           ON CONFLICT (task_id, depends_on_task_id) DO NOTHING`
        )
        .run(taskId, blockerId, now)
      if (Number(result.changes) === 0) return 'duplicate'
      this.db.raw
        .prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`)
        .run(now, taskId)
      return 'ok'
    })
  }

  /** Removes an edge while the dependent is still queued. */
  removeDependency(taskId: string, blockerId: string, now: number): boolean {
    return this.db.transaction(() => {
      const dependent = this.findById(taskId)
      if (!dependent || dependent.status !== 'queued') return false
      const result = this.db.raw
        .prepare(
          `DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?`
        )
        .run(taskId, blockerId)
      if (Number(result.changes) === 0) return false
      this.db.raw
        .prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`)
        .run(now, taskId)
      return true
    })
  }

  /**
   * Stores the blocker's acceptance gate.
   *
   * The gate describes how the result will be judged, so it is editable only
   * while that judgement is pending and the row is not history.
   */
  setHoldDependents(taskId: string, hold: boolean, now: number): boolean {
    const task = this.findById(taskId)
    if (!task || task.archivedAt !== null || task.reviewDecision !== 'pending') return false
    const result = this.db.raw
      .prepare(
        `UPDATE tasks SET hold_dependents = ?, updated_at = ?
         WHERE id = ? AND archived_at IS NULL AND review_decision = 'pending'`
      )
      .run(hold ? 1 : 0, now, taskId)
    return Number(result.changes) === 1
  }

  /**
   * Applies a patch only while the task is still in an expected status.
   *
   * Used by the tracker so a late host event cannot overwrite a cancellation
   * the user made a moment earlier.
   */
  updateIfStatus(
    id: string,
    expected: readonly TaskStatus[],
    patch: TaskPatch,
    now: number
  ): boolean {
    const sets: string[] = []
    const params: Array<string | number | null> = []
    const assign = (column: string, value: string | number | null): void => {
      sets.push(`${column} = ?`)
      params.push(value)
    }
    if (patch.status !== undefined) assign('status', patch.status)
    if (patch.sessionId !== undefined) assign('session_id', patch.sessionId)
    if (patch.worktreePath !== undefined) assign('worktree_path', patch.worktreePath)
    if (patch.startedAt !== undefined) assign('started_at', patch.startedAt)
    if (patch.finishedAt !== undefined) assign('finished_at', patch.finishedAt)
    if (patch.resultSummary !== undefined) assign('result_summary', patch.resultSummary)
    if (patch.error !== undefined) assign('error', patch.error)
    if (patch.errorDetail !== undefined) assign('error_detail', patch.errorDetail)
    if (patch.failureReason !== undefined) assign('failure_reason', patch.failureReason)
    if (patch.lastObservedState !== undefined) assign('last_observed_state', patch.lastObservedState)
    if (patch.exitCode !== undefined) assign('exit_code', patch.exitCode)
    if (sets.length === 0) return false
    assign('updated_at', now)
    const placeholders = expected.map(() => '?').join(', ')
    const result = this.db.raw
      .prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ? AND status IN (${placeholders})`)
      .run(...params, id, ...expected)
    return Number(result.changes) === 1
  }

  /**
   * Records a review decision, but only over an expected current decision.
   *
   * The conditional WHERE is what makes the decision safe under a double click:
   * two writers that both saw `pending` cannot both settle it, and changing an
   * existing verdict requires the caller to name that verdict explicitly.
   */
  setReview(
    id: string,
    expected: ReviewDecision,
    decision: ReviewDecision,
    note: string | null,
    now: number
  ): boolean {
    const result = this.db.raw
      .prepare(
        `UPDATE tasks SET review_decision = ?, reviewed_at = ?, review_note = ?, updated_at = ?
         WHERE id = ? AND review_decision = ?`
      )
      .run(decision, now, note, now, id, expected)
    return Number(result.changes) === 1
  }

  /**
   * Approves a queued proposal.
   *
   * Only `pending` + `queued` may move; a task that already started, finished,
   * or was rejected cannot be retroactively approved into a launch.
   */
  approvePending(id: string, approvedBy: string, now: number): boolean {
    const result = this.db.raw
      .prepare(
        `UPDATE tasks
         SET approval = 'approved', approved_at = ?, approved_by = ?, updated_at = ?
         WHERE id = ? AND approval = 'pending' AND status = 'queued'`
      )
      .run(now, approvedBy, now, id)
    return Number(result.changes) === 1
  }

  /**
   * Rejects a queued proposal as cancelled.
   *
   * The work never starts; `approval = 'rejected'` preserves why the row exists
   * while `status = 'cancelled'` keeps it out of the active queue forever.
   */
  rejectPending(id: string, note: string | null, now: number): boolean {
    const result = this.db.raw
      .prepare(
        `UPDATE tasks
         SET approval = 'rejected', status = 'cancelled', finished_at = ?,
             failure_reason = 'approval-rejected',
             error = 'Rejected before it started.',
             error_detail = ?, updated_at = ?
         WHERE id = ? AND approval = 'pending' AND status = 'queued'`
      )
      .run(now, note, now, id)
    return Number(result.changes) === 1
  }

  countPending(repoId: RepoId): number {
    const row = this.db.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks
         WHERE repo_id = ? AND approval = 'pending' AND status = 'queued'`
      )
      .get(repoId) as { n: number }
    return Number(row.n)
  }

  /** How many Mira tasks are waiting for approval across all projects. */
  countPendingByActor(actor: string): number {
    const row = this.db.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks
         WHERE created_by_actor = ? AND approval = 'pending' AND status = 'queued'`
      )
      .get(actor) as { n: number }
    return Number(row.n)
  }

  /**
   * Records a non-binding review recommendation.
   *
   * Conditional on the task still awaiting a human decision, so a late
   * supervisor cannot overwrite the record of a decision a person already made.
   */
  setReviewRecommendation(
    id: string,
    recommendation: ReviewRecommendation,
    note: string | null,
    sessionId: SessionId | null,
    now: number
  ): boolean {
    const result = this.db.raw
      .prepare(
        `UPDATE tasks
         SET review_recommendation = ?, review_recommendation_note = ?,
             review_recommended_at = ?, review_recommended_by_session_id = ?, updated_at = ?
         WHERE id = ? AND review_decision = 'pending'
           AND status IN ('completed', 'failed', 'cancelled')`
      )
      .run(recommendation, note, now, sessionId, now, id)
    return Number(result.changes) === 1
  }

  /** Unconditional patch, for fields that are not a lifecycle decision. */
  update(id: string, patch: TaskPatch, now: number): void {
    const all: readonly TaskStatus[] = [
      'queued',
      'dispatching',
      'running',
      'waiting',
      'completed',
      'failed',
      'cancelled'
    ]
    this.updateIfStatus(id, all, patch, now)
  }

  /** Tasks still attached to a session, for rebinding the tracker after a restart. */
  active(): TaskRecord[] {
    return this.list({ limit: 500 }).filter((task) => isActiveTaskStatus(task.status))
  }

  /**
   * The whole retry chain this task belongs to, oldest attempt first.
   *
   * Walk to the root first so asking about attempt 2 still returns attempt 1:
   * the history is the point, and a caller should not have to know which end of
   * the chain it is holding.
   */
  chainOf(taskId: string): TaskRecord[] {
    let root = this.findById(taskId)
    const guard = new Set<string>()
    while (root?.previousTaskId && !guard.has(root.id)) {
      guard.add(root.id)
      const parent = this.findById(root.previousTaskId)
      if (!parent) break
      root = parent
    }
    if (!root) return []
    const ordered: TaskRecord[] = []
    let cursor: TaskRecord | null = root
    while (cursor) {
      ordered.push(cursor)
      const next = this.db.raw
        .prepare(
          `SELECT ${TASK_COLUMNS} FROM tasks WHERE previous_task_id = ? ORDER BY attempt ASC, created_at ASC LIMIT 1`
        )
        .get(cursor.id) as TaskRow | undefined
      cursor = next ? taskFromRow(next) : null
    }
    return ordered
  }

  // ─── Schedules ────────────────────────────────────────────────────

  listSchedules(repoId?: RepoId): TaskSchedule[] {
    const rows = (
      repoId
        ? this.db.raw
            .prepare(`SELECT * FROM task_schedules WHERE repo_id = ? ORDER BY created_at ASC`)
            .all(repoId)
        : this.db.raw.prepare(`SELECT * FROM task_schedules ORDER BY created_at ASC`).all()
    ) as Array<Record<string, unknown>>
    return rows.map(scheduleFromRow)
  }

  findSchedule(id: string): TaskSchedule | null {
    const row = this.db.raw.prepare(`SELECT * FROM task_schedules WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined
    return row ? scheduleFromRow(row) : null
  }

  insertSchedule(schedule: TaskSchedule): void {
    this.db.raw
      .prepare(
        `INSERT INTO task_schedules (id, repo_id, title, prompt, harness, shape_json, overlap,
           enabled, created_at, updated_at, next_run_at, last_run_at, consecutive_failures, last_note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        schedule.id,
        schedule.repoId,
        schedule.title,
        schedule.prompt,
        schedule.harness,
        JSON.stringify(schedule.shape),
        schedule.overlap,
        schedule.enabled ? 1 : 0,
        schedule.createdAt,
        schedule.updatedAt,
        schedule.nextRunAt,
        schedule.lastRunAt,
        schedule.consecutiveFailures,
        schedule.lastNote
      )
  }

  updateSchedule(
    id: string,
    patch: Partial<
      Pick<
        TaskSchedule,
        | 'enabled'
        | 'nextRunAt'
        | 'lastRunAt'
        | 'consecutiveFailures'
        | 'lastNote'
        | 'repoId'
        | 'title'
        | 'prompt'
        | 'harness'
        | 'shape'
        | 'overlap'
      >
    >,
    now: number
  ): void {
    const sets: string[] = []
    const params: Array<string | number | null> = []
    if (patch.enabled !== undefined) {
      sets.push('enabled = ?')
      params.push(patch.enabled ? 1 : 0)
    }
    if (patch.nextRunAt !== undefined) {
      sets.push('next_run_at = ?')
      params.push(patch.nextRunAt)
    }
    if (patch.lastRunAt !== undefined) {
      sets.push('last_run_at = ?')
      params.push(patch.lastRunAt)
    }
    if (patch.consecutiveFailures !== undefined) {
      sets.push('consecutive_failures = ?')
      params.push(patch.consecutiveFailures)
    }
    if (patch.lastNote !== undefined) {
      sets.push('last_note = ?')
      params.push(patch.lastNote)
    }
    if (patch.repoId !== undefined) {
      sets.push('repo_id = ?')
      params.push(patch.repoId)
    }
    if (patch.title !== undefined) {
      sets.push('title = ?')
      params.push(patch.title)
    }
    if (patch.prompt !== undefined) {
      sets.push('prompt = ?')
      params.push(patch.prompt)
    }
    if (patch.harness !== undefined) {
      sets.push('harness = ?')
      params.push(patch.harness)
    }
    if (patch.shape !== undefined) {
      sets.push('shape_json = ?')
      params.push(JSON.stringify(patch.shape))
    }
    if (patch.overlap !== undefined) {
      sets.push('overlap = ?')
      params.push(patch.overlap)
    }
    if (sets.length === 0) return
    sets.push('updated_at = ?')
    params.push(now)
    this.db.raw.prepare(`UPDATE task_schedules SET ${sets.join(', ')} WHERE id = ?`).run(...params, id)
  }

  deleteSchedule(id: string): void {
    this.db.raw.prepare(`DELETE FROM task_schedules WHERE id = ?`).run(id)
  }

  /**
   * Reserves an occurrence, or returns `null` when it already exists.
   *
   * This is the durable receipt: the UNIQUE constraint makes "have I fired
   * this instant?" a question the database answers, so it holds across a
   * restart, a second window, and a clock that jumped.
   */
  reserveOccurrence(
    draft: { id: string; scheduleId: string; occurrenceAt: number; note: string | null },
    now: number
  ): boolean {
    const result = this.db.raw
      .prepare(
        `INSERT INTO task_occurrences (id, schedule_id, occurrence_at, task_id, status, note, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'reserved', ?, ?, ?)
         ON CONFLICT (schedule_id, occurrence_at) DO NOTHING`
      )
      .run(draft.id, draft.scheduleId, draft.occurrenceAt, draft.note, now, now)
    return Number(result.changes) === 1
  }

  resolveOccurrence(
    scheduleId: string,
    occurrenceAt: number,
    patch: { taskId?: string | null; status: 'created' | 'skipped' | 'error'; note?: string | null },
    now: number
  ): void {
    this.db.raw
      .prepare(
        `UPDATE task_occurrences SET status = ?, task_id = COALESCE(?, task_id), note = COALESCE(?, note), updated_at = ?
         WHERE schedule_id = ? AND occurrence_at = ?`
      )
      .run(patch.status, patch.taskId ?? null, patch.note ?? null, now, scheduleId, occurrenceAt)
  }

  listOccurrences(scheduleId: string, limit = 20): ScheduleOccurrenceRecord[] {
    const rows = this.db.raw
      .prepare(
        `SELECT * FROM task_occurrences WHERE schedule_id = ?
         ORDER BY occurrence_at DESC LIMIT ?`
      )
      .all(scheduleId, limit) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: String(row.id),
      scheduleId: String(row.schedule_id),
      occurrenceAt: Number(row.occurrence_at),
      taskId: row.task_id === null ? null : String(row.task_id),
      status: String(row.status) as ScheduleOccurrenceRecord['status'],
      note: row.note === null ? null : String(row.note),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    }))
  }

  /** True when this schedule already has a task occupying a slot. */
  hasActiveTaskForSchedule(scheduleId: string): boolean {
    const row = this.db.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks
         WHERE schedule_id = ? AND status IN ('dispatching', 'running', 'waiting')`
      )
      .get(scheduleId) as { n: number }
    return Number(row.n) > 0
  }

  // ─── Settings ─────────────────────────────────────────────────────

  maxConcurrent(): number {
    const row = this.db.raw.prepare(`SELECT max_concurrent FROM task_settings WHERE id = 1`).get() as
      | { max_concurrent: number }
      | undefined
    return row ? Number(row.max_concurrent) : 1
  }

  setMaxConcurrent(value: number): void {
    this.db.raw.prepare(`UPDATE task_settings SET max_concurrent = ? WHERE id = 1`).run(value)
  }

  maxConcurrentPerProject(): number {
    const row = this.db.raw
      .prepare(`SELECT max_concurrent_per_project FROM task_settings WHERE id = 1`)
      .get() as { max_concurrent_per_project: number } | undefined
    return row ? Number(row.max_concurrent_per_project) : 1
  }

  setMaxConcurrentPerProject(value: number): void {
    this.db.raw
      .prepare(`UPDATE task_settings SET max_concurrent_per_project = ? WHERE id = 1`)
      .run(value)
  }
}

function scheduleFromRow(row: Record<string, unknown>): TaskSchedule {
  return {
    id: String(row.id),
    repoId: String(row.repo_id) as RepoId,
    title: String(row.title),
    prompt: String(row.prompt),
    harness: String(row.harness) as HarnessId,
    shape: JSON.parse(String(row.shape_json)) as TaskScheduleShape,
    overlap: String(row.overlap) as TaskSchedule['overlap'],
    enabled: Number(row.enabled) === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    nextRunAt: row.next_run_at === null ? null : Number(row.next_run_at),
    lastRunAt: row.last_run_at === null ? null : Number(row.last_run_at),
    consecutiveFailures: Number(row.consecutive_failures),
    lastNote: row.last_note === null ? null : String(row.last_note)
  }
}
