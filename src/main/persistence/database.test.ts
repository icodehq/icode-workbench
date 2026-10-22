import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseError, openDatabase, runMigrations } from './database'
import { MIGRATIONS } from './migrations'
import { RepositoryStore } from './repository-store'
import { SessionStore } from './session-store'
import { WorktreeStore } from './worktree-store'
import { makeTempRoot, openTempDatabase, type TempRoot } from './persistence-test-fixtures'
import { newRepoId, newSessionId, newWorkspaceId } from '../../shared/domain/ids'
import { toCanonicalRepositoryPath } from '../../shared/domain/paths'
import { reconcileSessionState } from '../../shared/domain/session'

const cleanups: Array<() => void> = []

function tempRoot(): TempRoot {
  const root = makeTempRoot()
  cleanups.push(root.cleanup)
  return root
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

describe('database initialization', () => {
  it('creates a fresh database at schema version 2', () => {
    const root = tempRoot()
    const db = openTempDatabase(root)
    expect(db.userVersion()).toBe(2)
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>
    expect(tables.map((row) => row.name)).toEqual([
      'repos',
      'session_worktrees',
      'sessions',
      'sqlite_sequence',
      'ui_state',
      'workspaces',
      'worktree_branches'
    ].filter((name) => name !== 'sqlite_sequence'))
    db.close()
    expect(db.isClosed()).toBe(true)
  })

  it('applies the required pragmas and verifies them', () => {
    const root = tempRoot()
    const db = openTempDatabase(root)
    expect(db.pragmaValue('journal_mode')).toMatchObject({ journal_mode: 'wal' })
    expect(db.pragmaValue('foreign_keys')).toMatchObject({ foreign_keys: 1 })
    expect(db.pragmaValue('busy_timeout')).toMatchObject({ timeout: 5000 })
    expect(db.pragmaValue('synchronous')).toMatchObject({ synchronous: 1 })
    expect(() => db.assertHealthy()).not.toThrow()
    db.close()
  })

  it('closes idempotently', () => {
    const root = tempRoot()
    const db = openTempDatabase(root)
    db.close()
    expect(() => db.close()).not.toThrow()
    expect(db.isClosed()).toBe(true)
  })

  it('reopens durable records and keeps the schema version', () => {
    const root = tempRoot()
    const path = join(root.dir, 'ade.sqlite')
    const first = openTempDatabase(root)
    const repositories = new RepositoryStore(first)
    repositories.insert({
      id: newRepoId(),
      path: toCanonicalRepositoryPath(root.dir),
      displayName: 'atlas',
      addedAt: 1,
      lastOpenedAt: 2,
      currentBranch: 'main',
      availability: 'present',
      gitCommonDir: null
    })
    first.close()

    const second = openDatabase({ path, migrations: MIGRATIONS })
    expect(second.userVersion()).toBe(2)
    expect(new RepositoryStore(second).list()).toHaveLength(1)
    second.close()
  })

  it('refuses to open a database written by a newer schema', () => {
    const root = tempRoot()
    const path = join(root.dir, 'ade.sqlite')
    const db = openTempDatabase(root)
    db.raw.exec('PRAGMA user_version = 99')
    db.close()

    expect(() => openDatabase({ path, migrations: MIGRATIONS })).toThrow(DatabaseError)
    expect(existsSync(path)).toBe(true)
  })
})

describe('transactions', () => {
  it('commits and rolls back explicitly', () => {
    const root = tempRoot()
    const db = openTempDatabase(root)
    const repositories = new RepositoryStore(db)

    db.transaction(() => {
      repositories.insert({
        id: newRepoId(),
        path: toCanonicalRepositoryPath('/tmp/committed'),
        displayName: 'committed',
        addedAt: 1,
        lastOpenedAt: 1,
        currentBranch: null,
        availability: 'present',
      gitCommonDir: null
      })
    })
    expect(repositories.list()).toHaveLength(1)

    expect(() =>
      db.transaction(() => {
        repositories.insert({
          id: newRepoId(),
          path: toCanonicalRepositoryPath('/tmp/rolled-back'),
          displayName: 'rolled-back',
          addedAt: 2,
          lastOpenedAt: 2,
          currentBranch: null,
          availability: 'present',
      gitCommonDir: null
        })
        throw new Error('abort')
      })
    ).toThrow('abort')
    expect(repositories.list()).toHaveLength(1)
    expect(repositories.findByPath('/tmp/rolled-back')).toBeNull()
    db.close()
  })
})

describe('foreign keys', () => {
  it('rejects a workspace that references an unknown repository', () => {
    const root = tempRoot()
    const db = openTempDatabase(root)
    const repositories = new RepositoryStore(db)
    expect(() =>
      repositories.insertWorkspace({
        id: newWorkspaceId(),
        repoId: newRepoId(),
        path: toCanonicalRepositoryPath('/tmp/orphan'),
        kind: 'primary-checkout',
        createdAt: 1
      })
    ).toThrow(/FOREIGN KEY/i)
    db.close()
  })

  it('cascades repository deletion to workspaces and sessions', () => {
    const root = tempRoot()
    const db = openTempDatabase(root)
    const repositories = new RepositoryStore(db)
    const sessions = new SessionStore(db)
    const repoId = newRepoId()
    const workspaceId = newWorkspaceId()
    repositories.insert({
      id: repoId,
      path: toCanonicalRepositoryPath('/tmp/cascade'),
      displayName: 'cascade',
      addedAt: 1,
      lastOpenedAt: 1,
      currentBranch: 'main',
      availability: 'present',
      gitCommonDir: null
    })
    repositories.insertWorkspace({
      id: workspaceId,
      repoId,
      path: toCanonicalRepositoryPath('/tmp/cascade'),
      kind: 'primary-checkout',
      createdAt: 1
    })
    sessions.insert({
      id: newSessionId(),
      workspaceId,
      harness: 'claude',
      title: 'Session',
      createdAt: 1,
      lastActiveAt: 1,
      observation: {
        lastObservedState: 'live',
        lastObservedExitCode: null,
        lastObservedError: null,
        lastObservedIncarnationId: null,
        lastObservedAt: 1
      }
    })
    expect(repositories.delete(repoId)).toBe(1)
    expect(repositories.workspaceForRepo(repoId)).toBeNull()
    expect(sessions.listForRepo(repoId)).toHaveLength(0)
    db.close()
  })
})

describe('persisted session state is historical', () => {
  it('round-trips an observation without claiming liveness', () => {
    const root = tempRoot()
    const db = openTempDatabase(root)
    const repositories = new RepositoryStore(db)
    const sessions = new SessionStore(db)
    const repoId = newRepoId()
    const workspaceId = newWorkspaceId()
    repositories.insert({
      id: repoId,
      path: toCanonicalRepositoryPath('/tmp/history'),
      displayName: 'history',
      addedAt: 1,
      lastOpenedAt: 1,
      currentBranch: null,
      availability: 'present',
      gitCommonDir: null
    })
    repositories.insertWorkspace({
      id: workspaceId,
      repoId,
      path: toCanonicalRepositoryPath('/tmp/history'),
      kind: 'primary-checkout',
      createdAt: 1
    })
    const sessionId = newSessionId()
    sessions.insert({
      id: sessionId,
      workspaceId,
      harness: 'codex',
      title: 'Historical live',
      createdAt: 1,
      lastActiveAt: 2,
      observation: {
        lastObservedState: 'live',
        lastObservedExitCode: null,
        lastObservedError: null,
        lastObservedIncarnationId: null,
        lastObservedAt: 2
      }
    })

    const stored = sessions.findById(sessionId)
    expect(stored?.observation.lastObservedState).toBe('live')
    const reconciled = reconcileSessionState(stored!.observation, { reachable: false })
    expect(reconciled.state).toBe('unavailable')
    expect(reconciled.authority).toBe('unreachable')
    db.close()
  })
})

describe('corruption handling', () => {
  it('preserves a non-SQLite file byte-for-byte and reports DB_CORRUPT', () => {
    const root = tempRoot()
    const path = join(root.dir, 'ade.sqlite')
    writeFileSync(path, Buffer.from('this is not a sqlite database'.repeat(64)))
    const before = sha256(path)

    let caught: unknown
    try {
      openDatabase({ path, migrations: MIGRATIONS })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(DatabaseError)
    expect((caught as DatabaseError).appError.code).toBe('DB_CORRUPT')
    expect((caught as DatabaseError).appError.context?.path).toBe(path)
    expect((caught as DatabaseError).appError.detail).toContain('preserved')
    expect(existsSync(path)).toBe(true)
    expect(sha256(path)).toBe(before)
  })

  it('preserves a truncated SQLite database byte-for-byte', () => {
    const root = tempRoot()
    const path = join(root.dir, 'ade.sqlite')
    const db = openTempDatabase(root)
    db.close()
    const full = readFileSync(path)
    const truncated = full.subarray(0, Math.max(200, Math.floor(full.length / 2)))
    writeFileSync(path, truncated)
    const before = sha256(path)

    expect(() => openDatabase({ path, migrations: MIGRATIONS })).toThrow(DatabaseError)
    expect(existsSync(path)).toBe(true)
    expect(sha256(path)).toBe(before)
    expect(readFileSync(path).length).toBe(truncated.length)
  })

  it('preserves a zero-byte database file instead of treating it as new', () => {
    const root = tempRoot()
    const path = join(root.dir, 'ade.sqlite')
    writeFileSync(path, Buffer.alloc(0))
    expect(() => openDatabase({ path, migrations: MIGRATIONS })).toThrow(DatabaseError)
    expect(readFileSync(path).length).toBe(0)
  })

  it('does not recreate the database after a corrupt open', () => {
    const root = tempRoot()
    const path = join(root.dir, 'ade.sqlite')
    writeFileSync(path, Buffer.from('garbage'.repeat(20)))
    const before = sha256(path)
    expect(() => openDatabase({ path, migrations: MIGRATIONS })).toThrow(DatabaseError)
    expect(sha256(path)).toBe(before)
    expect(() => openDatabase({ path, migrations: MIGRATIONS })).toThrow(DatabaseError)
    expect(sha256(path)).toBe(before)
  })
})

describe('migrations', () => {
  it('rolls back a failing migration without changing user_version or schema', () => {
    const root = tempRoot()
    const path = join(root.dir, 'ade.sqlite')
    const db = new DatabaseSync(path)
    db.exec('PRAGMA journal_mode = WAL')
    const migrations = [
      {
        version: 1,
        name: 'create-t1',
        statements: ['CREATE TABLE t1 (id INTEGER PRIMARY KEY)']
      },
      {
        version: 2,
        name: 'fails-after-t2',
        statements: [
          'CREATE TABLE t2 (id INTEGER PRIMARY KEY)',
          'INSERT INTO missing_table (id) VALUES (1)'
        ]
      }
    ]
    expect(() => runMigrations(db, migrations)).toThrow(/fails-after-t2/)
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
    // The failing migration rolled back; only version 1 remains committed.
    expect(version.user_version).toBe(1)
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>
    expect(tables.map((row) => row.name)).toEqual(['t1'])
    db.close()
  })

  it('reports migration failure through openDatabase without partial schema', () => {
    const root = tempRoot()
    const path = join(root.dir, 'ade.sqlite')
    const migrations = [
      { version: 1, name: 'ok', statements: ['CREATE TABLE ok_table (id INTEGER PRIMARY KEY)'] },
      {
        version: 2,
        name: 'broken',
        statements: ['CREATE TABLE broken_table (id INTEGER PRIMARY KEY)', 'SELECT * FROM nope']
      }
    ]
    expect(() => openDatabase({ path, migrations })).toThrow(DatabaseError)
    const inspect = new DatabaseSync(path, { readOnly: true })
    const version = inspect.prepare('PRAGMA user_version').get() as { user_version: number }
    // Only migration 1 committed; the failing migration 2 rolled back.
    expect(version.user_version).toBe(1)
    const tables = inspect
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>
    expect(tables.map((row) => row.name)).toEqual(['ok_table'])
    inspect.close()
  })

  it('upgrades a v1 database without touching existing repository and session rows', () => {
    const root = tempRoot()
    const path = join(root.dir, 'ade.sqlite')
    const v1 = openDatabase({ path, migrations: [MIGRATIONS[0]!] })
    const repoId = newRepoId()
    const workspaceId = newWorkspaceId()
    const sessionId = newSessionId()
    // Raw v1 inserts: a real v1 database predates `git_common_dir`.
    v1.raw
      .prepare(
        `INSERT INTO repos (id, path, display_name, added_at, last_opened_at, current_branch, availability)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(repoId, '/tmp/legacy', 'legacy', 1, 1, 'main', 'present')
    v1.raw
      .prepare(
        `INSERT INTO workspaces (id, repo_id, path, kind, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(workspaceId, repoId, '/tmp/legacy', 'primary-checkout', 1)
    v1.raw
      .prepare(
        `INSERT INTO sessions (id, workspace_id, harness, title, created_at, last_active_at,
           last_observed_state, last_observed_exit_code, last_observed_error_json,
           last_observed_incarnation_id, last_observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(sessionId, workspaceId, 'shell', 'legacy session', 1, 1, 'exited', 0, null, null, 1)
    v1.close()

    const v2 = openDatabase({ path, migrations: MIGRATIONS })
    expect(v2.userVersion()).toBe(2)
    const repositoriesV2 = new RepositoryStore(v2)
    const sessionsV2 = new SessionStore(v2)
    expect(repositoriesV2.findById(repoId)).toMatchObject({
      displayName: 'legacy',
      gitCommonDir: null
    })
    expect(repositoriesV2.workspaceForRepo(repoId)?.id).toBe(workspaceId)
    expect(sessionsV2.findById(sessionId)).toMatchObject({ title: 'legacy session' })
    expect(new WorktreeStore(v2).listAll()).toEqual([])
    v2.close()
  })

  it('rejects a migration gap', () => {
    const root = tempRoot()
    const db = new DatabaseSync(join(root.dir, 'gap.db'))
    expect(() =>
      runMigrations(db, [
        { version: 1, name: 'one', statements: ['CREATE TABLE a (id INTEGER)'] },
        { version: 3, name: 'three', statements: ['CREATE TABLE c (id INTEGER)'] }
      ])
    ).toThrow(/Migration gap/)
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
    expect(version.user_version).toBe(0)
    db.close()
  })

  it('creates the approved schema only', () => {
    const root = tempRoot()
    const db = openTempDatabase(root)
    const indexes = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>
    expect(indexes.map((row) => row.name)).toEqual([
      'session_worktrees_repo_idx',
      'sessions_workspace_idx',
      'workspaces_repo_idx',
      'worktree_branches_repo_idx'
    ])
    db.close()
  })

  it('is compatible with a real git-created fixture path', () => {
    const root = tempRoot()
    const repo = join(root.dir, 'repo')
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' })
    const db = openTempDatabase(root)
    expect(db.userVersion()).toBe(2)
    db.close()
  })
})
