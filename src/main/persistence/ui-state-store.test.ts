import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeRepositoryService, makeTempRoot, openTempDatabase } from './persistence-test-fixtures'
import type { TempRoot } from './persistence-test-fixtures'
import { newRepoId, newSessionId, newWorkspaceId } from '../../shared/domain/ids'
import { DatabaseError } from './database'
import type { Database } from './database'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function setup(): {
  root: TempRoot
  db: Database
  stores: ReturnType<typeof makeRepositoryService>
} {
  const root = makeTempRoot('icode-ui-')
  cleanups.push(root.cleanup)
  const db = openTempDatabase(root)
  cleanups.push(() => db.close())
  return { root, db, stores: makeRepositoryService(db) }
}

describe('ui_state', () => {
  it('persists an active repository that exists', async () => {
    const { root, stores } = setup()
    const repoPath = join(root.dir, 'atlas')
    execFileSync('git', ['init', '-q', '-b', 'main', repoPath], { stdio: 'pipe' })
    const added = await stores.service.addRepository(repoPath)
    expect(stores.uiState.getActiveRepository()).toBe(added.repository.id)

    stores.uiState.setActiveRepository(null)
    expect(stores.uiState.getActiveRepository()).toBeNull()

    stores.uiState.setActiveRepository(added.repository.id)
    expect(stores.uiState.getActiveRepository()).toBe(added.repository.id)
  })

  it('rejects selecting a repository that is not stored', () => {
    const { stores } = setup()
    expect(() => stores.uiState.setActiveRepository(newRepoId())).toThrow(DatabaseError)
    try {
      stores.uiState.setActiveRepository(newRepoId())
    } catch (error) {
      expect((error as DatabaseError).appError.code).toBe('INVALID_ARGUMENT')
    }
  })

  it('rejects selecting a session that is not stored', () => {
    const { stores } = setup()
    expect(() => stores.uiState.setActiveSession(newSessionId())).toThrow(DatabaseError)
  })

  it('ignores malformed stored IDs instead of returning them', () => {
    const { db, stores } = setup()
    db.raw
      .prepare('INSERT INTO ui_state (key, value) VALUES (?, ?)')
      .run('activeRepositoryId', 'not-a-repo-id')
    expect(stores.uiState.getActiveRepository()).toBeNull()
  })

  it('accepts a stored session when its workspace exists', () => {
    const { db, stores } = setup()
    // Direct inserts establish FK-valid fixture rows without a session service.
    const repoId = newRepoId()
    const workspaceId = newWorkspaceId()
    const sessionId = newSessionId()
    db.raw
      .prepare('INSERT INTO repos (id, path, display_name, added_at, last_opened_at, current_branch, availability) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(repoId, '/tmp/atlas', 'atlas', 1, 1, 'main', 'present')
    db.raw
      .prepare('INSERT INTO workspaces (id, repo_id, path, kind, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(workspaceId, repoId, '/tmp/atlas', 'primary-checkout', 1)
    db.raw
      .prepare(`INSERT INTO sessions (id, workspace_id, harness, title, created_at, last_active_at,
        last_observed_state, last_observed_exit_code, last_observed_error_json,
        last_observed_incarnation_id, last_observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sessionId, workspaceId, 'claude', 'Session', 1, 1, 'exited', 0, null, null, 1)
    stores.uiState.setActiveSession(sessionId)
    expect(stores.uiState.getActiveSession()).toBe(sessionId)
  })
})
