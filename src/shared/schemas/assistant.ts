import { z } from 'zod'
import { repoIdSchema } from './primitives'
import {
  ASSISTANT_CONVERSATION_RESET_REASONS,
  ASSISTANT_CONVERSATION_STATES,
  ASSISTANT_LIMITS,
  ASSISTANT_MESSAGE_KINDS,
  ASSISTANT_NOTIFICATION_KINDS,
  ASSISTANT_NOTIFICATION_STATES,
  ASSISTANT_PRIORITIES,
  ASSISTANT_ROLES,
  ASSISTANT_RUN_STAGES,
  ASSISTANT_RUN_STATUSES,
  ASSISTANT_STATUSES,
  ASSISTANT_TRIGGERS
} from '../domain/assistant'

const assistantRoleSchema = z.enum(ASSISTANT_ROLES)
const assistantMessageKindSchema = z.enum(ASSISTANT_MESSAGE_KINDS)
const assistantPrioritySchema = z.enum(ASSISTANT_PRIORITIES)
const assistantStatusSchema = z.enum(ASSISTANT_STATUSES)
const assistantTriggerSchema = z.enum(ASSISTANT_TRIGGERS)
const assistantRunStatusSchema = z.enum(ASSISTANT_RUN_STATUSES)
const assistantRunStageSchema = z.enum(ASSISTANT_RUN_STAGES)
const assistantNotificationStateSchema = z.enum(ASSISTANT_NOTIFICATION_STATES)
const assistantNotificationKindSchema = z.enum(ASSISTANT_NOTIFICATION_KINDS)

export const assistantTaskCardSchema = z.strictObject({
  type: z.literal('task'),
  taskId: z.string().min(1).max(120),
  repoId: repoIdSchema,
  title: z.string().min(1).max(200),
  status: z.string().min(1).max(40),
  approval: z.enum(['approved', 'pending', 'rejected']),
  autoApproved: z.boolean().optional(),
  reasons: z.array(z.string().max(200)).max(10).optional()
})

export const assistantActionCardSchema = z.strictObject({
  type: z.literal('action'),
  op: z.string().min(1).max(80),
  ok: z.boolean(),
  message: z.string().max(2_000),
  taskId: z.string().max(120).optional()
})

export const assistantNotificationCardSchema = z.strictObject({
  type: z.literal('notification'),
  kind: assistantNotificationKindSchema,
  text: z.string().min(1).max(ASSISTANT_LIMITS.maxNotificationLength),
  taskId: z.string().max(120).optional(),
  repoId: repoIdSchema.optional()
})

export const assistantErrorCardSchema = z.strictObject({
  type: z.literal('error'),
  message: z.string().min(1).max(2_000)
})

export const assistantCardSchema = z.discriminatedUnion('type', [
  assistantTaskCardSchema,
  assistantActionCardSchema,
  assistantNotificationCardSchema,
  assistantErrorCardSchema
])

export const assistantThreadSchema = z.strictObject({
  id: z.string().min(1).max(120),
  kind: z.enum(['main', 'system']),
  title: z.string().min(1).max(200),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  lastMessageAt: z.number().int().nullable(),
  lastReadSeq: z.number().int().min(0),
  activeRunId: z.string().max(120).nullable(),
  archivedAt: z.number().int().nullable()
})

export const assistantConversationSchema = z.strictObject({
  id: z.string().min(1).max(120),
  threadId: z.string().min(1).max(120),
  harness: z.enum(['claude', 'codex', 'opencode']),
  targetKind: z.enum(['local', 'wsl']),
  targetDistro: z.string().max(200).nullable(),
  state: z.enum(ASSISTANT_CONVERSATION_STATES),
  resetReason: z.enum(ASSISTANT_CONVERSATION_RESET_REASONS).nullable(),
  startSeq: z.number().int().min(1),
  /** Null for the latest open segment. */
  endSeq: z.number().int().min(1).nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int()
})

export const assistantMessageSchema = z.strictObject({
  id: z.string().min(1).max(120),
  threadId: z.string().min(1).max(120),
  seq: z.number().int().min(1),
  runId: z.string().max(120).nullable(),
  role: assistantRoleSchema,
  kind: assistantMessageKindSchema,
  body: z.string().min(1).max(20_000),
  card: assistantCardSchema.nullable(),
  notificationKind: assistantNotificationKindSchema.nullable(),
  notificationPriority: assistantPrioritySchema.nullable(),
  notificationState: assistantNotificationStateSchema.nullable(),
  createdAt: z.number().int()
})

export const assistantRunSchema = z.strictObject({
  id: z.string().min(1).max(120),
  threadId: z.string().min(1).max(120),
  trigger: assistantTriggerSchema,
  status: assistantRunStatusSchema,
  stage: z.string().max(120).nullable(),
  harness: z.enum(['claude', 'codex', 'opencode']).nullable(),
  targetKind: z.enum(['local', 'wsl']).nullable(),
  targetDistro: z.string().max(200).nullable(),
  round: z.number().int().min(0),
  contextChars: z.number().int().min(0).nullable(),
  startedAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
  error: z.string().max(4_000).nullable()
})

export const assistantTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('auto') }),
  z.strictObject({ kind: z.literal('local') }),
  z.strictObject({ kind: z.literal('wsl'), distro: z.string().min(1).max(200) })
])

export const assistantNotificationSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  budgetPerHour: z.number().int().min(0).max(100),
  quietMode: z.enum(['off', 'in-app', 'respect-hours']),
  quietHours: z.strictObject({
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(0).max(1439)
  })
})

export const assistantAutoDispatchSettingsSchema = z.strictObject({
  mode: z.enum(['off', 'low-risk', 'all']),
  dailyCapPerProject: z.number().int().min(0).max(100),
  dailyCapGlobal: z.number().int().min(0).max(200),
  maxTasksPerRun: z.number().int().min(0).max(10),
  protectedKeywords: z.array(z.string().min(1).max(80)).max(50),
  protectedPaths: z.array(z.string().min(1).max(200)).max(50)
})

export const assistantSettingsSchema = z.strictObject({
  personaName: z.string().min(1).max(40),
  target: assistantTargetSchema,
  harnessPriority: z.array(z.enum(['claude', 'codex', 'opencode'])).min(1).max(3),
  opencodeAgent: z.string().min(1).max(80),
  notifications: assistantNotificationSettingsSchema,
  autoDispatch: assistantAutoDispatchSettingsSchema
})

export const assistantStateSchema = z.strictObject({
  threadId: z.string().min(1).max(120),
  personaName: z.string().min(1).max(40),
  unread: z.number().int().min(0),
  status: assistantStatusSchema,
  harness: z.string().max(40).nullable(),
  target: z.string().max(240).nullable(),
  activeRun: z
    .strictObject({
      id: z.string().min(1).max(120),
      stage: assistantRunStageSchema,
      harness: z.string().max(40).nullable(),
      target: z.string().max(240).nullable(),
      round: z.number().int().min(0),
      thinkingTokens: z.number().int().min(0).nullable(),
      startedAt: z.number().int()
    })
    .nullable(),
  settings: assistantSettingsSchema
})

export const assistantEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('changed') }),
  z.strictObject({ type: z.literal('status'), status: assistantStatusSchema }),
  z.strictObject({
    type: z.literal('focus'),
    threadId: z.string().min(1).max(120),
    messageId: z.string().min(1).max(120),
    conversationId: z.string().min(1).max(120).nullable(),
    seq: z.number().int().min(1).nullable()
  }),
  z.strictObject({
    type: z.literal('run'),
    runId: z.string().min(1).max(120),
    stage: assistantRunStageSchema,
    harness: z.string().max(40).nullable(),
    target: z.string().max(240).nullable(),
    round: z.number().int().min(0),
    thinkingTokens: z.number().int().min(0).nullable(),
    startedAt: z.number().int()
  }),
  z.strictObject({
    type: z.literal('delta'),
    runId: z.string().min(1).max(120),
    text: z.string().max(20_000)
  })
])

export const assistantSendInputSchema = z.strictObject({
  text: z.string().trim().min(1).max(ASSISTANT_LIMITS.maxMessageLength),
  repoId: repoIdSchema.optional()
})

export const assistantSendResultSchema = z.strictObject({
  message: assistantMessageSchema,
  runId: z.string().min(1).max(120)
})

export const assistantMessagesInputSchema = z.strictObject({
  threadId: z.string().min(1).max(120),
  beforeSeq: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(ASSISTANT_LIMITS.maxThreadMessages).optional(),
  conversationId: z.string().min(1).max(120).optional()
})

export const assistantMarkReadInputSchema = z.strictObject({
  threadId: z.string().min(1).max(120),
  messageId: z.string().min(1).max(120).optional()
})

export const assistantRunInputSchema = z.strictObject({
  threadId: z.string().min(1).max(120)
})

export const assistantSetSettingsInputSchema = z.strictObject({
  settings: assistantSettingsSchema
})

export const assistantEmptyInputSchema = z.strictObject({})

export const assistantNotificationsInputSchema = z.strictObject({
  limit: z.number().int().min(1).max(ASSISTANT_LIMITS.maxNotificationFeed).optional()
})

export const assistantFocusInputSchema = z.strictObject({
  messageId: z.string().min(1).max(120)
})

export const assistantNewConversationResultSchema = z.strictObject({
  message: assistantMessageSchema.nullable()
})

export type AssistantThreadPayload = z.infer<typeof assistantThreadSchema>
export type AssistantConversationPayload = z.infer<typeof assistantConversationSchema>
export type AssistantMessagePayload = z.infer<typeof assistantMessageSchema>
export type AssistantRunPayload = z.infer<typeof assistantRunSchema>
export type AssistantStatePayload = z.infer<typeof assistantStateSchema>
export type AssistantEventPayload = z.infer<typeof assistantEventSchema>
export type AssistantSettingsPayload = z.infer<typeof assistantSettingsSchema>
export type AssistantSendInput = z.infer<typeof assistantSendInputSchema>
export type AssistantSendResult = z.infer<typeof assistantSendResultSchema>
export type AssistantNewConversationResult = z.infer<
  typeof assistantNewConversationResultSchema
>
export type AssistantMessagesInput = z.infer<typeof assistantMessagesInputSchema>
export type AssistantNotificationsInput = z.infer<typeof assistantNotificationsInputSchema>
export type AssistantFocusInput = z.infer<typeof assistantFocusInputSchema>
export type AssistantMarkReadInput = z.infer<typeof assistantMarkReadInputSchema>
export type AssistantCardPayload = z.infer<typeof assistantCardSchema>
