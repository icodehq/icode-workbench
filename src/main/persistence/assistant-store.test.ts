import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from './database'
import { MIGRATIONS } from './migrations'
import { AssistantStore } from './assistant-store'
import { makeTempRoot, openTempDatabase } from './persistence-test-fixtures'
import { DEFAULT_ASSISTANT_SETTINGS } from '../../shared/domain/assistant'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function fixture(): { root: ReturnType<typeof makeTempRoot>; db: ReturnType<typeof openTempDatabase>; store: AssistantStore } {
  const root = makeTempRoot()
  cleanups.push(() => root.cleanup())
  const db = openTempDatabase(root)
  cleanups.push(() => db.close())
  return { root, db, store: new AssistantStore(db) }
}

function thread(store: AssistantStore, now = 1_000) {
  return store.insertThread({
    id: 'thread_main',
    kind: 'main',
    title: 'Mira',
    createdAt: now,
    updatedAt: now,
    lastMessageAt: null,
    lastReadSeq: 0,
    activeRunId: null,
    archivedAt: null
  })
}

describe('assistant store', () => {
  it('orders messages per thread and tracks unread with a monotonic watermark', () => {
    const { store } = fixture()
    thread(store)

    const welcome = store.appendMessage({
      id: 'msg_1',
      threadId: 'thread_main',
      role: 'assistant',
      kind: 'welcome',
      body: 'Hello',
      createdAt: 1_001
    })
    expect(welcome?.seq).toBe(1)
    expect(store.unreadCount('thread_main')).toBe(1)

    const user = store.appendMessage({
      id: 'msg_2',
      threadId: 'thread_main',
      role: 'user',
      kind: 'text',
      body: 'What needs me?',
      createdAt: 1_002
    })
    expect(user?.seq).toBe(2)
    expect(store.unreadCount('thread_main')).toBe(1)

    expect(store.markRead('thread_main', 1, 1_003)).toBe(0)
    expect(store.markRead('thread_main', 0, 1_004)).toBe(0)

    const reply = store.appendMessage({
      id: 'msg_3',
      threadId: 'thread_main',
      role: 'assistant',
      kind: 'text',
      body: 'Nothing yet.',
      createdAt: 1_005
    })
    expect(reply?.seq).toBe(3)
    expect(store.unreadCount('thread_main')).toBe(1)
    expect(store.listMessages('thread_main').map((message) => message.id)).toEqual([
      'msg_1',
      'msg_2',
      'msg_3'
    ])
  })

  it('deduplicates notifications by key and preserves the first row', () => {
    const { store } = fixture()
    thread(store)

    const first = store.appendMessage({
      id: 'msg_n1',
      threadId: 'thread_main',
      role: 'assistant',
      kind: 'notification',
      body: 'Task failed',
      notificationKind: 'task-failed',
      notificationPriority: 'high',
      notificationState: 'pending',
      notificationDedupeKey: 'task:one:failed',
      createdAt: 2_000
    })
    expect(first?.id).toBe('msg_n1')

    const duplicate = store.appendMessage({
      id: 'msg_n2',
      threadId: 'thread_main',
      role: 'assistant',
      kind: 'notification',
      body: 'Task failed again',
      notificationKind: 'task-failed',
      notificationPriority: 'high',
      notificationState: 'pending',
      notificationDedupeKey: 'task:one:failed',
      createdAt: 2_001
    })
    expect(duplicate).toBeNull()
    expect(store.listMessages('thread_main')).toHaveLength(1)
  })

  it('persists settings, memory, runs and actions', () => {
    const { store, db } = fixture()
    thread(store)

    expect(store.getSettings()).toEqual(DEFAULT_ASSISTANT_SETTINGS)
    const settings = {
      ...DEFAULT_ASSISTANT_SETTINGS,
      personaName: 'Ada',
      autoDispatch: { ...DEFAULT_ASSISTANT_SETTINGS.autoDispatch, mode: 'off' as const }
    }
    expect(store.saveSettings(settings, 3_000)).toEqual(settings)
    expect(store.getSettings().personaName).toBe('Ada')

    store.setMemory('merge-style', 'squash', 3_001)
    store.setMemory('merge-style', 'rebase', 3_002)
    expect(store.listMemory()).toEqual([{ key: 'merge-style', value: 'rebase' }])
    expect(store.forgetMemory('merge-style')).toBe(true)

    const run = store.createRun({
      id: 'run_1',
      threadId: 'thread_main',
      trigger: 'user',
      harness: 'claude',
      startedAt: 3_003
    })
    expect(run.status).toBe('running')
    store.updateRun('run_1', {
      status: 'completed',
      targetKind: 'local',
      round: 1,
      contextChars: 1200,
      finishedAt: 3_004
    })
    expect(store.findRun('run_1')).toMatchObject({
      status: 'completed',
      targetKind: 'local',
      round: 1,
      contextChars: 1200
    })

    store.recordAction({
      threadId: 'thread_main',
      runId: 'run_1',
      actor: 'mira',
      op: 'tasks.create',
      repoId: 'repo_x',
      taskId: 'task_x',
      outcome: 'auto-dispatched',
      detail: { risk: 'low' },
      now: 3_005
    })
    const actions = db.raw
      .prepare('SELECT actor, op, outcome FROM assistant_actions')
      .all() as Array<{ actor: string; op: string; outcome: string }>
    expect(actions).toEqual([
      { actor: 'mira', op: 'tasks.create', outcome: 'auto-dispatched' }
    ])
  })

  it('claims one active run and fails stale runs on restart', () => {
    const { store } = fixture()
    thread(store)

    expect(store.claimRun('thread_main', 'run_1')).toBe(true)
    expect(store.claimRun('thread_main', 'run_2')).toBe(false)
    store.releaseRun('thread_main', 'run_1')
    expect(store.findThread('thread_main')?.activeRunId).toBeNull()

    store.createRun({
      id: 'run_1',
      threadId: 'thread_main',
      trigger: 'user',
      harness: 'claude',
      startedAt: 4_000
    })
    expect(store.failStaleRuns(4_001)).toBe(1)
    expect(store.findRun('run_1')).toMatchObject({
      status: 'failed',
      error: 'iCode restarted before this run finished.'
    })
  })

  it('rotates one active native conversation per thread', () => {
    const { store } = fixture()
    thread(store)

    const first = store.insertConversation({
      id: 'conv_1',
      threadId: 'thread_main',
      harness: 'claude',
      targetKind: 'local',
      targetDistro: null,
      historyMode: 'bridge',
      startSeq: 1,
      createdAt: 4_000
    })
    expect(first).toMatchObject({
      state: 'active',
      resetReason: null,
      nativeSessionId: null,
      historyMode: 'bridge'
    })
    expect(store.findActiveConversation('thread_main')?.id).toBe('conv_1')
    expect(() =>
      store.insertConversation({
        id: 'conv_dup',
        threadId: 'thread_main',
        harness: 'claude',
        targetKind: 'local',
        targetDistro: null,
        historyMode: 'bridge',
        startSeq: 2,
        createdAt: 4_001
      })
    ).toThrow()

    store.setConversationSession('conv_1', 'session_1', 4_002)
    expect(store.findConversation('conv_1')).toMatchObject({
      nativeSessionId: 'session_1',
      observedAt: 4_002
    })

    store.touchConversation('conv_1', { now: 4_003, lastPromptSeq: 7 })
    expect(store.findConversation('conv_1')?.lastPromptSeq).toBe(7)

    const retired = store.retireConversation('conv_1', {
      state: 'reset',
      reason: 'user',
      now: 4_004
    })
    expect(retired).toMatchObject({ state: 'reset', resetReason: 'user' })
    expect(store.findActiveConversation('thread_main')).toBeNull()
    expect(store.findLatestConversation('thread_main')?.id).toBe('conv_1')
    expect(
      store.retireConversation('conv_1', { state: 'reset', reason: 'user', now: 4_005 })
    ).toBeNull()

    store.insertConversation({
      id: 'conv_2',
      threadId: 'thread_main',
      harness: 'opencode',
      targetKind: 'wsl',
      targetDistro: 'Ubuntu',
      historyMode: 'clean',
      startSeq: 8,
      createdAt: 4_006
    })
    expect(store.findActiveConversation('thread_main')?.id).toBe('conv_2')
    expect(
      store.resetActiveConversation('thread_main', { reason: 'resume-failed', now: 4_007 })
    ).toMatchObject({ state: 'invalid', resetReason: 'resume-failed' })
    expect(store.findActiveConversation('thread_main')).toBeNull()
  })

  it('records conversation ranges and the digest/notification feeds', () => {
    const { store, db } = fixture()
    thread(store)
    const append = (id: string, kind: string, role: string, createdAt: number) =>
      store.appendMessage({
        id,
        threadId: 'thread_main',
        role: role as never,
        kind: kind as never,
        body: id,
        createdAt
      })

    append('m1', 'text', 'user', 1_001)
    append('m2', 'text', 'assistant', 1_002)
    append('m3', 'notification', 'assistant', 1_003)
    append('m4', 'card', 'assistant', 1_004)
    append('m5', 'action', 'assistant', 1_005)
    append('m6', 'error', 'system', 1_006)
    append('m7', 'status', 'system', 1_007)
    append('m8', 'text', 'assistant', 1_008)

    store.insertConversation({
      id: 'conv_1',
      threadId: 'thread_main',
      harness: 'claude',
      targetKind: 'local',
      targetDistro: null,
      historyMode: 'bridge',
      startSeq: 1,
      createdAt: 1_009
    })
    expect(store.latestMessageSeq('thread_main')).toBe(8)
    expect(store.listConversations('thread_main')).toMatchObject([
      { id: 'conv_1', startSeq: 1, endSeq: null }
    ])
    expect(store.findConversationForSeq('thread_main', 4)?.id).toBe('conv_1')

    store.retireConversation('conv_1', {
      state: 'reset',
      reason: 'user',
      now: 1_010,
      endSeq: 4
    })
    store.insertConversation({
      id: 'conv_2',
      threadId: 'thread_main',
      harness: 'claude',
      targetKind: 'local',
      targetDistro: null,
      historyMode: 'bridge',
      startSeq: 5,
      createdAt: 1_011
    })
    expect(store.listConversations('thread_main').map((entry) => entry.id)).toEqual([
      'conv_1',
      'conv_2'
    ])
    expect(store.findConversationForSeq('thread_main', 4)?.id).toBe('conv_1')
    expect(store.findConversationForSeq('thread_main', 5)?.id).toBe('conv_2')

    expect(
      store
        .listMessagesInRange('thread_main', { startSeq: 1, endSeq: 4 })
        .map((message) => message.id)
    ).toEqual(['m1', 'm2', 'm3', 'm4'])
    expect(
      store
        .listMessagesInRange('thread_main', { startSeq: 5, endSeq: null })
        .map((message) => message.id)
    ).toEqual(['m5', 'm6', 'm7', 'm8'])
    expect(
      store
        .listMessagesInRange('thread_main', {
          startSeq: 1,
          endSeq: 4,
          beforeSeq: 4,
          limit: 2
        })
        .map((message) => message.id)
    ).toEqual(['m2', 'm3'])

    expect(
      store.listRecentNotifications('thread_main').map((message) => message.id)
    ).toEqual(['m3'])
    expect(
      store.listDigestMessages('thread_main', 2, 10).map((message) => message.id)
    ).toEqual(['m3', 'm4', 'm5', 'm6'])

    // A legacy open predecessor is closed when a new segment starts.
    db.raw
      .prepare(
        `UPDATE assistant_conversations
         SET state = 'reset', reset_reason = 'user', end_seq = NULL
         WHERE id = 'conv_2'`
      )
      .run()
    store.insertConversation({
      id: 'conv_3',
      threadId: 'thread_main',
      harness: 'claude',
      targetKind: 'local',
      targetDistro: null,
      historyMode: 'bridge',
      startSeq: 7,
      createdAt: 1_012
    })
    expect(store.findConversation('conv_2')?.endSeq).toBe(6)
    expect(
      store.listConversations('thread_main', 2).map((entry) => entry.id)
    ).toEqual(['conv_2', 'conv_3'])
  })

  it('stores the resume token a run used', () => {
    const { store, db } = fixture()
    thread(store)
    store.createRun({
      id: 'run_1',
      threadId: 'thread_main',
      trigger: 'user',
      harness: 'claude',
      startedAt: 5_000
    })
    store.updateRun('run_1', { resumeToken: 'session_1' })
    const row = db.raw
      .prepare('SELECT resume_token FROM assistant_runs WHERE id = ?')
      .get('run_1') as { resume_token: string | null }
    expect(row.resume_token).toBe('session_1')
  })

  it('backfills the newest v11 conversation as the legacy segment', () => {
    const root = makeTempRoot()
    cleanups.push(() => root.cleanup())
    const path = join(root.dir, 'v11.sqlite')
    const v11 = openDatabase({ path, migrations: MIGRATIONS.slice(0, 11) })
    expect(v11.userVersion()).toBe(11)
    v11.raw
      .prepare(
        `INSERT INTO assistant_threads (
           id, kind, title, created_at, updated_at, last_message_at, last_read_seq,
           active_run_id, archived_at
         ) VALUES ('thread_main', 'main', 'Mira', 1, 1, NULL, 0, NULL, NULL)`
      )
      .run()
    v11.raw
      .prepare(
        `INSERT INTO assistant_threads (
           id, kind, title, created_at, updated_at, last_message_at, last_read_seq,
           active_run_id, archived_at
         ) VALUES ('thread_system', 'system', 'System', 1, 1, NULL, 0, NULL, NULL)`
      )
      .run()
    const insert = v11.raw.prepare(
      `INSERT INTO assistant_conversations (
         id, thread_id, harness, target_kind, target_distro, native_session_id,
         state, reset_reason, history_mode, last_prompt_seq, created_at, updated_at,
         observed_at
       ) VALUES (?, ?, 'claude', 'local', NULL, NULL, ?, ?, 'bridge', NULL, ?, ?, NULL)`
    )
    insert.run('conv_old', 'thread_main', 'reset', 'user', 1, 1)
    insert.run('conv_new', 'thread_main', 'active', null, 2, 2)
    insert.run('conv_system', 'thread_system', 'active', null, 3, 3)
    v11.close()

    const current = openDatabase({ path, migrations: MIGRATIONS })
    cleanups.push(() => current.close())
    expect(current.userVersion()).toBe(15)
    const rows = current.raw
      .prepare(
        `SELECT id, start_seq, end_seq FROM assistant_conversations ORDER BY rowid`
      )
      .all() as Array<{ id: string; start_seq: number | null; end_seq: number | null }>
    expect(rows).toEqual([
      { id: 'conv_old', start_seq: null, end_seq: null },
      { id: 'conv_new', start_seq: 1, end_seq: null },
      { id: 'conv_system', start_seq: 1, end_seq: null }
    ])
  })

  it('adds a fresh attempt_mode to a v12 task', () => {
    const root = makeTempRoot()
    cleanups.push(() => root.cleanup())
    const path = join(root.dir, 'v12.sqlite')
    const v12 = openDatabase({ path, migrations: MIGRATIONS.slice(0, 12) })
    expect(v12.userVersion()).toBe(12)
    v12.raw
      .prepare(
        `INSERT INTO tasks (
           id, workspace_id, repo_id, title, prompt, harness, status, attempt,
           created_at, updated_at
         ) VALUES ('task_old', 'ws', 'repo', 'Old', 'Prompt', 'claude', 'failed', 1, 1, 1)`
      )
      .run()
    v12.close()

    const current = openDatabase({ path, migrations: MIGRATIONS })
    cleanups.push(() => current.close())
    expect(current.userVersion()).toBe(15)
    const row = current.raw
      .prepare("SELECT attempt_mode FROM tasks WHERE id = 'task_old'")
      .get() as { attempt_mode: string }
    expect(row.attempt_mode).toBe('fresh')
  })

  it('upgrades a v8 database with additive task provenance columns', () => {
    const root = makeTempRoot()
    cleanups.push(() => root.cleanup())
    const path = join(root.dir, 'v8.sqlite')
    const v8 = openDatabase({ path, migrations: MIGRATIONS.slice(0, 8) })
    expect(v8.userVersion()).toBe(8)
    v8.close()

    const current = openDatabase({ path, migrations: MIGRATIONS })
    cleanups.push(() => current.close())
    expect(current.userVersion()).toBe(15)
    const columns = current.raw
      .prepare("PRAGMA table_info('tasks')")
      .all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'created_by_actor',
        'assistant_run_id',
        'approval_policy',
        'archived_at'
      ])
    )
    const tables = new DatabaseSync(path, { readOnly: true })
    const names = tables
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'assistant_%' ORDER BY name")
      .all() as Array<{ name: string }>
    expect(names.map((row) => row.name)).toEqual([
      'assistant_actions',
      'assistant_conversations',
      'assistant_memory',
      'assistant_messages',
      'assistant_runs',
      'assistant_settings',
      'assistant_threads'
    ])
    tables.close()
  })
})
