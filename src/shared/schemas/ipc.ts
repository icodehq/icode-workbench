import { z } from 'zod'
import type { AppError } from '../domain/errors'
import { WORKTREE_STATES, WORKTREE_STATUSES } from '../domain/worktree'
import { SESSION_ROLES } from '../domain/session'
import { activitySummarySchema } from './activity'
import {
  appErrorSchema,
  harnessIdSchema,
  reconciliationReasonSchema,
  repositoryPreparationSchema
} from './domain'
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
  runtimeInfo: 'icode:runtime-info',
  localeGet: 'icode:locale:get',
  localeSet: 'icode:locale:set',
  localeChangedEvent: 'icode:locale:changed',
  reposList: 'icode:repos:list',
  reposAdd: 'icode:repos:add',
  reposInspect: 'icode:repos:inspect',
  reposInitialize: 'icode:repos:initialize',
  reposRetryPreparation: 'icode:repos:retry-preparation',
  reposPickFolder: 'icode:repos:pick-folder',
  reposRemove: 'icode:repos:remove',
  reposEvent: 'icode:repos:event',
  viewCommand: 'icode:view:command',
  windowMinimize: 'icode:window:minimize',
  windowToggleMaximize: 'icode:window:toggle-maximize',
  windowClose: 'icode:window:close',
  windowBeforeClose: 'icode:window:before-close',
  windowCloseResponse: 'icode:window:close-response',
  windowIsMaximized: 'icode:window:is-maximized',
  windowOpenExternal: 'icode:window:open-external',
  windowMaximizedEvent: 'icode:window:maximized',
  sessionsList: 'icode:sessions:list',
  sessionsGet: 'icode:sessions:get',
  sessionsCreate: 'icode:sessions:create',
  sessionsClose: 'icode:sessions:close',
  sessionsRestart: 'icode:sessions:restart',
  sessionsSleep: 'icode:sessions:sleep',
  sessionsWake: 'icode:sessions:wake',
  sessionsRemove: 'icode:sessions:remove',
  sessionsDiscard: 'icode:sessions:discard',
  sessionsRecoverWorktree: 'icode:sessions:recover-worktree',
  branchesList: 'icode:branches:list',
  branchesRemove: 'icode:branches:remove',
  filesList: 'icode:files:list',
  filesRead: 'icode:files:read',
  filesWrite: 'icode:files:write',
  filesSearch: 'icode:files:search',
  filesCancelSearch: 'icode:files:cancel-search',
  filesReplace: 'icode:files:replace',
  filesCreate: 'icode:files:create',
  filesRename: 'icode:files:rename',
  filesRemove: 'icode:files:remove',
  filesRemoveMany: 'icode:files:remove-many',
  filesTrash: 'icode:files:trash',
  filesRestoreTrash: 'icode:files:restore-trash',
  filesListTrash: 'icode:files:list-trash',
  filesMoveMany: 'icode:files:move-many',
  filesCopyMany: 'icode:files:copy-many',
  filesCopyPaths: 'icode:files:copy-paths',
  filesStat: 'icode:files:stat',
  filesWatch: 'icode:files:watch',
  filesChangedEvent: 'icode:files:changed-event',
  gitInvoke: 'icode:git:invoke',
  gitStatusEvent: 'icode:git:status-event',
  tasksList: 'icode:tasks:list',
  tasksCreate: 'icode:tasks:create',
  tasksApprove: 'icode:tasks:approve',
  tasksReject: 'icode:tasks:reject',
  tasksCancel: 'icode:tasks:cancel',
  tasksRetry: 'icode:tasks:retry',
  tasksHistory: 'icode:tasks:history',
  tasksChanges: 'icode:tasks:changes',
  tasksDecideReview: 'icode:tasks:decide-review',
  tasksArchive: 'icode:tasks:archive',
  tasksUnarchive: 'icode:tasks:unarchive',
  tasksArchiveFinished: 'icode:tasks:archive-finished',
  tasksSettings: 'icode:tasks:settings',
  tasksSetSettings: 'icode:tasks:set-settings',
  supervisorOpen: 'icode:supervisor:open',
  assistantState: 'icode:assistant:state',
  assistantMessagesList: 'icode:assistant:messages:list',
  assistantSend: 'icode:assistant:send',
  assistantMarkRead: 'icode:assistant:mark-read',
  assistantStop: 'icode:assistant:stop',
  assistantSettingsGet: 'icode:assistant:settings:get',
  assistantSetSettings: 'icode:assistant:settings:set',
  assistantConversationsList: 'icode:assistant:conversations:list',
  assistantNotificationsList: 'icode:assistant:notifications:list',
  assistantFocus: 'icode:assistant:focus',
  assistantNewConversation: 'icode:assistant:new-conversation',
  assistantEvent: 'icode:assistant-event',
  schedulesList: 'icode:schedules:list',
  schedulesCreate: 'icode:schedules:create',
  schedulesUpdate: 'icode:schedules:update',
  schedulesSetEnabled: 'icode:schedules:set-enabled',
  schedulesRunNow: 'icode:schedules:run-now',
  schedulesRemove: 'icode:schedules:remove',
  taskEvent: 'icode:tasks:event',
  activityList: 'icode:activity:list',
  activityClearUnread: 'icode:activity:clear-unread',
  terminalAttach: 'icode:terminal:attach',
  terminalWrite: 'icode:terminal:write',
  terminalResize: 'icode:terminal:resize',
  harnessList: 'icode:harness:list',
  aiCommitMessage: 'icode:ai:commit-message',
  aiCancelCommitMessage: 'icode:ai:cancel-commit-message',
  wslListDistros: 'icode:wsl:list-distros',
  sessionEvent: 'icode:session-event'
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

/**
 * External links in assistant Markdown. Only http(s) reaches the OS browser;
 * file:, custom schemes and local paths are rejected.
 */
export const windowOpenExternalInputSchema = z.strictObject({
  url: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .refine((value) => {
      try {
        const url = new URL(value)
        return url.protocol === 'http:' || url.protocol === 'https:'
      } catch {
        return false
      }
    }, 'must be an http(s) URL')
})

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

/**
 * Asking the platform's folder dialog for a repository path.
 *
 * The target travels with the request because what a picker can show depends on
 * it: a local repository is a Windows path, while a WSL one is browsed through
 * that distro's `\\wsl.localhost` namespace and answered in Linux spelling.
 */
export const pickRepositoryFolderInputSchema = z.strictObject({
  target: executionTargetSchema,
  /**
   * A WSL project can be stored in the distro or on a Windows drive. The latter
   * needs a native Windows folder dialog because Windows denies browsing
   * `\\wsl.localhost\<distro>\mnt\<drive>`; the selected spelling is translated
   * by the project-folder service, never recorded as a Linux path verbatim.
   */
  source: z.enum(['wsl', 'windows']).optional()
})

export const pickRepositoryFolderResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('selected'),
    path: absolutePathSchema,
    /** The Windows spelling the user chose, before WSL translation. */
    translatedFrom: z.string().min(1).max(4096).optional()
  }),
  z.strictObject({ status: z.literal('cancelled') }),
  z.strictObject({
    status: z.literal('unavailable'),
    reason: z.enum([
      'not_windows',
      'guest_home_unknown',
      'dialog_failed',
      'wrong_filesystem',
      'path_unavailable'
    ]),
    detail: z.string().min(1).max(500)
  })
])

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

/** Opening a project supervisor creates it if needed and returns its session. */
export const supervisorOpenInputSchema = z.strictObject({
  repoId: repoIdSchema
})

/**
 * Removing a live session is the normal user path: the UI asks to remove the
 * session, not to understand the separate "stop process" step. The backend
 * stops the PTY first, then applies every existing worktree safety check.
 */
export const removeSessionInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  stopIfLive: z.boolean().optional()
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
  target: executionTargetSchema,
  /**
   * Background first-commit state. Null for an ordinary checkout that already
   * has a baseline and for rows that predate preparation.
   */
  preparation: repositoryPreparationSchema.nullable()
})

/** `alreadyRegistered` is the service's own answer, not a client-side guess. */
export const addRepositoryResultSchema = repositorySummarySchema.extend({
  alreadyRegistered: z.boolean()
})

/** A repository offered when the selected folder is only a container of repos. */
export const projectRepositoryCandidateSchema = z.strictObject({
  path: absolutePathSchema,
  displayName: z.string().min(1).max(200)
})

/** The bounded file estimate shown before an initial commit is created. */
export const projectFolderPreviewSchema = z.strictObject({
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean()
})

export const projectIdentityStateSchema = z.strictObject({
  configured: z.boolean(),
  name: z.string().max(200).nullable(),
  email: z.string().max(320).nullable()
})

/**
 * What Add project found before it changes anything.
 *
 * `gitless` and `unborn` are deliberately different: one needs `git init`, the
 * other already has a repository but no baseline commit. `parent` means the
 * folder contains repositories and must not be initialized over them.
 */
export const projectFolderInspectionSchema = z.strictObject({
  kind: z.enum(['repository', 'unborn', 'gitless', 'parent']),
  path: absolutePathSchema,
  /**
   * The Windows spelling supplied for a WSL target, when it was translated.
   * Absent for a path that was already a Linux path.
   */
  translatedFrom: z.string().min(1).max(4096).optional(),
  root: absolutePathSchema.nullable(),
  currentBranch: z.string().min(1).max(255).nullable(),
  hasCommit: z.boolean(),
  repositories: z.array(projectRepositoryCandidateSchema).max(200),
  preview: projectFolderPreviewSchema.nullable(),
  identity: projectIdentityStateSchema,
  canInitialize: z.boolean(),
  blockedReason: z.string().max(2000).nullable()
})

export const inspectRepositoryInputSchema = z.strictObject({
  path: absolutePathSchema,
  target: executionTargetSchema
})

export const projectIdentityInputSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), 'must not contain control characters'),
  email: z
    .string()
    .trim()
    .min(3)
    .max(320)
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), 'must not contain control characters')
})

export const initializeRepositoryInputSchema = z.strictObject({
  path: absolutePathSchema,
  target: executionTargetSchema,
  identity: projectIdentityInputSchema.optional()
})

export const retryRepositoryPreparationInputSchema = z.strictObject({
  repoId: repoIdSchema
})

export const initializeRepositoryResultSchema = addRepositoryResultSchema.extend({
  initialized: z.boolean(),
  committedFiles: z.number().int().nonnegative()
})


export const worktreeSummarySchema = z.strictObject({
  path: absolutePathSchema,
  branch: z.string().min(1).max(255),
  baseOid: z.string().min(1).max(128),
  state: z.enum(WORKTREE_STATES),
  status: z.enum(WORKTREE_STATUSES),
  error: appErrorSchema.nullable()
})

export const sessionRoleSchema = z.enum(SESSION_ROLES)

export const sessionSummarySchema = z.strictObject({
  id: sessionIdSchema,
  repoId: repoIdSchema,
  title: sessionTitleSchema,
  harness: harnessIdSchema,
  role: sessionRoleSchema.optional(),
  state: z.enum(['starting', 'live', 'exited', 'failed', 'unavailable']),
  authority: z.enum(['host', 'persisted', 'unreachable']),
  reason: reconciliationReasonSchema,
  incarnationId: incarnationIdSchema.nullable(),
  exitCode: z.number().int().nullable(),
  error: appErrorSchema.nullable(),
  updatedAt: timestampSchema,
  /**
   * Durable sleep intent. The process is stopped; the session and worktree
   * remain. Optional so older fixtures and already-persisted summaries remain
   * parseable; the backend always sets it.
   */
  sleeping: z.boolean().optional(),
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
 * A live host PTY with no durable iCode row. Surfaced rather than hidden so the
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
export type ProjectRepositoryCandidate = z.infer<typeof projectRepositoryCandidateSchema>
export type ProjectFolderPreview = z.infer<typeof projectFolderPreviewSchema>
export type ProjectIdentityState = z.infer<typeof projectIdentityStateSchema>
export type ProjectFolderInspection = z.infer<typeof projectFolderInspectionSchema>
export type InspectRepositoryInput = z.infer<typeof inspectRepositoryInputSchema>
export type ProjectIdentityInput = z.infer<typeof projectIdentityInputSchema>
export type InitializeRepositoryInput = z.infer<typeof initializeRepositoryInputSchema>
export type InitializeRepositoryResult = z.infer<typeof initializeRepositoryResultSchema>
export type RemoveRepositoryInput = z.infer<typeof removeRepositoryInputSchema>
export type ListSessionsInput = z.infer<typeof listSessionsInputSchema>
export type CreateSessionInput = z.infer<typeof createSessionInputSchema>
export type SessionTargetInput = z.infer<typeof sessionTargetInputSchema>
export type RemoveSessionInput = z.infer<typeof removeSessionInputSchema>
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
