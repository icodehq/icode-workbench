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

export const botHomeInputSchema = z.strictObject({ botId: botIdSchema })
export const botHomeResultSchema = z.strictObject({
  path: z.string().min(1).max(4_096),
  opened: z.boolean()
})

export const botSettingsInputSchema = z.strictObject({ botId: botIdSchema })
export const botSetSettingsInputSchema = z.strictObject({
  botId: botIdSchema,
  settings: assistantSettingsSchema
})

export const botAutomationSchema = z.strictObject({
  id: z.string().min(1).max(120),
  botId: botIdSchema,
  name: z.string().min(1).max(120),
  prompt: z.string().min(1).max(4_000),
  intervalMinutes: z.number().int().min(1).max(10_080),
  enabled: z.boolean(),
  lastRunAt: z.number().int().nullable(),
  nextRunAt: z.number().int(),
  createdAt: z.number().int(),
  updatedAt: z.number().int()
})

export const botAutomationsInputSchema = z.strictObject({ botId: botIdSchema })
export const botAutomationCreateInputSchema = z.strictObject({
  botId: botIdSchema,
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(4_000),
  intervalMinutes: z.number().int().min(1).max(10_080),
  enabled: z.boolean().optional()
})
export const botAutomationUpdateInputSchema = z.strictObject({
  id: z.string().min(1).max(120),
  name: z.string().trim().min(1).max(120).optional(),
  prompt: z.string().trim().min(1).max(4_000).optional(),
  intervalMinutes: z.number().int().min(1).max(10_080).optional(),
  enabled: z.boolean().optional()
})
export const botAutomationRemoveInputSchema = z.strictObject({
  id: z.string().min(1).max(120)
})

export const botSkillFolderSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/)
  .max(80)

export const botSkillSchema = z.strictObject({
  name: z.string().min(1).max(200),
  description: z.string().max(300),
  folder: botSkillFolderSchema,
  updatedAt: z.number().int()
})

export const botSkillsInputSchema = z.strictObject({ botId: botIdSchema })
export const botSkillReadInputSchema = z.strictObject({
  botId: botIdSchema,
  folder: botSkillFolderSchema
})
export const botSkillSaveInputSchema = z.strictObject({
  botId: botIdSchema,
  folder: botSkillFolderSchema,
  text: z.string().max(100_000)
})
export const botSkillDeleteInputSchema = z.strictObject({
  botId: botIdSchema,
  folder: botSkillFolderSchema
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
export type BotSkillPayload = z.infer<typeof botSkillSchema>
export type BotAutomationPayload = z.infer<typeof botAutomationSchema>
export type BotCardPayload = z.infer<typeof assistantCardSchema>
