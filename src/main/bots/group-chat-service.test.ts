import { afterEach, describe, expect, it } from 'vitest'
import { BOT_GROUP_LIMITS } from '../../shared/domain/group'
import { GroupStore } from '../persistence/group-store'
import { openTempDatabase, makeTempRoot, type TempRoot } from '../persistence/persistence-test-fixtures'
import {
  GroupChatService,
  type GroupChatEvent,
  type GroupRuntimePort,
  type GroupTurnContext,
  type GroupTurnResult
} from './group-chat-service'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

const now = 10_000

function createService() {
  const temp: TempRoot = makeTempRoot()
  cleanups.push(temp.cleanup)
  const db = openTempDatabase(temp)
  cleanups.push(() => db.close())
  const seeds: Array<[string, string]> = [
    ['backend', 'Backend'],
    ['reviewer', 'Reviewer']
  ]
  for (const [id, name] of seeds) {
    db.raw
      .prepare(
        `INSERT INTO bots (id, name, role, avatar_color, instructions, settings_json,
           archived_at, created_at, updated_at, paused_at)
         VALUES (?, ?, 'Engineer', '#5b8def', '', NULL, NULL, ?, ?, NULL)`
      )
      .run(id, name, now, now)
  }
  const store = new GroupStore(db)
  const replies = new Map<string, string | (() => Promise<GroupTurnResult>)>()
  const stopped: string[] = []
  let release: (() => void) | null = null
  let callCount = 0
  let currentTime = now
  const runtime: GroupRuntimePort = {
    async ensureRoomSession({ botId, groupThreadId }) {
      const assistantThreadId = `athread_${botId}_${groupThreadId}`
      db.raw
        .prepare(
          `INSERT OR IGNORE INTO assistant_threads (
             id, kind, title, bot_id, group_thread_id, created_at, updated_at,
             last_message_at, last_read_seq, active_run_id, archived_at
           ) VALUES (?, 'room', 'Room', ?, ?, ?, ?, NULL, 0, NULL, NULL)`
        )
        .run(assistantThreadId, botId, groupThreadId, now, now)
      return { assistantThreadId }
    },
    async sendTurn(input) {
      callCount += 1
      const behavior = replies.get(input.botId) ?? 'ok'
      if (typeof behavior === 'function') return behavior()
      if (behavior === 'defer') {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      return { status: 'completed' as const, reply: behavior, error: null }
    },
    stopThread(assistantThreadId) {
      stopped.push(assistantThreadId)
    }
  }
  const botInfo = (botId: string) =>
    botId === 'backend'
      ? { id: 'backend', name: 'Backend', paused: false, archived: false }
      : botId === 'reviewer'
        ? { id: 'reviewer', name: 'Reviewer', paused: false, archived: false }
        : null
  const service = new GroupChatService({
    store,
    botInfo,
    runtime,
    composeTurnPrompt: (context: GroupTurnContext) => `prompt:${context.bot.id}`,
    now: () => currentTime,
    newId: (() => {
      let id = 0
      return (prefix: string) => `${prefix}_${++id}`
    })(),
    onError: () => {}
  })
  return {
    service,
    store,
    runtime,
    replies,
    stopped,
    calls: () => callCount,
    release: () => release?.(),
    advance: (ms = 1) => {
      currentTime += ms
      return currentTime
    }
  }
}

async function setup() {
  const env = createService()
  const group = await env.service.createGroup({
    name: 'Core',
    memberBotIds: ['backend', 'reviewer']
  })
  const thread = env.service.listThreads(group.id)[0]!
  return { ...env, group, thread }
}

describe('group chat service', () => {
  it('turns an owner message into one default-replier turn and stores the reply on it', async () => {
    const { service, store, group, thread } = await setup()
    const sent = await service.sendOwnerMessage({
      groupId: group.id,
      threadId: thread.id,
      text: 'Please look at the login flow'
    })
    expect(sent.message).toMatchObject({ authorKind: 'human', rootRequestId: sent.message.id })
    expect(sent.turns).toHaveLength(1)
    expect(sent.turns[0]).toMatchObject({ botId: 'backend', status: 'queued' })
    await service.waitForIdle()
    const page = service.messages(thread.id)
    expect(page.messages.map((message) => message.authorKind)).toEqual(['human'])
    expect(page.turns[0]).toMatchObject({ status: 'completed', reply: 'ok', botName: 'Backend' })
    expect(store.findThread(thread.id)).toMatchObject({
      latestAuthorName: 'Backend',
      latestText: 'ok'
    })
  })

  it('honours reply modes and leading mention errors', async () => {
    const { service, store, group, thread } = await setup()
    service.updateGroup({
      groupId: group.id,
      revision: store.findGroup(group.id)!.revision,
      replyMode: { kind: 'mentions' }
    })
    const quiet = await service.sendOwnerMessage({
      groupId: group.id,
      threadId: thread.id,
      text: 'hello'
    })
    expect(quiet.turns).toHaveLength(0)
    const mentioned = await service.sendOwnerMessage({
      groupId: group.id,
      threadId: thread.id,
      text: '@Reviewer take a look'
    })
    expect(mentioned.turns.map((turn) => turn.botId)).toEqual(['reviewer'])
    await expect(
      service.sendOwnerMessage({
        groupId: group.id,
        threadId: thread.id,
        text: '@Ghost hello'
      })
    ).rejects.toMatchObject({ code: 'GROUP_MENTION_UNAVAILABLE' })
  })

  it('hands a bot reply off to a mentioned member under the same request', async () => {
    const { service, replies, group, thread } = await setup()
    replies.set('backend', 'Done. @Reviewer please check the diff.')
    replies.set('reviewer', 'Looks good.')
    const sent = await service.sendOwnerMessage({
      groupId: group.id,
      threadId: thread.id,
      text: 'Fix the login flow'
    })
    await service.waitForIdle()
    const page = service.messages(thread.id)
    const handoff = page.messages.find((message) => message.authorKind === 'bot')
    expect(handoff).toMatchObject({
      authorBotId: 'backend',
      requesterName: 'Backend',
      mentioned: true,
      body: 'Backend asked Reviewer'
    })
    const reviewerTurn = page.turns.find((turn) => turn.botId === 'reviewer')
    expect(reviewerTurn).toMatchObject({ status: 'completed', reply: 'Looks good.' })
    expect(
      page.turns.find((turn) => turn.botId === 'backend')?.handedOff
    ).toEqual(['reviewer'])
    const reloaded = sent.message
    expect(reloaded.rootRequestId).toBe(reloaded.id)
  })

  it('does not hand off to the speaker or through code', async () => {
    const { service, replies, group, thread } = await setup()
    replies.set('backend', 'I will handle it. `@Reviewer` and @Backend stay out.')
    await service.sendOwnerMessage({
      groupId: group.id,
      threadId: thread.id,
      text: 'Fix it'
    })
    await service.waitForIdle()
    const page = service.messages(thread.id)
    expect(page.turns.filter((turn) => turn.botId === 'reviewer')).toHaveLength(0)
  })

  it('stops a working turn without storing its late reply', async () => {
    const { service, replies, stopped, group, thread, release } = await setup()
    replies.set('backend', 'defer')
    const sent = await service.sendOwnerMessage({
      groupId: group.id,
      threadId: thread.id,
      text: 'Run the long job'
    })
    expect(sent.turns).toHaveLength(1)
    await service.stop({ groupId: group.id, threadId: thread.id })
    expect(stopped).toHaveLength(1)
    release()
    await service.waitForIdle()
    const page = service.messages(thread.id)
    expect(page.turns[0]).toMatchObject({ status: 'cancelled', reply: null })
    expect(page.messages.filter((message) => message.authorKind === 'bot')).toHaveLength(0)
  })

  it('wakes all members with @everyone and skips paused bots', async () => {
    const { service, store, group, thread, replies } = await setup()
    service.updateGroup({
      groupId: group.id,
      revision: store.findGroup(group.id)!.revision,
      replyMode: { kind: 'all' }
    })
    const sent = await service.sendOwnerMessage({
      groupId: group.id,
      threadId: thread.id,
      text: '@everyone sync up'
    })
    expect(sent.turns.map((turn) => turn.botId).sort()).toEqual(['backend', 'reviewer'])
    await service.waitForIdle()
    expect(replies.size).toBe(0)
  })

  it('creates threads with fresh member rows and titles them from the first post', async () => {
    const { service, group } = await setup()
    const thread = service.createThread(group.id)
    expect(thread.isDefault).toBe(false)
    expect(service.messages(thread.id).messages).toEqual([])
    await service.sendOwnerMessage({
      groupId: group.id,
      threadId: thread.id,
      text: 'Login revamp\nDetails'
    })
    await service.waitForIdle()
    expect(service.getThread(thread.id)?.title).toBe('Login revamp')
    await service.sendOwnerMessage({
      groupId: group.id,
      threadId: thread.id,
      text: 'A later line'
    })
    await service.waitForIdle()
    expect(service.getThread(thread.id)?.title).toBe('Login revamp')
  })

  it('cuts a thread title to the thread-title limit', async () => {
    const { service, group } = await setup()
    const thread = service.createThread(group.id)
    await service.sendOwnerMessage({
      groupId: group.id,
      threadId: thread.id,
      text: 'x'.repeat(BOT_GROUP_LIMITS.maxThreadTitleLength + 30)
    })
    await service.waitForIdle()
    expect(service.getThread(thread.id)?.title).toHaveLength(
      BOT_GROUP_LIMITS.maxThreadTitleLength
    )
  })

  it('keeps creating threads without a fixed group limit', async () => {
    const { service, group } = await setup()
    for (let index = 0; index < 40; index += 1) {
      service.createThread(group.id)
    }
    expect(service.listThreads(group.id)).toHaveLength(41)
  })

  it('keeps a finished bot reply unread after its owner message is read', async () => {
    const { service, replies, group, thread, calls, advance, release } = await setup()
    replies.set('backend', 'defer')
    advance(5)
    const sent = await service.sendOwnerMessage({
      groupId: group.id,
      threadId: thread.id,
      text: 'Work on this'
    })
    while (calls() === 0) await new Promise((resolve) => setTimeout(resolve, 0))
    service.markRead(thread.id, sent.message.seq)
    expect(service.hasUnreadActivity(thread.id)).toBe(false)
    expect(service.unreadCount(thread.id)).toBe(0)

    advance(5)
    release()
    await service.waitForIdle()
    expect(service.unreadCount(thread.id)).toBe(0)
    expect(service.hasUnreadActivity(thread.id)).toBe(true)

    service.markRead(thread.id, sent.message.seq)
    expect(service.hasUnreadActivity(thread.id)).toBe(false)
  })

  it('emits a read event instead of reloading the whole group', async () => {
    const { service, store, group, thread } = await setup()
    const events: GroupChatEvent[] = []
    service.subscribe((event) => events.push(event))
    const sent = await service.sendOwnerMessage({
      groupId: group.id,
      threadId: thread.id,
      text: 'Read me'
    })
    await service.waitForIdle()
    const unread = service.markRead(thread.id, sent.message.seq)
    expect(unread).toBe(0)
    expect(events.at(-1)).toMatchObject({
      type: 'read',
      groupId: group.id,
      threadId: thread.id,
      seq: sent.message.seq,
      unread: 0
    })
    expect(store.findThread(thread.id)?.lastReadSeq).toBe(sent.message.seq)
  })

  it('caps hand-offs per root across turns', async () => {
    const { service, store, replies, group, thread, release } = await setup()
    replies.set('reviewer', 'defer')
    const sent = await service.sendOwnerMessage({
      groupId: group.id,
      threadId: thread.id,
      text: '@Reviewer check the diff'
    })
    const root = sent.message
    for (let index = 0; index < 8; index += 1) {
      store.appendMessage({
        id: `seed_handoff_${index}`,
        groupId: group.id,
        threadId: thread.id,
        authorKind: 'bot',
        authorBotId: 'backend',
        authorName: 'Backend',
        body: `Backend asked Reviewer ${index}`,
        requesterBotId: 'backend',
        requesterName: 'Backend',
        mentioned: true,
        rootRequestId: root.id,
        rootSequence: root.seq,
        dedupeKey: `seed:${index}`,
        createdAt: now
      })
    }
    replies.set('reviewer', 'Backend should take it. @Backend please.')
    release()
    await service.waitForIdle()
    expect(store.countHandoffs(root.id)).toBe(8)
    const turn = service.messages(thread.id).turns.find((entry) => entry.botId === 'reviewer')
    expect(turn).toMatchObject({ status: 'completed', handedOff: [] })
  })

  it('wakes the bot that asked when an item question is answered', async () => {
    const { service, replies, group, thread } = await setup()
    replies.set('reviewer', 'Continuing with OAuth.')
    const turn = service.wakeFromItem({
      groupId: group.id,
      threadId: thread.id,
      botId: 'reviewer',
      taskId: 'task_1',
      answerId: 'answer_1',
      question: 'Which login flow?',
      answer: 'OAuth.'
    })
    expect(turn).toMatchObject({ botId: 'reviewer', status: 'queued' })
    expect(
      service.wakeFromItem({
        groupId: group.id,
        threadId: thread.id,
        botId: 'reviewer',
        taskId: 'task_1',
        answerId: 'answer_1',
        question: 'Which login flow?',
        answer: 'OAuth.'
      })
    ).toBeNull()
    await service.waitForIdle()
    const page = service.messages(thread.id)
    const root = page.messages.find((message) => message.fromItems)
    expect(root).toMatchObject({ authorKind: 'system', taskId: 'task_1' })
    const reply = page.turns.find((entry) => entry.messageId === root?.id)
    expect(reply).toMatchObject({ botId: 'reviewer', status: 'completed', reply: 'Continuing with OAuth.' })
  })

  it('removes an archived bot and repairs the default replier', async () => {
    const { service, store, group, thread } = await setup()
    service.removeBotFromGroups('backend')
    const updated = store.findGroup(group.id)
    expect(updated).toMatchObject({ defaultBotId: 'reviewer', revision: group.revision + 1 })
    expect(updated?.replyMode).toEqual({ kind: 'bot', botId: 'reviewer' })
    expect(service.memberIds(group.id)).toEqual(['reviewer'])
    expect(store.listThreadMembers(thread.id).map((member) => member.botId)).toEqual([
      'reviewer'
    ])
  })

  it('marks the whole group read and unread from the row menu', async () => {
    const { service, store, group, thread } = await setup()
    service.postSystemMessage({
      groupId: group.id,
      threadId: thread.id,
      body: 'Review ready',
      dedupeKey: 'task:t1:review'
    })
    expect(store.unreadCount(thread.id)).toBe(1)
    expect(service.setGroupRead(group.id, true)).toBe(0)
    expect(store.unreadCount(thread.id)).toBe(0)
    expect(service.setGroupRead(group.id, false)).toBe(1)
    expect(store.unreadCount(thread.id)).toBe(1)
  })

  it('mutes and unmutes group notifications without touching unread', async () => {
    const { service, group } = await setup()
    const muted = service.setGroupMuted(group.id, true)
    expect(muted.mutedAt).toBe(now)
    expect(service.listGroups().find((entry) => entry.id === group.id)?.mutedAt).toBe(now)
    const unmuted = service.setGroupMuted(group.id, false)
    expect(unmuted.mutedAt).toBeNull()
  })

  it('archives a group out of the active roster', async () => {
    const { service, group } = await setup()
    const archived = service.archiveGroup(group.id)
    expect(archived.archivedAt).toBe(now)
    expect(service.listGroups().some((entry) => entry.id === group.id)).toBe(false)
    expect(service.listGroups({ includeArchived: true }).some((entry) => entry.id === group.id)).toBe(true)
  })

  it('deletes a group and its threads', async () => {
    const { service, store, group, thread } = await setup()
    expect(service.deleteGroup(group.id)).toBe(true)
    expect(store.findGroup(group.id)).toBeNull()
    expect(store.findThread(thread.id)).toBeNull()
    expect(service.listGroups({ includeArchived: true })).toEqual([])
  })

  it('keeps system messages and dedupes them', async () => {
    const { service, group, thread } = await setup()
    const first = service.postSystemMessage({
      groupId: group.id,
      threadId: thread.id,
      body: 'Review ready',
      dedupeKey: 'task:t1:review'
    })
    const second = service.postSystemMessage({
      groupId: group.id,
      threadId: thread.id,
      body: 'Review ready again',
      dedupeKey: 'task:t1:review'
    })
    expect(second.id).toBe(first.id)
  })
})
