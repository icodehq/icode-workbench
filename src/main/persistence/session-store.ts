import type { Database } from './database'
import { sessionFromRow, type SessionRow, type StoredSession } from './rows'
import type { AppError } from '../../shared/domain/errors'
import type { HarnessId } from '../../shared/domain/harness'
import type { PtyIncarnationId, SessionId, WorkspaceId } from '../../shared/domain/ids'
import type {
  PersistedSessionObservation,
  SessionLifecycleState,
  SessionRole
} from '../../shared/domain/session'

export type SessionMetadataDraft = {
  id: SessionId
  workspaceId: WorkspaceId
  harness: HarnessId
  title: string
  role?: SessionRole
  createdAt: number
  lastActiveAt: number
  observation: PersistedSessionObservation
}

const SESSION_COLUMNS = `id, workspace_id, harness, title, role, created_at, last_active_at,
  last_observed_state, last_observed_exit_code, last_observed_error_json,
  last_observed_incarnation_id, last_observed_at, sleeping_at, resume_token`

/**
 * Session rows are durable *observations*, not liveness. Work 5 must reconcile
 * them with the host before showing `live` or accepting input.
 */
export class SessionStore {
  constructor(private readonly db: Database) {}

  insert(draft: SessionMetadataDraft): void {
    const error: AppError | null = draft.observation.lastObservedError
    this.db.raw
      .prepare(
        `INSERT INTO sessions (${SESSION_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`
      )
      .run(
        draft.id,
        draft.workspaceId,
        draft.harness,
        draft.title,
        draft.role ?? 'interactive',
        draft.createdAt,
        draft.lastActiveAt,
        draft.observation.lastObservedState,
        draft.observation.lastObservedExitCode,
        error ? JSON.stringify(error) : null,
        draft.observation.lastObservedIncarnationId,
        draft.observation.lastObservedAt
      )
  }

  findById(id: SessionId): StoredSession | null {
    const row = this.db.raw
      .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`)
      .get(id) as SessionRow | undefined
    return row ? sessionFromRow(row) : null
  }

  listAll(): StoredSession[] {
    const rows = this.db.raw
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM sessions ORDER BY created_at ASC, id ASC`
      )
      .all() as SessionRow[]
    return rows.map(sessionFromRow)
  }

  listForWorkspace(workspaceId: WorkspaceId): StoredSession[] {
    const rows = this.db.raw
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM sessions WHERE workspace_id = ?
         ORDER BY created_at ASC, id ASC`
      )
      .all(workspaceId) as SessionRow[]
    return rows.map(sessionFromRow)
  }

  listForRepo(repoId: string): StoredSession[] {
    const rows = this.db.raw
      .prepare(
        `SELECT s.id, s.workspace_id, s.harness, s.title, s.role, s.created_at, s.last_active_at,
                s.last_observed_state, s.last_observed_exit_code, s.last_observed_error_json,
                s.last_observed_incarnation_id, s.last_observed_at, s.sleeping_at,
                s.resume_token
         FROM sessions s
         JOIN workspaces w ON w.id = s.workspace_id
         WHERE w.repo_id = ?
         ORDER BY s.created_at ASC, s.id ASC`
      )
      .all(repoId) as SessionRow[]
    return rows.map(sessionFromRow)
  }

  delete(id: SessionId): number {
    const result = this.db.raw.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    return Number(result.changes)
  }

  recordObservation(id: SessionId, observation: PersistedSessionObservation): void {
    this.db.raw
      .prepare(
        `UPDATE sessions
         SET last_observed_state = ?, last_observed_exit_code = ?,
             last_observed_error_json = ?, last_observed_incarnation_id = ?,
             last_observed_at = ?
         WHERE id = ?`
      )
      .run(
        observation.lastObservedState,
        observation.lastObservedExitCode,
        observation.lastObservedError ? JSON.stringify(observation.lastObservedError) : null,
        observation.lastObservedIncarnationId,
        observation.lastObservedAt,
        id
      )
  }

  setSleeping(id: SessionId, sleepingAt: number | null): void {
    this.db.raw
      .prepare('UPDATE sessions SET sleeping_at = ? WHERE id = ?')
      .run(sleepingAt, id)
  }

  setResumeToken(id: SessionId, resumeToken: string | null): void {
    this.db.raw
      .prepare('UPDATE sessions SET resume_token = ? WHERE id = ?')
      .run(resumeToken, id)
  }
}

export type DeletionSessionSummary = {
  id: SessionId
  harness: HarnessId
  title: string
  /** Historical observation only. Never a liveness verdict. */
  lastObservedState: SessionLifecycleState
  lastObservedIncarnationId: PtyIncarnationId | null
  lastObservedAt: number
}
