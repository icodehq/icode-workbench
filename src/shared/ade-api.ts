import type { z } from 'zod'
import type {
  addRepositoryInputSchema,
  addRepositoryResultSchema,
  inspectRepositoryInputSchema,
  initializeRepositoryInputSchema,
  initializeRepositoryResultSchema,
  retryRepositoryPreparationInputSchema,
  pickRepositoryFolderInputSchema,
  pickRepositoryFolderResultSchema,
  projectFolderInspectionSchema,
  createSessionInputSchema,
  discardSessionInputSchema,
  listBranchesInputSchema,
  removeBranchInputSchema,
  harnessListInputSchema,
  removeRepositoryInputSchema,
  removeSessionInputSchema,
  sessionTargetInputSchema,
  terminalAttachInputSchema,
  terminalResizeInputSchema,
  terminalWriteInputSchema
} from './schemas/ipc'
import type { clearActivityUnreadInputSchema } from './schemas/activity'
import type {
  reviewAreaDiffInputSchema,
  ReviewDiffResult
} from './schemas/review'
import type {
  filesCreateInputSchema,
  filesListInputSchema,
  filesReadInputSchema,
  filesRemoveInputSchema,
  filesRenameInputSchema,
  filesSearchInputSchema,
  filesWriteInputSchema,
  gitAddRemoteInputSchema,
  gitAmendInputSchema,
  gitPullInputSchema,
  gitBlameInputSchema,
  gitBranchesInputSchema,
  gitCommitInputSchema,
  gitCommitDetailInputSchema,
  gitCancelStatusInputSchema,
  gitCommitActionInputSchema,
  gitCreateBranchInputSchema,
  gitCheckoutRefInputSchema,
  gitCreateTagInputSchema,
  gitDeleteBranchInputSchema,
  gitDeleteTagInputSchema,
  gitMergeBranchInputSchema,
  gitRebaseBranchInputSchema,
  gitRenameBranchInputSchema,
  gitResetInputSchema,
  gitDiscardPathInputSchema,
  gitDiscardPathsInputSchema,
  gitFetchRemoteInputSchema,
  gitFileAtRevisionInputSchema,
  gitIndexFileInputSchema,
  gitApplyPatchInputSchema,
  gitConflictFileInputSchema,
  gitResolveConflictInputSchema,
  gitStashPushInputSchema,
  gitStashTargetInputSchema,
  gitStashActionInputSchema,
  gitWorktreeActionInputSchema,
  gitSubmoduleActionInputSchema,
  gitHistoryInputSchema,
  gitLogInputSchema,
  gitOperationActionInputSchema,
  gitOperationStateInputSchema,
  gitRangeDiffInputSchema,
  gitRevisionFileDiffInputSchema,
  gitWatchStatusInputSchema,
  gitStageAllInputSchema,
  gitRemoteOpInputSchema,
  gitRemoveRemoteInputSchema,
  gitSetPathStagedInputSchema,
  gitSetUpstreamInputSchema,
  gitSetPathsStagedInputSchema,
  gitStatusInputSchema,
  scheduleCreateInputSchema,
  scheduleEnabledInputSchema,
  scheduleIdInputSchema,
  scheduleListInputSchema,
  scheduleUpdateInputSchema,
  taskChangesPayloadSchema,
  taskCreateInputSchema,
  taskDecideReviewInputSchema,
  taskIdInputSchema,
  taskListInputSchema,
  taskRecordSchema,
  taskScheduleSchema,
  taskSettingsInputSchema,
  gitSwitchBranchInputSchema,
  gitUnstageAllInputSchema
} from './schemas/workspace'
import type { FileContent, FileListing, FileSearchResult } from './domain/workspace-files'
import type {
  GitBatchResult,
  GitRemote,
  GitTag,
  GitCommitDetail,
  GitCommitResult,
  GitLogPage,
  GitOperationKind,
  GitRangeFile,
  GitStatusEntry,
  GitStatusWatchEvent,
  GitWatchUnavailableReason,
  GitWorkspaceStatus
} from './domain/git-workspace'
import type {
  DiscardSessionResult,
  IpcResult,
  ListSessionsInput,
  OwnedBranchSummary,
  RemoveBranchResult,
  RemoveRepositoryResult,
  RemoveSessionResult,
  ActivitySummaryPayload,
  RepositorySummary,
  SessionListView,
  SessionSummary,
  TerminalAttachPayload,
  RendererSessionEvent,
  WslDistroListPayload
} from './schemas/ipc'
import type { HarnessDetection } from './domain/harness'

export type RuntimeInfo = {
  appVersion: string
  electron: string | null
  node: string
  platform: string
  packaged: boolean
}

/**
 * Contract for the repository/session/terminal surface, implemented by preload.
 * The renderer never sees IPC channel names or a raw ipcRenderer, and cannot
 * supply commands, cwd, or host protocol messages.
 */
export type AdeProductApi = {
  repos: {
    list: () => Promise<IpcResult<RepositorySummary[]>>
    add: (
      input: z.infer<typeof addRepositoryInputSchema>
    ) => Promise<IpcResult<AddRepositoryResultPayload>>
    /** Describes a folder before Add project mutates anything. */
    inspect: (
      input: z.infer<typeof inspectRepositoryInputSchema>
    ) => Promise<IpcResult<ProjectFolderInspectionPayload>>
    /**
     * Registers an existing checkout or starts background preparation of a
     * first commit. The result is authoritative for the preparation state.
     */
    initialize: (
      input: z.infer<typeof initializeRepositoryInputSchema>
    ) => Promise<IpcResult<InitializeRepositoryResultPayload>>
    /** Retries a failed or interrupted background first commit. */
    retryPreparation: (
      input: z.infer<typeof retryRepositoryPreparationInputSchema>
    ) => Promise<IpcResult<RepositorySummary>>
    /**
     * Opens the platform's folder dialog for `target`.
     *
     * For a WSL target, `source: 'windows'` opens the native Windows dialog and
     * returns a Linux path translated by the selected distro; `source: 'wsl'`
     * browses the distro's own files through `\\wsl.localhost`.
     *
     * `cancelled` is a normal answer, and `unavailable` explains why browsing is
     * impossible for that target rather than returning a path nobody chose.
     */
    pickFolder: (
      input: z.infer<typeof pickRepositoryFolderInputSchema>
    ) => Promise<IpcResult<RepositoryFolderPickPayload>>
    remove: (
      input: z.infer<typeof removeRepositoryInputSchema>
    ) => Promise<IpcResult<RemoveRepositoryResult>>
  }
  sessions: {
    list: (input: ListSessionsInput) => Promise<IpcResult<SessionListView>>
    get: (
      input: z.infer<typeof sessionTargetInputSchema>
    ) => Promise<IpcResult<SessionSummary>>
    create: (
      input: z.infer<typeof createSessionInputSchema>
    ) => Promise<IpcResult<SessionSummary>>
    close: (input: z.infer<typeof sessionTargetInputSchema>) => Promise<IpcResult<null>>
    restart: (input: z.infer<typeof sessionTargetInputSchema>) => Promise<IpcResult<SessionSummary>>
    /** Stops the process, frees resources, and keeps the session/worktree. */
    sleep: (input: z.infer<typeof sessionTargetInputSchema>) => Promise<IpcResult<SessionSummary>>
    /** Restarts a sleeping session, resuming the harness conversation where supported. */
    wake: (input: z.infer<typeof sessionTargetInputSchema>) => Promise<IpcResult<SessionSummary>>
    /** Removes metadata and a clean worktree; `stopIfLive` stops the PTY first. */
    remove: (input: z.infer<typeof removeSessionInputSchema>) => Promise<IpcResult<RemoveSessionResult>>
    /** Destructive: requires the exact branch name; any uncommitted work is lost. */
    discard: (
      input: z.infer<typeof discardSessionInputSchema>
    ) => Promise<IpcResult<DiscardSessionResult>>
    recoverWorktree: (
      input: z.infer<typeof sessionTargetInputSchema>
    ) => Promise<IpcResult<SessionSummary>>
  }
  branches: {
    list: (input: z.infer<typeof listBranchesInputSchema>) => Promise<IpcResult<OwnedBranchSummary[]>>
    remove: (input: z.infer<typeof removeBranchInputSchema>) => Promise<IpcResult<RemoveBranchResult>>
  }
  /**
   * Read-only review of a session's changes since its persisted baseline.
   * Both calls resolve with a truthful `unavailable` result when no review is
   * possible; an IpcResult error is reserved for transport or invalid input.
   */
  activity: {
    /** Snapshot of per-session activity for the sessions this window knows. */
    list: () => Promise<IpcResult<Array<{ sessionId: string; activity: ActivitySummaryPayload }>>>
    clearUnread: (
      input: z.infer<typeof clearActivityUnreadInputSchema>
    ) => Promise<IpcResult<boolean>>
  }
  review: {
    /** One side of the working tree: HEAD→index, index→worktree, or untracked. */
    areaDiff: (
      input: z.infer<typeof reviewAreaDiffInputSchema>
    ) => Promise<IpcResult<ReviewDiffResult>>
  }
  /**
   * Browsing, editing and search inside the selected session's worktree.
   *
   * Every call resolves with a truthful `unavailable` reason for the checkout
   * (missing, unreachable, primary) rather than rejecting or answering `[]`.
   */
  files: {
    list: (
      input: z.infer<typeof filesListInputSchema>
    ) => Promise<IpcResult<FilesListingPayload>>
    read: (input: z.infer<typeof filesReadInputSchema>) => Promise<IpcResult<FileContentPayload>>
    write: (
      input: z.infer<typeof filesWriteInputSchema>
    ) => Promise<IpcResult<FilesWritePayload>>
    search: (
      input: z.infer<typeof filesSearchInputSchema>
    ) => Promise<IpcResult<FileSearchPayload>>
    create: (
      input: z.infer<typeof filesCreateInputSchema>
    ) => Promise<IpcResult<FilesMutatePayload>>
    rename: (
      input: z.infer<typeof filesRenameInputSchema>
    ) => Promise<IpcResult<FilesMutatePayload>>
    remove: (
      input: z.infer<typeof filesRemoveInputSchema>
    ) => Promise<IpcResult<FilesMutatePayload>>
  }
  /** Worktree-scoped Git state and the common change operations. */
  git: {
    status: (input: z.infer<typeof gitStatusInputSchema>) => Promise<IpcResult<GitStatusPayload>>
    cancelStatus: (
      input: z.infer<typeof gitCancelStatusInputSchema>
    ) => Promise<IpcResult<{ cancelled: boolean }>>
    operationState: (
      input: z.infer<typeof gitOperationStateInputSchema>
    ) => Promise<IpcResult<GitOperationStatePayload>>
    continueOperation: (
      input: z.infer<typeof gitOperationActionInputSchema>
    ) => Promise<IpcResult<GitOperationActionPayload>>
    abortOperation: (
      input: z.infer<typeof gitOperationActionInputSchema>
    ) => Promise<IpcResult<GitOperationActionPayload>>
    rangeDiff: (
      input: z.infer<typeof gitRangeDiffInputSchema>
    ) => Promise<IpcResult<GitRangeDiffPayload>>
    /** Enables live worktree watching only while Changes is visible. */
    watchStatus: (
      input: z.infer<typeof gitWatchStatusInputSchema>
    ) => Promise<IpcResult<{ watching: boolean; reason?: GitWatchUnavailableReason }>>
    /** Coalesced worktree revisions; the listener re-reads status and diffs. */
    onStatusChange: (listener: (event: GitStatusWatchEvent) => void) => () => void
    stageAll: (
      input: z.infer<typeof gitStageAllInputSchema>
    ) => Promise<IpcResult<GitOpPayload>>
    unstageAll: (
      input: z.infer<typeof gitUnstageAllInputSchema>
    ) => Promise<IpcResult<GitOpPayload>>
    commit: (
      input: z.infer<typeof gitCommitInputSchema>
    ) => Promise<IpcResult<GitCommitPayload>>
    discardPath: (
      input: z.infer<typeof gitDiscardPathInputSchema>
    ) => Promise<IpcResult<{ status: 'ok'; restored: boolean } | WorkspaceUnavailablePayload>>
    setPathStaged: (
      input: z.infer<typeof gitSetPathStagedInputSchema>
    ) => Promise<IpcResult<GitOpPayload>>
    setPathsStaged: (
      input: z.infer<typeof gitSetPathsStagedInputSchema>
    ) => Promise<IpcResult<GitBatchPayload>>
    discardPaths: (
      input: z.infer<typeof gitDiscardPathsInputSchema>
    ) => Promise<IpcResult<GitBatchPayload>>
    branches: (
      input: z.infer<typeof gitBranchesInputSchema>
    ) => Promise<IpcResult<GitBranchesPayload>>
    switchBranch: (
      input: z.infer<typeof gitSwitchBranchInputSchema>
    ) => Promise<IpcResult<GitBranchPayload>>
    createBranch: (
      input: z.infer<typeof gitCreateBranchInputSchema>
    ) => Promise<IpcResult<GitBranchPayload>>
    createTag: (
      input: z.infer<typeof gitCreateTagInputSchema>
    ) => Promise<IpcResult<GitTagPayload>>
    deleteTag: (
      input: z.infer<typeof gitDeleteTagInputSchema>
    ) => Promise<IpcResult<GitTagPayload>>
    tags: (
      input: z.infer<typeof gitRemoteOpInputSchema>
    ) => Promise<IpcResult<GitTagsPayload>>
    checkoutRef: (
      input: z.infer<typeof gitCheckoutRefInputSchema>
    ) => Promise<IpcResult<GitCheckoutRefPayload>>
    fileAtRevision: (
      input: z.infer<typeof gitFileAtRevisionInputSchema>
    ) => Promise<IpcResult<GitFileAtRevisionPayload>>
    /** Reads stage 0 of one path from the index for a split working-tree diff. */
    indexFile: (
      input: z.infer<typeof gitIndexFileInputSchema>
    ) => Promise<IpcResult<GitIndexFilePayload>>
    /** Stages or unstages one hunk by applying its patch to the index. */
    applyPatch: (
      input: z.infer<typeof gitApplyPatchInputSchema>
    ) => Promise<IpcResult<GitApplyPatchPayload>>
    /** Reads the three index stages of a conflicted path. */
    conflictFile: (
      input: z.infer<typeof gitConflictFileInputSchema>
    ) => Promise<IpcResult<GitConflictFilePayload>>
    /** Adds a fully resolved worktree file to the index. */
    resolveConflict: (
      input: z.infer<typeof gitResolveConflictInputSchema>
    ) => Promise<IpcResult<GitResolveConflictPayload>>
    stashList: (
      input: z.infer<typeof gitRemoteOpInputSchema>
    ) => Promise<IpcResult<GitStashListPayload>>
    stashPush: (
      input: z.infer<typeof gitStashPushInputSchema>
    ) => Promise<IpcResult<GitStashPushPayload>>
    stashDiff: (
      input: z.infer<typeof gitStashTargetInputSchema>
    ) => Promise<IpcResult<GitStashDiffPayload>>
    stashAction: (
      input: z.infer<typeof gitStashActionInputSchema>
    ) => Promise<IpcResult<GitStashActionPayload>>
    worktreeList: (
      input: z.infer<typeof gitRemoteOpInputSchema>
    ) => Promise<IpcResult<GitWorktreeListPayload>>
    worktreeAction: (
      input: z.infer<typeof gitWorktreeActionInputSchema>
    ) => Promise<IpcResult<GitWorktreeActionPayload>>
    submoduleList: (
      input: z.infer<typeof gitRemoteOpInputSchema>
    ) => Promise<IpcResult<GitSubmoduleListPayload>>
    submoduleAction: (
      input: z.infer<typeof gitSubmoduleActionInputSchema>
    ) => Promise<IpcResult<GitSubmoduleActionPayload>>
    blame: (input: z.infer<typeof gitBlameInputSchema>) => Promise<IpcResult<GitBlamePayload>>
    renameBranch: (
      input: z.infer<typeof gitRenameBranchInputSchema>
    ) => Promise<IpcResult<GitRenameBranchPayload>>
    deleteBranch: (
      input: z.infer<typeof gitDeleteBranchInputSchema>
    ) => Promise<IpcResult<GitBranchPayload>>
    mergeBranch: (
      input: z.infer<typeof gitMergeBranchInputSchema>
    ) => Promise<IpcResult<GitBranchPayload>>
    rebaseBranch: (
      input: z.infer<typeof gitRebaseBranchInputSchema>
    ) => Promise<IpcResult<GitBranchPayload>>
    cherryPick: (
      input: z.infer<typeof gitCommitActionInputSchema>
    ) => Promise<IpcResult<GitCommitActionPayload>>
    revert: (
      input: z.infer<typeof gitCommitActionInputSchema>
    ) => Promise<IpcResult<GitCommitActionPayload>>
    reset: (input: z.infer<typeof gitResetInputSchema>) => Promise<IpcResult<GitResetPayload>>
    push: (input: z.infer<typeof gitRemoteOpInputSchema>) => Promise<IpcResult<GitBranchPayload>>
    pull: (input: z.infer<typeof gitPullInputSchema>) => Promise<IpcResult<GitBranchPayload>>
    publish: (input: z.infer<typeof gitRemoteOpInputSchema>) => Promise<IpcResult<GitBranchPayload>>
    fetch: (input: z.infer<typeof gitRemoteOpInputSchema>) => Promise<IpcResult<GitFetchPayload>>
    remotes: (
      input: z.infer<typeof gitRemoteOpInputSchema>
    ) => Promise<IpcResult<GitRemotesPayload>>
    fetchRemote: (
      input: z.infer<typeof gitFetchRemoteInputSchema>
    ) => Promise<IpcResult<GitFetchPayload>>
    addRemote: (
      input: z.infer<typeof gitAddRemoteInputSchema>
    ) => Promise<IpcResult<GitRemoteMutationPayload>>
    removeRemote: (
      input: z.infer<typeof gitRemoveRemoteInputSchema>
    ) => Promise<IpcResult<GitRemoteMutationPayload>>
    pushTags: (
      input: z.infer<typeof gitRemoteOpInputSchema>
    ) => Promise<IpcResult<GitPushTagsPayload>>
    forcePush: (input: z.infer<typeof gitRemoteOpInputSchema>) => Promise<IpcResult<GitBranchPayload>>
    remoteBranches: (
      input: z.infer<typeof gitRemoteOpInputSchema>
    ) => Promise<IpcResult<GitRemoteBranchesPayload>>
    setUpstream: (
      input: z.infer<typeof gitSetUpstreamInputSchema>
    ) => Promise<IpcResult<GitBranchPayload>>
    amend: (input: z.infer<typeof gitAmendInputSchema>) => Promise<IpcResult<GitCommitPayload>>
    history: (input: z.infer<typeof gitHistoryInputSchema>) => Promise<IpcResult<GitHistoryPayload>>
    /** Paginated History feed with parents and ref decorations. */
    log: (input: z.infer<typeof gitLogInputSchema>) => Promise<IpcResult<GitLogPayload>>
    /** One commit plus its first-parent file comparison. */
    commitDetail: (
      input: z.infer<typeof gitCommitDetailInputSchema>
    ) => Promise<IpcResult<GitCommitDetailPayload>>
    /** Unified patch for one file between two revisions. */
    revisionFileDiff: (
      input: z.infer<typeof gitRevisionFileDiffInputSchema>
    ) => Promise<IpcResult<GitRevisionFileDiffPayload>>
    compare: (input: z.infer<typeof gitRemoteOpInputSchema>) => Promise<IpcResult<GitComparePayload>>
  }
  harness: {
    /** `repoId` asks for that repository's execution target; omit for this machine. */
    list: (
      input?: z.infer<typeof harnessListInputSchema>
    ) => Promise<IpcResult<HarnessDetection[]>>
  }
  wsl: {
    /**
     * Registered distros for the repository dialog.
     *
     * `unavailable` is a normal answer on a machine without WSL, so it resolves
     * rather than rejecting; only a broken IPC call fails.
     */
    listDistros: () => Promise<IpcResult<WslDistroListPayload>>
  }
  terminal: {
    attach: (
      input: z.infer<typeof terminalAttachInputSchema>
    ) => Promise<IpcResult<TerminalAttachPayload>>
    write: (input: z.infer<typeof terminalWriteInputSchema>) => Promise<IpcResult<null>>
    resize: (input: z.infer<typeof terminalResizeInputSchema>) => Promise<IpcResult<null>>
  }
  tasks: {
      list: (input?: z.infer<typeof taskListInputSchema>) => Promise<IpcResult<TaskRecordPayload[]>>
      create: (input: z.infer<typeof taskCreateInputSchema>) => Promise<IpcResult<TaskRecordPayload>>
      cancel: (input: z.infer<typeof taskIdInputSchema>) => Promise<IpcResult<TaskRecordPayload>>
      retry: (input: z.infer<typeof taskIdInputSchema>) => Promise<IpcResult<TaskRecordPayload>>
      history: (input: z.infer<typeof taskIdInputSchema>) => Promise<IpcResult<TaskRecordPayload[]>>
      /** The changes belonging to this task's own session, from the review layer. */
      changes: (input: z.infer<typeof taskIdInputSchema>) => Promise<IpcResult<TaskChangesPayload>>
      decideReview: (
        input: z.infer<typeof taskDecideReviewInputSchema>
      ) => Promise<IpcResult<TaskRecordPayload>>
      settings: () => Promise<IpcResult<{ maxConcurrent: number }>>
      setSettings: (input: z.infer<typeof taskSettingsInputSchema>) => Promise<IpcResult<number>>
    }
    schedules: {
      list: (input?: z.infer<typeof scheduleListInputSchema>) => Promise<IpcResult<TaskSchedulePayload[]>>
      create: (input: z.infer<typeof scheduleCreateInputSchema>) => Promise<IpcResult<TaskSchedulePayload>>
      update: (input: z.infer<typeof scheduleUpdateInputSchema>) => Promise<IpcResult<TaskSchedulePayload>>
      setEnabled: (
        input: z.infer<typeof scheduleEnabledInputSchema>
      ) => Promise<IpcResult<TaskSchedulePayload>>
      runNow: (input: z.infer<typeof scheduleIdInputSchema>) => Promise<IpcResult<ScheduleFirePayload>>
      remove: (input: z.infer<typeof scheduleIdInputSchema>) => Promise<IpcResult<null>>
    }
  /** Custom title-bar controls for the frameless Electron window. */
  window: {
    minimize: () => Promise<IpcResult<null>>
    toggleMaximize: () => Promise<IpcResult<boolean>>
    close: () => Promise<IpcResult<null>>
    isMaximized: () => Promise<IpcResult<boolean>>
    onMaximizedChange: (listener: (maximized: boolean) => void) => () => void
  }
  onSessionEvent: (listener: (event: RendererSessionEvent) => void) => () => void
  /** Fires when the durable queue changed; the listener re-reads the list. */
  onTaskEvent: (listener: () => void) => () => void
  /** Fires after a repository row or its background preparation changed. */
  onRepoEvent: (listener: () => void) => () => void
  /** Native View-menu commands that toggle renderer-owned view state. */
  onViewCommand: (listener: (command: ViewCommand) => void) => () => void
}

export type ViewCommand = 'focus' | 'sessions'

/** A truthful "cannot answer" for any worktree-scoped tool. */
export type WorkspaceUnavailablePayload = {
  status: 'unavailable'
  reason: string
  detail: string
}
export type FilesListingPayload =
  | ({ status: 'ok' } & FileListing)
  | WorkspaceUnavailablePayload
export type FileContentPayload = ({ status: 'ok' } & FileContent) | WorkspaceUnavailablePayload
export type FileSearchPayload =
  | ({ status: 'ok' } & FileSearchResult)
  | WorkspaceUnavailablePayload
export type FilesMutatePayload =
  | { status: 'ok'; path?: string; kind?: 'file' | 'directory'; from?: string; to?: string }
  | WorkspaceUnavailablePayload
export type FilesWritePayload =
  | ({ status: 'ok'; size: number })
  | WorkspaceUnavailablePayload
export type GitOpPayload =
  | ({ status: 'ok'; staged?: number; unstaged?: number })
  | WorkspaceUnavailablePayload
export type GitCommitPayload =
  | ({ status: 'ok' } & GitCommitResult)
  | WorkspaceUnavailablePayload
export type AddRepositoryResultPayload = z.infer<typeof addRepositoryResultSchema>
export type ProjectFolderInspectionPayload = z.infer<typeof projectFolderInspectionSchema>
export type InitializeRepositoryResultPayload = z.infer<typeof initializeRepositoryResultSchema>
export type RepositoryFolderPickPayload = z.infer<typeof pickRepositoryFolderResultSchema>
export type TaskRecordPayload = z.infer<typeof taskRecordSchema>
export type TaskChangesPayload = z.infer<typeof taskChangesPayloadSchema>
export type TaskSchedulePayload = z.infer<typeof taskScheduleSchema>
export type ScheduleFirePayload = {
  result: 'created' | 'duplicate' | 'skipped' | 'paused' | 'not-due'
  taskId?: string
  occurrenceAt?: number
  trigger?: string
  note?: string
}
export type GitBranchesPayload =
  | { status: 'ok'; current: string | null; names: string[] }
  | WorkspaceUnavailablePayload
export type GitBranchPayload =
  | { status: 'ok'; branch: string; upstream?: string }
  | WorkspaceUnavailablePayload
export type GitTagPayload =
  | { status: 'ok'; name: string; oid?: string }
  | WorkspaceUnavailablePayload
export type GitRenameBranchPayload =
  | { status: 'ok'; branch: string; from: string }
  | WorkspaceUnavailablePayload
export type GitCommitActionPayload =
  | { status: 'ok'; oid: string; shortOid: string; subject: string }
  | WorkspaceUnavailablePayload
export type GitResetPayload =
  | { status: 'ok'; oid: string; branch: string | null }
  | WorkspaceUnavailablePayload
export type GitStatusPayload =
  | ({ status: 'ok'; snapshot: GitWorkspaceStatus })
  | WorkspaceUnavailablePayload
export type GitBatchPayload =
  | { status: 'ok'; result: GitBatchResult }
  | WorkspaceUnavailablePayload
export type GitRangeDiffPayload =
  | {
      status: 'ok'
      fromOid: string
      toOid: string
      files: GitRangeFile[]
      truncated: boolean
    }
  | WorkspaceUnavailablePayload
export type GitOperationStatePayload =
  | { status: 'ok'; operation: GitOperationKind | null; marker: string | null }
  | WorkspaceUnavailablePayload
export type GitOperationActionPayload =
  | { status: 'ok'; operation: GitOperationKind }
  | WorkspaceUnavailablePayload
export type GitCommitSummary = {
  oid: string
  subject: string
  author: string
  when: string
}
export type GitHistoryPayload =
  | { status: 'ok'; branch: string | null; commits: GitCommitSummary[] }
  | WorkspaceUnavailablePayload
export type GitLogPayload = ({ status: 'ok' } & GitLogPage) | WorkspaceUnavailablePayload
export type GitCommitDetailPayload =
  | ({ status: 'ok' } & GitCommitDetail)
  | WorkspaceUnavailablePayload
export type GitRevisionFileDiffPayload =
  | {
      status: 'ok'
      patch: string
      truncated: boolean
      binary: boolean
      additions: number | null
      deletions: number | null
      fromOid: string
      toOid: string
    }
  | WorkspaceUnavailablePayload
export type GitCompareFile = {
  path: string
  oldPath: string | null
  status: string
  additions: number | null
  deletions: number | null
  binary: boolean
}
export type GitComparePayload =
  | {
      status: 'ok'
      baseOid: string
      ahead: number
      behind: number
      files: GitCompareFile[]
      truncated: boolean
    }
  | WorkspaceUnavailablePayload
export type GitFetchPayload =
  | { status: 'ok'; remote: string }
  | WorkspaceUnavailablePayload
export type GitRemotesPayload =
  | { status: 'ok'; remotes: GitRemote[] }
  | WorkspaceUnavailablePayload
export type GitRemoteMutationPayload =
  | { status: 'ok'; name: string }
  | WorkspaceUnavailablePayload
export type GitTagsPayload =
  | { status: 'ok'; tags: GitTag[] }
  | WorkspaceUnavailablePayload
export type GitCheckoutRefPayload =
  | { status: 'ok'; ref: string; headOid: string }
  | WorkspaceUnavailablePayload
export type GitBlameLine = {
  line: number
  oid: string
  author: string
  authorTime: number
  summary: string
  committed: boolean
}
export type GitBlamePayload =
  | { status: 'ok'; lines: GitBlameLine[]; truncated: boolean }
  | WorkspaceUnavailablePayload
export type GitFileAtRevisionPayload =
  | {
      status: 'ok'
      rev: string
      oid: string
      text: string
      binary: boolean
      tooLarge: boolean
    }
  | WorkspaceUnavailablePayload
export type GitIndexFilePayload =
  | {
      status: 'ok'
      path: string
      text: string
      binary: boolean
      tooLarge: boolean
    }
  | WorkspaceUnavailablePayload
export type GitApplyPatchPayload =
  | { status: 'ok'; path: string; mode: 'stage' | 'unstage' | 'discard' }
  | WorkspaceUnavailablePayload
export type GitConflictSide = {
  oid: string
  text: string
  binary: boolean
  tooLarge: boolean
}
export type GitConflictFilePayload =
  | {
      status: 'ok'
      path: string
      base: GitConflictSide | null
      current: GitConflictSide
      incoming: GitConflictSide
    }
  | WorkspaceUnavailablePayload
export type GitResolveConflictPayload =
  | { status: 'ok'; path: string }
  | WorkspaceUnavailablePayload
export type GitStashEntry = {
  index: number
  ref: string
  subject: string
  date: string
  oid: string
}
export type GitStashListPayload =
  | { status: 'ok'; stashes: GitStashEntry[] }
  | WorkspaceUnavailablePayload
export type GitStashPushPayload =
  | { status: 'ok'; created: boolean }
  | WorkspaceUnavailablePayload
export type GitStashDiffPayload =
  | { status: 'ok'; ref: string; patch: string; truncated: boolean }
  | WorkspaceUnavailablePayload
export type GitStashActionPayload =
  | { status: 'ok'; ref: string; action: 'apply' | 'pop' | 'drop' }
  | WorkspaceUnavailablePayload
export type GitWorktreeInfo = {
  path: string
  head: string | null
  branch: string | null
  bare: boolean
  detached: boolean
  locked: string | null
  prunable: string | null
  sessionId: string | null
  active: boolean
  primary: boolean
}
export type GitWorktreeListPayload =
  | { status: 'ok'; worktrees: GitWorktreeInfo[] }
  | WorkspaceUnavailablePayload
export type GitWorktreeActionPayload =
  | { status: 'ok'; action: 'lock' | 'unlock' | 'prune' | 'remove'; path: string | null }
  | WorkspaceUnavailablePayload
export type GitSubmoduleInfo = {
  path: string
  oid: string
  state: 'clean' | 'uninitialized' | 'modified' | 'conflict'
  branch: string | null
}
export type GitSubmoduleListPayload =
  | { status: 'ok'; submodules: GitSubmoduleInfo[] }
  | WorkspaceUnavailablePayload
export type GitSubmoduleActionPayload =
  | { status: 'ok'; action: 'init' | 'update' | 'sync' | 'stage'; path: string | null }
  | WorkspaceUnavailablePayload
export type GitPushTagsPayload =
  | { status: 'ok'; remote: string }
  | WorkspaceUnavailablePayload
export type GitRemoteBranchesPayload =
  | { status: 'ok'; branches: string[] }
  | WorkspaceUnavailablePayload

export type { FileContent, FileListing, FileSearchResult, GitCommitResult, GitStatusEntry, GitWorkspaceStatus }

/** Implemented renderer surface: diagnostics plus the product API. */
export type AdeApi = {
  getRuntimeInfo: () => Promise<RuntimeInfo>
} & AdeProductApi
