import { z } from 'zod'
import { repoIdSchema } from '../../shared/schemas/primitives'
import { ASSISTANT_LIMITS, ASSISTANT_NOTIFICATION_KINDS } from '../../shared/domain/assistant'

const taskId = z.string().min(1).max(120)
const text = z.string().trim().min(1).max(ASSISTANT_LIMITS.maxMessageLength)

const stateAction = z.strictObject({ op: z.literal('state') })
const projectsList = z.strictObject({ op: z.literal('projects.list') })
const tasksListAll = z.strictObject({
  op: z.literal('tasks.listAll'),
  statuses: z.array(z.string().max(40)).max(7).optional(),
  approvals: z.array(z.enum(['approved', 'pending', 'rejected'])).max(3).optional(),
  includeArchived: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional()
})
const tasksGet = z.strictObject({ op: z.literal('tasks.get'), taskId })
const tasksChanges = z.strictObject({ op: z.literal('tasks.changes'), taskId })
const tasksDiff = z.strictObject({
  op: z.literal('tasks.diff'),
  taskId,
  path: z.string().min(1).max(4096)
})
const sessionsList = z.strictObject({
  op: z.literal('sessions.list'),
  repoId: repoIdSchema.optional()
})
const tasksCreate = z.strictObject({
  op: z.literal('tasks.create'),
  repoId: repoIdSchema,
  title: z.string().max(200).optional(),
  prompt: z.string().trim().min(1).max(20_000),
  harness: z.enum(['claude', 'codex', 'opencode']).optional(),
  idempotencyKey: z.string().min(1).max(200).optional()
})
const tasksCancel = z.strictObject({ op: z.literal('tasks.cancel'), taskId })
const tasksRetry = z.strictObject({ op: z.literal('tasks.retry'), taskId })
const tasksResume = z.strictObject({ op: z.literal('tasks.resume'), taskId })
const tasksArchive = z.strictObject({ op: z.literal('tasks.archive'), taskId })
const sessionsMessage = z.strictObject({
  op: z.literal('sessions.message'),
  taskId,
  text
})
const supervisorMessage = z.strictObject({
  op: z.literal('supervisor.message'),
  repoId: repoIdSchema,
  text
})
const reviewRecommend = z.strictObject({
  op: z.literal('review.recommend'),
  taskId,
  decision: z.enum(['accept', 'reject']),
  note: z.string().max(2_000).optional()
})
const notify = z.strictObject({
  op: z.literal('notify'),
  text: z.string().trim().min(1).max(ASSISTANT_LIMITS.maxNotificationLength),
  kind: z.enum(ASSISTANT_NOTIFICATION_KINDS).optional(),
  priority: z.enum(['high', 'normal', 'low']).optional()
})
const memorySet = z.strictObject({
  op: z.literal('memory.set'),
  key: z.string().min(1).max(ASSISTANT_LIMITS.maxMemoryKeyLength),
  value: z.string().min(1).max(ASSISTANT_LIMITS.maxMemoryValueLength)
})
const memoryForget = z.strictObject({
  op: z.literal('memory.forget'),
  key: z.string().min(1).max(ASSISTANT_LIMITS.maxMemoryKeyLength)
})

export const assistantActionSchema = z.discriminatedUnion('op', [
  stateAction,
  projectsList,
  tasksListAll,
  tasksGet,
  tasksChanges,
  tasksDiff,
  sessionsList,
  tasksCreate,
  tasksCancel,
  tasksRetry,
  tasksResume,
  tasksArchive,
  sessionsMessage,
  supervisorMessage,
  reviewRecommend,
  notify,
  memorySet,
  memoryForget
])

export const assistantEnvelopeSchema = z.strictObject({
  reply: z.string().max(8_000).optional(),
  actions: z.array(assistantActionSchema).max(ASSISTANT_LIMITS.maxActionsPerRound).optional(),
  notify: z
    .strictObject({
      text: z.string().trim().min(1).max(ASSISTANT_LIMITS.maxNotificationLength),
      kind: z.enum(ASSISTANT_NOTIFICATION_KINDS).optional(),
      priority: z.enum(['high', 'normal', 'low']).optional()
    })
    .optional()
})

export type AssistantEnvelope = z.infer<typeof assistantEnvelopeSchema>
export type AssistantActionPayload = z.infer<typeof assistantActionSchema>

/**
 * Models sometimes wrap JSON in prose or a fence. Extract the first balanced
 * object and validate it; never execute actions from a partial parse.
 */
export function parseAssistantEnvelope(text: string): {
  ok: true
  value: AssistantEnvelope
} | {
  ok: false
  error: string
} {
  const start = text.indexOf('{')
  if (start === -1) return { ok: false, error: 'No JSON object found.' }
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        const candidate = text.slice(start, index + 1)
        try {
          const parsed = JSON.parse(candidate)
          const result = assistantEnvelopeSchema.safeParse(parsed)
          if (!result.success) return { ok: false, error: 'The action envelope is invalid.' }
          return { ok: true, value: result.data }
        } catch {
          return { ok: false, error: 'The action envelope is not valid JSON.' }
        }
      }
    }
  }
  return { ok: false, error: 'The JSON object is incomplete.' }
}
