import type { Database } from './database'
import type { RepoId, SessionId } from '../../shared/domain/ids'

/**
 * Durable supervisor identity.
 *
 * One binding per repository is the product rule; the primary key enforces it.
 * The control token lives here rather than in memory because a supervisor PTY
 * deliberately survives an app relaunch, and a per-run token would lock the
 * still-running session out after the next start.
 */
export type SupervisorBinding = {
  repoId: RepoId
  sessionId: SessionId
  controlToken: string
  initializedAt: number | null
  createdAt: number
  updatedAt: number
}

type BindingRow = {
  repo_id: string
  session_id: string
  control_token: string
  initialized_at: number | null
  created_at: number
  updated_at: number
}

function bindingFromRow(row: BindingRow): SupervisorBinding {
  return {
    repoId: row.repo_id as RepoId,
    sessionId: row.session_id as SessionId,
    controlToken: row.control_token,
    initializedAt: row.initialized_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class SupervisorStore {
  constructor(private readonly db: Database) {}

  findByRepo(repoId: RepoId): SupervisorBinding | null {
    const row = this.db.raw
      .prepare(`SELECT * FROM supervisor_bindings WHERE repo_id = ?`)
      .get(repoId) as BindingRow | undefined
    return row ? bindingFromRow(row) : null
  }

  findBySession(sessionId: SessionId): SupervisorBinding | null {
    const row = this.db.raw
      .prepare(`SELECT * FROM supervisor_bindings WHERE session_id = ?`)
      .get(sessionId) as BindingRow | undefined
    return row ? bindingFromRow(row) : null
  }

  findByToken(token: string): SupervisorBinding | null {
    const row = this.db.raw
      .prepare(`SELECT * FROM supervisor_bindings WHERE control_token = ?`)
      .get(token) as BindingRow | undefined
    return row ? bindingFromRow(row) : null
  }

  listAll(): SupervisorBinding[] {
    const rows = this.db.raw
      .prepare(`SELECT * FROM supervisor_bindings ORDER BY created_at ASC`)
      .all() as BindingRow[]
    return rows.map(bindingFromRow)
  }

  upsert(
    draft: {
      repoId: RepoId
      sessionId: SessionId
      controlToken: string
      initializedAt: number | null
    },
    now: number
  ): void {
    this.db.raw
      .prepare(
        `INSERT INTO supervisor_bindings
           (repo_id, session_id, control_token, initialized_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo_id) DO UPDATE SET
           session_id = excluded.session_id,
           control_token = excluded.control_token,
           initialized_at = excluded.initialized_at,
           updated_at = excluded.updated_at`
      )
      .run(
        draft.repoId,
        draft.sessionId,
        draft.controlToken,
        draft.initializedAt,
        now,
        now
      )
  }

  setInitialized(repoId: RepoId, initializedAt: number | null, now: number): void {
    this.db.raw
      .prepare(`UPDATE supervisor_bindings SET initialized_at = ?, updated_at = ? WHERE repo_id = ?`)
      .run(initializedAt, now, repoId)
  }

  deleteByRepo(repoId: RepoId): void {
    this.db.raw.prepare(`DELETE FROM supervisor_bindings WHERE repo_id = ?`).run(repoId)
  }

  deleteBySession(sessionId: SessionId): void {
    this.db.raw.prepare(`DELETE FROM supervisor_bindings WHERE session_id = ?`).run(sessionId)
  }

  recordAction(input: {
    repoId: RepoId
    sessionId: SessionId
    op: string
    taskId: string | null
    outcome: string
    detail?: unknown
    now: number
  }): void {
    this.db.raw
      .prepare(
        `INSERT INTO supervisor_actions
           (repo_id, session_id, op, task_id, outcome, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.repoId,
        input.sessionId,
        input.op,
        input.taskId,
        input.outcome,
        input.detail === undefined ? null : JSON.stringify(input.detail),
        input.now
      )
  }
}
