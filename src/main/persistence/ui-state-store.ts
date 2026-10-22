import type { Database } from './database'
import { makeAppError } from '../../shared/domain/errors'
import { DatabaseError } from './database'
import { parseRepoId, parseSessionId, type RepoId, type SessionId } from '../../shared/domain/ids'

/** Allowlisted keys only: this is not a general-purpose KV store. */
export const UI_STATE_KEYS = ['activeRepositoryId', 'activeSessionId'] as const
export type UiStateKey = (typeof UI_STATE_KEYS)[number]

export class UiStateStore {
  constructor(private readonly db: Database) {}

  get(key: UiStateKey): string | null {
    const row = this.db.raw
      .prepare('SELECT value FROM ui_state WHERE key = ?')
      .get(key) as { value?: unknown } | undefined
    return typeof row?.value === 'string' ? row.value : null
  }

  setActiveRepository(id: RepoId | null): void {
    if (id === null) {
      this.db.raw.prepare('DELETE FROM ui_state WHERE key = ?').run('activeRepositoryId')
      return
    }
    const exists = this.db.raw.prepare('SELECT 1 AS present FROM repos WHERE id = ?').get(id)
    if (!exists) {
      throw new DatabaseError(
        makeAppError('INVALID_ARGUMENT', 'Cannot select a repository that is not registered.', {
          context: { repoId: id }
        })
      )
    }
    this.db.raw
      .prepare('INSERT INTO ui_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('activeRepositoryId', id)
  }

  getActiveRepository(): RepoId | null {
    const value = this.get('activeRepositoryId')
    return value === null ? null : parseRepoId(value)
  }

  setActiveSession(id: SessionId | null): void {
    if (id === null) {
      this.db.raw.prepare('DELETE FROM ui_state WHERE key = ?').run('activeSessionId')
      return
    }
    const exists = this.db.raw.prepare('SELECT 1 AS present FROM sessions WHERE id = ?').get(id)
    if (!exists) {
      throw new DatabaseError(
        makeAppError('INVALID_ARGUMENT', 'Cannot select a session that is not stored.', {
          context: { sessionId: id }
        })
      )
    }
    this.db.raw
      .prepare('INSERT INTO ui_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('activeSessionId', id)
  }

  getActiveSession(): SessionId | null {
    const value = this.get('activeSessionId')
    return value === null ? null : parseSessionId(value)
  }
}
