import type { Database } from './database'
import type { AppError } from '../../shared/domain/errors'
import { appErrorSchema } from '../../shared/schemas/domain'
import { parseRepoId, parseSessionId } from './rows'
import type { OwnedBranchRecord, SessionWorktreeRecord, WorktreeState } from '../../shared/domain/worktree'
import { WORKTREE_STATES } from '../../shared/domain/worktree'
import type { RepoId } from '../../shared/domain/ids'

type WorktreeRow = {
  session_id: unknown
  repo_id: unknown
  path: unknown
  branch: unknown
  base_ref: unknown
  base_oid: unknown
  state: unknown
  last_error_json: unknown
  created_at: unknown
  updated_at: unknown
}

type BranchRow = {
  branch: unknown
  repo_id: unknown
  session_id: unknown
  base_oid: unknown
  created_at: unknown
}

const WORKTREE_COLUMNS = `session_id, repo_id, path, branch, base_ref, base_oid, state,
  last_error_json, created_at, updated_at`
const BRANCH_COLUMNS = `branch, repo_id, session_id, base_oid, created_at`

function requireString(value: unknown, column: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Unusable database value for ${column}`)
  }
  return value
}

function requireInteger(value: unknown, column: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`Unusable database value for ${column}`)
  }
  return value
}

function parseError(value: unknown): AppError | null {
  if (value === null) return null
  const text = requireString(value, 'session_worktrees.last_error_json')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Unusable database value for session_worktrees.last_error_json')
  }
  const result = appErrorSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error('Unusable database value for session_worktrees.last_error_json')
  }
  return result.data
}

function worktreeFromRow(row: WorktreeRow): SessionWorktreeRecord {
  const state = row.state
  if (typeof state !== 'string' || !WORKTREE_STATES.includes(state as WorktreeState)) {
    throw new Error('Unusable database value for session_worktrees.state')
  }
  const baseRef = row.base_ref
  if (baseRef !== null && typeof baseRef !== 'string') {
    throw new Error('Unusable database value for session_worktrees.base_ref')
  }
  return {
    sessionId: parseSessionId(row.session_id),
    repoId: parseRepoId(row.repo_id),
    path: requireString(row.path, 'session_worktrees.path'),
    branch: requireString(row.branch, 'session_worktrees.branch'),
    baseRef: baseRef === null ? null : baseRef,
    baseOid: requireString(row.base_oid, 'session_worktrees.base_oid'),
    state: state as WorktreeState,
    error: parseError(row.last_error_json),
    createdAt: requireInteger(row.created_at, 'session_worktrees.created_at'),
    updatedAt: requireInteger(row.updated_at, 'session_worktrees.updated_at')
  }
}

function branchFromRow(row: BranchRow): OwnedBranchRecord {
  return {
    branch: requireString(row.branch, 'worktree_branches.branch'),
    repoId: parseRepoId(row.repo_id),
    sessionId: requireString(row.session_id, 'worktree_branches.session_id'),
    baseOid: requireString(row.base_oid, 'worktree_branches.base_oid'),
    createdAt: requireInteger(row.created_at, 'worktree_branches.created_at')
  }
}

/**
 * Durable session-worktree metadata and branch ownership. Rows describe what
 * iCode created and intended; liveness and path state always come from the
 * filesystem and the Host at the moment of use.
 */
export class WorktreeStore {
  constructor(private readonly db: Database) {}

  insert(record: SessionWorktreeRecord): void {
    this.db.raw
      .prepare(
        `INSERT INTO session_worktrees (${WORKTREE_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.sessionId,
        record.repoId,
        record.path,
        record.branch,
        record.baseRef,
        record.baseOid,
        record.state,
        record.error ? JSON.stringify(record.error) : null,
        record.createdAt,
        record.updatedAt
      )
  }

  findBySession(sessionId: string): SessionWorktreeRecord | null {
    const row = this.db.raw
      .prepare(`SELECT ${WORKTREE_COLUMNS} FROM session_worktrees WHERE session_id = ?`)
      .get(sessionId) as WorktreeRow | undefined
    return row ? worktreeFromRow(row) : null
  }

  listAll(): SessionWorktreeRecord[] {
    const rows = this.db.raw
      .prepare(`SELECT ${WORKTREE_COLUMNS} FROM session_worktrees ORDER BY created_at ASC`)
      .all() as WorktreeRow[]
    return rows.map(worktreeFromRow)
  }

  listByRepo(repoId: RepoId): SessionWorktreeRecord[] {
    const rows = this.db.raw
      .prepare(
        `SELECT ${WORKTREE_COLUMNS} FROM session_worktrees WHERE repo_id = ?
         ORDER BY created_at ASC`
      )
      .all(repoId) as WorktreeRow[]
    return rows.map(worktreeFromRow)
  }

  updateState(
    sessionId: string,
    state: WorktreeState,
    error: AppError | null,
    updatedAt: number
  ): void {
    this.db.raw
      .prepare(
        `UPDATE session_worktrees SET state = ?, last_error_json = ?, updated_at = ?
         WHERE session_id = ?`
      )
      .run(state, error ? JSON.stringify(error) : null, updatedAt, sessionId)
  }

  deleteBySession(sessionId: string): void {
    this.db.raw.prepare('DELETE FROM session_worktrees WHERE session_id = ?').run(sessionId)
  }

  insertBranch(record: OwnedBranchRecord): void {
    this.db.raw
      .prepare(
        `INSERT INTO worktree_branches (${BRANCH_COLUMNS}) VALUES (?, ?, ?, ?, ?)`
      )
      .run(record.branch, record.repoId, record.sessionId, record.baseOid, record.createdAt)
  }

  findBranch(branch: string): OwnedBranchRecord | null {
    const row = this.db.raw
      .prepare(`SELECT ${BRANCH_COLUMNS} FROM worktree_branches WHERE branch = ?`)
      .get(branch) as BranchRow | undefined
    return row ? branchFromRow(row) : null
  }

  listBranches(repoId: RepoId): OwnedBranchRecord[] {
    const rows = this.db.raw
      .prepare(
        `SELECT ${BRANCH_COLUMNS} FROM worktree_branches WHERE repo_id = ?
         ORDER BY created_at ASC`
      )
      .all(repoId) as BranchRow[]
    return rows.map(branchFromRow)
  }

  deleteBranch(branch: string): void {
    this.db.raw.prepare('DELETE FROM worktree_branches WHERE branch = ?').run(branch)
  }
}
