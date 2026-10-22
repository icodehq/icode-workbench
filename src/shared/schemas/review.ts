import { z } from 'zod'
import { REVIEW_AREAS, REVIEW_FILE_STATUSES } from '../domain/review'
import { appErrorSchema } from './domain'
import { absolutePathSchema, sessionIdSchema } from './primitives'

/**
 * Review paths are always worktree-relative. The renderer only ever echoes a
 * path it received from a validated listing, and main re-validates every
 * request: no absolute paths, no `..`, no NUL, no leading `-` (which Git would
 * read as an option), and no drive/UNC prefixes.
 */
export const reviewPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes('\u0000'), 'must not contain NUL')
  .refine((value) => !value.startsWith('-'), 'must not start with a dash')
  .refine((value) => !value.startsWith('/'), 'must be relative to the worktree')
  .refine((value) => !/^[A-Za-z]:[\\/]/.test(value), 'must not be a drive path')
  .refine((value) => !value.startsWith('\\\\'), 'must not be a UNC path')
  .refine(
    (value) => !value.split(/[\\/]/u).some((segment) => segment === '..'),
    'must not contain a parent segment'
  )

export const reviewListInputSchema = z.strictObject({
  sessionId: sessionIdSchema
})

export const reviewDiffInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  path: reviewPathSchema,
  /** Rename origin reported by the listing; required for rename diffs. */
  oldPath: reviewPathSchema.nullish()
})

export const reviewFileSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  oldPath: z.string().min(1).max(4096).nullable(),
  status: z.enum(REVIEW_FILE_STATUSES),
  area: z.enum(REVIEW_AREAS),
  origin: z.enum(['tracked', 'untracked']),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  binary: z.boolean(),
  symlink: z.boolean()
})

export const reviewUnavailableReasonSchema = z.enum([
  'primary-checkout',
  'worktree-missing',
  'worktree-inconsistent',
  'worktree-failed',
  'invalid-baseline'
])

export const reviewListPayloadSchema = z.strictObject({
  status: z.literal('available'),
  sessionId: sessionIdSchema,
  baselineOid: z.string().min(1).max(128),
  files: z.array(reviewFileSchema).max(1000),
  listTruncated: z.boolean()
})

export const reviewUnavailableSchema = z.strictObject({
  status: z.literal('unavailable'),
  reason: reviewUnavailableReasonSchema,
  detail: z.string().min(1).max(500)
})

/** A list/diff request succeeds even when it reports that review is impossible. */
export const reviewListResultSchema = z.union([
  reviewListPayloadSchema,
  reviewUnavailableSchema
])

export const reviewDiffPayloadSchema = z.strictObject({
  status: z.literal('available'),
  sessionId: sessionIdSchema,
  path: z.string().min(1).max(4096),
  oldPath: z.string().min(1).max(4096).nullable(),
  fileStatus: z.enum(REVIEW_FILE_STATUSES),
  patch: z.string().max(2 * 1024 * 1024 + 64 * 1024),
  truncated: z.boolean(),
  truncatedReason: z.enum(['bytes', 'timeout']).nullable(),
  binary: z.boolean(),
  symlink: z.boolean(),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable()
})

export const reviewDiffResultSchema = z.union([
  reviewDiffPayloadSchema,
  reviewUnavailableSchema
])

export type ReviewUnavailableReason = z.infer<typeof reviewUnavailableReasonSchema>
export type ReviewListInput = z.infer<typeof reviewListInputSchema>
export type ReviewDiffInput = z.infer<typeof reviewDiffInputSchema>
export type ReviewFilePayload = z.infer<typeof reviewFileSchema>
export type ReviewListPayload = z.infer<typeof reviewListPayloadSchema>
export type ReviewDiffPayload = z.infer<typeof reviewDiffPayloadSchema>
export type ReviewListResult = z.infer<typeof reviewListResultSchema>
export type ReviewDiffResult = z.infer<typeof reviewDiffResultSchema>

export { absolutePathSchema, appErrorSchema }
