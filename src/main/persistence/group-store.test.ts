import { afterEach, describe, expect, it } from 'vitest'
import type { BotGroupMessage, BotGroupRecord, BotGroupThread, BotGroupTurn } from '../../shared/domain/group'
import { openTempDatabase, makeTempRoot, type TempRoot } from './persistence-test-fixtures'
import { GroupStore } from './group-store'

const cleanups: Array<() => void> = []
function root(): TempRoot {
  const temp = makeTempRoot()
  cleanups.push(temp.cleanup)
  return temp
}
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

const now = 1_000

function seed() {
  const temp = root()
  const db = openTempDatabase(temp)
  cleanups.push(() => db.close())
  db.raw
    .prepare(
      `INSERT INTO bots (id, name, role, avatar_color, instructions, settings_json,
         archived_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', NULL, NULL, ?, ?)`
    )
    .run('backend', 'Backend', 'Engineer', '#5b8def', now, now)
  db.raw
    .prepare(
      `INSERT INTO bots (id, name, role, avatar_color, instructions, settings_json,
         archived_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', NULL, NULL, ?, ?)`
    )
    .run('reviewer', 'Reviewer', 'Reviewer', '#5b8def', now, now)
  return { store: new GroupStore(db), db }
}

function group(overrides: Partial<BotGroupRecord> = {}): BotGroupRecord {
  return {
    id: 'group_1',
    name: 'Group',
    revision: 1,
    defaultBotId: 'backend',
    replyMode: { kind: 'bot', botId: 'backend' },
    archivedAt: null,
    mutedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

function thread(overrides: Partial<BotGroupThread> = {}): BotGroupThread {
  return {
    id: 'thread_1',
    groupId: 'group_1',
    title: 'General',
    isDefault: true,
    lastReadSeq: 0,
    lastReadAt: 0,
    lastActivityAt: 0,
    latestAuthorName: null,
    latestText: null,
    latestAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

function message(overrides: Partial<BotGroupMessage> = {}): BotGroupMessage {
  return {
    id: 'message_1',
    groupId: 'group_1',
    threadId: 'thread_1',
    seq: 1,
    authorKind: 'human',
    authorBotId: null,
    authorName: null,
    body: 'hello',
    card: null,
    dedupeKey: null,
    rootRequestId: 'message_1',
    rootSequence: 1,
    requesterBotId: null,
    requesterName: null,
    mentioned: false,
    fromItems: false,
    fromReports: false,
    taskId: null,
    createdAt: now,
    ...overrides
  }
}

function turn(overrides: Partial<BotGroupTurn> = {}): BotGroupTurn {
  return {
    operationId: 'turn_1',
    messageId: 'message_1',
    groupId: 'group_1',
    threadId: 'thread_1',
    botId: 'backend',
    botName: 'Backend',
    assistantThreadId: null,
    runId: null,
    status: 'queued',
    reply: null,
    error: null,
    context: '[]',
    handedOff: [],
    createdAt: now,
    updatedAt: now,
    deliveredAt: null,
    ...overrides
  }
}

describe('group store', () => {
  it('stores groups, members and threads with revision CAS', () => {
    const { store } = seed()
    expect(store.insertGroup(group())).toMatchObject({ revision: 1 })
    store.addMember('group_1', 'backend', now)
    store.addMember('group_1', 'reviewer', now)
    store.insertThread(thread())
    store.ensureThreadMembers('thread_1', ['backend', 'reviewer'], now)

    expect(store.listMembers('group_1').map((member) => member.botId)).toEqual([
      'backend',
      'reviewer'
    ])
    expect(store.listThreads('group_1')).toHaveLength(1)
    expect(store.listThreadMembers('thread_1')).toHaveLength(2)
    expect(store.groupsForBot('reviewer')).toHaveLength(1)
    expect(store.groupsForBot('backend')[0]?.replyMode).toEqual({ kind: 'bot', botId: 'backend' })

    const updated = store.updateGroup(
      'group_1',
      1,
      { name: 'Renamed', replyMode: { kind: 'all' } },
      now + 1
    )
    expect(updated).toMatchObject({ name: 'Renamed', revision: 2 })
    expect(store.updateGroup('group_1', 1, { name: 'Stale' }, now + 2)).toBeNull()
  })

  it('appends per-thread messages, dedupes, and tracks unread', () => {
    const { store } = seed()
    store.insertGroup(group())
    store.insertThread(thread())
    const first = store.appendMessage({
      ...message(),
      rootRequestId: null,
      rootSequence: null
    })
    expect(first.seq).toBe(1)
    expect(store.findThread('thread_1')).toMatchObject({
      latestText: 'hello',
      latestAuthorName: null
    })

    const bot = store.appendMessage({
      ...message({ id: 'message_2', authorKind: 'bot', authorBotId: 'backend', authorName: 'Backend', body: 'hi' }),
      createdAt: now + 1
    })
    expect(bot.seq).toBe(2)
    expect(store.unreadCount('thread_1')).toBe(2)
    expect(store.markRead('thread_1', 2, now + 2)).toBe(0)

    const deduped = store.appendMessage({
      ...message({ id: 'message_3', dedupeKey: 'task:one' }),
      createdAt: now + 3
    })
    const again = store.appendMessage({
      ...message({ id: 'message_4', dedupeKey: 'task:one', body: 'changed' }),
      createdAt: now + 4
    })
    expect(again.id).toBe(deduped.id)
    expect(store.listMessages('thread_1').map((row) => row.id)).toEqual([
      'message_1',
      'message_2',
      'message_3'
    ])
  })

  it('stores a turn once and updates it', () => {
    const { store } = seed()
    store.insertGroup(group())
    store.insertThread(thread())
    store.appendMessage({ ...message(), rootRequestId: null, rootSequence: null })
    expect(store.insertTurn(turn())).toMatchObject({ status: 'queued' })
    expect(store.pendingTurns()).toHaveLength(1)
    expect(
      store.updateTurn(
        'turn_1',
        { status: 'working', runId: 'run_1', assistantThreadId: 'athread_1' },
        now + 1
      )
    ).toMatchObject({ status: 'working', runId: 'run_1' })
    expect(
      store.updateTurn(
        'turn_1',
        { status: 'completed', reply: 'done', handedOff: ['reviewer'] },
        now + 2
      )
    ).toMatchObject({ status: 'completed', reply: 'done', handedOff: ['reviewer'] })
    expect(store.pendingTurns()).toHaveLength(0)
    expect(store.turnsForMessage('message_1')[0]?.operationId).toBe('turn_1')
  })

  it('deletes a group with its threads, messages, turns and members', () => {
    const { store, db } = seed()
    store.insertGroup(group())
    store.addMember('group_1', 'backend', now)
    store.insertThread(thread())
    store.ensureThreadMembers('thread_1', ['backend'], now)
    store.appendMessage({ ...message(), rootRequestId: null, rootSequence: null })
    store.insertTurn(turn())
    expect(store.deleteGroup('group_1')).toBe(true)
    expect(store.findGroup('group_1')).toBeNull()
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM bot_group_threads').get()).toMatchObject({
      n: 0
    })
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM bot_group_messages').get()).toMatchObject({
      n: 0
    })
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM bot_group_turns').get()).toMatchObject({
      n: 0
    })
  })
})
