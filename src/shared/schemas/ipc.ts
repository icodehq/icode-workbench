import { z } from 'zod'
import type { AppError } from '../domain/errors'
import { WORKTREE_STATES, WORKTREE_STATUSES } from '../domain/worktree'
import { activitySummarySchema } from './activity'
import { appErrorSchema, harnessIdSchema, reconciliationReasonSchema } from './domain'
import {
  absolutePathSchema,
  dimensionSchema,
  incarnationIdSchema,
  repoIdSchema,
  sessionIdSchema,
  sessionTitleSchema,
  terminalInputSchema,
  timestampSchema
} from './primitives'

/** Renderer-facing channels. Preload exposes methods, never these strings. */
export const IPC_CHANNELS = {
  runtimeInfo: 'ade:runtime-info',
  reposList: 'ade:repos:list',
  reposAdd: 'ade:repos:add',
  reposRemove: 'ade:repos:remove',
  sessionsList: 'ade:sessions:list',
  sessionsGet: 'ade:sessions:get',
  sessionsCreate: 'ade:sessions:create',
  sessionsClose: 'ade:sessions:close',
  sessionsRestart: 'ade:sessions:restart',
  sessionsRemove: 'ade:sessions:remove',
  sessionsDiscard: 'ade:sessions:discard',
  sessionsRecoverWorktree: 'ade:sessions:recover-worktree',
  branchesList: 'ade:branches:list',
  branchesRemove: 'ade:branches:remove',
  reviewList: 'ade:review:list',
  reviewDiff: 'ade:review:diff',
  filesList: 'ade:files:list',
  filesRead: 'ade:files:read',
  filesWrite: 'ade:files:write',
  filesSearch: 'ade:files:search',
  gitStatus: 'ade:git:status',
  gitStageAll: 'ade:git:stage-all',
  gitUnstageAll: 'ade:git:unstage-all',
  gitCommit: 'ade:git:commit',
  gitDiscardPath: 'ade:git:discard-path',
  activityList: 'ade:activity:list',
  activityClearUnread: 'ade:activity:clear-unread',
  terminalAttach: 'ade:terminal:attach',
  terminalWrite: 'ade:terminal:write',
  terminalResize: 'ade:terminal:resize',
  harnessList: 'ade:harness:list',
  wslListDistros: 'ade:wsl:list-distros',
  sessionEvent: 'ade:session-event'
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: AppError }

export function ipcResultSchema<T extends z.ZodType>(value: T) {
  return z.union([
    z.strictObject({ ok: z.literal(true), value }),
    z.strictObject({ ok: z.literal(false), error: appErrorSchema })
  ])
}

/**
 * Execution target. Local omits the WSL fields entirely, so every existing
 * renderer payload stays valid and unchanged.
 *
 * `distroId` is the WSL registration identity. It is optional because it may be
 * unreadable; when absent the distro name is the only identity available and the
 * database treats it as the weaker, name-scoped match.
 */
export const executionTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('local') }),
  z.strictObject({
    kind: z.literal('wsl'),
    distro: z.string().min(1).max(255),
    distroId: z.string().min(1).max(255).nullable()
  })
])

/**
 * One registered distro, as the add-repository dialog may offer it.
 *
 * `running` is `null` when the running probe failed: the dialog says "not running
 * or unknown" rather than guessing, and starting a terminal starts it anyway.
 */
export const wslDistroSummarySchema = z.strictObject({
  name: z.string().min(1).max(255),
  registrationId: z.string().min(1).max(255),
  version: z.union([z.literal(1), z.literal(2)]).nullable(),
  running: z.boolean().nullable()
})

/**
 * Discovered distros, or why discovery could not answer.
 *
 * "unavailable" is a first-class result, not an error: on a machine without WSL
 * the repository dialog must still work for local repositories and must not
 * pretend WSL is merely empty.
 */
export const wslDistroListPayloadSchema = z.union([
  z.strictObject({
    status: z.literal('ok'),
    distros: z.array(wslDistroSummarySchema).max(64),
    defaultRegistrationId: z.string().min(1).max(255).nullable()
  }),
  z.strictObject({
    status: z.literal('unavailable'),
    reason: z.enum(['not_windows', 'registry_unreadable', 'undecodable_names']),
    detail: z.string().max(4000)
  })
])

export const addRepositoryInputSchema = z.strictObject({
  path: absolutePathSchema,
  /** Absent means local, which is what every pre-existing caller sends. */
  target: executionTargetSchema.optional()
})

export const removeRepositoryInputSchema = z.strictObject({
  repoId: repoIdSchema,
  /** Required before stored session rows are cascaded. */
  acknowledgeDependentSessions: z.boolean().optional()
})

export const listSessionsInputSchema = z.strictObject({
  repoId: repoIdSchema.optional()
})

export const createSessionInputSchema = z.strictObject({
  repoId: repoIdSchema,
  harness: harnessIdSchema,
  title: sessionTitleSchema.optional(),
  cols: dimensionSchema,
  rows: dimensionSchema
})

export const sessionTargetInputSchema = z.strictObject({
  sessionId: sessionIdSchema
})

export const harnessListInputSchema = z.strictObject({
  /** Re-resolve and re-probe instead of returning a recent observation. */
  force: z.boolean().optional(),
  /**
   * Detect for *this repository's* execution target.
   *
   * Absent keeps the original behaviour (detect on this machine). A WSL
   * repository must not be shown this machine's Harnesses: the Agent runs inside
   * the distro, so a local `claude` says nothing about the guest one.
   */
  repoId: repoIdSchema.optional()
})

export const terminalAttachInputSchema = z.strictObject({
  sessionId: sessionIdSchema
})

export const terminalWriteInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  incarnationId: incarnationIdSchema,
  data: terminalInputSchema
})

export const terminalResizeInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  incarnationId: incarnationIdSchema,
  cols: dimensionSchema,
  rows: dimensionSchema
})

export const repositorySummarySchema = z.strictObject({
  id: repoIdSchema,
  displayName: z.string().min(1).max(200),
  path: absolutePathSchema,
  currentBranch: z.string().min(1).max(255).nullable(),
  availability: z.enum(['present', 'missing', 'unknown']),
  /** Always present on the wire; local for every repository that predates v3. */
  target: executionTargetSchema
})

export const worktreeSummarySchema = z.strictObject({
  path: absolutePathSchema,
  branch: z.string().min(1).max(255),
  baseOid: z.string().min(1).max(128),
  state: z.enum(WORKTREE_STATES),
  status: z.enum(WORKTREE_STATUSES),
  error: appErrorSchema.nullable()
})

export const sessionSummarySchema = z.strictObject({
  id: sessionIdSchema,
  repoId: repoIdSchema,
  title: sessionTitleSchema,
  harness: harnessIdSchema,
  state: z.enum(['starting', 'live', 'exited', 'failed', 'unavailable']),
  authority: z.enum(['host', 'persisted', 'unreachable']),
  reason: reconciliationReasonSchema,
  incarnationId: incarnationIdSchema.nullable(),
  exitCode: z.number().int().nullable(),
  error: appErrorSchema.nullable(),
  updatedAt: timestampSchema,
  /** `null` for legacy sessions that run in the repository's primary checkout. */
  worktree: worktreeSummarySchema.nullable(),
  /**
   * Hook-derived agent activity. Advisory only: `unknown` means no trustworthy
   * evidence, never a claim that the agent is idle.
   */
  activity: activitySummarySchema.nullable()
})

const worktreeFileListSchema = z.array(z.string().min(1).max(4096)).max(200)

export const worktreeBlockerSchema = z.strictObject({
  kind: z.enum(['dirty', 'unmerged', 'missing', 'inconsistent']),
  files: worktreeFileListSchema.optional(),
  commits: z.number().int().nonnegative().optional(),
  detail: z.string().min(1).max(2000).optional()
})

export const removeSessionResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('removed'),
    branch: z.string().min(1).max(255).nullable(),
    branchRetained: z.boolean()
  }),
  z.strictObject({
    status: z.literal('blocked_live_sessions'),
    session: sessionSummarySchema
  }),
  z.strictObject({ status: z.literal('host_unavailable'), error: appErrorSchema }),
  z.strictObject({
    status: z.literal('blocked_worktree'),
    session: sessionSummarySchema,
    blocker: worktreeBlockerSchema
  })
])

export const discardSessionResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('discarded'),
    branch: z.string().min(1).max(255),
    files: worktreeFileListSchema,
    commits: z.number().int().nonnegative(),
    branchRetained: z.literal(true)
  }),
  z.strictObject({
    status: z.literal('blocked_live_sessions'),
    session: sessionSummarySchema
  }),
  z.strictObject({ status: z.literal('host_unavailable'), error: appErrorSchema }),
  z.strictObject({
    status: z.literal('blocked_worktree'),
    session: sessionSummarySchema,
    blocker: worktreeBlockerSchema
  })
])

export const discardSessionInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  /** The exact branch name, typed by the user. Never a boolean acknowledgement. */
  confirmBranch: z.string().min(1).max(255)
})

export const ownedBranchSummarySchema = z.strictObject({
  branch: z.string().min(1).max(255),
  repoId: repoIdSchema,
  sessionId: z.string().min(1).max(128),
  baseOid: z.string().min(1).max(128),
  createdAt: timestampSchema,
  exists: z.boolean(),
  unmergedCommits: z.number().int().nonnegative().nullable(),
  worktreePath: absolutePathSchema.nullable()
})

export const removeBranchInputSchema = z.strictObject({
  repoId: repoIdSchema,
  branch: z.string().min(1).max(255),
  /** Required only when the branch has commits that are not reachable from the primary HEAD. */
  confirmBranch: z.string().min(1).max(255).optional()
})

export const removeBranchResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('removed'), branch: z.string().min(1).max(255) }),
  z.strictObject({
    status: z.literal('confirmation_required'),
    branch: z.string().min(1).max(255),
    commits: z.number().int().nonnegative()
  }),
  z.strictObject({
    status: z.literal('blocked_worktree'),
    branch: z.string().min(1).max(255),
    path: absolutePathSchema
  }),
  z.strictObject({ status: z.literal('not_owned'), branch: z.string().min(1).max(255) })
])

export const listBranchesInputSchema = z.strictObject({ repoId: repoIdSchema })

/**
 * A live host PTY with no durable ADE row. Surfaced rather than hidden so the
 * user can see and stop it; it is never silently adopted as a session.
 */
export const orphanedHostSessionSchema = z.strictObject({
  sessionId: z.string().min(1).max(128),
  incarnationId: incarnationIdSchema,
  ptyPid: z.number().int().min(1),
  cwd: absolutePathSchema,
  command: z.string().min(1).max(4096),
  status: z.enum(['starting', 'live', 'exited', 'failed']),
  cols: dimensionSchema,
  rows: dimensionSchema
})

export const sessionListViewSchema = z.strictObject({
  sessions: z.array(sessionSummarySchema),
  orphans: z.array(orphanedHostSessionSchema)
})

export const removeRepositoryResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('removed') }),
  z.strictObject({
    status: z.literal('confirmation_required'),
    sessions: z.array(sessionSummarySchema)
  }),
  z.strictObject({
    status: z.literal('blocked_live_sessions'),
    sessions: z.array(sessionSummarySchema)
  }),
  z.strictObject({
    status: z.literal('host_unavailable'),
    error: appErrorSchema
  }),
  z.strictObject({
    status: z.literal('blocked_worktree_changes'),
    blockers: z.array(
      z.strictObject({
        session: sessionSummarySchema,
        blocker: worktreeBlockerSchema
      })
    )
  })
])

export const terminalAttachPayloadSchema = z.strictObject({
  sessionId: sessionIdSchema,
  incarnationId: incarnationIdSchema,
  cols: dimensionSchema,
  rows: dimensionSchema,
  /** Serialized headless-terminal state, including alternate-screen transitions. */
  snapshot: z.string().max(4 * 1024 * 1024),
  seq: z.number().int().nonnegative(),
  alternateScreen: z.boolean(),
  cursor: z.strictObject({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative()
  }),
  scrollbackLines: z.number().int().nonnegative(),
  /** True when the snapshot no longer holds the full history. */
  truncated: z.boolean()
})

export const rendererSessionEventSchema = z.union([
  z.strictObject({
    type: z.literal('data'),
    sessionId: sessionIdSchema,
    incarnationId: incarnationIdSchema,
    seq: z.number().int().nonnegative(),
    data: z.string()
  }),
  z.strictObject({
    type: z.literal('exit'),
    sessionId: sessionIdSchema,
    incarnationId: incarnationIdSchema,
    exitCode: z.number().int()
  }),
  z.strictObject({
    type: z.literal('state'),
    session: sessionSummarySchema
  }),
  /** Advisory activity for one session; never changes lifecycle state. */
  z.strictObject({
    type: z.literal('activity'),
    sessionId: sessionIdSchema,
    activity: activitySummarySchema
  }),
  /** A notification click asked the window to reveal this session. */
  z.strictObject({
    type: z.literal('activity-focus'),
    sessionId: sessionIdSchema
  })
])

export type HarnessListInput = z.infer<typeof harnessListInputSchema>
export type WslDistroSummary = z.infer<typeof wslDistroSummarySchema>
export type WslDistroListPayload = z.infer<typeof wslDistroListPayloadSchema>
export type OrphanedHostSession = z.infer<typeof orphanedHostSessionSchema>
export type SessionListView = z.infer<typeof sessionListViewSchema>
export type RemoveRepositoryResult = z.infer<typeof removeRepositoryResultSchema>
export type AddRepositoryInput = z.infer<typeof addRepositoryInputSchema>
export type RemoveRepositoryInput = z.infer<typeof removeRepositoryInputSchema>
export type ListSessionsInput = z.infer<typeof listSessionsInputSchema>
export type CreateSessionInput = z.infer<typeof createSessionInputSchema>
export type SessionTargetInput = z.infer<typeof sessionTargetInputSchema>
export type TerminalAttachInput = z.infer<typeof terminalAttachInputSchema>
export type TerminalWriteInput = z.infer<typeof terminalWriteInputSchema>
export type TerminalResizeInput = z.infer<typeof terminalResizeInputSchema>
export type RepositorySummary = z.infer<typeof repositorySummarySchema>
export type WorktreeSummary = z.infer<typeof worktreeSummarySchema>
export type WorktreeBlocker = z.infer<typeof worktreeBlockerSchema>
export type RemoveSessionResult = z.infer<typeof removeSessionResultSchema>
export type DiscardSessionResult = z.infer<typeof discardSessionResultSchema>
export type DiscardSessionInput = z.infer<typeof discardSessionInputSchema>
export type OwnedBranchSummary = z.infer<typeof ownedBranchSummarySchema>
export type RemoveBranchResult = z.infer<typeof removeBranchResultSchema>
export type RemoveBranchInput = z.infer<typeof removeBranchInputSchema>
export type ListBranchesInput = z.infer<typeof listBranchesInputSchema>
export type SessionSummary = z.infer<typeof sessionSummarySchema>
export type ActivitySummaryPayload = z.infer<typeof activitySummarySchema>
export type TerminalAttachPayload = z.infer<typeof terminalAttachPayloadSchema>
export type RendererSessionEvent = z.infer<typeof rendererSessionEventSchema>
