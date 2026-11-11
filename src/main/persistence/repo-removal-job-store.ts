import type { Database } from './database'
import { DatabaseError } from './database'
import type { AppError } from '../../shared/domain/errors'
import { makeAppError } from '../../shared/domain/errors'
import { parseRepoId, type RepoId } from '../../shared/domain/ids'
import type { ExecutionTarget } from '../../shared/domain/repository'
import { appErrorSchema } from '../../shared/schemas/domain'
import { executionTargetSchema } from '../../shared/schemas/ipc'
import {
  removalJobStageSchema,
  removalJobStatusSchema,
  removalManifestSchema,
  type RemovalJobStage,
  type RemovalJobStatus,
  type RemovalManifest
} from '../../shared/schemas/repo-removal'

const COLUMNS = `id, repo_id, repo_name, repo_path, target_json, status, stage,
  manifest_json, attempts, next_attempt_at, last_error_json, created_at, updated_at,
  completed_at`

type RepoRemovalJobRow = {
  id: unknown
  repo_id: unknown
  repo_name: unknown
  repo_path: unknown
  target_json: unknown
  status: unknown
  stage: unknown
  manifest_json: unknown
  attempts: unknown
  next_attempt_at: unknown
  last_error_json: unknown
  created_at: unknown
  updated_at: unknown
  completed_at: unknown
}

export type RepoRemovalJobRecord = {
  id: string
  repoId: RepoId
  repoName: string
  repoPath: string
  target: ExecutionTarget
  status: RemovalJobStatus
  stage: RemovalJobStage
  manifest: RemovalManifest
  attempts: number
  nextAttemptAt: number | null
  lastError: AppError | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export type InsertRepoRemovalJob = {
  id: string
  repoId: RepoId
  repoName: string
  repoPath: string
  target: ExecutionTarget
  status: RemovalJobStatus
  stage: RemovalJobStage
  manifest: RemovalManifest
  now: number
}

export type RepoRemovalPurgeCounts = {
  taskOccurrences: number
  taskDependencies: number
  assistantActions: number
  supervisorActions: number
  supervisorBindings: number
  tasks: number
  taskSchedules: number
}

function corrupt(column: string, cause?: unknown): DatabaseError {
  return new DatabaseError(
    makeAppError('DB_CORRUPT', 'The repository removal job is corrupt.', {
      detail: `repo_removal_jobs.${column}`,
      context: { column }
    }),
    cause === undefined ? {} : { cause }
  )
}

function text(value: unknown, column: string): string {
  if (typeof value !== 'string' || value.length === 0) throw corrupt(column)
  return value
}

function nullableText(value: unknown, column: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw corrupt(column)
  return value
}

function integer(value: unknown, column: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw corrupt(column)
  return value
}

function nullableInteger(value: unknown, column: string): number | null {
  if (value === null) return null
  return integer(value, column)
}

function parseJson(value: unknown, column: string): unknown {
  const raw = text(value, column)
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw corrupt(column, error)
  }
}

function parseTarget(value: unknown): ExecutionTarget {
  const result = executionTargetSchema.safeParse(parseJson(value, 'target_json'))
  if (!result.success) throw corrupt('target_json', result.error)
  return result.data
}

function parseManifest(value: unknown): RemovalManifest {
  const result = removalManifestSchema.safeParse(parseJson(value, 'manifest_json'))
  if (!result.success) throw corrupt('manifest_json', result.error)
  return result.data
}

function parseStatus(value: unknown): RemovalJobStatus {
  const result = removalJobStatusSchema.safeParse(value)
  if (!result.success) throw corrupt('status', result.error)
  return result.data
}

function parseStage(value: unknown): RemovalJobStage {
  const result = removalJobStageSchema.safeParse(value)
  if (!result.success) throw corrupt('stage', result.error)
  return result.data
}

function parseError(value: unknown): AppError | null {
  const raw = nullableText(value, 'last_error_json')
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw corrupt('last_error_json', error)
  }
  const result = appErrorSchema.safeParse(parsed)
  if (!result.success) throw corrupt('last_error_json', result.error)
  return result.data
}

function fromRow(row: RepoRemovalJobRow): RepoRemovalJobRecord {
  const repoId = parseRepoId(text(row.repo_id, 'repo_id'))
  if (repoId === null) throw corrupt('repo_id')
  return {
    id: text(row.id, 'id'),
    repoId,
    repoName: text(row.repo_name, 'repo_name'),
    repoPath: text(row.repo_path, 'repo_path'),
    target: parseTarget(row.target_json),
    status: parseStatus(row.status),
    stage: parseStage(row.stage),
    manifest: parseManifest(row.manifest_json),
    attempts: integer(row.attempts, 'attempts'),
    nextAttemptAt: nullableInteger(row.next_attempt_at, 'next_attempt_at'),
    lastError: parseError(row.last_error_json),
    createdAt: integer(row.created_at, 'created_at'),
    updatedAt: integer(row.updated_at, 'updated_at'),
    completedAt: nullableInteger(row.completed_at, 'completed_at')
  }
}

/**
 * Persistence for durable repository-removal jobs.
 *
 * The job outlives the repository row: `repo_id` deliberately has no foreign
 * key here, and the manifest carries everything the worker needs after the
 * cascade. `purgeOwnedRows` is the one place that hard-deletes task rows; the
 * comment there explains the exception.
 */
export class RepoRemovalJobStore {
  constructor(private readonly db: Database) {}

  insert(input: InsertRepoRemovalJob): void {
    this.db.raw
      .prepare(
        `INSERT INTO repo_removal_jobs (${COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.repoId,
        input.repoName,
        input.repoPath,
        JSON.stringify(input.target),
        input.status,
        input.stage,
        JSON.stringify(input.manifest),
        0,
        null,
        null,
        input.now,
        input.now,
        null
      )
  }

  findById(id: string): RepoRemovalJobRecord | null {
    const row = this.db.raw
      .prepare(`SELECT ${COLUMNS} FROM repo_removal_jobs WHERE id = ?`)
      .get(id) as RepoRemovalJobRow | undefined
    return row ? fromRow(row) : null
  }

  findByRepo(repoId: RepoId): RepoRemovalJobRecord | null {
    const row = this.db.raw
      .prepare(`SELECT ${COLUMNS} FROM repo_removal_jobs WHERE repo_id = ?`)
      .get(repoId) as RepoRemovalJobRow | undefined
    return row ? fromRow(row) : null
  }

  /**
   * A small table: the service filters to unfinished jobs plus completed jobs
   * that still own snapshots or attention.
   */
  listAll(): RepoRemovalJobRecord[] {
    const rows = this.db.raw
      .prepare(`SELECT ${COLUMNS} FROM repo_removal_jobs ORDER BY created_at ASC, id ASC`)
      .all() as RepoRemovalJobRow[]
    return rows.map(fromRow)
  }

  /** Returns jobs whose retry timer is due; `queued` jobs are always due. */
  listDue(now: number): RepoRemovalJobRecord[] {
    const rows = this.db.raw
      .prepare(
        `SELECT ${COLUMNS} FROM repo_removal_jobs
          WHERE status = 'queued'
             OR (status = 'waiting_host'
                 AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
          ORDER BY created_at ASC, id ASC`
      )
      .all(now) as RepoRemovalJobRow[]
    return rows.map(fromRow)
  }

  save(job: RepoRemovalJobRecord): void {
    this.db.raw
      .prepare(
        `UPDATE repo_removal_jobs
            SET status = ?, stage = ?, manifest_json = ?, attempts = ?,
                next_attempt_at = ?, last_error_json = ?, updated_at = ?,
                completed_at = ?
          WHERE id = ?`
      )
      .run(
        job.status,
        job.stage,
        JSON.stringify(job.manifest),
        job.attempts,
        job.nextAttemptAt,
        job.lastError === null ? null : JSON.stringify(job.lastError),
        job.updatedAt,
        job.completedAt,
        job.id
      )
  }

  delete(id: string): void {
    this.db.raw.prepare('DELETE FROM repo_removal_jobs WHERE id = ?').run(id)
  }

  /**
   * Removes every repo-owned row that has no FK cascade.
   *
   * Task rows are normally archived, never deleted (see migration v15). A
   * repository removal is the deliberate exception: a task cannot outlive the
   * project it belongs to, and these tables would otherwise be left as
   * unreachable orphans. The worker runs this again immediately before the
   * repo row so rows created during a long cleanup are caught too.
   */
  purgeOwnedRows(repoId: RepoId): RepoRemovalPurgeCounts {
    const run = (sql: string): number => {
      const result = this.db.raw.prepare(sql).run(repoId)
      return Number(result.changes)
    }
    const taskOccurrences = run(
      `DELETE FROM task_occurrences
        WHERE schedule_id IN (SELECT id FROM task_schedules WHERE repo_id = ?)`
    )
    const taskDependencies = this.db.raw
      .prepare(
        `DELETE FROM task_dependencies
          WHERE task_id IN (SELECT id FROM tasks WHERE repo_id = ?)
             OR depends_on_task_id IN (SELECT id FROM tasks WHERE repo_id = ?)`
      )
      .run(repoId, repoId)
    const assistantActions = this.db.raw
      .prepare(
        `DELETE FROM assistant_actions
          WHERE repo_id = ?
             OR task_id IN (SELECT id FROM tasks WHERE repo_id = ?)`
      )
      .run(repoId, repoId)
    const supervisorActions = run('DELETE FROM supervisor_actions WHERE repo_id = ?')
    const supervisorBindings = run('DELETE FROM supervisor_bindings WHERE repo_id = ?')
    const tasks = run('DELETE FROM tasks WHERE repo_id = ?')
    const taskSchedules = run('DELETE FROM task_schedules WHERE repo_id = ?')
    return {
      taskOccurrences,
      taskDependencies: Number(taskDependencies.changes),
      assistantActions: Number(assistantActions.changes),
      supervisorActions,
      supervisorBindings,
      tasks,
      taskSchedules
    }
  }
}
