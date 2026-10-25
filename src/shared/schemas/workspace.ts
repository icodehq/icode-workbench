import { z } from 'zod'
import { sessionIdSchema } from './primitives'

/**
 * Workspace file requests.
 *
 * `path` is worktree-relative and validated again in main; the schema only
 * bounds its size so a pathological string never reaches the service.
 */
const relativePathSchema = z.string().max(4096)

export const filesListInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  path: relativePathSchema.default('')
})

export const filesReadInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  path: relativePathSchema
})

export const filesWriteInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  path: relativePathSchema,
  /** Capped so a renderer cannot push an unbounded buffer through IPC. */
  text: z.string().max(4 * 1024 * 1024)
})

export const filesSearchInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  query: z.string().min(1).max(400),
  caseSensitive: z.boolean().default(false),
  limit: z.number().int().min(1).max(500).default(200)
})

export const gitStatusInputSchema = z.strictObject({ sessionId: sessionIdSchema })
export const gitStageAllInputSchema = z.strictObject({ sessionId: sessionIdSchema })
export const gitUnstageAllInputSchema = z.strictObject({ sessionId: sessionIdSchema })

export const gitCommitInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  message: z.string().min(1).max(4000)
})

export const gitDiscardPathInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  path: relativePathSchema
})
