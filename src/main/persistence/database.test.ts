import { LOCAL_EXECUTION_TARGET } from '../../shared/domain/repository'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseError, SCHEMA_VERSION, openDatabase, runMigrations } from './database'
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
  it('creates a fresh database at the latest schema version', () => {
    const root = tempRoot()
    const db = openTempDatabase(root)
    expect(db.userVersion()).toBe(SCHEMA_VERSION)
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>
    expect(tables.map((row) => row.name)).toEqual([
      // v9: the global assistant thread and its audit trail.
      // v11: the rotating native conversation owned by that thread.
      'assistant_actions',
      'assistant_conversations',
      'assistant_memory',
      'assistant_messages',
      'assistant_runs',
      'assistant_settings',
      'assistant_threads',
      // v13: per-harness provider configuration and its selection.
      'harness_provider_selection',
      // v16: durable merge claims and audit trail.
      'merge_records',
      'providers',
      // v4: durable work lives beside sessions, not inside them.
      'repos',
      'session_worktrees',
      'sessions',
      'sqlite_sequence',
      'supervisor_actions',
      'supervisor_bindings',
      // v14: ordering edges between tasks.
      'task_dependencies',
      'task_occurrences',
      'task_schedules',
      'task_settings',
      'tasks',
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
    const path = join(root.dir, 'icode.sqlite')
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
      gitCommonDir: null,
      executionTarget: LOCAL_EXECUTION_TARGET
    })
    first.close()

    const second = openDatabase({ path, migrations: MIGRATIONS })
    expect(second.userVersion()).toBe(SCHEMA_VERSION)
    expect(new RepositoryStore(second).list()).toHaveLength(1)
    second.close()
  })

  it('round-trips background preparation state without losing the repository', () => {
    const root = tempRoot()
    const path = join(root.dir, 'icode.sqlite')
    const db = openDatabase({ path, migrations: MIGRATIONS })
    const repositories = new RepositoryStore(db)
    const id = newRepoId()
    repositories.insert({
      id,
      path: toCanonicalRepositoryPath(root.dir),
      displayName: 'atlas',
      addedAt: 1,
      lastOpenedAt: 2,
      currentBranch: null,
      availability: 'present',
      gitCommonDir: null,
      executionTarget: LOCAL_EXECUTION_TARGET,
      preparation: {
        state: 'preparing',
        startedAt: 10,
        finishedAt: null,
        committedFiles: null,
        skippedFolders: ['node_modules/'],
        error: null
      }
    })

    expect(repositories.findById(id)?.preparation).toMatchObject({
      state: 'preparing',
      skippedFolders: ['node_modules/']
    })

    repositories.updatePreparation(id, {
      state: 'ready',
      startedAt: 10,
      finishedAt: 20,
      committedFiles: 7,
      skippedFolders: ['node_modules/'],
      error: null
    })
    db.close()

    const reopened = openDatabase({ path, migrations: MIGRATIONS })
    expect(new RepositoryStore(reopened).findById(id)?.preparation).toMatchObject({
      state: 'ready',
      committedFiles: 7
    })
    reopened.close()
  })

  it('refuses to open a database written by a newer schema', () => {
    const root = tempRoot()
    const path = join(root.dir, 'icode.sqlite')
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
      gitCommonDir: null,
      executionTarget: LOCAL_EXECUTION_TARGET
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
      gitCommonDir: null,
      executionTarget: LOCAL_EXECUTION_TARGET
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
      gitCommonDir: null,
      executionTarget: LOCAL_EXECUTION_TARGET
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
      gitCommonDir: null,
      executionTarget: LOCAL_EXECUTION_TARGET
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
    const path = join(root.dir, 'icode.sqlite')
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
    const path = join(root.dir, 'icode.sqlite')
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
    const path = join(root.dir, 'icode.sqlite')
    writeFileSync(path, Buffer.alloc(0))
    expect(() => openDatabase({ path, migrations: MIGRATIONS })).toThrow(DatabaseError)
    expect(readFileSync(path).length).toBe(0)
  })

  it('does not recreate the database after a corrupt open', () => {
    const root = tempRoot()
    const path = join(root.dir, 'icode.sqlite')
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
    const path = join(root.dir, 'icode.sqlite')
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
    const path = join(root.dir, 'icode.sqlite')
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
    const path = join(root.dir, 'icode.sqlite')
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
    expect(v2.userVersion()).toBe(SCHEMA_VERSION)
    const repositoriesV2 = new RepositoryStore(v2)
    const sessionsV2 = new SessionStore(v2)
    expect(repositoriesV2.findById(repoId)).toMatchObject({
      displayName: 'legacy',
      gitCommonDir: null,
      executionTarget: LOCAL_EXECUTION_TARGET
    })
    expect(repositoriesV2.workspaceForRepo(repoId)?.id).toBe(workspaceId)
    expect(sessionsV2.findById(sessionId)).toMatchObject({ title: 'legacy session' })
    expect(new WorktreeStore(v2).listAll()).toEqual([])
    v2.close()
  })

  it('preserves pre-v16 task and branch rows while adding merge gating', () => {
    const root = tempRoot()
    const path = join(root.dir, 'v16.sqlite')
    const v15 = openDatabase({ path, migrations: MIGRATIONS.slice(0, 15) })
    v15.raw
      .prepare(
        `INSERT INTO repos
           (id, path, display_name, added_at, last_opened_at, current_branch, availability)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run('repo_legacy', '/tmp/legacy', 'legacy', 1, 1, 'main', 'present')
    v15.raw
      .prepare(
        `INSERT INTO tasks
           (id, workspace_id, repo_id, title, prompt, harness, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('task_legacy', 'ws_legacy', 'repo_legacy', 'legacy', 'prompt', 'claude', 'queued', 1, 1)
    v15.raw
      .prepare(
        `INSERT INTO worktree_branches (branch, repo_id, session_id, base_oid, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run('icode/ses_legacy', 'repo_legacy', 'ses_legacy', 'a'.repeat(40), 1)
    v15.close()

    const v16 = openDatabase({ path, migrations: MIGRATIONS })
    expect(v16.userVersion()).toBe(SCHEMA_VERSION)
    expect(
      v16.raw
        .prepare(
          `SELECT chain_gate, chain_branch, start_from FROM tasks WHERE id = 'task_legacy'`
        )
        .get()
    ).toEqual({ chain_gate: 'legacy', chain_branch: null, start_from: null })
    expect(
      v16.raw
        .prepare(
          `SELECT kind, session_id, task_id FROM worktree_branches
           WHERE branch = 'icode/ses_legacy'`
        )
        .get()
    ).toEqual({ kind: 'session', session_id: 'ses_legacy', task_id: null })
    v16.close()
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
      // v9: assistant thread ordering, unread watermarks and notification
      // dedupe, plus Mira task provenance.
      'assistant_actions_repo_created_idx',
      'assistant_actions_run_idx',
      'assistant_conversations_active_idx',
      'assistant_conversations_thread_created_idx',
      'assistant_conversations_thread_seq_idx',
      'assistant_messages_dedupe_idx',
      'assistant_messages_thread_created_idx',
      'assistant_messages_thread_seq_idx',
      'assistant_runs_status_idx',
      'assistant_runs_thread_started_idx',
      'assistant_threads_main_idx',
      'assistant_threads_updated_idx',
      // v16: durable merge claims and audit trail.
      'merge_records_active_session_idx',
      'merge_records_active_target_idx',
      'merge_records_session_idx',
      'merge_records_target_idx',
      // v13: provider lookup per harness.
      'providers_harness_idx',
      // v3: one uniqueness rule per execution target, plus the host-kind lookup
      // index. The partial unique indexes are what allow the same path string on
      // two targets while still refusing a duplicate within one.
      'repos_host_kind_idx',
      'repos_local_path_idx',
      'repos_wsl_name_path_idx',
      'repos_wsl_registration_path_idx',
      'session_worktrees_repo_idx',
      'sessions_workspace_idx',
      // v8: supervisor actions and the approval queue.
      'supervisor_actions_repo_created_idx',
      // v14: the reverse edge lookup used by readiness and successor re-pointing.
      'task_dependencies_depends_on_idx',
      // v4: the queue's own access paths, and the occurrence receipt that makes
      // duplicate triggers a database answer rather than a memory one.
      'task_occurrences_schedule_idx',
      'task_schedules_enabled_idx',
      'tasks_actor_created_idx',
      'tasks_approval_status_created_idx',
      // v10: the archived working-list split.
      'tasks_archived_updated_idx',
      'tasks_chain_branch_idx',
      'tasks_previous_idx',
      'tasks_repo_created_idx',
      // v5: review state is read per queue view and per retry chain.
      'tasks_review_idx',
      'tasks_schedule_idx',
      'tasks_session_idx',
      'tasks_status_created_idx',
      'workspaces_repo_idx',
      'worktree_branches_repo_idx',
      'worktree_branches_task_idx'
    ])
    db.close()
  })

  it('is compatible with a real git-created fixture path', () => {
    const root = tempRoot()
    const repo = join(root.dir, 'repo')
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' })
    const db = openTempDatabase(root)
    expect(db.userVersion()).toBe(SCHEMA_VERSION)
    db.close()
  })
})

/**
 * The execution-target contract, exercised at the database boundary.
 *
 * These assert the *index* semantics rather than the service's convenience
 * wrappers: the service can only be as correct as the uniqueness the schema
 * enforces underneath it.
 */
describe('execution target schema (v3)', () => {
  const wsl = (distro: string, distroId: string | null) =>
    ({ kind: 'wsl', distro, distroId }) as const

  function repoAt(path: string, target: ReturnType<typeof wsl> | typeof LOCAL_EXECUTION_TARGET) {
    return {
      id: newRepoId(),
      path: toCanonicalRepositoryPath(path),
      displayName: 'n',
      addedAt: 1,
      lastOpenedAt: 1,
      currentBranch: null,
      availability: 'present' as const,
      gitCommonDir: null,
      executionTarget: target
    }
  }

  it('allows the same path on distinct execution targets', () => {
    const db = openTempDatabase(tempRoot())
    const store = new RepositoryStore(db)
    store.insert(repoAt('/repo', LOCAL_EXECUTION_TARGET))
    store.insert(repoAt('/repo', wsl('Ubuntu-A', 'guid-a')))
    store.insert(repoAt('/repo', wsl('Ubuntu-B', 'guid-b')))
    expect(store.list()).toHaveLength(3)
    expect(store.findByPath('/repo', LOCAL_EXECUTION_TARGET)?.executionTarget).toEqual(
      LOCAL_EXECUTION_TARGET
    )
    expect(store.findByPath('/repo', wsl('Ubuntu-A', 'guid-a'))?.executionTarget).toEqual(
      wsl('Ubuntu-A', 'guid-a')
    )
    db.close()
  })

  it('deduplicates a renamed distro by registration id, not by name', () => {
    const db = openTempDatabase(tempRoot())
    const store = new RepositoryStore(db)
    store.insert(repoAt('/repo', wsl('Ubuntu-Old', 'guid-a')))
    // Same registration, renamed: the lookup must still find the original row.
    expect(store.findByPath('/repo', wsl('Ubuntu-Renamed', 'guid-a'))).not.toBeNull()
    // A genuinely different registration is a different target.
    expect(store.findByPath('/repo', wsl('Ubuntu-Renamed', 'guid-b'))).toBeNull()
    db.close()
  })

  it('uses the distro name only when no registration id exists', () => {
    const db = openTempDatabase(tempRoot())
    const store = new RepositoryStore(db)
    store.insert(repoAt('/repo', wsl('Ubuntu-A', null)))
    expect(store.findByPath('/repo', wsl('Ubuntu-A', null))).not.toBeNull()
    // An id-bearing target is never matched against an id-less row.
    expect(store.findByPath('/repo', wsl('Ubuntu-A', 'guid-a'))).toBeNull()
    db.close()
  })

  it('rejects a duplicate within one target at the database boundary', () => {
    const db = openTempDatabase(tempRoot())
    const store = new RepositoryStore(db)
    store.insert(repoAt('/repo', LOCAL_EXECUTION_TARGET))
    expect(() => store.insert(repoAt('/repo', LOCAL_EXECUTION_TARGET))).toThrow(/UNIQUE/)
    db.close()
  })

  it('rejects invalid target combinations at the schema boundary', () => {
    const db = openTempDatabase(tempRoot())
    // The record type cannot express these, so they are driven through raw SQL.
    const insert = (hostKind: string, distro: string, distroId: string | null) =>
      db.raw
        .prepare(
          `INSERT INTO repos (id, path, display_name, added_at, last_opened_at, current_branch,
             availability, git_common_dir, host_kind, wsl_distro, wsl_distro_id)
           VALUES (?, ?, 'n', 1, 1, NULL, 'present', NULL, ?, ?, ?)`
        )
        .run(newRepoId(), `/p-${Math.random()}`, hostKind, distro, distroId)

    // wsl requires a distro name
    expect(() => insert('wsl', '', null)).toThrow(/CHECK/)
    // local must not carry a distro name
    expect(() => insert('local', 'Ubuntu-A', null)).toThrow(/CHECK/)
    // local must not carry a registration id
    expect(() => insert('local', '', 'guid-a')).toThrow(/CHECK/)
    // unknown host kind
    expect(() => insert('ssh', 'Ubuntu-A', null)).toThrow(/CHECK/)
    // the valid shapes are accepted
    expect(() => insert('local', '', null)).not.toThrow()
    expect(() => insert('wsl', 'Ubuntu-A', 'guid-a')).not.toThrow()
    expect(() => insert('wsl', 'Ubuntu-A', null)).not.toThrow()
    db.close()
  })

  it('rolls a failed rebuild back to v2 with child rows and foreign keys intact', () => {
    const root = tempRoot()
    const path = join(root.dir, 'icode.sqlite')
    const v2 = openDatabase({ path, migrations: [MIGRATIONS[0]!, MIGRATIONS[1]!] })
    const repoId = newRepoId()
    const workspaceId = newWorkspaceId()
    const sessionId = newSessionId()
    v2.raw
      .prepare(
        `INSERT INTO repos (id, path, display_name, added_at, last_opened_at, current_branch,
           availability, git_common_dir) VALUES (?, ?, ?, 1, 1, NULL, 'present', NULL)`
      )
      .run(repoId, '/tmp/keep', 'keep')
    v2.raw
      .prepare(`INSERT INTO workspaces (id, repo_id, path, kind, created_at) VALUES (?, ?, ?, ?, 1)`)
      .run(workspaceId, repoId, '/tmp/keep', 'primary-checkout')
    v2.raw
      .prepare(
        `INSERT INTO sessions (id, workspace_id, harness, title, created_at, last_active_at,
           last_observed_state, last_observed_exit_code, last_observed_error_json,
           last_observed_incarnation_id, last_observed_at)
         VALUES (?, ?, 'shell', 'keep', 1, 1, 'exited', 0, NULL, NULL, 1)`
      )
      .run(sessionId, workspaceId)
    expect(v2.userVersion()).toBe(2)
    v2.close()

    // A v3 that rebuilds and then fails: the rebuild must not commit.
    const brokenV3 = {
      version: 3,
      name: 'broken-execution-target',
      rebuildsReferencedTable: true,
      statements: [
        `CREATE TABLE repos_new (id TEXT PRIMARY KEY NOT NULL, path TEXT NOT NULL, display_name TEXT NOT NULL, added_at INTEGER NOT NULL, last_opened_at INTEGER NOT NULL, current_branch TEXT, availability TEXT NOT NULL, git_common_dir TEXT, host_kind TEXT NOT NULL DEFAULT 'local', wsl_distro TEXT NOT NULL DEFAULT '', wsl_distro_id TEXT) STRICT`,
        `INSERT INTO repos_new SELECT id, path, display_name, added_at, last_opened_at, current_branch, availability, git_common_dir, 'local', '', NULL FROM repos`,
        `DROP TABLE repos`,
        `ALTER TABLE repos_new RENAME TO repos`,
        'SELECT * FROM does_not_exist'
      ]
    }
    expect(() =>
      openDatabase({ path, migrations: [MIGRATIONS[0]!, MIGRATIONS[1]!, brokenV3] })
    ).toThrow(DatabaseError)

    const inspect = new DatabaseSync(path, { readOnly: true })
    const version = inspect.prepare('PRAGMA user_version').get() as { user_version: number }
    expect(version.user_version).toBe(2)
    const counts = (table: string) =>
      (inspect.prepare(`SELECT count(*) c FROM ${table}`).get() as { c: number }).c
    expect(counts('repos')).toBe(1)
    expect(counts('workspaces')).toBe(1)
    expect(counts('sessions')).toBe(1)
    // The rebuilt table must not have survived the rollback.
    const tables = inspect
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('repos','repos_new')")
      .all() as Array<{ name: string }>
    expect(tables.map((r) => r.name)).toEqual(['repos'])
    inspect.close()
  })

  it('restores foreign-key enforcement after a rebuild migration', () => {
    const db = openTempDatabase(tempRoot())
    const fk = db.raw.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }
    expect(fk.foreign_keys).toBe(1)
    db.close()
  })
})
