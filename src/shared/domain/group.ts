export const BOT_GROUP_LIMITS = {
  maxNameLength: 60,
  maxBodyLength: 8_000,
  maxMembers: 32,
  maxThreads: 32,
  /** Room history quoted into a turn, in characters. */
  maxContextChars: 24_000,
  maxHandoffsPerRoot: 8,
  pageSize: 40
} as const

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
