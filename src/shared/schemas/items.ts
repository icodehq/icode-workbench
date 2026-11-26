import { z } from 'zod'
import {
  ITEM_LIMITS,
  ITEM_STATUSES,
  TASK_COMMENT_AUTHOR_KINDS,
  TASK_COMMENT_KINDS,
  TASK_LINK_KINDS
} from '../domain/item'
import { taskRecordSchema } from './workspace'

export const itemTaskIdSchema = z.string().min(1).max(120)
export const itemStatusSchema = z.enum(ITEM_STATUSES)
export const taskCommentKindSchema = z.enum(TASK_COMMENT_KINDS)
export const taskCommentAuthorKindSchema = z.enum(TASK_COMMENT_AUTHOR_KINDS)
export const taskLinkKindSchema = z.enum(TASK_LINK_KINDS)

export const taskCommentSchema = z.strictObject({
  id: z.string().min(1).max(120),
  taskId: itemTaskIdSchema,
  authorKind: taskCommentAuthorKindSchema,
  authorBotId: z.string().min(1).max(120).nullable(),
  authorName: z.string().max(200).nullable(),
  kind: taskCommentKindSchema,
  body: z.string().min(1).max(ITEM_LIMITS.maxBodyLength),
  options: z.array(z.string().max(ITEM_LIMITS.maxOptionLength)).nullable(),
  recommendedOption: z.string().max(ITEM_LIMITS.maxOptionLength).nullable(),
  replyToId: z.string().max(120).nullable(),
  answeredAt: z.number().int().nullable(),
  dedupeKey: z.string().max(200).nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int()
})

export const taskLinkSchema = z.strictObject({
  taskId: itemTaskIdSchema,
  kind: taskLinkKindSchema,
  ref: z.string().min(1).max(ITEM_LIMITS.maxRefLength),
  addedAt: z.number().int()
})

export const taskAttachmentSchema = z.strictObject({
  id: z.string().min(1).max(120),
  taskId: itemTaskIdSchema,
  name: z.string().min(1).max(200),
  mime: z.string().min(1).max(200),
  size: z.number().int().min(0).max(ITEM_LIMITS.maxAttachmentBytes),
  dataUrl: z.string().min(1).max(ITEM_LIMITS.maxAttachmentBytes * 2),
  createdAt: z.number().int()
})

export const itemSchema = z.strictObject({
  task: taskRecordSchema,
  status: itemStatusSchema,
  comments: z.array(taskCommentSchema),
  links: z.array(taskLinkSchema),
  attachments: z.array(taskAttachmentSchema).max(ITEM_LIMITS.maxAttachmentsPerTask),
  openQuestion: taskCommentSchema.nullable(),
  stale: z.boolean()
})

export const itemCountsSchema = z.strictObject({
  planned: z.number().int().min(0),
  working: z.number().int().min(0),
  waiting: z.number().int().min(0),
  needs_you: z.number().int().min(0),
  done: z.number().int().min(0),
  canceled: z.number().int().min(0)
})

export const itemsListInputSchema = z.strictObject({
  repoId: z.string().min(1).max(120).optional(),
  groupId: z.string().min(1).max(120).optional(),
  botId: z.string().min(1).max(120).optional(),
  includeArchived: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).optional()
})

export const itemsListResultSchema = z.strictObject({
  items: z.array(itemSchema),
  counts: itemCountsSchema
})

export const itemsGetInputSchema = z.strictObject({ taskId: itemTaskIdSchema })
export const itemsGetResultSchema = z.strictObject({ item: itemSchema.nullable() })

export const itemsCommentInputSchema = z.strictObject({
  taskId: itemTaskIdSchema,
  body: z.string().trim().min(1).max(ITEM_LIMITS.maxBodyLength)
})

export const itemsAskInputSchema = z.strictObject({
  taskId: itemTaskIdSchema,
  body: z.string().trim().min(1).max(ITEM_LIMITS.maxBodyLength),
  options: z.array(z.string().max(ITEM_LIMITS.maxOptionLength)).max(ITEM_LIMITS.maxOptions).optional(),
  recommendedOption: z.string().max(ITEM_LIMITS.maxOptionLength).optional()
})

export const itemsAnswerInputSchema = z.strictObject({
  taskId: itemTaskIdSchema,
  commentId: z.string().min(1).max(120),
  body: z.string().trim().min(1).max(ITEM_LIMITS.maxBodyLength)
})

export const itemsSetStatusInputSchema = z.strictObject({
  taskId: itemTaskIdSchema,
  status: itemStatusSchema.nullable()
})

export const itemsSetStatusResultSchema = z.strictObject({ item: itemSchema })

export const itemsSnoozeInputSchema = z.strictObject({
  taskId: itemTaskIdSchema,
  until: z.number().int().nullable()
})

export const itemsAttachInputSchema = z.strictObject({
  taskId: itemTaskIdSchema,
  name: z.string().trim().min(1).max(200),
  mime: z.string().trim().min(1).max(200),
  size: z.number().int().min(0).max(ITEM_LIMITS.maxAttachmentBytes),
  dataUrl: z.string().min(1).max(ITEM_LIMITS.maxAttachmentBytes * 2)
})

export const itemsRemoveAttachmentInputSchema = z.strictObject({
  taskId: itemTaskIdSchema,
  id: z.string().min(1).max(120)
})

export const itemsLinkAddInputSchema = z.strictObject({
  taskId: itemTaskIdSchema,
  kind: taskLinkKindSchema,
  ref: z.string().trim().min(1).max(ITEM_LIMITS.maxRefLength)
})

export const itemsLinkRemoveInputSchema = itemsLinkAddInputSchema

export type ItemPayload = z.infer<typeof itemSchema>
export type ItemCountsPayload = z.infer<typeof itemCountsSchema>
export type TaskCommentPayload = z.infer<typeof taskCommentSchema>
export type TaskLinkPayload = z.infer<typeof taskLinkSchema>
export type TaskAttachmentPayload = z.infer<typeof taskAttachmentSchema>
export type ItemsListResult = z.infer<typeof itemsListResultSchema>
export type ItemsListInput = z.infer<typeof itemsListInputSchema>
export type ItemsCommentInput = z.infer<typeof itemsCommentInputSchema>
export type ItemsAskInput = z.infer<typeof itemsAskInputSchema>
export type ItemsAnswerInput = z.infer<typeof itemsAnswerInputSchema>
export type ItemsSnoozeInput = z.infer<typeof itemsSnoozeInputSchema>
export type ItemsSetStatusInput = z.infer<typeof itemsSetStatusInputSchema>
export type ItemsLinkAddInput = z.infer<typeof itemsLinkAddInputSchema>
export type ItemsAttachInput = z.infer<typeof itemsAttachInputSchema>
export type ItemsRemoveAttachmentInput = z.infer<typeof itemsRemoveAttachmentInputSchema>
