import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { openDatabase, SCHEMA_VERSION, type Database } from './database'
import { MIGRATIONS } from './migrations'
import { makeTempRoot, type TempRoot } from './persistence-test-fixtures'
import { newProviderRowId } from '../../shared/schemas/provider'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function tempPath(): { root: TempRoot; path: string } {
  const root = makeTempRoot('icode-migrations-')
  cleanups.push(root.cleanup)
  return { root, path: join(root.dir, 'icode.sqlite') }
}

function closeAfter(db: Database): void {
  cleanups.push(() => {
    if (!db.isClosed()) db.close()
  })
}

const PROVIDER_ID = 'prv_00000000-0000-4000-8000-000000000001'

function seedV19(path: string): void {
  const db = openDatabase({
    path,
    migrations: MIGRATIONS.filter((migration) => migration.version <= 19)
  })
  closeAfter(db)
  db.raw
    .prepare(
      `INSERT INTO providers (
         id, harness, name, base_url, model, auth_style,
         api_key_cipher, api_key_scheme, api_key_backend, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      PROVIDER_ID,
      'claude',
      'Relay',
      'https://relay.example.com',
      'claude-sonnet-5',
      'auth_token',
      new Uint8Array([1, 2, 3]),
      'safe_storage_v1',
      'safe_storage',
      10,
      20
    )
  db.raw
    .prepare(
      `INSERT INTO harness_provider_selection (harness, provider_id, updated_at)
       VALUES (?, ?, ?)`
    )
    .run('claude', PROVIDER_ID, 30)
  db.close()
}

describe('migration 20: provider harnesses', () => {
  it('preserves provider and selection rows while widening the harness list', () => {
    const { path } = tempPath()
    seedV19(path)

    const db = openDatabase({
      path,
      migrations: MIGRATIONS.filter((migration) => migration.version <= 20)
    })
    closeAfter(db)
    expect(db.userVersion()).toBe(20)

    const provider = db.raw
      .prepare(
        `SELECT harness, name, base_url, model, auth_style, created_at, updated_at
         FROM providers WHERE id = ?`
      )
      .get(PROVIDER_ID) as Record<string, unknown>
    expect(provider).toMatchObject({
      harness: 'claude',
      name: 'Relay',
      base_url: 'https://relay.example.com',
      model: 'claude-sonnet-5',
      auth_style: 'auth_token',
      created_at: 10,
      updated_at: 20
    })

    expect(
      db.raw
        .prepare(
          'SELECT harness, provider_id, updated_at FROM harness_provider_selection'
        )
        .all()
    ).toEqual([{ harness: 'claude', provider_id: PROVIDER_ID, updated_at: 30 }])

    const providerSql = (
      db.raw
        .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'providers'")
        .get() as { sql: string }
    ).sql
    expect(providerSql).toContain("'codebuddy'")
    expect(providerSql).toContain('STRICT')
    expect(
      db.raw
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'providers_harness_idx'"
        )
        .get()
    ).toBeDefined()
  })

  it('accepts a new provider harness and rejects an unknown one', () => {
    const { path } = tempPath()
    seedV19(path)
    const db = openDatabase({ path, migrations: MIGRATIONS })
    closeAfter(db)

    const insert = (harness: string, authStyle: string | null): void => {
      db.raw
        .prepare(
          `INSERT INTO providers (
             id, harness, name, base_url, model, auth_style,
             api_key_cipher, api_key_scheme, api_key_backend, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          newProviderRowId(),
          harness,
          `Provider ${harness}`,
          'https://relay.example.com',
          'model',
          authStyle,
          new Uint8Array([4]),
          'safe_storage_v1',
          'safe_storage',
          1,
          1
        )
    }

    expect(() => insert('codebuddy', null)).not.toThrow()
    expect(() => insert('not-a-harness', null)).toThrow()
    expect(() => insert('codebuddy', 'auth_token')).toThrow()
    expect(() => insert('openclaude', 'api_key')).not.toThrow()
  })

  it('keeps the selection foreign key restrictive', () => {
    const { path } = tempPath()
    seedV19(path)
    const db = openDatabase({ path, migrations: MIGRATIONS })
    closeAfter(db)

    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO harness_provider_selection (harness, provider_id, updated_at)
           VALUES (?, ?, ?)`
        )
        .run('codex', 'prv_00000000-0000-4000-8000-000000000099', 1)
    ).toThrow()

    expect(() =>
      db.raw.prepare('DELETE FROM providers WHERE id = ?').run(PROVIDER_ID)
    ).toThrow()
  })
})

describe('migration 21: sidebar order', () => {
  it('adds a single-row order document table', () => {
    const { path } = tempPath()
    const v20 = openDatabase({
      path,
      migrations: MIGRATIONS.filter((migration) => migration.version <= 20)
    })
    v20.close()

    const db = openDatabase({ path, migrations: MIGRATIONS })
    closeAfter(db)
    expect(db.userVersion()).toBe(SCHEMA_VERSION)

    const document = '{"projects":["repo_1"],"worktrees":{},"sessions":{}}'
    db.raw
      .prepare('INSERT INTO sidebar_order (id, document, updated_at) VALUES (1, ?, 5)')
      .run(document)
    expect(
      db.raw.prepare('SELECT document FROM sidebar_order WHERE id = 1').get()
    ).toEqual({ document })
    expect(() =>
      db.raw
        .prepare('INSERT INTO sidebar_order (id, document, updated_at) VALUES (2, ?, 5)')
        .run('{}')
    ).toThrow()
  })
})

describe('migration 22: bots, teams and memory', () => {
  it('backfills Mira and moves the old assistant memory into bot_memory', () => {
    const { path } = tempPath()
    const v21 = openDatabase({
      path,
      migrations: MIGRATIONS.filter((migration) => migration.version <= 21)
    })
    v21.raw
      .prepare(
        `INSERT INTO assistant_threads (
           id, kind, title, created_at, updated_at, last_message_at,
           last_read_seq, active_run_id, archived_at
         ) VALUES ('thread_main', 'main', 'Mira', 1, 1, NULL, 0, NULL, NULL)`
      )
      .run()
    v21.raw
      .prepare(
        `INSERT INTO assistant_memory (id, key, value, created_at, updated_at)
         VALUES ('mem_1', 'tone', 'direct', 1, 1)`
      )
      .run()
    v21.raw
      .prepare(
        `INSERT INTO assistant_messages (
           id, thread_id, seq, run_id, role, kind, body, card_json,
           notification_kind, notification_priority, notification_state,
           notification_dedupe_key, notified_at, metadata_json, created_at
         ) VALUES ('msg_1', 'thread_main', 1, NULL, 'user', 'text', 'hello',
           NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1)`
      )
      .run()
    v21.close()

    const db = openDatabase({ path, migrations: MIGRATIONS })
    closeAfter(db)
    expect(db.userVersion()).toBe(SCHEMA_VERSION)

    expect(
      db.raw
        .prepare('SELECT id, name, role FROM bots WHERE id = ?')
        .get('mira')
    ).toEqual({ id: 'mira', name: 'Yarcy', role: 'Chief of Staff' })
    expect(
      db.raw.prepare('SELECT title FROM assistant_threads WHERE id = ?').get('thread_main')
    ).toEqual({ title: 'Yarcy' })
    expect(
      db.raw
        .prepare('SELECT bot_id FROM assistant_threads WHERE id = ?')
        .get('thread_main')
    ).toEqual({ bot_id: 'mira' })
    expect(
      db.raw.prepare('SELECT body, thread_id FROM assistant_messages WHERE id = ?').get('msg_1')
    ).toEqual({ body: 'hello', thread_id: 'thread_main' })
    expect(db.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(
      db.raw
        .prepare(
          `SELECT scope, bot_id, key, value, status, proposed_by_bot_id
           FROM bot_memory WHERE key = ?`
        )
        .get('tone')
    ).toEqual({
      scope: 'bot',
      bot_id: 'mira',
      key: 'tone',
      value: 'direct',
      status: 'active',
      proposed_by_bot_id: 'mira'
    })
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'assistant_memory'")
      .all()
    expect(tables).toEqual([])
    const taskColumns = db.raw
      .prepare("PRAGMA table_info('tasks')")
      .all() as Array<{ name: string }>
    expect(taskColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'bot_id',
        'group_id',
        'acceptance_criteria',
        'changes_requested_at'
      ])
    )

    db.raw
      .prepare(
        `INSERT INTO bots (
           id, name, role, avatar_color, instructions, settings_json,
           archived_at, created_at, updated_at
         ) VALUES ('backend', 'Backend', 'Backend engineer', '#123456', '', NULL, NULL, 1, 1)`
      )
      .run()
    db.raw
      .prepare(
        `INSERT INTO assistant_threads (
           id, kind, title, bot_id, created_at, updated_at, last_message_at,
           last_read_seq, active_run_id, archived_at
         ) VALUES ('thread_backend', 'bot', 'Backend', 'backend', 1, 1, NULL, 0, NULL, NULL)`
      )
      .run()
    expect(
      db.raw
        .prepare('SELECT kind, bot_id FROM assistant_threads WHERE id = ?')
        .get('thread_backend')
    ).toEqual({ kind: 'bot', bot_id: 'backend' })
  })
})

describe('migration 23: the default Chief is Yarcy', () => {
  function v22(path: string) {
    return openDatabase({
      path,
      migrations: MIGRATIONS.filter((migration) => migration.version <= 22)
    })
  }

  it('renames only the untouched default name, thread title and persona', () => {
    const { path } = tempPath()
    const db = v22(path)
    db.raw
      .prepare(
        `INSERT INTO assistant_threads (
           id, kind, title, bot_id, created_at, updated_at, last_message_at,
           last_read_seq, active_run_id, archived_at
         ) VALUES ('thread_main', 'main', 'Mira', 'mira', 1, 1, NULL, 0, NULL, NULL)`
      )
      .run()
    db.raw
      .prepare(
        `INSERT INTO assistant_settings (id, settings_json, updated_at)
         VALUES (1, ?, 5)`
      )
      .run(JSON.stringify({ personaName: 'Mira', autoDispatch: { mode: 'low-risk' } }))
    db.raw
      .prepare(
        `INSERT INTO assistant_messages (
           id, thread_id, seq, run_id, role, kind, body, card_json,
           notification_kind, notification_priority, notification_state,
           notification_dedupe_key, notified_at, metadata_json, created_at
         ) VALUES ('msg_welcome', 'thread_main', 1, NULL, 'assistant', 'welcome',
           'Hi, I am Mira.', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1)`
      )
      .run()
    db.close()

    const migrated = openDatabase({ path, migrations: MIGRATIONS })
    closeAfter(migrated)
    expect(migrated.userVersion()).toBe(SCHEMA_VERSION)
    expect(
      migrated.raw.prepare('SELECT name FROM bots WHERE id = ?').get('mira')
    ).toEqual({ name: 'Yarcy' })
    expect(
      migrated.raw.prepare('SELECT title FROM assistant_threads WHERE id = ?').get('thread_main')
    ).toEqual({ title: 'Yarcy' })
    const settings = migrated.raw
      .prepare('SELECT settings_json FROM assistant_settings WHERE id = 1')
      .get() as { settings_json: string }
    expect(JSON.parse(settings.settings_json)).toMatchObject({
      personaName: 'Yarcy',
      autoDispatch: { mode: 'low-risk' }
    })
    expect(
      migrated.raw.prepare('SELECT body FROM assistant_messages WHERE id = ?').get('msg_welcome')
    ).toEqual({ body: 'Hi, I am Yarcy.' })
  })

  it('leaves a customized name, thread title and persona alone', () => {
    const { path } = tempPath()
    const db = v22(path)
    db.raw
      .prepare(`UPDATE bots SET name = 'Chief' WHERE id = 'mira'`)
      .run()
    db.raw
      .prepare(
        `INSERT INTO assistant_threads (
           id, kind, title, bot_id, created_at, updated_at, last_message_at,
           last_read_seq, active_run_id, archived_at
         ) VALUES ('thread_main', 'main', 'Chief', 'mira', 1, 1, NULL, 0, NULL, NULL)`
      )
      .run()
    db.raw
      .prepare(
        `INSERT INTO assistant_settings (id, settings_json, updated_at)
         VALUES (1, ?, 5)`
      )
      .run(JSON.stringify({ personaName: 'Chief' }))
    db.close()

    const migrated = openDatabase({ path, migrations: MIGRATIONS })
    closeAfter(migrated)
    expect(
      migrated.raw.prepare('SELECT name FROM bots WHERE id = ?').get('mira')
    ).toEqual({ name: 'Chief' })
    expect(
      migrated.raw.prepare('SELECT title FROM assistant_threads WHERE id = ?').get('thread_main')
    ).toEqual({ title: 'Chief' })
    const settings = migrated.raw
      .prepare('SELECT settings_json FROM assistant_settings WHERE id = 1')
      .get() as { settings_json: string }
    expect(JSON.parse(settings.settings_json).personaName).toBe('Chief')
  })

  it('follows a customized bot name when the persona and welcome are still default', () => {
    const { path } = tempPath()
    const db = v22(path)
    db.raw.prepare(`UPDATE bots SET name = 'Chief' WHERE id = 'mira'`).run()
    db.raw
      .prepare(
        `INSERT INTO assistant_threads (
           id, kind, title, bot_id, created_at, updated_at, last_message_at,
           last_read_seq, active_run_id, archived_at
         ) VALUES ('thread_main', 'main', 'Mira', 'mira', 1, 1, NULL, 0, NULL, NULL)`
      )
      .run()
    db.raw
      .prepare(
        `INSERT INTO assistant_settings (id, settings_json, updated_at)
         VALUES (1, ?, 5)`
      )
      .run(JSON.stringify({ personaName: 'Mira' }))
    db.raw
      .prepare(
        `INSERT INTO assistant_messages (
           id, thread_id, seq, run_id, role, kind, body, card_json,
           notification_kind, notification_priority, notification_state,
           notification_dedupe_key, notified_at, metadata_json, created_at
         ) VALUES ('msg_welcome', 'thread_main', 1, NULL, 'assistant', 'welcome',
           'Hi, I am Mira.', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1)`
      )
      .run()
    db.close()

    const migrated = openDatabase({ path, migrations: MIGRATIONS })
    closeAfter(migrated)
    expect(
      migrated.raw.prepare('SELECT name FROM bots WHERE id = ?').get('mira')
    ).toEqual({ name: 'Chief' })
    expect(
      migrated.raw.prepare('SELECT title FROM assistant_threads WHERE id = ?').get('thread_main')
    ).toEqual({ title: 'Chief' })
    const settings = migrated.raw
      .prepare('SELECT settings_json FROM assistant_settings WHERE id = 1')
      .get() as { settings_json: string }
    expect(JSON.parse(settings.settings_json).personaName).toBe('Chief')
    expect(
      migrated.raw.prepare('SELECT body FROM assistant_messages WHERE id = ?').get('msg_welcome')
    ).toEqual({ body: 'Hi, I am Chief.' })
  })

  it('does not rename into an existing Yarcy bot', () => {
    const { path } = tempPath()
    const db = v22(path)
    db.raw
      .prepare(
        `INSERT INTO bots (
           id, name, role, avatar_color, instructions, settings_json,
           archived_at, created_at, updated_at
         ) VALUES ('bot_yarcy', 'Yarcy', 'Researcher', '#5b8def', '', NULL, NULL, 2, 2)`
      )
      .run()
    db.close()

    const migrated = openDatabase({ path, migrations: MIGRATIONS })
    closeAfter(migrated)
    expect(
      migrated.raw.prepare('SELECT name FROM bots WHERE id = ?').get('mira')
    ).toEqual({ name: 'Mira' })
  })
})

describe('migration 24: groups, threads and room sessions', () => {
  function v23(path: string) {
    return openDatabase({
      path,
      migrations: MIGRATIONS.filter((migration) => migration.version <= 23)
    })
  }

  it('turns a team into a group with one default thread and keeps home chats', () => {
    const { path } = tempPath()
    const db = v23(path)
    db.raw
      .prepare(
        `INSERT INTO bots (
           id, name, role, avatar_color, instructions, settings_json,
           archived_at, created_at, updated_at
         ) VALUES ('backend', 'Backend', 'Backend engineer', '#123456', '', NULL, NULL, 2, 2)`
      )
      .run()
    db.raw
      .prepare(
        `INSERT INTO assistant_threads (
           id, kind, title, bot_id, created_at, updated_at, last_message_at,
           last_read_seq, active_run_id, archived_at
         ) VALUES ('thread_backend', 'bot', 'Backend', 'backend', 2, 2, NULL, 0, NULL, NULL)`
      )
      .run()
    db.raw
      .prepare(
        `INSERT INTO teams (
           id, name, chief_bot_id, last_read_seq, archived_at, created_at, updated_at
         ) VALUES ('team_1', 'Core', 'backend', 2, NULL, 1, 5)`
      )
      .run()
    db.raw
      .prepare(
        `INSERT INTO team_members (team_id, bot_id, joined_at)
         VALUES ('team_1', 'backend', 1), ('team_1', 'mira', 1)`
      )
      .run()
    db.raw
      .prepare(
        `INSERT INTO team_messages (
           id, team_id, seq, author_kind, author_bot_id, body, card_json,
           dedupe_key, created_at
         ) VALUES
           ('m1', 'team_1', 1, 'human', NULL, 'start', NULL, NULL, 1),
           ('m2', 'team_1', 2, 'bot', 'backend', 'working', NULL, NULL, 2),
           ('m3', 'team_1', 3, 'system', NULL, 'done', NULL, 'task:t1:review', 3)`
      )
      .run()
    db.raw
      .prepare(
        `INSERT INTO bot_memory (
           id, scope, bot_id, repo_id, team_id, proposed_by_bot_id,
           key, value, status, source_task_id, created_at, updated_at
         ) VALUES ('mem_team', 'team', NULL, NULL, 'team_1', 'backend',
           'style', 'direct', 'active', NULL, 1, 1)`
      )
      .run()
    db.raw
      .prepare(
        `INSERT INTO tasks (
           id, workspace_id, repo_id, title, prompt, harness, status,
           attempt, created_at, updated_at, bot_id, team_id
         ) VALUES ('task_1', 'ws_1', 'repo_1', 'Work', 'Do it', 'shell', 'queued',
           1, 1, 1, 'backend', 'team_1')`
      )
      .run()
    db.close()

    const migrated = openDatabase({ path, migrations: MIGRATIONS })
    closeAfter(migrated)
    expect(migrated.userVersion()).toBe(SCHEMA_VERSION)
    expect(
      migrated.raw
        .prepare(
          `SELECT id, name, revision, default_bot_id, reply_mode
           FROM bot_groups WHERE id = 'team_1'`
        )
        .get()
    ).toEqual({
      id: 'team_1',
      name: 'Core',
      revision: 1,
      default_bot_id: 'backend',
      reply_mode: 'bot'
    })
    expect(
      migrated.raw
        .prepare(
          `SELECT title, is_default, last_read_seq, last_read_at,
                  latest_author_name, latest_text
           FROM bot_group_threads WHERE id = 'gthread_team_1'`
        )
        .get()
    ).toEqual({
      title: 'Core',
      is_default: 1,
      last_read_seq: 2,
      last_read_at: 0,
      latest_author_name: 'System',
      latest_text: 'done'
    })
    expect(
      migrated.raw
        .prepare(
          `SELECT seq, author_kind, author_name, root_request_id, root_sequence
           FROM bot_group_messages WHERE thread_id = 'gthread_team_1' ORDER BY seq`
        )
        .all()
    ).toEqual([
      { seq: 1, author_kind: 'human', author_name: null, root_request_id: 'm1', root_sequence: 1 },
      { seq: 2, author_kind: 'bot', author_name: 'Backend', root_request_id: 'm2', root_sequence: 2 },
      { seq: 3, author_kind: 'system', author_name: 'System', root_request_id: 'm3', root_sequence: 3 }
    ])
    expect(
      migrated.raw
        .prepare(
          `SELECT bot_id, assistant_thread_id FROM bot_group_thread_members
           WHERE thread_id = 'gthread_team_1' ORDER BY bot_id`
        )
        .all()
    ).toEqual([
      { bot_id: 'backend', assistant_thread_id: null },
      { bot_id: 'mira', assistant_thread_id: null }
    ])
    expect(
      migrated.raw.prepare("SELECT team_id FROM bot_memory WHERE id = 'mem_team'").get()
    ).toEqual({ team_id: 'team_1' })
    expect(
      migrated.raw.prepare("SELECT group_thread_id FROM tasks WHERE id = 'task_1'").get()
    ).toEqual({ group_thread_id: 'gthread_team_1' })
    expect(
      migrated.raw
        .prepare("SELECT kind, group_thread_id FROM assistant_threads WHERE id = 'thread_backend'")
        .get()
    ).toEqual({ kind: 'bot', group_thread_id: null })
    expect(() =>
      migrated.raw
        .prepare(
          `INSERT INTO assistant_threads (
             id, kind, title, bot_id, group_thread_id, created_at, updated_at,
             last_message_at, last_read_seq, active_run_id, archived_at
           ) VALUES ('thread_backend_2', 'bot', 'Backend 2', 'backend', NULL, 1, 1, NULL, 0, NULL, NULL)`
        )
        .run()
    ).toThrow(/UNIQUE/i)
    migrated.raw
      .prepare(
        `INSERT INTO assistant_threads (
           id, kind, title, bot_id, group_thread_id, created_at, updated_at,
           last_message_at, last_read_seq, active_run_id, archived_at
         ) VALUES ('thread_room', 'room', 'Core', 'backend', 'gthread_team_1', 1, 1, NULL, 0, NULL, NULL)`
      )
      .run()
    expect(
      migrated.raw
        .prepare("SELECT kind, group_thread_id FROM assistant_threads WHERE id = 'thread_room'")
        .get()
    ).toEqual({ kind: 'room', group_thread_id: 'gthread_team_1' })
    // v26 drops the legacy team tables after the group copy is complete.
    expect(
      migrated.raw
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'teams'")
        .get()
    ).toEqual({ n: 0 })
    expect(migrated.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
})

describe('migration 25: task items', () => {
  it('adds snooze and the comment/link tables without a second work table', () => {
    const { path } = tempPath()
    const db = openDatabase({ path, migrations: MIGRATIONS })
    closeAfter(db)
    expect(db.userVersion()).toBe(SCHEMA_VERSION)
    const columns = db.raw.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).toContain('snoozed_until')
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>
    const names = tables.map((row) => row.name)
    expect(names).toContain('task_comments')
    expect(names).toContain('task_links')
    expect(names).not.toContain('items')
    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO task_links (task_id, kind, ref, added_at)
           VALUES ('missing', 'url', 'https://example.com', 1)`
        )
        .run()
    ).toThrow(/FOREIGN KEY/i)
  })
})

describe('migration 26: drop legacy teams', () => {
  it('renames task routing and points group memory at bot_groups', () => {
    const { path } = tempPath()
    const db = openDatabase({ path, migrations: MIGRATIONS })
    closeAfter(db)
    expect(db.userVersion()).toBe(SCHEMA_VERSION)
    const taskColumns = db.raw.prepare('PRAGMA table_info(tasks)').all() as Array<{
      name: string
    }>
    expect(taskColumns.map((column) => column.name)).toContain('group_id')
    expect(taskColumns.map((column) => column.name)).not.toContain('team_id')
    for (const table of ['teams', 'team_members', 'team_messages']) {
      expect(
        db.raw
          .prepare(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?"
          )
          .get(table)
      ).toEqual({ n: 0 })
    }
    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO bot_memory (
             id, scope, bot_id, repo_id, team_id, proposed_by_bot_id,
             key, value, status, source_task_id, created_at, updated_at
           ) VALUES ('mem_missing', 'team', NULL, NULL, 'missing', NULL,
             'k', 'v', 'active', NULL, 1, 1)`
        )
        .run()
    ).toThrow(/FOREIGN KEY/i)
  })
})

describe('migration 27: group mute', () => {
  it('adds the group mute timestamp', () => {
    const { path } = tempPath()
    const db = openDatabase({ path, migrations: MIGRATIONS })
    closeAfter(db)
    const columns = db.raw.prepare('PRAGMA table_info(bot_groups)').all() as Array<{
      name: string
    }>
    expect(columns.map((column) => column.name)).toContain('muted_at')
  })
})
