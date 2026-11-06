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
  aiCancelCommitMessageInputSchema,
  aiCommitMessageInputSchema,
  AiCancelCommitMessageResult,
  AiCommitMessageResult
} from './schemas/ai'
import type { GitCommandInput, GitCommandName } from './ipc/git-commands'
import type { ChangeListResult, FileDiffResult } from './schemas/changes'
import type {
  filesCreateInputSchema,
  filesCancelSearchInputSchema,
  filesCopyManyInputSchema,
  filesCopyPathsInputSchema,
  filesReplaceInputSchema,
  filesListInputSchema,
  filesMoveManyInputSchema,
  filesReadInputSchema,
  filesRemoveInputSchema,
  filesRemoveManyInputSchema,
  filesRenameInputSchema,
  filesSearchInputSchema,
  filesStatInputSchema,
  filesTrashInputSchema,
  filesRestoreTrashInputSchema,
  filesListTrashInputSchema,
  filesWatchInputSchema,
  filesWriteInputSchema,
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
  taskSettingsInputSchema
} from './schemas/workspace'
import type {
  FileBatchResult,
  FileContent,
  FileListing,
  FileReplaceResult,
  FileSearchResult,
  FileStat,
  FileTrashOperation,
  FileTrashResult,
  FilesChangedEvent,
  FilesWatchOutcome
} from './domain/workspace-files'
import type {
  GitBatchResult,
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
 * The result payload of every Git command, keyed by the shared command name.
 * The renderer API is a mapped type over this map and `GIT_COMMAND_INPUTS`, so
 * adding a command does not require editing another interface.
 */
export type GitCommandResultMap = {
  status: GitStatusPayload
  checkIgnore: GitCheckIgnorePayload
  changeDiff: FileDiffResult
  sessionChanges: ChangeListResult
  operationState: GitOperationStatePayload
  continueOperation: GitOperationActionPayload
  abortOperation: GitOperationActionPayload
  rangeDiff: GitRangeDiffPayload
  watchStatus: { watching: boolean; reason?: GitWatchUnavailableReason }
  commit: GitCommitPayload
  setPathStaged: GitOpPayload
  setPathsStaged: GitBatchPayload
  discardPaths: GitBatchPayload
  fileAtRevision: GitFileAtRevisionPayload
  indexFile: GitIndexFilePayload
  applyPatch: GitApplyPatchPayload
  conflictFile: GitConflictFilePayload
  resolveConflict: GitResolveConflictPayload
  blame: GitBlamePayload
  cherryPick: GitCommitActionPayload
  revert: GitCommitActionPayload
  reset: GitResetPayload
  push: GitBranchPayload
  pull: GitBranchPayload
  publish: GitBranchPayload
  amend: GitCommitPayload
  log: GitLogPayload
  commitDetail: GitCommitDetailPayload
  revisionFileDiff: GitRevisionFileDiffPayload
}

/** One call per Git command, with inputs and results derived from the registry. */
export type GitApi = {
  [K in GitCommandName]: (
    input: GitCommandInput<K>
  ) => Promise<IpcResult<GitCommandResultMap[K]>>
} & {
  /** Coalesced worktree revisions; the listener re-reads status and diffs. */
  onStatusChange: (listener: (event: GitStatusWatchEvent) => void) => () => void
}

/**
 * Contract for the repository/session/terminal surface, implemented by preload.
 * The renderer never sees IPC channel names or a raw ipcRenderer, and cannot
 * supply commands, cwd, or host protocol messages.
 */
export type IcodeProductApi = {
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
  activity: {
    /** Snapshot of per-session activity for the sessions this window knows. */
    list: () => Promise<IpcResult<Array<{ sessionId: string; activity: ActivitySummaryPayload }>>>
    clearUnread: (
      input: z.infer<typeof clearActivityUnreadInputSchema>
    ) => Promise<IpcResult<boolean>>
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
    /** Stops the current search; a newer search also cancels the old one. */
    cancelSearch: (
      input: z.infer<typeof filesCancelSearchInputSchema>
    ) => Promise<IpcResult<{ cancelled: boolean }>>
    replace: (
      input: z.infer<typeof filesReplaceInputSchema>
    ) => Promise<IpcResult<FilesReplacePayload>>
    create: (
      input: z.infer<typeof filesCreateInputSchema>
    ) => Promise<IpcResult<FilesMutatePayload>>
    rename: (
      input: z.infer<typeof filesRenameInputSchema>
    ) => Promise<IpcResult<FilesMutatePayload>>
    remove: (
      input: z.infer<typeof filesRemoveInputSchema>
    ) => Promise<IpcResult<FilesMutatePayload>>
    removeMany: (
      input: z.infer<typeof filesRemoveManyInputSchema>
    ) => Promise<IpcResult<FilesBatchPayload>>
    /** Move paths to the app-managed session trash; returns the restore batch. */
    trashMany: (
      input: z.infer<typeof filesTrashInputSchema>
    ) => Promise<IpcResult<FilesTrashPayload>>
    restoreTrash: (
      input: z.infer<typeof filesRestoreTrashInputSchema>
    ) => Promise<IpcResult<FilesRestoreTrashPayload>>
    listTrash: (
      input: z.infer<typeof filesListTrashInputSchema>
    ) => Promise<IpcResult<FilesTrashListPayload>>
    moveMany: (
      input: z.infer<typeof filesMoveManyInputSchema>
    ) => Promise<IpcResult<FilesBatchPayload>>
    copyMany: (
      input: z.infer<typeof filesCopyManyInputSchema>
    ) => Promise<IpcResult<FilesBatchPayload>>
    /** Main writes the resulting paths to the system clipboard. */
    copyPaths: (
      input: z.infer<typeof filesCopyPathsInputSchema>
    ) => Promise<IpcResult<FilesCopyPathsPayload>>
    stat: (input: z.infer<typeof filesStatInputSchema>) => Promise<IpcResult<FilesStatPayload>>
    /** Starts or stops the live worktree watcher; poll when `watching` is false. */
    watch: (
      input: z.infer<typeof filesWatchInputSchema>
    ) => Promise<IpcResult<FilesWatchOutcome>>
    onChanged: (listener: (event: FilesChangedEvent) => void) => () => void
  }
  /** Worktree-scoped Git state and the common change operations. */
  git: GitApi
  harness: {
    /** `repoId` asks for that repository's execution target; omit for this machine. */
    list: (
      input?: z.infer<typeof harnessListInputSchema>
    ) => Promise<IpcResult<HarnessDetection[]>>
  }
  ai: {
    /** Drafts a commit message from the staged diff with the session's agent. */
    commitMessage: (
      input: z.infer<typeof aiCommitMessageInputSchema>
    ) => Promise<IpcResult<AiCommitMessageResult>>
    /** Stops one in-flight generation. */
    cancelCommitMessage: (
      input: z.infer<typeof aiCancelCommitMessageInputSchema>
    ) => Promise<IpcResult<AiCancelCommitMessageResult>>
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
      /** The changes belonging to this task's own session, from the Git engine. */
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
    /** Main asks before closing; answer with `respondClose`. */
    onBeforeClose: (listener: () => void) => () => void
    /**
     * `ack` says the renderer received the request and is showing a prompt;
     * `close`/`cancel` resolve it.
     */
    respondClose: (action: 'ack' | 'close' | 'cancel') => Promise<IpcResult<null>>
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
  /** Present when a write lost the optimistic-concurrency check. */
  currentEtag?: string
}
export type FilesListingPayload =
  | ({ status: 'ok' } & FileListing)
  | WorkspaceUnavailablePayload
export type FileContentPayload = ({ status: 'ok' } & FileContent) | WorkspaceUnavailablePayload
export type FileSearchPayload =
  | ({ status: 'ok' } & FileSearchResult)
  | WorkspaceUnavailablePayload
export type FilesReplacePayload =
  | ({ status: 'ok' } & FileReplaceResult)
  | WorkspaceUnavailablePayload
export type FilesMutatePayload =
  | {
      status: 'ok'
      path?: string
      kind?: 'file' | 'directory'
      from?: string
      to?: string
      /** Present when a file was created, so it opens with a valid version. */
      etag?: string | null
    }
  | WorkspaceUnavailablePayload
export type FilesWritePayload =
  | ({ status: 'ok'; size: number; etag: string })
  | WorkspaceUnavailablePayload
export type FilesStatPayload =
  | ({ status: 'ok' } & FileStat)
  | WorkspaceUnavailablePayload
export type FilesBatchPayload =
  | ({ status: 'ok' } & FileBatchResult)
  | WorkspaceUnavailablePayload
export type FilesTrashPayload =
  | ({ status: 'ok' } & FileTrashResult)
  | WorkspaceUnavailablePayload
export type FilesRestoreTrashPayload =
  | ({ status: 'ok' } & FileBatchResult)
  | WorkspaceUnavailablePayload
export type FilesTrashListPayload =
  | { status: 'ok'; items: FileTrashOperation[] }
  | WorkspaceUnavailablePayload
export type FilesCopyPathsPayload =
  | { status: 'ok'; count: number }
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
export type GitBranchPayload =
  | { status: 'ok'; branch: string; upstream?: string }
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
export type GitCheckIgnorePayload =
  | { status: 'ok'; ignored: string[] }
  | WorkspaceUnavailablePayload
export type GitBatchPayload =
  | { status: 'ok'; result: GitBatchResult }
  | WorkspaceUnavailablePayload
export type GitRangeDiffPayload =
  | {
      status: 'ok'
      fromOid: string
      toOid: string
      commitCount: number
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

export type { FileContent, FileListing, FileSearchResult, GitCommitResult, GitStatusEntry, GitWorkspaceStatus }

/** Implemented renderer surface: diagnostics plus the product API. */
export type IcodeApi = {
  getRuntimeInfo: () => Promise<RuntimeInfo>
} & IcodeProductApi
