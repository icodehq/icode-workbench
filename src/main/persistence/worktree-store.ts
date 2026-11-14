import type { Database } from './database'
import type { AppError } from '../../shared/domain/errors'
import { appErrorSchema } from '../../shared/schemas/domain'
import { parseRepoId, parseSessionId, parseWorktreeId } from './rows'
import type {
  OwnedBranchKind,
  OwnedBranchRecord,
  SessionWorktreeRecord,
  WorktreeRecord,
  WorktreeState
} from '../../shared/domain/worktree'
import { OWNED_BRANCH_KINDS, WORKTREE_STATES } from '../../shared/domain/worktree'
import type { RepoId, SessionId, WorktreeId } from '../../shared/domain/ids'

type WorktreeRow = {
  id: unknown
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

type SessionWorktreeRow = WorktreeRow & { session_id: unknown }

type BranchRow = {
  branch: unknown
  repo_id: unknown
  worktree_id: unknown
  session_id: unknown
  task_id: unknown
  kind: unknown
  base_oid: unknown
  created_at: unknown
}

const WORKTREE_COLUMNS = `w.id, w.repo_id, w.path, w.branch, w.base_ref, w.base_oid,
  w.state, w.last_error_json, w.created_at, w.updated_at`
const BRANCH_COLUMNS = `branch, repo_id, worktree_id, session_id, task_id, kind, base_oid,
  created_at`

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
  const text = requireString(value, 'worktrees.last_error_json')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Unusable database value for worktrees.last_error_json')
  }
  const result = appErrorSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error('Unusable database value for worktrees.last_error_json')
  }
  return result.data
}

function worktreeFromRow(row: WorktreeRow): WorktreeRecord {
  const state = row.state
  if (typeof state !== 'string' || !WORKTREE_STATES.includes(state as WorktreeState)) {
    throw new Error('Unusable database value for worktrees.state')
  }
  const baseRef = row.base_ref
  if (baseRef !== null && typeof baseRef !== 'string') {
    throw new Error('Unusable database value for worktrees.base_ref')
  }
  return {
    id: parseWorktreeId(row.id),
    repoId: parseRepoId(row.repo_id),
    path: requireString(row.path, 'worktrees.path'),
    branch: requireString(row.branch, 'worktrees.branch'),
    baseRef: baseRef === null ? null : baseRef,
    baseOid: requireString(row.base_oid, 'worktrees.base_oid'),
    state: state as WorktreeState,
    error: parseError(row.last_error_json),
    createdAt: requireInteger(row.created_at, 'worktrees.created_at'),
    updatedAt: requireInteger(row.updated_at, 'worktrees.updated_at')
  }
}

function sessionWorktreeFromRow(row: SessionWorktreeRow): SessionWorktreeRecord {
  return {
    ...worktreeFromRow(row),
    sessionId: parseSessionId(row.session_id)
  }
}

function optionalString(value: unknown, column: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Unusable database value for ${column}`)
  }
  return value
}

function branchFromRow(row: BranchRow): OwnedBranchRecord {
  const kind = row.kind
  if (typeof kind !== 'string' || !OWNED_BRANCH_KINDS.includes(kind as OwnedBranchKind)) {
    throw new Error('Unusable database value for worktree_branches.kind')
  }
  const worktreeId = optionalString(row.worktree_id, 'worktree_branches.worktree_id')
  return {
    branch: requireString(row.branch, 'worktree_branches.branch'),
    repoId: parseRepoId(row.repo_id),
    worktreeId: worktreeId === null ? null : parseWorktreeId(worktreeId),
    sessionId: optionalString(row.session_id, 'worktree_branches.session_id'),
    taskId: optionalString(row.task_id, 'worktree_branches.task_id'),
    kind: kind as OwnedBranchKind,
    baseOid: requireString(row.base_oid, 'worktree_branches.base_oid'),
    createdAt: requireInteger(row.created_at, 'worktree_branches.created_at')
  }
}

/**
 * Durable worktree metadata, session links, and branch ownership.
 *
 * A worktree is repo-owned and can be shared by several sessions; the link
 * table is the only session→checkout association. Rows describe what iCode
 * created and intended; liveness and path state always come from the
 * filesystem and the Host at the moment of use.
 */
export class WorktreeStore {
  constructor(private readonly db: Database) {}

  /**
   * Inserts a worktree and its first session link.
   *
   * Callers already run inside the session-create transaction; the store never
   * opens one itself, so this cannot split a session row from its checkout.
   */
  insert(record: SessionWorktreeRecord): void {
    this.insertWorktree(record)
    this.linkSession(record.sessionId, record.id)
  }

  insertWorktree(record: WorktreeRecord): void {
    this.db.raw
      .prepare(
        `INSERT INTO worktrees (id, repo_id, path, branch, base_ref, base_oid, state,
           last_error_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
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

  linkSession(sessionId: SessionId | string, worktreeId: WorktreeId | string): void {
    this.db.raw
      .prepare(
        `INSERT INTO session_worktree_links (session_id, worktree_id) VALUES (?, ?)`
      )
      .run(sessionId, worktreeId)
  }

  findBySession(sessionId: string): SessionWorktreeRecord | null {
    const row = this.db.raw
      .prepare(
        `SELECT ${WORKTREE_COLUMNS}, l.session_id
         FROM session_worktree_links l
         JOIN worktrees w ON w.id = l.worktree_id
         WHERE l.session_id = ?`
      )
      .get(sessionId) as SessionWorktreeRow | undefined
    return row ? sessionWorktreeFromRow(row) : null
  }

  findById(worktreeId: WorktreeId | string): WorktreeRecord | null {
    const row = this.db.raw
      .prepare(`SELECT ${WORKTREE_COLUMNS} FROM worktrees w WHERE w.id = ?`)
      .get(worktreeId) as WorktreeRow | undefined
    return row ? worktreeFromRow(row) : null
  }

  findByPath(path: string): WorktreeRecord | null {
    const row = this.db.raw
      .prepare(`SELECT ${WORKTREE_COLUMNS} FROM worktrees w WHERE w.path = ?`)
      .get(path) as WorktreeRow | undefined
    return row ? worktreeFromRow(row) : null
  }

  findByBranch(branch: string): WorktreeRecord | null {
    const row = this.db.raw
      .prepare(`SELECT ${WORKTREE_COLUMNS} FROM worktrees w WHERE w.branch = ?`)
      .get(branch) as WorktreeRow | undefined
    return row ? worktreeFromRow(row) : null
  }

  listAll(): WorktreeRecord[] {
    const rows = this.db.raw
      .prepare(`SELECT ${WORKTREE_COLUMNS} FROM worktrees w ORDER BY w.created_at ASC`)
      .all() as WorktreeRow[]
    return rows.map(worktreeFromRow)
  }

  listByRepo(repoId: RepoId | string): WorktreeRecord[] {
    const rows = this.db.raw
      .prepare(
        `SELECT ${WORKTREE_COLUMNS} FROM worktrees w WHERE w.repo_id = ?
         ORDER BY w.created_at ASC`
      )
      .all(repoId) as WorktreeRow[]
    return rows.map(worktreeFromRow)
  }

  /** Sessions attached to one worktree, oldest first (callers need a representative). */
  sessionIdsForWorktree(worktreeId: WorktreeId | string): SessionId[] {
    const rows = this.db.raw
      .prepare(
        `SELECT l.session_id
         FROM session_worktree_links l
         JOIN sessions s ON s.id = l.session_id
         WHERE l.worktree_id = ?
         ORDER BY s.created_at ASC, l.session_id ASC`
      )
      .all(worktreeId) as Array<{ session_id: unknown }>
    return rows.map((row) => parseSessionId(row.session_id))
  }

  sessionCountForWorktree(worktreeId: WorktreeId | string): number {
    const row = this.db.raw
      .prepare(
        `SELECT COUNT(*) AS count FROM session_worktree_links WHERE worktree_id = ?`
      )
      .get(worktreeId) as { count: unknown } | undefined
    if (!row || typeof row.count !== 'number') {
      throw new Error('Unusable database value for session_worktree_links count')
    }
    return row.count
  }

  /**
   * Updates the checkout state through a session link.
   *
   * Kept session-addressed because every lifecycle caller already holds a
   * session; the subquery makes it worktree-scoped, so any attached session
   * updates the one shared row.
   */
  updateState(
    sessionId: string,
    state: WorktreeState,
    error: AppError | null,
    updatedAt: number
  ): void {
    this.db.raw
      .prepare(
        `UPDATE worktrees SET state = ?, last_error_json = ?, updated_at = ?
         WHERE id = (SELECT worktree_id FROM session_worktree_links WHERE session_id = ?)`
      )
      .run(state, error ? JSON.stringify(error) : null, updatedAt, sessionId)
  }

  updateStateById(
    worktreeId: WorktreeId | string,
    state: WorktreeState,
    error: AppError | null,
    updatedAt: number
  ): void {
    this.db.raw
      .prepare(
        `UPDATE worktrees SET state = ?, last_error_json = ?, updated_at = ? WHERE id = ?`
      )
      .run(state, error ? JSON.stringify(error) : null, updatedAt, worktreeId)
  }

  /**
   * Removes one session's attachment. The checkout itself survives for any
   * other session still linked to it; only `deleteWorktree` destroys it.
   */
  unlinkSession(sessionId: string): void {
    this.db.raw
      .prepare('DELETE FROM session_worktree_links WHERE session_id = ?')
      .run(sessionId)
  }

  deleteWorktree(worktreeId: WorktreeId | string): void {
    this.db.raw.prepare('DELETE FROM worktrees WHERE id = ?').run(worktreeId)
  }

  insertBranch(record: OwnedBranchRecord): void {
    this.db.raw
      .prepare(
        `INSERT INTO worktree_branches (${BRANCH_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.branch,
        record.repoId,
        record.worktreeId,
        record.sessionId,
        record.taskId,
        record.kind,
        record.baseOid,
        record.createdAt
      )
  }

  /** Updates the review baseline after a merge has integrated the target. */
  updateBase(
    sessionId: string,
    baseRef: string | null,
    baseOid: string,
    updatedAt: number
  ): void {
    this.db.raw
      .prepare(
        `UPDATE worktrees SET base_ref = ?, base_oid = ?, updated_at = ?
         WHERE id = (SELECT worktree_id FROM session_worktree_links WHERE session_id = ?)`
      )
      .run(baseRef, baseOid, updatedAt, sessionId)
  }

  findBranch(branch: string): OwnedBranchRecord | null {
    const row = this.db.raw
      .prepare(`SELECT ${BRANCH_COLUMNS} FROM worktree_branches WHERE branch = ?`)
      .get(branch) as BranchRow | undefined
    return row ? branchFromRow(row) : null
  }

  listBranches(repoId: RepoId | string): OwnedBranchRecord[] {
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
