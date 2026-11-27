export const BOT_GROUP_LIMITS = {
  maxNameLength: 60,
  maxBodyLength: 8_000,
  maxMembers: 32,
  /** A thread is named by its first post, cut to one line. */
  maxThreadTitleLength: 80,
  /** Room history quoted into a turn, in characters. */
  maxContextChars: 24_000,
  maxHandoffsPerRoot: 8,
  pageSize: 40
} as const

/** Stored title of a thread until its first post names it; the UI localizes it. */
export const NEW_GROUP_THREAD_TITLE = 'New thread'

export const GROUP_REPLY_MODES = ['bot', 'all', 'mentions'] as const

/**
 * Who answers an owner's message when it names no one. `bot` needs its default
 * replier to still be a member; otherwise the group behaves as mention-only.
 */
export type GroupReplyMode =
  | { kind: 'bot'; botId: string }
  | { kind: 'all' }
  | { kind: 'mentions' }

export type GroupNamedBot = { id: string; name: string }

export type BotGroupRecord = {
  id: string
  name: string
  revision: number
  defaultBotId: string | null
  replyMode: GroupReplyMode
  archivedAt: number | null
  /** Non-null while system notifications for this group are muted. */
  mutedAt: number | null
  createdAt: number
  updatedAt: number
}

export type BotGroupMember = {
  groupId: string
  botId: string
  joinedAt: number
}

export type BotGroupThread = {
  id: string
  groupId: string
  title: string
  isDefault: boolean
  lastReadSeq: number
  lastReadAt: number
  lastActivityAt: number
  latestAuthorName: string | null
  latestText: string | null
  latestAt: number | null
  createdAt: number
  updatedAt: number
}

export type BotGroupThreadMember = {
  threadId: string
  botId: string
  assistantThreadId: string | null
  stoppedThroughSequence: number
  joinedAt: number
}

/** A room tab's name: the group's name for the original room, or the thread's title. */
export function groupThreadLabel(
  groupName: string,
  thread: Pick<BotGroupThread, 'title' | 'isDefault'>,
  untitledLabel: string = NEW_GROUP_THREAD_TITLE
): string {
  if (thread.isDefault) return groupName
  return thread.title === NEW_GROUP_THREAD_TITLE ? untitledLabel : thread.title
}

/** The first post names a thread: its first non-empty line, cut to one line. */
export function groupThreadTitleFromText(text: string): string {
  const line = text
    .split(/\r?\n/u)
    .map((part) => part.trim())
    .find((part) => part.length > 0)
  const title = (line ?? '').slice(0, BOT_GROUP_LIMITS.maxThreadTitleLength).trim()
  return title.length > 0 ? title : NEW_GROUP_THREAD_TITLE
}

export function groupThreadIsUntitled(
  thread: Pick<BotGroupThread, 'title' | 'isDefault'>
): boolean {
  return !thread.isDefault && thread.title === NEW_GROUP_THREAD_TITLE
}

/** The room with the newest line, for the sidebar row's preview. */
export function groupLatestThread<
  T extends Pick<BotGroupThread, 'latestAt' | 'isDefault'>
>(group: { threads: readonly T[] }): T | null {
  let latest: T | null = null
  for (const thread of group.threads) {
    if (thread.latestAt === null) continue
    if (latest === null) {
      latest = thread
      continue
    }
    const latestAt = latest.latestAt ?? 0
    if (thread.latestAt > latestAt) {
      latest = thread
    } else if (thread.latestAt === latestAt && thread.isDefault && !latest.isDefault) {
      latest = thread
    }
  }
  return latest
}

export const BOT_GROUP_MESSAGE_AUTHOR_KINDS = ['human', 'bot', 'system'] as const
export type BotGroupMessageAuthorKind = (typeof BOT_GROUP_MESSAGE_AUTHOR_KINDS)[number]

export type BotGroupMessage = {
  id: string
  groupId: string
  threadId: string
  seq: number
  authorKind: BotGroupMessageAuthorKind
  authorBotId: string | null
  authorName: string | null
  body: string
  card: import('./assistant').AssistantCard | null
  dedupeKey: string | null
  rootRequestId: string | null
  rootSequence: number | null
  requesterBotId: string | null
  requesterName: string | null
  mentioned: boolean
  fromItems: boolean
  fromReports: boolean
  taskId: string | null
  createdAt: number
}

export const BOT_GROUP_TURN_STATUSES = [
  'queued',
  'working',
  'completed',
  'failed',
  'cancelled',
  'inactive'
] as const
export type BotGroupTurnStatus = (typeof BOT_GROUP_TURN_STATUSES)[number]

export type BotGroupTurn = {
  operationId: string
  messageId: string
  groupId: string
  threadId: string
  botId: string
  botName: string
  assistantThreadId: string | null
  runId: string | null
  status: BotGroupTurnStatus
  reply: string | null
  error: string | null
  context: string | null
  handedOff: string[]
  createdAt: number
  updatedAt: number
  deliveredAt: number | null
}

/** The subset of a group the mention/audience helpers need. */
export type GroupRoom = {
  members: readonly { botId: string }[]
  replyMode: GroupReplyMode
}

export function groupRoomMemberIds(room: GroupRoom): string[] {
  return room.members.map((member) => member.botId)
}

export function isBotGroupMember(room: GroupRoom, botId: string): boolean {
  return room.members.some((member) => member.botId === botId)
}
