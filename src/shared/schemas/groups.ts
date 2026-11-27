import { z } from 'zod'
import { assistantCardSchema } from './assistant'
import { repoIdSchema } from './primitives'
import { BOT_GROUP_LIMITS, BOT_GROUP_MESSAGE_AUTHOR_KINDS, BOT_GROUP_TURN_STATUSES, GROUP_REPLY_MODES } from '../domain/group'

export const groupIdSchema = z.string().min(1).max(120)
export const groupThreadIdSchema = z.string().min(1).max(120)
export const groupMessageIdSchema = z.string().min(1).max(120)

export const groupReplyModeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('bot'), botId: z.string().min(1).max(120) }),
  z.strictObject({ kind: z.literal('all') }),
  z.strictObject({ kind: z.literal('mentions') })
])

export const groupThreadPayloadSchema = z.strictObject({
  id: groupThreadIdSchema,
  groupId: groupIdSchema,
  title: z.string().min(1).max(BOT_GROUP_LIMITS.maxThreadTitleLength),
  isDefault: z.boolean(),
  lastReadSeq: z.number().int().min(0),
  lastReadAt: z.number().int().min(0),
  lastActivityAt: z.number().int().min(0),
  latestAuthorName: z.string().max(200).nullable(),
  latestText: z.string().max(BOT_GROUP_LIMITS.maxBodyLength).nullable(),
  latestAt: z.number().int().nullable(),
  unread: z.number().int().min(0),
  createdAt: z.number().int(),
  updatedAt: z.number().int()
})

export const groupSummarySchema = z.strictObject({
  id: groupIdSchema,
  name: z.string().min(1).max(BOT_GROUP_LIMITS.maxNameLength),
  revision: z.number().int().min(1),
  defaultBotId: z.string().min(1).max(120).nullable(),
  replyMode: groupReplyModeSchema,
  memberBotIds: z.array(z.string().min(1).max(120)).max(BOT_GROUP_LIMITS.maxMembers),
  threads: z.array(groupThreadPayloadSchema),
  unread: z.number().int().min(0),
  archivedAt: z.number().int().nullable(),
  mutedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int()
})

export const groupTurnSchema = z.strictObject({
  operationId: z.string().min(1).max(120),
  messageId: groupMessageIdSchema,
  groupId: groupIdSchema,
  threadId: groupThreadIdSchema,
  botId: z.string().min(1).max(120),
  botName: z.string().min(1).max(200),
  assistantThreadId: z.string().max(120).nullable(),
  runId: z.string().max(120).nullable(),
  status: z.enum(BOT_GROUP_TURN_STATUSES),
  reply: z.string().max(200_000).nullable(),
  error: z.string().max(4_000).nullable(),
  handedOff: z.array(z.string().min(1).max(120)),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  deliveredAt: z.number().int().nullable()
})

export const groupMessageSchema = z.strictObject({
  id: groupMessageIdSchema,
  groupId: groupIdSchema,
  threadId: groupThreadIdSchema,
  seq: z.number().int().min(1),
  authorKind: z.enum(BOT_GROUP_MESSAGE_AUTHOR_KINDS),
  authorBotId: z.string().min(1).max(120).nullable(),
  authorName: z.string().max(200).nullable(),
  body: z.string().min(1).max(BOT_GROUP_LIMITS.maxBodyLength),
  card: assistantCardSchema.nullable(),
  dedupeKey: z.string().max(200).nullable(),
  rootRequestId: z.string().max(120).nullable(),
  rootSequence: z.number().int().nullable(),
  requesterBotId: z.string().max(120).nullable(),
  requesterName: z.string().max(200).nullable(),
  mentioned: z.boolean(),
  fromItems: z.boolean(),
  fromReports: z.boolean(),
  taskId: z.string().max(120).nullable(),
  createdAt: z.number().int()
})

export const groupMessageWithTurnsSchema = groupMessageSchema.extend({
  turns: z.array(groupTurnSchema).max(64)
})

export const groupsListInputSchema = z.strictObject({})

export const groupCreateInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(BOT_GROUP_LIMITS.maxNameLength),
  memberBotIds: z
    .array(z.string().min(1).max(120))
    .min(1)
    .max(BOT_GROUP_LIMITS.maxMembers),
  defaultBotId: z.string().min(1).max(120).optional(),
  replyMode: groupReplyModeSchema.optional()
})

export const groupUpdateInputSchema = z.strictObject({
  groupId: groupIdSchema,
  revision: z.number().int().min(1),
  name: z.string().trim().min(1).max(BOT_GROUP_LIMITS.maxNameLength).optional(),
  memberBotIds: z
    .array(z.string().min(1).max(120))
    .min(1)
    .max(BOT_GROUP_LIMITS.maxMembers)
    .optional(),
  defaultBotId: z.string().min(1).max(120).nullable().optional(),
  replyMode: groupReplyModeSchema.optional()
})

export const groupSetMutedInputSchema = z.strictObject({
  groupId: groupIdSchema,
  muted: z.boolean()
})

export const groupSetMutedResultSchema = z.strictObject({
  group: groupSummarySchema
})

export const groupThreadCreateInputSchema = z.strictObject({
  groupId: groupIdSchema
})

export const groupArchiveInputSchema = z.strictObject({
  groupId: groupIdSchema
})

export const groupDeleteInputSchema = z.strictObject({
  groupId: groupIdSchema
})

export const groupThreadCreateResultSchema = z.strictObject({
  thread: groupThreadPayloadSchema
})

export const groupMessagesInputSchema = z.strictObject({
  threadId: groupThreadIdSchema,
  beforeSeq: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(200).optional()
})

export const groupMessagesResultSchema = z.strictObject({
  messages: z.array(groupMessageWithTurnsSchema),
  hasEarlier: z.boolean()
})

export const groupSendInputSchema = z.strictObject({
  groupId: groupIdSchema,
  threadId: groupThreadIdSchema,
  text: z.string().trim().min(1).max(BOT_GROUP_LIMITS.maxBodyLength),
  messageId: groupMessageIdSchema.optional(),
  revision: z.number().int().min(1).optional(),
  repoId: repoIdSchema.optional()
})

export const groupSendResultSchema = z.strictObject({
  message: groupMessageWithTurnsSchema
})

export const groupMarkReadInputSchema = z.strictObject({
  threadId: groupThreadIdSchema,
  seq: z.number().int().min(0)
})

export const groupMarkReadResultSchema = z.strictObject({ unread: z.number().int().min(0) })

export const groupSetReadInputSchema = z.strictObject({
  groupId: groupIdSchema,
  read: z.boolean()
})

export const groupSetReadResultSchema = z.strictObject({
  unread: z.number().int().min(0)
})

export const groupStopInputSchema = z.strictObject({
  groupId: groupIdSchema,
  threadId: groupThreadIdSchema,
  botId: z.string().min(1).max(120).optional()
})

export const groupStopResultSchema = z.strictObject({
  turns: z.array(groupTurnSchema).max(64)
})

export const groupTurnDetailsInputSchema = z.strictObject({
  operationId: z.string().min(1).max(120)
})

export const groupEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('changed'), groupId: groupIdSchema }),
  z.strictObject({
    type: z.literal('message'),
    groupId: groupIdSchema,
    message: groupMessageWithTurnsSchema
  }),
  z.strictObject({
    type: z.literal('turn'),
    groupId: groupIdSchema,
    turn: groupTurnSchema
  }),
  z.strictObject({
    type: z.literal('thread'),
    groupId: groupIdSchema,
    threadId: groupThreadIdSchema
  }),
  z.strictObject({
    type: z.literal('read'),
    groupId: groupIdSchema,
    threadId: groupThreadIdSchema,
    seq: z.number().int().min(0),
    unread: z.number().int().min(0)
  })
])

export type GroupThreadPayload = z.infer<typeof groupThreadPayloadSchema>
export type GroupSummaryPayload = z.infer<typeof groupSummarySchema>
export type GroupTurnPayload = z.infer<typeof groupTurnSchema>
export type GroupMessagePayload = z.infer<typeof groupMessageSchema>
export type GroupMessageWithTurnsPayload = z.infer<typeof groupMessageWithTurnsSchema>
export type GroupCreateInput = z.infer<typeof groupCreateInputSchema>
export type GroupUpdateInput = z.infer<typeof groupUpdateInputSchema>
export type GroupArchiveInput = z.infer<typeof groupArchiveInputSchema>
export type GroupDeleteInput = z.infer<typeof groupDeleteInputSchema>
export type GroupSetMutedInput = z.infer<typeof groupSetMutedInputSchema>
export type GroupSetReadInput = z.infer<typeof groupSetReadInputSchema>
export type GroupSendInput = z.infer<typeof groupSendInputSchema>
export type GroupSendResult = z.infer<typeof groupSendResultSchema>
export type GroupMessagesResult = z.infer<typeof groupMessagesResultSchema>
export type GroupEventPayload = z.infer<typeof groupEventSchema>
export type GroupTurnDetailsInput = z.infer<typeof groupTurnDetailsInputSchema>

export const GROUP_REPLY_MODE_KINDS = GROUP_REPLY_MODES
