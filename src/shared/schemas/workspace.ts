import { z } from 'zod'
import { repoIdSchema, sessionIdSchema } from './primitives'
import { harnessIdSchema } from './domain'
import { reviewFileSchema, reviewPathSchema } from './review'

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
export const gitCancelStatusInputSchema = z.strictObject({ sessionId: sessionIdSchema })
export const gitOperationStateInputSchema = z.strictObject({ sessionId: sessionIdSchema })
export const gitOperationActionInputSchema = z.strictObject({ sessionId: sessionIdSchema })
export const gitRangeDiffInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  from: z.string().min(1).max(255),
  to: z.string().min(1).max(255).default('HEAD')
})
export const gitWatchStatusInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  active: z.boolean()
})
export const gitStageAllInputSchema = z.strictObject({ sessionId: sessionIdSchema })
export const gitUnstageAllInputSchema = z.strictObject({ sessionId: sessionIdSchema })

export const gitCommitInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  message: z.string().min(1).max(4000),
  /** `git commit -a`: stage tracked changes before committing. */
  all: z.boolean().optional(),
  /** Add a Signed-off-by trailer from the configured Git identity. */
  signOff: z.boolean().optional(),
  /** Sign the commit with the Git signing configuration on this machine. */
  sign: z.boolean().optional()
})

export const gitDiscardPathInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  path: relativePathSchema
})

export const filesCreateInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  path: relativePathSchema,
  kind: z.enum(['file', 'directory'])
})

export const filesRenameInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  from: relativePathSchema,
  to: relativePathSchema
})

export const filesRemoveInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  path: relativePathSchema
})

export const gitSetPathStagedInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  path: relativePathSchema,
  staged: z.boolean()
})

export const gitPathTargetSchema = z.strictObject({
  path: relativePathSchema,
  area: z.enum(['staged', 'unstaged', 'untracked', 'conflicted']),
  oldPath: relativePathSchema.nullable().optional(),
  status: z
    .enum(['added', 'modified', 'deleted', 'renamed', 'copied', 'unmerged', 'untracked'])
    .optional()
})

export const gitSetPathsStagedInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  targets: z.array(gitPathTargetSchema).min(1).max(5000),
  staged: z.boolean()
})

export const gitDiscardPathsInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  targets: z.array(gitPathTargetSchema).min(1).max(5000),
  expectedRevision: z.string().min(1).max(64).optional()
})
export const gitBranchesInputSchema = z.strictObject({ sessionId: sessionIdSchema })
export const gitSwitchBranchInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  branch: z.string().min(1).max(255)
})
export const gitCreateBranchInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  branch: z.string().min(1).max(255),
  /** Commit-ish to start at; HEAD when omitted. */
  at: z.string().min(4).max(64).regex(/^[0-9a-f]+$/i).optional()
})
export const gitRenameBranchInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  from: z.string().min(1).max(255),
  to: z.string().min(1).max(255)
})
export const gitDeleteBranchInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  branch: z.string().min(1).max(255)
})
export const gitMergeBranchInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  branch: z.string().min(1).max(255)
})
export const gitRebaseBranchInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  branch: z.string().min(1).max(255)
})
export const gitDeleteTagInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  name: z.string().min(1).max(200)
})
export const gitBlameInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  path: reviewPathSchema
})
export const gitFileAtRevisionInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  rev: z.string().min(1).max(255).default('HEAD'),
  path: reviewPathSchema
})
export const gitIndexFileInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  path: reviewPathSchema
})
export const gitApplyPatchInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  path: reviewPathSchema,
  /** One file's patch, generated by the working-tree diff. */
  patch: z.string().min(1).max(2 * 1024 * 1024 + 64 * 1024),
  mode: z.enum(['stage', 'unstage', 'discard'])
})
export const gitConflictFileInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  path: reviewPathSchema
})
export const gitResolveConflictInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  path: reviewPathSchema
})
export const gitStashPushInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  message: z.string().max(4000).default(''),
  includeUntracked: z.boolean().default(false),
  keepIndex: z.boolean().default(false)
})
export const gitStashTargetInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  index: z.number().int().min(0).max(10_000)
})
export const gitStashActionInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  index: z.number().int().min(0).max(10_000),
  action: z.enum(['apply', 'pop', 'drop'])
})
export const gitWorktreeActionInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  action: z.enum(['lock', 'unlock', 'prune', 'remove']),
  path: z.string().min(1).max(4096).optional(),
  reason: z.string().max(200).optional()
})
export const gitSubmoduleActionInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  action: z.enum(['init', 'update', 'sync', 'stage']),
  path: z.string().min(1).max(4096).optional()
})
export const gitCheckoutRefInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  ref: z.string().min(1).max(255)
})
export const gitCreateTagInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  name: z.string().min(1).max(200),
  oid: z.string().min(4).max(64).regex(/^[0-9a-f]+$/i)
})
export const gitCommitActionInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  oid: z.string().min(4).max(64).regex(/^[0-9a-f]+$/i)
})
export const gitResetInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  oid: z.string().min(4).max(64).regex(/^[0-9a-f]+$/i),
  mode: z.enum(['soft', 'mixed', 'hard'])
})
export const gitRemoteOpInputSchema = z.strictObject({ sessionId: sessionIdSchema })
export const gitAddRemoteInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  name: z.string().min(1).max(100),
  url: z.string().min(1).max(2048)
})
export const gitRemoveRemoteInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  name: z.string().min(1).max(100)
})
export const gitFetchRemoteInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  remote: z.string().min(1).max(100),
  prune: z.boolean().optional()
})
export const gitSetUpstreamInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  upstream: z.string().min(1).max(255)
})
export const gitHistoryInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  limit: z.number().int().min(1).max(50).default(20)
})
export const gitLogInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  limit: z.number().int().min(1).max(200).default(50),
  skip: z.number().int().min(0).max(100_000).default(0),
  ref: z.string().min(1).max(255).optional(),
  /** `git log --all`; ignored when `ref` is also set. */
  allRefs: z.boolean().optional(),
  path: relativePathSchema.optional()
})
export const gitCommitDetailInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  oid: z.string().min(4).max(64).regex(/^[0-9a-f]+$/i),
  /** Compare against this parent instead of the first parent. */
  parent: z.string().min(4).max(64).regex(/^[0-9a-f]+$/i).optional()
})
export const gitRevisionFileDiffInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  from: z.string().min(1).max(255),
  to: z.string().min(1).max(255),
  path: reviewPathSchema,
  oldPath: reviewPathSchema.optional()
})
export const gitAmendInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  /** Omitted means keep the existing message and amend the tree only. */
  message: z.string().max(4000).optional(),
  sign: z.boolean().optional()
})
export const gitPullInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  /** Use `git pull --rebase` instead of the default fast-forward-only pull. */
  rebase: z.boolean().optional()
})

// ─── Tasks ──────────────────────────────────────────────────────────

export const taskStatusSchema = z.enum([
  'queued',
  'dispatching',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled'
])

export const taskFailureReasonSchema = z.enum([
  'harness-unavailable',
  'session-create-failed',
  'prompt-write-failed',
  'harness-failed',
  'interrupted',
  'cancelled'
])

export const taskReviewDecisionSchema = z.enum(['pending', 'accepted', 'rejected'])

export const taskRecordSchema = z.strictObject({
  id: z.string().min(1).max(80),
  repoId: repoIdSchema,
  title: z.string().min(1).max(200),
  prompt: z.string().min(1).max(20_000),
  harness: harnessIdSchema,
  status: taskStatusSchema,
  sessionId: sessionIdSchema.nullable(),
  worktreePath: z.string().max(4096).nullable(),
  attempt: z.number().int().min(1),
  previousTaskId: z.string().max(80).nullable(),
  scheduleId: z.string().max(80).nullable(),
  occurrenceAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  startedAt: z.number().int().nullable(),
  finishedAt: z.number().int().nullable(),
  resultSummary: z.string().max(2000).nullable(),
  error: z.string().max(2000).nullable(),
  errorDetail: z.string().max(4000).nullable(),
  failureReason: taskFailureReasonSchema.nullable(),
  lastObservedState: z.string().max(40).nullable(),
  exitCode: z.number().int().nullable(),
  reviewDecision: taskReviewDecisionSchema,
  reviewedAt: z.number().int().nullable(),
  reviewNote: z.string().max(2000).nullable(),
  sessionLive: z.boolean(),
  canRetry: z.boolean(),
  canReview: z.boolean(),
  canDecideReview: z.boolean(),
  reviewDecisionFinal: z.boolean()
})

export const taskListInputSchema = z.strictObject({
  repoId: repoIdSchema.optional(),
  statuses: z.array(taskStatusSchema).max(7).optional(),
  limit: z.number().int().min(1).max(200).optional()
})

export const taskCreateInputSchema = z.strictObject({
  repoId: repoIdSchema,
  title: z.string().min(1).max(200).optional(),
  prompt: z.string().min(1).max(20_000),
  harness: harnessIdSchema
})

export const taskIdInputSchema = z.strictObject({ taskId: z.string().min(1).max(80) })

export const taskDecideReviewInputSchema = z.strictObject({
  taskId: z.string().min(1).max(80),
  decision: z.enum(['accepted', 'rejected']),
  note: z.string().max(2000).nullable().optional(),
  /** Required to change a decision that was already made. */
  replace: z.boolean().optional()
})

export const taskChangesPayloadSchema = z.strictObject({
  taskId: z.string().min(1).max(80),
  sessionId: sessionIdSchema.nullable(),
  status: z.enum(['available', 'unavailable']),
  files: z.array(reviewFileSchema).max(1000).optional(),
  baselineOid: z.string().min(1).max(128).optional(),
  listTruncated: z.boolean().optional(),
  reason: z.string().max(80).optional(),
  detail: z.string().max(500).optional()
})

export const taskSettingsInputSchema = z.strictObject({
  maxConcurrent: z.number().int().min(1).max(4)
})

export const scheduleShapeSchema = z.strictObject({
  type: z.enum(['once', 'daily', 'weekdays', 'weekly', 'hours']),
  runAt: z.number().int().optional(),
  hour: z.number().int().min(0).max(23).optional(),
  minute: z.number().int().min(0).max(59).optional(),
  day: z.number().int().min(1).max(7).optional(),
  every: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(6),
    z.literal(8),
    z.literal(12)
  ]).optional()
})

export const scheduleOccurrenceSchema = z.strictObject({
  id: z.string().min(1).max(80),
  scheduleId: z.string().min(1).max(80),
  occurrenceAt: z.number().int(),
  taskId: z.string().max(80).nullable(),
  status: z.enum(['reserved', 'created', 'skipped', 'error']),
  note: z.string().max(2000).nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int()
})

export const taskScheduleSchema = z.strictObject({
  id: z.string().min(1).max(80),
  repoId: repoIdSchema,
  title: z.string().min(1).max(200),
  prompt: z.string().min(1).max(20_000),
  harness: harnessIdSchema,
  shape: scheduleShapeSchema,
  overlap: z.enum(['queue', 'skip']),
  enabled: z.boolean(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  nextRunAt: z.number().int().nullable(),
  lastRunAt: z.number().int().nullable(),
  consecutiveFailures: z.number().int().min(0),
  lastNote: z.string().max(2000).nullable(),
  label: z.string().max(200),
  occurrences: z.array(scheduleOccurrenceSchema).max(20)
})

export const scheduleListInputSchema = z.strictObject({ repoId: repoIdSchema.optional() })

export const scheduleCreateInputSchema = z.strictObject({
  repoId: repoIdSchema,
  title: z.string().min(1).max(200).optional(),
  prompt: z.string().min(1).max(20_000),
  harness: harnessIdSchema,
  shape: scheduleShapeSchema,
  overlap: z.enum(['queue', 'skip']).optional()
})

export const scheduleUpdateInputSchema = z.strictObject({
  scheduleId: z.string().min(1).max(80),
  repoId: repoIdSchema,
  title: z.string().min(1).max(200).optional(),
  prompt: z.string().min(1).max(20_000),
  harness: harnessIdSchema,
  shape: scheduleShapeSchema,
  overlap: z.enum(['queue', 'skip']).optional()
})

export const scheduleEnabledInputSchema = z.strictObject({
  scheduleId: z.string().min(1).max(80),
  enabled: z.boolean()
})

export const scheduleIdInputSchema = z.strictObject({
  scheduleId: z.string().min(1).max(80)
})
