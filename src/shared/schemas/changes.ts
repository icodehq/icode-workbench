import { z } from 'zod'
import { CHANGE_AREAS, CHANGE_DIFF_SCOPES, CHANGE_FILE_STATUSES } from '../domain/changes'
import { appErrorSchema } from './domain'
import {
  absolutePathSchema,
  sessionIdSchema,
  worktreeRelativePathSchema
} from './primitives'

/** Change paths use the shared worktree-relative path contract. */
export const changePathSchema = worktreeRelativePathSchema

export const changeDiffScopeSchema = z.enum(CHANGE_DIFF_SCOPES)

/**
 * A working-tree diff is scoped to one side of the index. The metadata is
 * display-only and comes from the same status snapshot the row was rendered
 * from; the path and containment are re-validated in main.
 */
export const changeDiffInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  path: changePathSchema,
  oldPath: changePathSchema.nullish(),
  scope: changeDiffScopeSchema,
  status: z.enum(CHANGE_FILE_STATUSES),
  binary: z.boolean(),
  symlink: z.boolean().nullable(),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable()
})

export const changeFileSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  oldPath: z.string().min(1).max(4096).nullable(),
  status: z.enum(CHANGE_FILE_STATUSES),
  area: z.enum(CHANGE_AREAS),
  origin: z.enum(['tracked', 'untracked']),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  binary: z.boolean(),
  symlink: z.boolean().nullable()
})

export const changeUnavailableReasonSchema = z.enum([
  'primary-checkout',
  'worktree-missing',
  'worktree-inconsistent',
  'worktree-failed',
  'invalid-baseline'
])

export const changeUnavailableSchema = z.strictObject({
  status: z.literal('unavailable'),
  reason: changeUnavailableReasonSchema,
  detail: z.string().min(1).max(500)
})

export const changeListPayloadSchema = z.strictObject({
  status: z.literal('available'),
  sessionId: sessionIdSchema,
  baselineOid: z.string().min(1).max(128),
  files: z.array(changeFileSchema).max(1000),
  listTruncated: z.boolean()
})

export const fileDiffPayloadSchema = z.strictObject({
  status: z.literal('available'),
  sessionId: sessionIdSchema,
  path: z.string().min(1).max(4096),
  oldPath: z.string().min(1).max(4096).nullable(),
  fileStatus: z.enum(CHANGE_FILE_STATUSES),
  patch: z.string().max(2 * 1024 * 1024 + 64 * 1024),
  truncated: z.boolean(),
  truncatedReason: z.enum(['bytes', 'timeout']).nullable(),
  binary: z.boolean(),
  symlink: z.boolean().nullable(),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable()
})

export const fileDiffResultSchema = z.union([fileDiffPayloadSchema, changeUnavailableSchema])
export const changeListResultSchema = z.union([changeListPayloadSchema, changeUnavailableSchema])

export type ChangeUnavailable = z.infer<typeof changeUnavailableSchema>
export type ChangeListResult = z.infer<typeof changeListResultSchema>
export type ChangeDiffInput = z.infer<typeof changeDiffInputSchema>
export type FileDiffPayload = z.infer<typeof fileDiffPayloadSchema>
export type FileDiffResult = z.infer<typeof fileDiffResultSchema>

export { absolutePathSchema, appErrorSchema }
