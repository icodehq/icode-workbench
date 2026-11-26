import { z } from 'zod'
import type { AppError } from '../domain/errors'
import { BRANCH_REF_KINDS } from '../domain/branch'
import { WORKTREE_STATES, WORKTREE_STATUSES } from '../domain/worktree'
import { MERGE_STATES } from '../domain/merge'
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
  startRefSchema,
  terminalInputSchema,
  timestampSchema,
  worktreeIdSchema
} from './primitives'

/** Renderer-facing channels. Preload exposes methods, never these strings. */
export const IPC_CHANNELS = {
  runtimeInfo: 'icode:runtime-info',
  localeGet: 'icode:locale:get',
  localeSet: 'icode:locale:set',
  localeChangedEvent: 'icode:locale:changed',
  sidebarOrderGet: 'icode:sidebar-order:get',
  sidebarOrderSet: 'icode:sidebar-order:set',
  reposList: 'icode:repos:list',
  reposAdd: 'icode:repos:add',
  reposInspect: 'icode:repos:inspect',
  reposInitialize: 'icode:repos:initialize',
  reposRetryPreparation: 'icode:repos:retry-preparation',
  reposPickFolder: 'icode:repos:pick-folder',
  reposRemove: 'icode:repos:remove',
  reposRemovalJobsList: 'icode:repos:removal-jobs',
  reposRemovalJobRetry: 'icode:repos:removal-job-retry',
  reposRemovalJobDiscardSnapshots: 'icode:repos:removal-job-discard-snapshots',
  reposRemovalEvent: 'icode:repos:removal-event',
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
  sessionsResume: 'icode:sessions:resume',
  sessionsSleep: 'icode:sessions:sleep',
  sessionsWake: 'icode:sessions:wake',
  sessionsRemove: 'icode:sessions:remove',
  sessionsDiscard: 'icode:sessions:discard',
  sessionsRecoverWorktree: 'icode:sessions:recover-worktree',
  worktreesRemove: 'icode:worktrees:remove',
  worktreesDiscard: 'icode:worktrees:discard',
  branchesList: 'icode:branches:list',
  branchesRefs: 'icode:branches:refs',
  branchesCurrent: 'icode:branches:current',
  branchesRemove: 'icode:branches:remove',
  remotesList: 'icode:remotes:list',
  remotesAdd: 'icode:remotes:add',
  remotesSetUrl: 'icode:remotes:set-url',
  remotesRemove: 'icode:remotes:remove',
  remotesFetch: 'icode:remotes:fetch',
  cloneStart: 'icode:clone:start',
  cloneCancel: 'icode:clone:cancel',
  clonePersist: 'icode:clone:persist',
  cloneSshStatus: 'icode:clone:ssh-status',
  cloneSshGenerate: 'icode:clone:ssh-generate',
  cloneSshTest: 'icode:clone:ssh-test',
  cloneSshTrustHost: 'icode:clone:ssh-trust-host',
  cloneProgress: 'icode:clone:progress',
  mergeStart: 'icode:merge:start',
  mergeContinue: 'icode:merge:continue',
  mergeAbort: 'icode:merge:abort',
  mergeState: 'icode:merge:state',
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
  tasksResume: 'icode:tasks:resume',
  tasksHistory: 'icode:tasks:history',
  tasksChanges: 'icode:tasks:changes',
  tasksDecideReview: 'icode:tasks:decide-review',
  tasksRequestChanges: 'icode:tasks:request-changes',
  tasksArchive: 'icode:tasks:archive',
  tasksUnarchive: 'icode:tasks:unarchive',
  tasksArchiveFinished: 'icode:tasks:archive-finished',
  tasksAddDependency: 'icode:tasks:add-dependency',
  tasksRemoveDependency: 'icode:tasks:remove-dependency',
  tasksSetHoldDependents: 'icode:tasks:set-hold-dependents',
  tasksSettings: 'icode:tasks:settings',
  tasksSetSettings: 'icode:tasks:set-settings',
  supervisorOpen: 'icode:supervisor:open',
  networkSettingsGet: 'icode:network:settings:get',
  networkSetSettings: 'icode:network:settings:set',
  botsList: 'icode:bots:list',
  botsCreate: 'icode:bots:create',
  botsUpdate: 'icode:bots:update',
  botsArchive: 'icode:bots:archive',
  botsSetPaused: 'icode:bots:set-paused',
  botsState: 'icode:bots:state',
  botsMessages: 'icode:bots:messages',
  botsConversations: 'icode:bots:conversations',
  botsNotifications: 'icode:bots:notifications',
  botsSend: 'icode:bots:send',
  botsMarkRead: 'icode:bots:mark-read',
  botsStop: 'icode:bots:stop',
  botsNewConversation: 'icode:bots:new-conversation',
  botsFocus: 'icode:bots:focus',
  botsSettingsGet: 'icode:bots:settings:get',
  botsSettingsSet: 'icode:bots:settings:set',
  botsMemoryList: 'icode:bots:memory:list',
  botsMemorySet: 'icode:bots:memory:set',
  botsMemoryDelete: 'icode:bots:memory:delete',
  botsMemoryApprove: 'icode:bots:memory:approve',
  botsEvent: 'icode:bots:event',
  groupsList: 'icode:groups:list',
  groupsCreate: 'icode:groups:create',
  groupsUpdate: 'icode:groups:update',
  groupsArchive: 'icode:groups:archive',
  groupsDelete: 'icode:groups:delete',
  groupsThreads: 'icode:groups:threads',
  groupsThreadCreate: 'icode:groups:thread-create',
  groupsMessages: 'icode:groups:messages',
  groupsSend: 'icode:groups:send',
  groupsMarkRead: 'icode:groups:mark-read',
  groupsSetRead: 'icode:groups:set-read',
  groupsSetMuted: 'icode:groups:set-muted',
  groupsStop: 'icode:groups:stop',
  groupsEvent: 'icode:groups:event',
  itemsList: 'icode:items:list',
  itemsGet: 'icode:items:get',
  itemsComment: 'icode:items:comment',
  itemsAsk: 'icode:items:ask',
  itemsAnswer: 'icode:items:answer',
  itemsSnooze: 'icode:items:snooze',
  itemsSetStatus: 'icode:items:set-status',
  itemsLinkAdd: 'icode:items:link-add',
  itemsLinkRemove: 'icode:items:link-remove',
  itemsAttach: 'icode:items:attach',
  itemsRemoveAttachment: 'icode:items:remove-attachment',
  schedulesList: 'icode:schedules:list',
  schedulesCreate: 'icode:schedules:create',
  schedulesUpdate: 'icode:schedules:update',
  schedulesSetEnabled: 'icode:schedules:set-enabled',
  schedulesRunNow: 'icode:schedules:run-now',
  schedulesRemove: 'icode:schedules:remove',
  taskEvent: 'icode:tasks:event',
  activityList: 'icode:activity:list',
  activityClearUnread: 'icode:activity:clear-unread',
  opencodeIntegrationGet: 'icode:opencode-integration:get',
  opencodeIntegrationSetEnabled: 'icode:opencode-integration:set-enabled',
  opencodeIntegrationEvent: 'icode:opencode-integration:event',
  managedHooksGet: 'icode:managed-hooks:get',
  managedHooksSetEnabled: 'icode:managed-hooks:set-enabled',
  managedHooksEvent: 'icode:managed-hooks:event',
  terminalAttach: 'icode:terminal:attach',
  terminalWrite: 'icode:terminal:write',
  terminalResize: 'icode:terminal:resize',
  harnessList: 'icode:harness:list',
  providersList: 'icode:providers:list',
  providersCreate: 'icode:providers:create',
  providersUpdate: 'icode:providers:update',
  providersRemove: 'icode:providers:remove',
  providersSelect: 'icode:providers:select',
  providersTest: 'icode:providers:test',
  aiCommitMessage: 'icode:ai:commit-message',
  aiCancelCommitMessage: 'icode:ai:cancel-commit-message',
  wslListDistros: 'icode:wsl:list-distros',
  updatesGet: 'icode:updates:get',
  updatesCheck: 'icode:updates:check',
  updatesDownload: 'icode:updates:download',
  updatesCancelDownload: 'icode:updates:cancel-download',
  updatesInstall: 'icode:updates:install',
  updatesSkip: 'icode:updates:skip',
  updatesSetAutoCheck: 'icode:updates:set-auto-check',
  updatesEvent: 'icode:updates:event',
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
  source: z.enum(['wsl', 'windows']).optional(),
  /**
   * What the folder is for. A clone destination is an existing *parent* folder,
   * so its dialog says so instead of asking for a repository.
   */
  purpose: z.enum(['repository', 'clone-parent']).optional()
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
  repoId: repoIdSchema
})

export const listSessionsInputSchema = z.strictObject({
  repoId: repoIdSchema.optional()
})

export const branchNameSchema = z.string().trim().min(1).max(255)

export const createSessionInputSchema = z.strictObject({
  repoId: repoIdSchema,
  harness: harnessIdSchema,
  title: sessionTitleSchema.optional(),
  /**
   * Where the session runs.
   *
   * Absent or `worktree` is the isolated path: attach to `worktreeId` or create
   * a new checkout. `default` runs directly in the repository's primary
   * checkout and is mutually exclusive with `worktreeId`, `startFrom`,
   * `branchName`, and a main-process `base`.
   */
  checkout: z.enum(['worktree', 'default']).optional(),
  /**
   * Run in an existing worktree owned by this repository.
   *
   * The checkout, branch, and baseline already exist; `startFrom`, `branchName`
   * and a main-process `base` are mutually exclusive with this.
   */
  worktreeId: worktreeIdSchema.optional(),
  /** Local or remote-tracking ref to base a new worktree on. Absent keeps the primary HEAD. */
  startFrom: startRefSchema.optional(),
  /** Optional user-chosen branch name. Absent keeps the generated session name. */
  branchName: branchNameSchema.optional(),
  cols: dimensionSchema,
  rows: dimensionSchema
})

export const branchRefSummarySchema = z.strictObject({
  /** Display label: a short local name, or remote shorthand such as `origin/foo`. */
  name: z.string().min(1).max(1024),
  /** Full Git refname. Remote options submit this value. */
  fullName: z.string().min(1).max(1024),
  kind: z.enum(BRANCH_REF_KINDS),
  oid: z.string().min(1).max(128),
  primaryHead: z.boolean(),
  worktreePath: absolutePathSchema.nullable()
})

export const listBranchRefsInputSchema = z.strictObject({
  repoId: repoIdSchema
})

export const mergeStateSchema = z.enum(MERGE_STATES)

export const mergeRecordSchema = z.strictObject({
  id: z.string().min(1).max(128),
  repoId: repoIdSchema,
  sessionId: sessionIdSchema,
  taskId: z.string().min(1).max(128).nullable(),
  sourceBranch: branchNameSchema,
  targetBranch: branchNameSchema,
  sourceOidBefore: z.string().min(1).max(128),
  targetOidBefore: z.string().min(1).max(128),
  targetOidAfter: z.string().min(1).max(128).nullable(),
  resultOid: z.string().min(1).max(128).nullable(),
  reviewBaseOid: z.string().min(1).max(128).nullable(),
  state: mergeStateSchema,
  commitOid: z.string().min(1).max(128).nullable(),
  conflictFiles: z.array(z.string().min(1).max(4096)).max(200),
  error: appErrorSchema.nullable(),
  pushRemote: z.string().min(1).max(255).nullable(),
  pushedAt: timestampSchema.nullable(),
  pushError: appErrorSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  finishedAt: timestampSchema.nullable()
})

export const mergeStartInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  targetBranch: branchNameSchema,
  commitMessage: z.string().max(20_000).optional(),
  pushRemote: z.string().trim().min(1).max(255).optional()
})

export const mergeSessionInputSchema = z.strictObject({
  sessionId: sessionIdSchema
})

export const mergeOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('merged'), record: mergeRecordSchema }),
  z.strictObject({ status: z.literal('conflicted'), record: mergeRecordSchema })
])

export const sessionTargetInputSchema = z.strictObject({
  sessionId: sessionIdSchema
})

/**
 * Explicit checkout recovery.
 *
 * `keepExistingAsAside` is the user's confirmation that an unrecoverable
 * directory may be moved aside; without it the main process refuses to touch
 * user files.
 */
export const recoverWorktreeInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  keepExistingAsAside: z.boolean().optional()
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
  stopIfLive: z.boolean().optional(),
  /**
   * Delete the session's owned branch after its checkout is removed.
   *
   * Only valid for a session that solely owns its worktree. The backend
   * re-verifies ownership, active task chains and registered worktrees before
   * touching the branch; a refusal leaves everything in place.
   */
  deleteBranch: z.boolean().optional()
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
  id: worktreeIdSchema,
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
  /**
   * Whether an explicit Resume can reopen this session's harness conversation.
   *
   * True only for a non-live, non-sleeping session whose conversation token was
   * captured and whose harness has a resume recipe. Restart deliberately starts
   * fresh; resume never guesses a conversation. Optional so older persisted
   * summaries remain parseable; the backend always sets it.
   */
  resumable: z.boolean().optional(),
  /** `null` for legacy and default-checkout sessions that run in the repository's primary checkout. */
  worktree: worktreeSummarySchema.nullable(),
  /**
   * Hook-derived agent activity. Advisory only: `unknown` means no trustworthy
   * evidence, never a claim that the agent is idle.
   */
  activity: activitySummarySchema.nullable()
})

/** Recovery result; `preservedPath` names files moved aside by user request. */
export const recoverWorktreeResultSchema = z.strictObject({
  session: sessionSummarySchema,
  preservedPath: z.string().min(1).max(4096).nullable()
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
    branchRetained: z.boolean(),
    /** Present when branch deletion was requested but Git refused it. */
    branchDeleteError: appErrorSchema.optional()
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
    branchRetained: z.boolean(),
    /** Present when branch deletion was requested but Git refused it. */
    branchDeleteError: appErrorSchema.optional()
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
  confirmBranch: z.string().min(1).max(255),
  /** Also delete the owned branch once the checkout is gone. */
  deleteBranch: z.boolean().optional()
})

const removedSessionIdsSchema = z.array(sessionIdSchema).max(500)

/**
 * Worktree-level removal: every session attached to the checkout leaves with
 * it. Live sessions are stopped first; a dirty or unmerged checkout still
 * blocks the operation so no uncommitted work is ever deleted implicitly.
 */
export const removeWorktreeInputSchema = z.strictObject({
  worktreeId: worktreeIdSchema,
  /** Delete the worktree's owned branch once its checkout is gone. */
  deleteBranch: z.boolean().optional()
})

export const removeWorktreeResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('removed'),
    sessionIds: removedSessionIdsSchema,
    branch: z.string().min(1).max(255).nullable(),
    branchRetained: z.boolean(),
    /** Present when branch deletion was requested but Git refused it. */
    branchDeleteError: appErrorSchema.optional()
  }),
  z.strictObject({ status: z.literal('host_unavailable'), error: appErrorSchema }),
  z.strictObject({
    status: z.literal('blocked_worktree'),
    sessionIds: removedSessionIdsSchema,
    blocker: worktreeBlockerSchema
  })
])

export const discardWorktreeInputSchema = z.strictObject({
  worktreeId: worktreeIdSchema,
  /** The exact branch name, typed by the user. Never a boolean acknowledgement. */
  confirmBranch: z.string().min(1).max(255),
  /** Also delete the owned branch once the checkout is gone. */
  deleteBranch: z.boolean().optional()
})

export const discardWorktreeResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('discarded'),
    sessionIds: removedSessionIdsSchema,
    branch: z.string().min(1).max(255),
    files: worktreeFileListSchema,
    commits: z.number().int().nonnegative(),
    branchRetained: z.boolean(),
    /** Present when branch deletion was requested but Git refused it. */
    branchDeleteError: appErrorSchema.optional()
  }),
  z.strictObject({ status: z.literal('host_unavailable'), error: appErrorSchema }),
  z.strictObject({
    status: z.literal('blocked_worktree'),
    sessionIds: removedSessionIdsSchema,
    blocker: worktreeBlockerSchema
  })
])

export const ownedBranchSummarySchema = z.strictObject({
  branch: z.string().min(1).max(255),
  repoId: repoIdSchema,
  worktreeId: worktreeIdSchema.nullable(),
  sessionId: z.string().min(1).max(128).nullable(),
  taskId: z.string().min(1).max(128).nullable(),
  kind: z.enum(['session', 'chain']),
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

/** The branch checked out in the repository's primary checkout. */
export const currentBranchInputSchema = z.strictObject({ repoId: repoIdSchema })

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

export const removeRepositoryResultSchema = z.strictObject({
  status: z.literal('removing'),
  jobId: z.string().min(1).max(128)
})

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
  /**
   * Transient repair/start progress for one session. The next `state` event (or
   * the renderer action settling) supersedes it; it is never persisted.
   */
  z.strictObject({
    type: z.literal('recovery'),
    sessionId: sessionIdSchema,
    phase: z.enum(['checking', 'repairing', 'starting']),
    detail: z.string().min(1).max(2000).optional()
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
  }),
  /** A kind-aware notification click asked the shell to navigate somewhere. */
  z.strictObject({
    type: z.literal('notification-focus'),
    destination: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('session'),
        sessionId: sessionIdSchema,
        view: z.enum(['terminal', 'changes', 'files']).optional()
      }),
      z.strictObject({
        kind: z.literal('task'),
        taskId: z.string().min(1).max(128)
      })
    ])
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
export type BranchRefSummary = z.infer<typeof branchRefSummarySchema>
export type ListBranchRefsInput = z.infer<typeof listBranchRefsInputSchema>
export type MergeRecordPayload = z.infer<typeof mergeRecordSchema>
export type MergeStartInput = z.infer<typeof mergeStartInputSchema>
export type MergeSessionInput = z.infer<typeof mergeSessionInputSchema>
export type MergeOutcomePayload = z.infer<typeof mergeOutcomeSchema>
export type SessionTargetInput = z.infer<typeof sessionTargetInputSchema>
export type RecoverWorktreeInput = z.infer<typeof recoverWorktreeInputSchema>
export type RecoverWorktreeResult = z.infer<typeof recoverWorktreeResultSchema>
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
export type RemoveWorktreeResult = z.infer<typeof removeWorktreeResultSchema>
export type RemoveWorktreeInput = z.infer<typeof removeWorktreeInputSchema>
export type DiscardWorktreeResult = z.infer<typeof discardWorktreeResultSchema>
export type DiscardWorktreeInput = z.infer<typeof discardWorktreeInputSchema>
export type OwnedBranchSummary = z.infer<typeof ownedBranchSummarySchema>
export type RemoveBranchResult = z.infer<typeof removeBranchResultSchema>
export type RemoveBranchInput = z.infer<typeof removeBranchInputSchema>
export type ListBranchesInput = z.infer<typeof listBranchesInputSchema>
export type SessionSummary = z.infer<typeof sessionSummarySchema>
export type ActivitySummaryPayload = z.infer<typeof activitySummarySchema>
export type TerminalAttachPayload = z.infer<typeof terminalAttachPayloadSchema>
export type RendererSessionEvent = z.infer<typeof rendererSessionEventSchema>
