import { z } from 'zod'
import { sessionIdSchema } from './primitives'

/** One renderer-initiated generation; cancelling targets this id. */
export const aiRequestIdSchema = z.string().min(8).max(64)

export const aiCommitMessageInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  requestId: aiRequestIdSchema
})

export const aiCancelCommitMessageInputSchema = z.strictObject({
  requestId: aiRequestIdSchema
})

export const aiCommitMessageAgentSchema = z.enum(['claude', 'codex', 'opencode'])
export type AiCommitMessageAgent = z.infer<typeof aiCommitMessageAgentSchema>

export const aiCommitMessageResultSchema = z.union([
  z.strictObject({
    status: z.literal('ok'),
    message: z.string().min(1).max(4000),
    agent: aiCommitMessageAgentSchema
  }),
  z.strictObject({ status: z.literal('cancelled') }),
  z.strictObject({
    status: z.literal('unavailable'),
    reason: z.enum([
      'not-agent',
      'unsupported-harness',
      'no-staged-changes',
      'harness-unavailable',
      'generation-failed'
    ]),
    detail: z.string().min(1).max(500)
  })
])

export const aiCancelCommitMessageResultSchema = z.strictObject({
  cancelled: z.boolean()
})

export type AiCommitMessageResult = z.infer<typeof aiCommitMessageResultSchema>
export type AiCancelCommitMessageResult = z.infer<typeof aiCancelCommitMessageResultSchema>
