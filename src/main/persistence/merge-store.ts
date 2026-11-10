import type { Database } from './database'
import type { AppError } from '../../shared/domain/errors'
import { appErrorSchema } from '../../shared/schemas/domain'
import { ACTIVE_MERGE_STATES, MERGE_STATES, type MergeRecord, type MergeState } from '../../shared/domain/merge'

type MergeRow = {
  id: unknown
  repo_id: unknown
  session_id: unknown
  task_id: unknown
  source_branch: unknown
  target_branch: unknown
  source_oid_before: unknown
  target_oid_before: unknown
  target_oid_after: unknown
  result_oid: unknown
  review_base_oid: unknown
  state: unknown
  commit_oid: unknown
  conflict_files_json: unknown
  error_json: unknown
  push_remote: unknown
  pushed_at: unknown
  push_error_json: unknown
  created_at: unknown
  updated_at: unknown
  finished_at: unknown
}

const COLUMNS = `id, repo_id, session_id, task_id, source_branch, target_branch,
  source_oid_before, target_oid_before, target_oid_after, result_oid, review_base_oid,
  state, commit_oid, conflict_files_json, error_json, push_remote, pushed_at,
  push_error_json, created_at, updated_at, finished_at`

function text(value: unknown, column: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Unusable database value for merge_records.${column}`)
  }
  return value
}

function nullableText(value: unknown, column: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new Error(`Unusable database value for merge_records.${column}`)
  return value
}

function integer(value: unknown, column: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`Unusable database value for merge_records.${column}`)
  }
  return value
}

function nullableInteger(value: unknown, column: string): number | null {
  if (value === null) return null
  return integer(value, column)
}

function jsonText(value: unknown, column: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new Error(`Unusable database value for merge_records.${column}`)
  return value
}

function parseError(value: unknown, column: string): AppError | null {
  const raw = jsonText(value, column)
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Unusable database value for merge_records.${column}`)
  }
  const result = appErrorSchema.safeParse(parsed)
  if (!result.success) throw new Error(`Unusable database value for merge_records.${column}`)
  return result.data
}

function parseConflictFiles(value: unknown): string[] {
  const raw = jsonText(value, 'conflict_files_json')
  if (raw === null) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    throw new Error('Unusable database value for merge_records.conflict_files_json')
  }
}

function fromRow(row: MergeRow): MergeRecord {
  const state = row.state
  if (typeof state !== 'string' || !MERGE_STATES.includes(state as MergeState)) {
    throw new Error('Unusable database value for merge_records.state')
  }
  return {
    id: text(row.id, 'id'),
    repoId: text(row.repo_id, 'repo_id'),
    sessionId: text(row.session_id, 'session_id'),
    taskId: nullableText(row.task_id, 'task_id'),
    sourceBranch: text(row.source_branch, 'source_branch'),
    targetBranch: text(row.target_branch, 'target_branch'),
    sourceOidBefore: text(row.source_oid_before, 'source_oid_before'),
    targetOidBefore: text(row.target_oid_before, 'target_oid_before'),
    targetOidAfter: nullableText(row.target_oid_after, 'target_oid_after'),
    resultOid: nullableText(row.result_oid, 'result_oid'),
    reviewBaseOid: nullableText(row.review_base_oid, 'review_base_oid'),
    state: state as MergeState,
    commitOid: nullableText(row.commit_oid, 'commit_oid'),
    conflictFiles: parseConflictFiles(row.conflict_files_json),
    error: parseError(row.error_json, 'error_json'),
    pushRemote: nullableText(row.push_remote, 'push_remote'),
    pushedAt: nullableInteger(row.pushed_at, 'pushed_at'),
    pushError: parseError(row.push_error_json, 'push_error_json'),
    createdAt: integer(row.created_at, 'created_at'),
    updatedAt: integer(row.updated_at, 'updated_at'),
    finishedAt: nullableInteger(row.finished_at, 'finished_at')
  }
}

export type MergeClaimInput = {
  id: string
  repoId: string
  sessionId: string
  taskId: string | null
  sourceBranch: string
  targetBranch: string
  sourceOidBefore: string
  targetOidBefore: string
  now: number
}

export type MergeClaimResult =
  | { kind: 'claimed'; record: MergeRecord }
  | { kind: 'session-busy'; record: MergeRecord }
  | { kind: 'target-busy'; record: MergeRecord }

/**
 * Durable merge claims and audit trail. The two partial unique indexes in the
 * schema are the cross-process lock; this store pre-checks so a contending
 * caller gets a specific busy result rather than a constraint error.
 */
export class MergeStore {
  constructor(private readonly db: Database) {}

  claim(input: MergeClaimInput): MergeClaimResult {
    return this.db.transaction(() => {
      const sessionActive = this.findActiveForSession(input.sessionId)
      if (sessionActive !== null) return { kind: 'session-busy', record: sessionActive }
      const targetActive = this.findActiveForTarget(input.repoId, input.targetBranch)
      if (targetActive !== null) return { kind: 'target-busy', record: targetActive }

      this.db.raw
        .prepare(
          `INSERT INTO merge_records (${COLUMNS})
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'running', NULL, NULL, NULL,
                   NULL, NULL, NULL, ?, ?, NULL)`
        )
        .run(
          input.id,
          input.repoId,
          input.sessionId,
          input.taskId,
          input.sourceBranch,
          input.targetBranch,
          input.sourceOidBefore,
          input.targetOidBefore,
          input.now,
          input.now
        )
      const record = this.latestForSession(input.sessionId)
      if (record === null) throw new Error('The merge record was not written.')
      return { kind: 'claimed', record }
    })
  }

  findActiveForSession(sessionId: string): MergeRecord | null {
    const placeholders = ACTIVE_MERGE_STATES.map(() => '?').join(', ')
    const row = this.db.raw
      .prepare(
        `SELECT ${COLUMNS} FROM merge_records
         WHERE session_id = ? AND state IN (${placeholders})
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(sessionId, ...ACTIVE_MERGE_STATES) as MergeRow | undefined
    return row ? fromRow(row) : null
  }

  private findActiveForTarget(repoId: string, targetBranch: string): MergeRecord | null {
    const placeholders = ACTIVE_MERGE_STATES.map(() => '?').join(', ')
    const row = this.db.raw
      .prepare(
        `SELECT ${COLUMNS} FROM merge_records
         WHERE repo_id = ? AND target_branch = ? AND state IN (${placeholders})
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(repoId, targetBranch, ...ACTIVE_MERGE_STATES) as MergeRow | undefined
    return row ? fromRow(row) : null
  }

  latestForSession(sessionId: string): MergeRecord | null {
    const row = this.db.raw
      .prepare(
        `SELECT ${COLUMNS} FROM merge_records WHERE session_id = ?
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(sessionId) as MergeRow | undefined
    return row ? fromRow(row) : null
  }

  latestMergedForSource(repoId: string, sourceBranch: string): MergeRecord | null {
    const row = this.db.raw
      .prepare(
        `SELECT ${COLUMNS} FROM merge_records
         WHERE repo_id = ? AND source_branch = ? AND state = 'merged'
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(repoId, sourceBranch) as MergeRow | undefined
    return row ? fromRow(row) : null
  }

  mergedSessionIdsForChains(repoId: string, branches: readonly string[]): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>()
    if (branches.length === 0) return result
    const placeholders = branches.map(() => '?').join(', ')
    const rows = this.db.raw
      .prepare(
        `SELECT target_branch, session_id FROM merge_records
         WHERE repo_id = ? AND state = 'merged' AND target_branch IN (${placeholders})`
      )
      .all(repoId, ...branches) as Array<{ target_branch: string; session_id: string }>
    for (const row of rows) {
      const set = result.get(row.target_branch) ?? new Set<string>()
      set.add(row.session_id)
      result.set(row.target_branch, set)
    }
    return result
  }

  latestStatesForSessions(sessionIds: readonly string[]): Map<string, MergeState> {
    const result = new Map<string, MergeState>()
    if (sessionIds.length === 0) return result
    const placeholders = sessionIds.map(() => '?').join(', ')
    const rows = this.db.raw
      .prepare(
        `SELECT session_id, state FROM merge_records
         WHERE session_id IN (${placeholders})
         ORDER BY created_at ASC`
      )
      .all(...sessionIds) as Array<{ session_id: string; state: string }>
    for (const row of rows) {
      if (MERGE_STATES.includes(row.state as MergeState)) {
        result.set(row.session_id, row.state as MergeState)
      }
    }
    return result
  }

  /** Records that still claim a session or target, including stale conflicts. */
  listActive(): MergeRecord[] {
    const placeholders = ACTIVE_MERGE_STATES.map(() => '?').join(', ')
    const rows = this.db.raw
      .prepare(
        `SELECT ${COLUMNS} FROM merge_records
         WHERE state IN (${placeholders})
         ORDER BY created_at ASC`
      )
      .all(...ACTIVE_MERGE_STATES) as MergeRow[]
    return rows.map(fromRow)
  }

  markConflicted(id: string, files: readonly string[], now: number): void {
    this.db.raw
      .prepare(
        `UPDATE merge_records SET state = 'conflicted', conflict_files_json = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(JSON.stringify(files), now, id)
  }

  markMerged(
    id: string,
    patch: {
      resultOid: string
      targetOidAfter: string
      reviewBaseOid: string
      commitOid: string | null
      pushRemote: string | null
      pushedAt: number | null
      pushError: AppError | null
    },
    now: number
  ): void {
    this.db.raw
      .prepare(
        `UPDATE merge_records SET state = 'merged', result_oid = ?, target_oid_after = ?,
           review_base_oid = ?, commit_oid = ?, push_remote = ?, pushed_at = ?,
           push_error_json = ?, error_json = NULL, finished_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        patch.resultOid,
        patch.targetOidAfter,
        patch.reviewBaseOid,
        patch.commitOid,
        patch.pushRemote,
        patch.pushedAt,
        patch.pushError === null ? null : JSON.stringify(patch.pushError),
        now,
        now,
        id
      )
  }

  markFailed(id: string, error: AppError, now: number): void {
    this.db.raw
      .prepare(
        `UPDATE merge_records SET state = 'failed', error_json = ?, finished_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(JSON.stringify(error), now, now, id)
  }

  markAborted(id: string, now: number): void {
    this.db.raw
      .prepare(
        `UPDATE merge_records SET state = 'aborted', finished_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(now, now, id)
  }

  markInterrupted(id: string, now: number): void {
    this.db.raw
      .prepare(
        `UPDATE merge_records SET state = 'interrupted', finished_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(now, now, id)
  }
}
