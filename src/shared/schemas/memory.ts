import { z } from 'zod'
import { botIdSchema } from './bots'

export const memoryFactSchema = z.strictObject({
  line: z.number().int().min(0),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  text: z.string().min(1).max(2_000),
  source: z.string().max(300).nullable()
})

const memoryLineSchema = z.strictObject({
  line: z.string().max(2_500),
  after: z.string().max(2_500).nullable()
})

const memoryChangeSchema = z.strictObject({
  added: z.array(memoryLineSchema).max(1_000),
  removed: z.array(memoryLineSchema).max(1_000)
})

const memoryAuthorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('owner') }),
  z.strictObject({
    kind: z.literal('bot'),
    botId: botIdSchema,
    name: z.string().min(1).max(200)
  }),
  z.strictObject({ kind: z.literal('undo'), of: z.string().min(1).max(120) }),
  z.strictObject({ kind: z.literal('tidy-up') })
])

export const memoryHistoryRowSchema = z.strictObject({
  id: z.string().min(1).max(120),
  at: z.number().int(),
  by: memoryAuthorSchema,
  change: memoryChangeSchema,
  undoable: z.boolean()
})

const memoryTopicSchema = z.strictObject({
  name: z.string().min(1).max(120),
  lines: z.number().int().min(0)
})

export const memoryReadInputSchema = z.strictObject({ botId: botIdSchema })

export const memoryReadResultSchema = z.strictObject({
  text: z.string().max(1_000_000),
  facts: z.array(memoryFactSchema).max(2_000),
  topics: z.array(memoryTopicSchema).max(200),
  omitted: z.number().int().min(0),
  history: z.array(memoryHistoryRowSchema).max(1_000)
})

export const memoryAddInputSchema = z.strictObject({
  botId: botIdSchema,
  text: z.string().trim().min(1).max(2_000)
})

export const memoryEditInputSchema = z.strictObject({
  botId: botIdSchema,
  fact: memoryFactSchema,
  text: z.string().trim().max(2_000)
})

export const memoryForgetInputSchema = z.strictObject({
  botId: botIdSchema,
  fact: memoryFactSchema
})

export const memoryTidyUpInputSchema = z.strictObject({ botId: botIdSchema })

export const memoryUndoInputSchema = z.strictObject({
  botId: botIdSchema,
  rowId: z.string().min(1).max(120)
})

export const memoryTopicInputSchema = z.strictObject({
  botId: botIdSchema,
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(120)
})

export const memoryTopicResultSchema = z
  .strictObject({
    name: z.string().min(1).max(120),
    text: z.string().max(200_000)
  })
  .nullable()

export type MemoryFactPayload = z.infer<typeof memoryFactSchema>
export type MemoryHistoryRowPayload = z.infer<typeof memoryHistoryRowSchema>
export type MemoryReadResultPayload = z.infer<typeof memoryReadResultSchema>
export type MemoryReadInput = z.infer<typeof memoryReadInputSchema>
export type MemoryAddInput = z.infer<typeof memoryAddInputSchema>
export type MemoryEditInput = z.infer<typeof memoryEditInputSchema>
export type MemoryForgetInput = z.infer<typeof memoryForgetInputSchema>
export type MemoryUndoInput = z.infer<typeof memoryUndoInputSchema>
export type MemoryTidyUpInput = z.infer<typeof memoryTidyUpInputSchema>
export type MemoryTopicInput = z.infer<typeof memoryTopicInputSchema>
export type MemoryTopicResultPayload = z.infer<typeof memoryTopicResultSchema>
