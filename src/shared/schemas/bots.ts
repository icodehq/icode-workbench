import { z } from 'zod'
import { repoIdSchema } from './primitives'
import { BOT_LIMITS } from '../domain/bot'
import { ASSISTANT_STATUSES } from '../domain/assistant'
import { MODEL_HARNESSES } from '../domain/harness'
import {
  assistantCardSchema,
  assistantEventSchema,
  assistantSendResultSchema,
  assistantSettingsSchema,
  assistantStateSchema,
  assistantTargetSchema
} from './assistant'

export const botIdSchema = z.string().min(1).max(120)
export const botNameSchema = z.string().trim().min(1).max(BOT_LIMITS.maxNameLength)
export const botRoleSchema = z.string().trim().min(1).max(BOT_LIMITS.maxRoleLength)
export const botAvatarColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/)
export const botAvatarImageSchema = z
  .string()
  .max(400_000)
  .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/)
export const botAvatarMascotSchema = z.string().max(16)
export const BOT_AVATAR_OUTFITS = ['none', 'sun', 'ocean', 'forest', 'rose', 'violet'] as const
export const botAvatarOutfitSchema = z.enum(BOT_AVATAR_OUTFITS)
export const botInstructionsSchema = z.string().max(BOT_LIMITS.maxInstructionsLength)
export const botGroupIdSchema = z.string().min(1).max(120)

export const botRecordSchema = z.strictObject({
  id: botIdSchema,
  name: botNameSchema,
  role: botRoleSchema,
  avatarColor: botAvatarColorSchema,
  avatarImage: botAvatarImageSchema.nullable(),
  avatarMascot: botAvatarMascotSchema.nullable(),
  avatarOutfit: botAvatarOutfitSchema.nullable(),
  instructions: botInstructionsSchema,
  settings: assistantSettingsSchema.nullable(),
  archivedAt: z.number().int().nullable(),
  pausedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int()
})

export const botSummarySchema = z.strictObject({
  id: botIdSchema,
  name: botNameSchema,
  role: botRoleSchema,
  avatarColor: botAvatarColorSchema,
  avatarImage: botAvatarImageSchema.nullable(),
  avatarMascot: botAvatarMascotSchema.nullable(),
  avatarOutfit: botAvatarOutfitSchema.nullable(),
  instructions: botInstructionsSchema,
  status: z.enum(ASSISTANT_STATUSES),
  unread: z.number().int().min(0),
  activeTaskCount: z.number().int().min(0),
  reviewCount: z.number().int().min(0),
  groupIds: z.array(botGroupIdSchema).max(64),
  threadId: z.string().min(1).max(120).nullable(),
  harness: z.string().max(40).nullable(),
  archivedAt: z.number().int().nullable(),
  pausedAt: z.number().int().nullable(),
  lastActivityAt: z.number().int().nullable(),
  notificationsEnabled: z.boolean()
})

export const botCreateInputSchema = z.strictObject({
  name: botNameSchema,
  role: botRoleSchema,
  avatarColor: botAvatarColorSchema.optional(),
  avatarImage: botAvatarImageSchema.nullable().optional(),
  avatarMascot: botAvatarMascotSchema.nullable().optional(),
  avatarOutfit: botAvatarOutfitSchema.nullable().optional(),
  instructions: botInstructionsSchema.optional(),
  harness: z.enum(MODEL_HARNESSES).optional(),
  target: assistantTargetSchema.optional(),
  seedMemory: z.string().max(2_000).optional()
})

export const botUpdateInputSchema = z.strictObject({
  botId: botIdSchema,
  name: botNameSchema.optional(),
  role: botRoleSchema.optional(),
  avatarColor: botAvatarColorSchema.optional(),
  avatarImage: botAvatarImageSchema.nullable().optional(),
  avatarMascot: botAvatarMascotSchema.nullable().optional(),
  avatarOutfit: botAvatarOutfitSchema.nullable().optional(),
  instructions: botInstructionsSchema.optional(),
  settings: assistantSettingsSchema.optional()
})

export const botArchiveInputSchema = z.strictObject({ botId: botIdSchema })
export const botSetPausedInputSchema = z.strictObject({
  botId: botIdSchema,
  paused: z.boolean()
})


export const botStateInputSchema = z.strictObject({ botId: botIdSchema })

export const botConversationsInputSchema = z.strictObject({ botId: botIdSchema })

export const botNotificationsInputSchema = z.strictObject({
  botId: botIdSchema,
  limit: z.number().int().min(1).max(50).optional()
})

export const botStopInputSchema = z.strictObject({ botId: botIdSchema })
export const botNewConversationInputSchema = z.strictObject({ botId: botIdSchema })
export const botFocusInputSchema = z.strictObject({
  botId: botIdSchema,
  messageId: z.string().min(1).max(120)
})

export const botSendInputSchema = z.strictObject({
  botId: botIdSchema,
  text: z.string().trim().min(1).max(4_000),
  repoId: repoIdSchema.optional()
})

export const botMessagesInputSchema = z.strictObject({
  botId: botIdSchema,
  beforeSeq: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  conversationId: z.string().min(1).max(120).optional()
})

export const botMarkReadInputSchema = z.strictObject({
  botId: botIdSchema,
  messageId: z.string().min(1).max(120).optional(),
  read: z.boolean().optional()
})

export const botSettingsInputSchema = z.strictObject({ botId: botIdSchema })
export const botSetSettingsInputSchema = z.strictObject({
  botId: botIdSchema,
  settings: assistantSettingsSchema
})

export const botMemoryScopeSchema = z.enum(['bot', 'project', 'team'])
export const botMemoryStatusSchema = z.enum(['proposed', 'active', 'archived'])

export const botMemoryEntrySchema = z.strictObject({
  id: z.string().min(1).max(120),
  scope: botMemoryScopeSchema,
  botId: botIdSchema.nullable(),
  repoId: repoIdSchema.nullable(),
  teamId: botGroupIdSchema.nullable(),
  proposedByBotId: botIdSchema.nullable(),
  key: z.string().min(1).max(120),
  value: z.string().min(1).max(2_000),
  status: botMemoryStatusSchema,
  sourceTaskId: z.string().max(120).nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int()
})

export const botMemoryListInputSchema = z
  .strictObject({
    botId: botIdSchema,
    scope: botMemoryScopeSchema,
    repoId: repoIdSchema.optional(),
    teamId: botGroupIdSchema.optional(),
    status: botMemoryStatusSchema.optional()
  })
  .refine(
    (value) =>
      (value.scope === 'bot' && value.repoId === undefined && value.teamId === undefined) ||
      (value.scope === 'project' && value.repoId !== undefined && value.teamId === undefined) ||
      (value.scope === 'team' && value.teamId !== undefined && value.repoId === undefined),
    { message: 'Memory scope and target do not match.' }
  )

export const botMemorySetInputSchema = z
  .strictObject({
    botId: botIdSchema,
    scope: botMemoryScopeSchema,
    key: z.string().min(1).max(120),
    value: z.string().min(1).max(2_000),
    repoId: repoIdSchema.optional(),
    teamId: botGroupIdSchema.optional(),
    status: z.enum(['proposed', 'active']).optional()
  })
  .refine(
    (value) =>
      (value.scope === 'bot' && value.repoId === undefined && value.teamId === undefined) ||
      (value.scope === 'project' && value.repoId !== undefined && value.teamId === undefined) ||
      (value.scope === 'team' && value.teamId !== undefined && value.repoId === undefined),
    { message: 'Memory scope and target do not match.' }
  )

export const botMemoryDeleteInputSchema = z.strictObject({
  botId: botIdSchema,
  memoryId: z.string().min(1).max(120)
})

export const botMemoryApproveInputSchema = z.strictObject({
  botId: botIdSchema,
  memoryId: z.string().min(1).max(120)
})

export const botEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('changed'),
    /** Null means "re-read the roster"; a bot id means that bot changed. */
    botId: botIdSchema.nullable()
  }),
  z.strictObject({
    type: z.literal('chat'),
    botId: botIdSchema,
    threadId: z.string().min(1).max(120),
    event: assistantEventSchema
  })
])

export type BotRecordPayload = z.infer<typeof botRecordSchema>
export type BotSummaryPayload = z.infer<typeof botSummarySchema>
export type BotCreateInput = z.infer<typeof botCreateInputSchema>
export type BotUpdateInput = z.infer<typeof botUpdateInputSchema>
export type BotStatePayload = z.infer<typeof assistantStateSchema>
export type BotSendResult = z.infer<typeof assistantSendResultSchema>
export type BotEventPayload = z.infer<typeof botEventSchema>
export type BotMemoryListInput = z.infer<typeof botMemoryListInputSchema>
export type BotMemorySetInput = z.infer<typeof botMemorySetInputSchema>
export type BotMemoryEntryPayload = z.infer<typeof botMemoryEntrySchema>
export type BotCardPayload = z.infer<typeof assistantCardSchema>
