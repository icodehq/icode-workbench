import { z } from 'zod'
import { appErrorSchema, harnessIdSchema } from './domain'
import { executionTargetSchema } from './ipc'
import {
  absolutePathSchema,
  repoIdSchema,
  sessionIdSchema,
  timestampSchema
} from './primitives'

/**
 * Durable repository-removal jobs.
 *
 * The manifest is internal to the main process but is validated on read so a
 * hand-edited or truncated row fails loudly instead of driving destructive
 * work. The summary is the renderer-facing projection; it never includes a
 * manifest or a snapshot ref.
 */

export const REMOVAL_JOB_STATUSES = [
  'queued',
  'running',
  'waiting_host',
  'failed',
  'completed'
] as const

export type RemovalJobStatus = (typeof REMOVAL_JOB_STATUSES)[number]

export const REMOVAL_JOB_STAGES = [
  'abort_merges',
  'stop_sessions',
  'snapshot_worktrees',
  'remove_worktrees',
  'prune_worktrees',
  'remove_repository',
  'cleanup',
  'done'
] as const

export type RemovalJobStage = (typeof REMOVAL_JOB_STAGES)[number]

export const removalJobStatusSchema = z.enum(REMOVAL_JOB_STATUSES)
export const removalJobStageSchema = z.enum(REMOVAL_JOB_STAGES)

const removalJobIdSchema = z.string().min(1).max(128)
const repoNameSchema = z.string().min(1).max(4096)
const refSchema = z.string().min(1).max(2048)
const oidSchema = z.string().min(7).max(128)
const branchSchema = z.string().min(1).max(1024)

export const removalSnapshotSchema = z.strictObject({
  sessionId: sessionIdSchema,
  ref: refSchema,
  branch: branchSchema,
  commit: oidSchema,
  files: z.number().int().nonnegative()
})

export type RemovalSnapshot = z.infer<typeof removalSnapshotSchema>

export const removalWorktreeSchema = z.strictObject({
  sessionId: sessionIdSchema,
  path: absolutePathSchema,
  branch: branchSchema,
  snapshot: removalSnapshotSchema.nullable(),
  snapshotState: z.enum(['pending', 'clean', 'saved', 'attention']),
  attention: appErrorSchema.nullable(),
  /** Idempotency marker: the worktree has been removed (or was already gone). */
  removed: z.boolean()
})

export type RemovalWorktree = z.infer<typeof removalWorktreeSchema>

export const removalManifestSchema = z.strictObject({
  v: z.literal(1),
  repoId: repoIdSchema,
  repoName: repoNameSchema,
  repoPath: absolutePathSchema,
  target: executionTargetSchema,
  /** Resolved by the worker; the synchronous start path never touches a host. */
  worktreeRoot: absolutePathSchema.nullable(),
  sessions: z.array(
    z.strictObject({
      id: sessionIdSchema,
      harness: harnessIdSchema
    })
  ),
  mergesSettled: z.boolean(),
  sessionsStopped: z.boolean(),
  worktrees: z.array(removalWorktreeSchema),
  snapshots: z.array(removalSnapshotSchema),
  repoRowRemoved: z.boolean(),
  purged: z.record(z.string().max(100), z.number().int().nonnegative())
})

export type RemovalManifest = z.infer<typeof removalManifestSchema>

export const repoRemovalJobSummarySchema = z.strictObject({
  id: removalJobIdSchema,
  repoId: repoIdSchema,
  repoName: repoNameSchema,
  repoPath: absolutePathSchema,
  status: removalJobStatusSchema,
  stage: removalJobStageSchema,
  worktreeCount: z.number().int().nonnegative(),
  snapshotCount: z.number().int().nonnegative(),
  attentionCount: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  error: appErrorSchema.nullable(),
  canRetry: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
})

export type RepoRemovalJobSummary = z.infer<typeof repoRemovalJobSummarySchema>

export const listRepoRemovalJobsResultSchema = z.strictObject({
  jobs: z.array(repoRemovalJobSummarySchema)
})

export type ListRepoRemovalJobsResult = z.infer<typeof listRepoRemovalJobsResultSchema>

export const repoRemovalJobIdInputSchema = z.strictObject({
  jobId: removalJobIdSchema
})

export type RepoRemovalJobIdInput = z.infer<typeof repoRemovalJobIdInputSchema>

export const retryRepoRemovalJobResultSchema = z.strictObject({
  status: z.literal('retrying')
})

export type RetryRepoRemovalJobResult = z.infer<typeof retryRepoRemovalJobResultSchema>

export const discardRepoRemovalSnapshotsResultSchema = z.strictObject({
  discarded: z.number().int().nonnegative()
})

export type DiscardRepoRemovalSnapshotsResult = z.infer<
  typeof discardRepoRemovalSnapshotsResultSchema
>

/** Push-only event: the renderer reloads the job list, never trusts a payload. */
export const removalEventSchema = z.strictObject({
  type: z.literal('removal-changed')
})

export type RemovalEvent = z.infer<typeof removalEventSchema>
