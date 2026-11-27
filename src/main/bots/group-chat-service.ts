import type {
  BotGroupMessage,
  BotGroupRecord,
  BotGroupThread,
  BotGroupTurn,
  GroupNamedBot,
  GroupReplyMode,
  GroupRoom
} from '../../shared/domain/group'
import {
  BOT_GROUP_LIMITS,
  NEW_GROUP_THREAD_TITLE,
  groupThreadIsUntitled,
  groupThreadTitleFromText
} from '../../shared/domain/group'
import {
  GroupMentionError,
  groupAudience,
  groupReplyMentions
} from '../../shared/domain/group-mentions'
import { runKeyedSerializedOperation } from '../../shared/concurrency/keyed-serialized-operation'
import { makeAppError } from '../../shared/domain/errors'
import type { MessageKey } from '../../shared/i18n'
import type { GroupStore } from '../persistence/group-store'
import type { AssistantCard } from '../../shared/domain/assistant'

export type GroupBotInfo = {
  id: string
  name: string
  paused: boolean
  archived: boolean
}

export type GroupBotLookup = (botId: string) => GroupBotInfo | null

export type GroupTurnContext = {
  group: BotGroupRecord
  thread: BotGroupThread
  root: BotGroupMessage
  bot: GroupBotInfo
  messages: BotGroupMessage[]
  handoffFrom: { botId: string; name: string } | null
}

export type GroupTurnResult = {
  status: 'completed' | 'failed' | 'stopped'
  reply: string | null
  error: string | null
  runId?: string | null
  assistantThreadId?: string | null
}

export type GroupRuntimePort = {
  ensureRoomSession(input: {
    botId: string
    groupThreadId: string
  }): Promise<{ assistantThreadId: string }>
  sendTurn(input: {
    botId: string
    groupThreadId: string
    assistantThreadId: string
    prompt: string
    context: GroupTurnContext
  }): Promise<GroupTurnResult>
  stopThread(assistantThreadId: string): void
}

export type GroupChatErrorCode =
  | 'GROUP_NOT_FOUND'
  | 'GROUP_THREAD_NOT_FOUND'
  | 'GROUP_ARCHIVED'
  | 'GROUP_REVISION_CONFLICT'
  | 'GROUP_EMPTY_MESSAGE'
  | 'GROUP_MESSAGE_ID_REUSED'
  | 'GROUP_MEMBER_MISSING'
  | 'GROUP_MENTION_AMBIGUOUS'
  | 'GROUP_MENTION_UNAVAILABLE'
  | 'GROUP_REPLIER_NOT_MEMBER'

export class GroupChatError extends Error {
  readonly appError
  constructor(readonly code: GroupChatErrorCode) {
    const text = GROUP_ERROR_TEXT[code]
    super(text.message)
    this.name = 'GroupChatError'
    this.appError = makeAppError('INVALID_ARGUMENT', text.message, {
      messageKey: text.messageKey
    })
  }
}

const GROUP_ERROR_TEXT: Record<
  GroupChatErrorCode,
  { message: string; messageKey: MessageKey }
> = {
  GROUP_NOT_FOUND: {
    message: 'That group could not be found.',
    messageKey: 'bots.error.notFound'
  },
  GROUP_THREAD_NOT_FOUND: {
    message: 'That group thread could not be found.',
    messageKey: 'bots.error.threadNotFound'
  },
  GROUP_ARCHIVED: {
    message: 'That group is archived.',
    messageKey: 'bots.error.archived'
  },
  GROUP_REVISION_CONFLICT: {
    message: 'The group changed while you were editing it. Try again.',
    messageKey: 'bots.error.revision'
  },
  GROUP_EMPTY_MESSAGE: {
    message: 'Write a message first.',
    messageKey: 'bots.error.empty'
  },
  GROUP_MESSAGE_ID_REUSED: {
    message: 'That message was already sent.',
    messageKey: 'bots.error.reused'
  },
  GROUP_MEMBER_MISSING: {
    message: 'Pick at least one bot that is still in the group.',
    messageKey: 'bots.error.memberMissing'
  },
  GROUP_MENTION_AMBIGUOUS: {
    message: 'More than one bot has that name. Use a different mention.',
    messageKey: 'bots.error.mentionAmbiguous'
  },
  GROUP_MENTION_UNAVAILABLE: {
    message: 'That bot is not in this group.',
    messageKey: 'bots.error.mentionUnavailable'
  },
  GROUP_REPLIER_NOT_MEMBER: {
    message: 'The default replier is no longer in this group.',
    messageKey: 'bots.error.replierNotMember'
  }
}

export type GroupChatEvent =
  | { type: 'changed'; groupId: string }
  | { type: 'message'; groupId: string; message: BotGroupMessage }
  | { type: 'turn'; groupId: string; turn: BotGroupTurn }
  | { type: 'thread'; groupId: string; threadId: string }
  | {
      type: 'read'
      groupId: string
      threadId: string
      seq: number
      unread: number
    }

export type GroupMessagePage = {
  messages: BotGroupMessage[]
  turns: BotGroupTurn[]
}

export type GroupChatServiceDeps = {
  store: GroupStore
  botInfo: GroupBotLookup
  runtime: GroupRuntimePort
  /** Builds the prompt for a room turn; the model's final reply becomes the room reply. */
  composeTurnPrompt: (context: GroupTurnContext) => Promise<string> | string
  now: () => number
  newId: (prefix: string) => string
  onEvent?: (event: GroupChatEvent) => void
  onError?: (error: unknown) => void
  /** Detach tasks and archive room sessions before the group row is dropped. */
  onDeleteGroup?: (groupId: string, threadIds: string[]) => void
}

export type CreateGroupInput = {
  name: string
  memberBotIds: readonly string[]
  defaultBotId?: string
  replyMode?: GroupReplyMode
}

export type UpdateGroupInput = {
  groupId: string
  revision: number
  name?: string
  memberBotIds?: readonly string[]
  defaultBotId?: string | null
  replyMode?: GroupReplyMode
}

export type SendOwnerMessageInput = {
  groupId: string
  threadId: string
  text: string
  messageId?: string
  revision?: number
  repoId?: string
  fromItems?: boolean
  taskId?: string
}

/**
 * The group room's send/reply/hand-off/stop runtime.
 *
 * Owner messages reserve one turn per target; each bot answers in its own room
 * session; its final assistant message becomes the turn's reply. Bot replies
 * only reach other bots through explicit @mentions, bounded by Stop and a
 * per-root hand-off cap. No remote members or peer mail in this product.
 */
export class GroupChatService {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly inFlight = new Set<Promise<void>>()

  private readonly listeners = new Set<(event: GroupChatEvent) => void>()

  constructor(private readonly deps: GroupChatServiceDeps) {}

  subscribe(listener: (event: GroupChatEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  listGroups(options: { includeArchived?: boolean } = {}): BotGroupRecord[] {
    return this.deps.store.listGroups(options)
  }

  archiveGroup(groupId: string): BotGroupRecord {
    const group = this.requireGroup(groupId)
    if (group.archivedAt !== null) return group
    const now = this.deps.now()
    const updated = this.deps.store.updateGroup(
      group.id,
      group.revision,
      { archivedAt: now },
      now
    )
    if (updated === null) throw new GroupChatError('GROUP_REVISION_CONFLICT')
    this.emit({ type: 'changed', groupId: group.id })
    return updated
  }

  /**
   * Permanently remove a group. Active room runs are stopped first, room
   * sessions are archived, and tasks keep their work but lose the group link.
   */
  deleteGroup(groupId: string): boolean {
    const group = this.requireGroup(groupId)
    const threads = this.deps.store.listThreads(group.id)
    for (const thread of threads) {
      for (const member of this.deps.store.listThreadMembers(thread.id)) {
        if (member.assistantThreadId !== null) {
          this.deps.runtime.stopThread(member.assistantThreadId)
        }
      }
    }
    const deleted = this.deps.store.deleteGroup(group.id)
    if (!deleted) return false
    this.deps.onDeleteGroup?.(group.id, threads.map((thread) => thread.id))
    this.emit({ type: 'changed', groupId: group.id })
    return true
  }

  getGroup(groupId: string): BotGroupRecord | null {
    return this.deps.store.findGroup(groupId)
  }

  listThreads(groupId: string): BotGroupThread[] {
    return this.deps.store.listThreads(groupId)
  }

  memberIds(groupId: string): string[] {
    return this.deps.store.listMembers(groupId).map((member) => member.botId)
  }

  unreadCount(threadId: string): number {
    return this.deps.store.unreadCount(threadId)
  }

  hasUnreadActivity(threadId: string): boolean {
    return this.deps.store.hasUnreadActivity(threadId)
  }

  turnsForMessage(messageId: string): BotGroupTurn[] {
    return this.deps.store.turnsForMessage(messageId)
  }

  getThread(threadId: string): BotGroupThread | null {
    return this.deps.store.findThread(threadId)
  }

  messages(
    threadId: string,
    options: { beforeSeq?: number; limit?: number } = {}
  ): GroupMessagePage {
    const messages = this.deps.store.listMessages(threadId, options)
    const turns = messages.flatMap((message) => this.deps.store.turnsForMessage(message.id))
    return { messages, turns }
  }

  markRead(threadId: string, seq: number): number {
    const thread = this.deps.store.findThread(threadId)
    if (thread === null) throw new GroupChatError('GROUP_THREAD_NOT_FOUND')
    const unread = this.deps.store.markRead(threadId, seq, this.deps.now())
    this.emit({
      type: 'read',
      groupId: thread.groupId,
      threadId,
      seq,
      unread
    })
    return unread
  }

  /** Mute or unmute system notifications without hiding unread state. */
  setGroupMuted(groupId: string, muted: boolean): BotGroupRecord {
    const group = this.requireGroup(groupId)
    const updated = this.deps.store.updateGroup(
      group.id,
      group.revision,
      { mutedAt: muted ? this.deps.now() : null },
      this.deps.now()
    )
    if (updated === null) throw new GroupChatError('GROUP_REVISION_CONFLICT')
    this.emit({ type: 'changed', groupId: group.id })
    return updated
  }

  /** Read or unread every thread in a group, for the sidebar row menu. */
  setGroupRead(groupId: string, read: boolean): number {
    const group = this.requireGroup(groupId)
    let unread = 0
    for (const thread of this.deps.store.listThreads(group.id)) {
      const latest = this.deps.store.latestSequence(thread.id)
      const seq = read ? latest : Math.max(0, latest - 1)
      unread += this.deps.store.setReadSeq(thread.id, seq, this.deps.now())
    }
    this.emit({ type: 'changed', groupId: group.id })
    return unread
  }

  async createGroup(input: CreateGroupInput): Promise<BotGroupRecord> {
    const name = input.name.trim()
    if (name.length === 0) throw new GroupChatError('GROUP_MEMBER_MISSING')
    const memberIds = [...new Set(input.memberBotIds)]
    if (memberIds.length === 0) throw new GroupChatError('GROUP_MEMBER_MISSING')
    if (memberIds.length > BOT_GROUP_LIMITS.maxMembers) {
      throw new GroupChatError('GROUP_MEMBER_MISSING')
    }
    const infos = memberIds.map((id) => this.requireBot(id))
    const defaultBotId =
      input.defaultBotId !== undefined && memberIds.includes(input.defaultBotId)
        ? input.defaultBotId
        : (memberIds[0] ?? null)
    const replyMode: GroupReplyMode =
      input.replyMode ??
      (defaultBotId === null ? { kind: 'mentions' } : { kind: 'bot', botId: defaultBotId })
    if (replyMode.kind === 'bot' && !memberIds.includes(replyMode.botId)) {
      throw new GroupChatError('GROUP_REPLIER_NOT_MEMBER')
    }
    const now = this.deps.now()
    const id = this.deps.newId('group')
    const group = this.deps.store.insertGroup({
      id,
      name: name.slice(0, BOT_GROUP_LIMITS.maxNameLength),
      revision: 1,
      defaultBotId,
      replyMode,
      archivedAt: null,
      mutedAt: null,
      createdAt: now,
      updatedAt: now
    })
    for (const info of infos) this.deps.store.addMember(id, info.id, now)
    const thread = this.deps.store.insertThread({
      id: this.deps.newId('gthread'),
      groupId: id,
      title: group.name,
      isDefault: true,
      lastReadSeq: 0,
      lastReadAt: now,
      lastActivityAt: now,
      latestAuthorName: null,
      latestText: null,
      latestAt: null,
      createdAt: now,
      updatedAt: now
    })
    this.deps.store.ensureThreadMembers(thread.id, memberIds, now)
    this.emit({ type: 'changed', groupId: id })
    return group
  }

  updateGroup(input: UpdateGroupInput): BotGroupRecord {
    const group = this.requireGroup(input.groupId)
    if (group.revision !== input.revision) throw new GroupChatError('GROUP_REVISION_CONFLICT')
    const memberIds =
      input.memberBotIds === undefined
        ? this.deps.store.listMembers(group.id).map((member) => member.botId)
        : [...new Set(input.memberBotIds)]
    if (memberIds.length === 0) throw new GroupChatError('GROUP_MEMBER_MISSING')
    for (const botId of memberIds) this.requireBot(botId)
    const defaultBotId =
      input.defaultBotId === undefined ? group.defaultBotId : input.defaultBotId
    if (defaultBotId !== null && !memberIds.includes(defaultBotId)) {
      throw new GroupChatError('GROUP_MEMBER_MISSING')
    }
    let replyMode = input.replyMode ?? group.replyMode
    if (replyMode.kind === 'bot' && !memberIds.includes(replyMode.botId)) {
      replyMode = { kind: 'mentions' }
    }
    const now = this.deps.now()
    const updated = this.deps.store.updateGroup(
      group.id,
      group.revision,
      {
        ...(input.name === undefined ? {} : { name: input.name.trim() }),
        defaultBotId,
        replyMode
      },
      now
    )
    if (updated === null) throw new GroupChatError('GROUP_REVISION_CONFLICT')
    for (const botId of memberIds) this.deps.store.addMember(group.id, botId, now)
    for (const member of this.deps.store.listMembers(group.id)) {
      if (!memberIds.includes(member.botId)) {
        this.deps.store.removeMember(group.id, member.botId)
      }
    }
    for (const thread of this.deps.store.listThreads(group.id)) {
      this.deps.store.ensureThreadMembers(thread.id, memberIds, now)
      for (const member of this.deps.store.listThreadMembers(thread.id)) {
        if (!memberIds.includes(member.botId)) {
          this.deps.store.removeThreadMember(thread.id, member.botId)
        }
      }
    }
    this.emit({ type: 'changed', groupId: group.id })
    return updated
  }

  /** Drop an archived bot from every group and keep the replier references valid. */
  removeBotFromGroups(botId: string): void {
    for (const group of this.deps.store.listGroups()) {
      const members = this.deps.store.listMembers(group.id)
      if (!members.some((member) => member.botId === botId)) continue
      const remaining = members
        .map((member) => member.botId)
        .filter((memberId) => memberId !== botId)
      const now = this.deps.now()
      const defaultBotId =
        group.defaultBotId === botId ? (remaining[0] ?? null) : group.defaultBotId
      const replyMode: GroupReplyMode =
        group.replyMode.kind === 'bot' && group.replyMode.botId === botId
          ? remaining[0] === undefined
            ? { kind: 'mentions' }
            : { kind: 'bot', botId: remaining[0] }
          : group.replyMode
      this.deps.store.updateGroup(
        group.id,
        group.revision,
        { defaultBotId, replyMode },
        now
      )
      this.deps.store.removeMember(group.id, botId)
      for (const thread of this.deps.store.listThreads(group.id)) {
        this.deps.store.removeThreadMember(thread.id, botId)
      }
      this.emit({ type: 'changed', groupId: group.id })
    }
  }

  createThread(groupId: string): BotGroupThread {
    const group = this.requireGroup(groupId)
    const now = this.deps.now()
    const members = this.deps.store.listMembers(group.id).map((member) => member.botId)
    const thread = this.deps.store.insertThread({
      id: this.deps.newId('gthread'),
      groupId: group.id,
      title: NEW_GROUP_THREAD_TITLE,
      isDefault: false,
      lastReadSeq: 0,
      lastReadAt: now,
      lastActivityAt: now,
      latestAuthorName: null,
      latestText: null,
      latestAt: null,
      createdAt: now,
      updatedAt: now
    })
    this.deps.store.ensureThreadMembers(thread.id, members, now)
    this.emit({ type: 'thread', groupId: group.id, threadId: thread.id })
    return thread
  }

  async sendOwnerMessage(
    input: SendOwnerMessageInput
  ): Promise<{ message: BotGroupMessage; turns: BotGroupTurn[] }> {
    const text = input.text.trim()
    if (text.length === 0) throw new GroupChatError('GROUP_EMPTY_MESSAGE')
    const group = this.requireGroup(input.groupId)
    if (group.archivedAt !== null) throw new GroupChatError('GROUP_ARCHIVED')
    const thread = this.deps.store.findThread(input.threadId)
    if (thread === null || thread.groupId !== group.id) {
      throw new GroupChatError('GROUP_THREAD_NOT_FOUND')
    }
    if (input.revision !== undefined && input.revision !== group.revision) {
      throw new GroupChatError('GROUP_REVISION_CONFLICT')
    }
    if (input.messageId !== undefined) {
      const existing = this.deps.store.message(input.messageId)
      if (existing !== null) {
        if (
          existing.groupId !== group.id ||
          existing.threadId !== thread.id ||
          existing.body !== text
        ) {
          throw new GroupChatError('GROUP_MESSAGE_ID_REUSED')
        }
        return { message: existing, turns: this.deps.store.turnsForMessage(existing.id) }
      }
    }
    const memberIds = this.deps.store.listMembers(group.id).map((member) => member.botId)
    const named = memberIds
      .map((id) => {
        const info = this.deps.botInfo(id)
        return info === null ? null : { id: info.id, name: info.name }
      })
      .filter((bot): bot is GroupNamedBot => bot !== null)
    const room: GroupRoom = {
      members: memberIds.map((botId) => ({ botId })),
      replyMode: group.replyMode
    }
    let audience: string[]
    try {
      audience = groupAudience(text, room, named)
    } catch (error) {
      if (error instanceof GroupMentionError) throw new GroupChatError(error.code)
      throw error
    }
    const now = this.deps.now()
    const message = this.deps.store.appendMessage({
      id: input.messageId ?? this.deps.newId('gmsg'),
      groupId: group.id,
      threadId: thread.id,
      authorKind: 'human',
      authorBotId: null,
      authorName: null,
      body: text,
      rootSelf: true,
      fromItems: input.fromItems === true,
      taskId: input.taskId ?? null,
      createdAt: now
    })
    this.titleThread(thread, message, now)
    const turns: BotGroupTurn[] = []
    for (const botId of audience) {
      const info = this.deps.botInfo(botId)
      if (info === null || info.paused || info.archived) continue
      const turn = this.deps.store.insertTurn({
        operationId: this.deps.newId('turn'),
        messageId: message.id,
        groupId: group.id,
        threadId: thread.id,
        botId,
        botName: info.name,
        assistantThreadId: null,
        runId: null,
        status: 'queued',
        reply: null,
        error: null,
        context: null,
        handedOff: [],
        createdAt: now,
        updatedAt: now,
        deliveredAt: null
      })
      turns.push(turn)
    }
    this.emit({ type: 'message', groupId: group.id, message })
    for (const turn of turns) {
      this.emit({ type: 'turn', groupId: group.id, turn })
      this.scheduleDelivery(turn.operationId)
    }
    return { message, turns }
  }

  stop(input: { groupId: string; threadId: string; botId?: string }): BotGroupTurn[] {
    const group = this.requireGroup(input.groupId)
    const thread = this.deps.store.findThread(input.threadId)
    if (thread === null || thread.groupId !== group.id) {
      throw new GroupChatError('GROUP_THREAD_NOT_FOUND')
    }
    const now = this.deps.now()
    const cutoff = this.deps.store.latestSequence(thread.id)
    const botId = input.botId ?? null
    this.deps.store.stopThreadMember(thread.id, botId, cutoff)
    this.deps.store.bumpRevision(group.id, now)
    const cancelled = this.deps.store.cancelTurnsThrough(thread.id, cutoff, botId, now)
    for (const turn of cancelled) {
      if (turn.assistantThreadId !== null) this.deps.runtime.stopThread(turn.assistantThreadId)
      this.emit({ type: 'turn', groupId: group.id, turn })
    }
    this.emit({ type: 'changed', groupId: group.id })
    return cancelled
  }

  /**
   * An owner answered an Item question. Wake the bot that asked, in the thread
   * where the work lives, with both sides of the question as the new root.
   */
  wakeFromItem(input: {
    groupId: string
    threadId: string
    botId: string
    taskId: string
    answerId: string
    question: string
    answer: string
  }): BotGroupTurn | null {
    const group = this.requireGroup(input.groupId)
    const thread = this.deps.store.findThread(input.threadId)
    if (thread === null || thread.groupId !== group.id) {
      throw new GroupChatError('GROUP_THREAD_NOT_FOUND')
    }
    const info = this.deps.botInfo(input.botId)
    if (info === null || info.paused || info.archived) return null
    if (this.deps.store.findThreadMember(thread.id, input.botId) === null) return null
    const dedupeKey = `item-answer:${input.answerId}`
    if (this.deps.store.findMessageByDedupe(thread.id, dedupeKey) !== null) return null
    const now = this.deps.now()
    const body = [
      'An Item question was answered.',
      `Question: ${input.question.trim().slice(0, 2_000)}`,
      `Answer: ${input.answer.trim().slice(0, 4_000)}`,
      'Continue the work this question was blocking.'
    ].join('\n')
    const message = this.deps.store.appendMessage({
      id: this.deps.newId('gmsg'),
      groupId: group.id,
      threadId: thread.id,
      authorKind: 'system',
      authorBotId: null,
      authorName: 'System',
      body,
      fromItems: true,
      rootSelf: true,
      taskId: input.taskId,
      dedupeKey,
      createdAt: now
    })
    this.titleThread(thread, message, now)
    const turn = this.deps.store.insertTurn({
      operationId: this.deps.newId('turn'),
      messageId: message.id,
      groupId: group.id,
      threadId: thread.id,
      botId: info.id,
      botName: info.name,
      assistantThreadId: null,
      runId: null,
      status: 'queued',
      reply: null,
      error: null,
      context: null,
      handedOff: [],
      createdAt: now,
      updatedAt: now,
      deliveredAt: null
    })
    this.emit({ type: 'message', groupId: group.id, message })
    this.emit({ type: 'turn', groupId: group.id, turn })
    this.scheduleDelivery(turn.operationId)
    return turn
  }

  postSystemMessage(input: {
    groupId: string
    threadId: string
    body: string
    dedupeKey: string
    card?: AssistantCard | null
    taskId?: string
  }): BotGroupMessage {
    const group = this.requireGroup(input.groupId)
    const thread = this.deps.store.findThread(input.threadId)
    if (thread === null || thread.groupId !== group.id) {
      throw new GroupChatError('GROUP_THREAD_NOT_FOUND')
    }
    const existing = this.deps.store.findMessageByDedupe(thread.id, input.dedupeKey)
    if (existing !== null) return existing
    const message = this.deps.store.appendMessage({
      id: this.deps.newId('gmsg'),
      groupId: group.id,
      threadId: thread.id,
      authorKind: 'system',
      authorBotId: null,
      authorName: 'System',
      body: input.body,
      card: input.card ?? null,
      dedupeKey: input.dedupeKey,
      taskId: input.taskId ?? null,
      createdAt: this.deps.now()
    })
    this.titleThread(thread, message, message.createdAt)
    this.emit({ type: 'message', groupId: group.id, message })
    return message
  }

  async waitForIdle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight])
    }
  }

  private scheduleDelivery(operationId: string): void {
    const promise = this.deliverTurn(operationId)
      .catch((error: unknown) => this.deps.onError?.(error))
      .finally(() => {
        this.inFlight.delete(promise)
      })
    this.inFlight.add(promise)
  }

  private async deliverTurn(operationId: string): Promise<void> {
    const initial = this.deps.store.turn(operationId)
    if (initial === null || initial.status !== 'queued') return
    const message = this.deps.store.message(initial.messageId)
    const group = this.deps.store.findGroup(initial.groupId)
    const thread = this.deps.store.findThread(initial.threadId)
    if (message === null || group === null || thread === null) {
      this.deps.store.updateTurn(operationId, { status: 'inactive' }, this.deps.now())
      return
    }
    const root =
      message.rootRequestId === null
        ? message
        : (this.deps.store.message(message.rootRequestId) ?? message)
    const rootSequence = message.rootSequence ?? message.seq
    const member = this.deps.store.findThreadMember(thread.id, initial.botId)
    const info = this.deps.botInfo(initial.botId)
    const stopped =
      member === null || member.stoppedThroughSequence >= rootSequence || info === null
    if (stopped || info.paused || info.archived) {
      const turn = this.deps.store.updateTurn(
        operationId,
        { status: 'inactive' },
        this.deps.now()
      )
      if (turn !== null) this.emit({ type: 'turn', groupId: group.id, turn })
      return
    }
    const session = await this.deps.runtime.ensureRoomSession({
      botId: info.id,
      groupThreadId: thread.id
    })
    this.deps.store.setThreadMemberSession(thread.id, info.id, session.assistantThreadId)
    const started = this.deps.store.updateTurn(
      operationId,
      {
        status: 'working',
        assistantThreadId: session.assistantThreadId
      },
      this.deps.now()
    )
    if (started === null) return
    this.emit({ type: 'turn', groupId: group.id, turn: started })

    const context: GroupTurnContext = {
      group,
      thread,
      root,
      bot: info,
      messages: this.deps.store.listMessages(thread.id, { limit: BOT_GROUP_LIMITS.pageSize }),
      handoffFrom:
        message.authorKind === 'bot' && message.requesterBotId !== null
          ? {
              botId: message.requesterBotId,
              name: message.requesterName ?? message.authorName ?? 'Bot'
            }
          : null
    }
    try {
      const prompt = await this.deps.composeTurnPrompt(context)
      const result = await this.deps.runtime.sendTurn({
        botId: info.id,
        groupThreadId: thread.id,
        assistantThreadId: session.assistantThreadId,
        prompt,
        context
      })
      await this.finishTurn(operationId, result)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const failed = this.deps.store.updateTurn(
        operationId,
        { status: 'failed', error: detail },
        this.deps.now()
      )
      if (failed !== null) this.emit({ type: 'turn', groupId: group.id, turn: failed })
      this.deps.onError?.(error)
    }
  }

  private async finishTurn(operationId: string, result: GroupTurnResult): Promise<void> {
    await runKeyedSerializedOperation(this.queues, operationId, async () => {
      const turn = this.deps.store.turn(operationId)
      if (turn === null || turn.status === 'cancelled' || turn.status === 'inactive') return
      const message = this.deps.store.message(turn.messageId)
      if (message === null) return
      const group = this.deps.store.findGroup(turn.groupId)
      if (group === null) return
      const thread = this.deps.store.findThread(turn.threadId)
      if (thread === null) return
      const member = this.deps.store.findThreadMember(thread.id, turn.botId)
      const rootSequence = message.rootSequence ?? message.seq
      const stopped =
        member === null || member.stoppedThroughSequence >= rootSequence
      if (stopped || result.status === 'stopped') {
        // A completion that races Stop cannot store a reply or hand off.
        const cancelled = this.deps.store.updateTurn(
          operationId,
          {
            status: 'cancelled',
            runId: result.runId ?? null,
            error: result.error ?? null
          },
          this.deps.now()
        )
        if (cancelled !== null) this.emit({ type: 'turn', groupId: group.id, turn: cancelled })
        return
      }
      if (result.status !== 'completed' || result.reply === null || result.reply.trim().length === 0) {
        const failed = this.deps.store.updateTurn(
          operationId,
          {
            status: 'failed',
            error: result.error ?? 'The bot did not answer.',
            runId: result.runId ?? null
          },
          this.deps.now()
        )
        if (failed !== null) this.emit({ type: 'turn', groupId: group.id, turn: failed })
        return
      }
      const now = this.deps.now()
      const reply = result.reply.trim()
      this.deps.store.updateThreadLatest(thread.id, turn.botName, reply, now)
      const completed = this.deps.store.updateTurn(
        operationId,
        {
          status: 'completed',
          reply,
          runId: result.runId ?? null
        },
        now
      )
      if (completed === null) return
      this.emit({ type: 'turn', groupId: group.id, turn: completed })
      await this.reserveHandoffs(completed, message, group, thread, reply)
    })
  }

  private async reserveHandoffs(
    turn: BotGroupTurn,
    message: BotGroupMessage,
    group: BotGroupRecord,
    thread: BotGroupThread,
    reply: string
  ): Promise<void> {
    const rootId = message.rootRequestId ?? message.id
    const root = this.deps.store.message(rootId)
    if (root === null) return
    if (!root.fromItems && root.authorKind !== 'human') return
    const memberIds = this.deps.store.listMembers(group.id).map((member) => member.botId)
    const named = memberIds
      .map((id) => {
        const info = this.deps.botInfo(id)
        return info === null ? null : { id: info.id, name: info.name }
      })
      .filter((bot): bot is GroupNamedBot => bot !== null)
    const room: GroupRoom = {
      members: memberIds.map((botId) => ({ botId })),
      replyMode: group.replyMode
    }
    const members = this.deps.store.listThreadMembers(thread.id)
    const targets = groupReplyMentions(reply, room, named, turn.botId).filter(({ id }) => {
      const info = this.deps.botInfo(id)
      const member = members.find((entry) => entry.botId === id)
      return (
        info !== null &&
        !info.paused &&
        !info.archived &&
        member !== undefined &&
        member.stoppedThroughSequence < (message.rootSequence ?? message.seq)
      )
    })
    const alreadyHandedOff = this.deps.store.countHandoffs(root.id)
    const capped = targets.slice(
      0,
      Math.max(0, BOT_GROUP_LIMITS.maxHandoffsPerRoot - alreadyHandedOff)
    )
    if (capped.length === 0) {
      this.deps.store.updateTurn(turn.operationId, { handedOff: [] }, this.deps.now())
      return
    }
    const ids = capped.map(({ id }) => id)
    this.deps.store.updateTurn(turn.operationId, { handedOff: ids }, this.deps.now())
    const now = this.deps.now()
    for (const target of capped) {
      const info = this.deps.botInfo(target.id)
      if (info === null) continue
      const handoff = this.deps.store.appendMessage({
        id: this.deps.newId('gmsg'),
        groupId: group.id,
        threadId: thread.id,
        authorKind: 'bot',
        authorBotId: turn.botId,
        authorName: turn.botName,
        body: `${turn.botName} asked ${info.name}`,
        requesterBotId: turn.botId,
        requesterName: turn.botName,
        mentioned: true,
        rootRequestId: root.id,
        rootSequence: root.seq,
        dedupeKey: `handoff:${turn.operationId}:${info.id}`,
        createdAt: now
      })
      this.titleThread(thread, handoff, now)
      const next = this.deps.store.insertTurn({
        operationId: this.deps.newId('turn'),
        messageId: handoff.id,
        groupId: group.id,
        threadId: thread.id,
        botId: info.id,
        botName: info.name,
        assistantThreadId: null,
        runId: null,
        status: 'queued',
        reply: null,
        error: null,
        context: null,
        handedOff: [],
        createdAt: now,
        updatedAt: now,
        deliveredAt: null
      })
      this.emit({ type: 'message', groupId: group.id, message: handoff })
      this.emit({ type: 'turn', groupId: group.id, turn: next })
      this.scheduleDelivery(next.operationId)
    }
  }

  /** The first line posted in a thread names it once; later lines never rename it. */
  private titleThread(
    thread: BotGroupThread,
    message: BotGroupMessage,
    now: number
  ): void {
    if (thread.isDefault || message.seq !== 1) return
    if (!groupThreadIsUntitled(thread)) return
    this.deps.store.updateThreadTitle(
      thread.id,
      groupThreadTitleFromText(message.body),
      now
    )
  }

  private requireGroup(groupId: string): BotGroupRecord {
    const group = this.deps.store.findGroup(groupId)
    if (group === null) throw new GroupChatError('GROUP_NOT_FOUND')
    return group
  }

  private requireBot(botId: string): GroupBotInfo {
    const info = this.deps.botInfo(botId)
    if (info === null || info.archived) throw new GroupChatError('GROUP_MEMBER_MISSING')
    return info
  }

  private emit(event: GroupChatEvent): void {
    try {
      this.deps.onEvent?.(event)
    } catch {
      // A broken listener must not stop a room turn.
    }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // A broken renderer must not stop a room turn.
      }
    }
  }
}
