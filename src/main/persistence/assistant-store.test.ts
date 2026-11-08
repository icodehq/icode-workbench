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

  it('upgrades a v8 database with additive task provenance columns', () => {
    const root = makeTempRoot()
    cleanups.push(() => root.cleanup())
    const path = join(root.dir, 'v8.sqlite')
    const v8 = openDatabase({ path, migrations: MIGRATIONS.slice(0, 8) })
    expect(v8.userVersion()).toBe(8)
    v8.close()

    const current = openDatabase({ path, migrations: MIGRATIONS })
    cleanups.push(() => current.close())
    expect(current.userVersion()).toBe(10)
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
      'assistant_memory',
      'assistant_messages',
      'assistant_runs',
      'assistant_settings',
      'assistant_threads'
    ])
    tables.close()
  })
})
