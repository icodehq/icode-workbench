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
  currentBranchInputSchema,
  listBranchesInputSchema,
  listBranchRefsInputSchema,
  mergeSessionInputSchema,
  mergeStartInputSchema,
  removeBranchInputSchema,
  harnessListInputSchema,
  removeRepositoryInputSchema,
  removeSessionInputSchema,
  discardWorktreeInputSchema,
  discardWorktreeResultSchema,
  removeWorktreeInputSchema,
  removeWorktreeResultSchema,
  recoverWorktreeInputSchema,
  recoverWorktreeResultSchema,
  sessionTargetInputSchema,
  supervisorOpenInputSchema,
  windowOpenExternalInputSchema,
  terminalAttachInputSchema,
  terminalResizeInputSchema,
  terminalWriteInputSchema
} from './schemas/ipc'
import type { clearActivityUnreadInputSchema } from './schemas/activity'
import type {
  DiscardRepoRemovalSnapshotsResult,
  ListRepoRemovalJobsResult,
  RepoRemovalJobIdInput,
  RetryRepoRemovalJobResult
} from './schemas/repo-removal'
import type {
  CloneProgressEventPayload,
  cloneCancelInputSchema,
  clonePersistInputSchema,
  cloneSshGenerateInputSchema,
  cloneSshGenerateResultSchema,
  cloneSshStatusInputSchema,
  cloneSshStatusResultSchema,
  cloneSshTestInputSchema,
  cloneSshTestResultSchema,
  cloneSshTrustHostInputSchema,
  cloneSshTrustHostResultSchema,
  cloneStartInputSchema,
  RemoteSummaryPayload,
  remoteAddInputSchema,
  remoteFetchInputSchema,
  remoteListInputSchema,
  remoteRemoveInputSchema,
  remoteSetUrlInputSchema
} from './schemas/remotes'
import type {
  AssistantConversationPayload,
  AssistantMessagePayload,
  AssistantNewConversationResult,
  AssistantSendResult,
  AssistantSettingsPayload,
  AssistantStatePayload,
} from './schemas/assistant'
import type {
  botArchiveInputSchema,
  botSetPausedInputSchema,
  botCreateInputSchema,
  botUpdateInputSchema,
  botFocusInputSchema,
  botHomeInputSchema,
  botHomeResultSchema,
  botAutomationCreateInputSchema,
  botAutomationRemoveInputSchema,
  botAutomationUpdateInputSchema,
  botAutomationsInputSchema,
  BotAutomationPayload,
  botSkillDeleteInputSchema,
  botSkillReadInputSchema,
  botSkillSaveInputSchema,
  botSkillsInputSchema,
  BotSkillPayload,
  botMarkReadInputSchema,
  botMessagesInputSchema,
  botConversationsInputSchema,
  botNewConversationInputSchema,
  botNotificationsInputSchema,
  botSendInputSchema,
  botSetSettingsInputSchema,
  botSettingsInputSchema,
  botStateInputSchema,
  botStopInputSchema,
  BotEventPayload,
  BotRecordPayload,
  BotSummaryPayload
} from './schemas/bots'
import type {
  memoryAddInputSchema,
  memoryEditInputSchema,
  memoryForgetInputSchema,
  memoryReadInputSchema,
  memoryTidyUpInputSchema,
  memoryTopicInputSchema,
  memoryUndoInputSchema,
  MemoryReadResultPayload,
  MemoryTopicResultPayload
} from './schemas/memory'
import type {
  groupCreateInputSchema,
  groupArchiveInputSchema,
  groupDeleteInputSchema,
  groupMarkReadInputSchema,
  groupSetReadInputSchema,
  groupSetMutedInputSchema,
  groupMarkReadResultSchema,
  groupSetReadResultSchema,
  groupSetMutedResultSchema,
  groupMessagesInputSchema,
  groupMessagesResultSchema,
  groupSendInputSchema,
  groupSendResultSchema,
  groupStopInputSchema,
  groupStopResultSchema,
  groupThreadCreateInputSchema,
  groupThreadCreateResultSchema,
  groupUpdateInputSchema,
  GroupEventPayload,
  GroupSummaryPayload,
  GroupThreadPayload
} from './schemas/groups'
import type {
  itemsAskInputSchema,
  itemsAnswerInputSchema,
  itemsCommentInputSchema,
  itemsGetInputSchema,
  itemsGetResultSchema,
  itemsLinkAddInputSchema,
  itemsAttachInputSchema,
  itemsRemoveAttachmentInputSchema,
  itemsLinkRemoveInputSchema,
  itemsListInputSchema,
  itemsListResultSchema,
  itemsSnoozeInputSchema,
  itemsSetStatusInputSchema,
  ItemPayload,
  TaskAttachmentPayload,
  TaskCommentPayload,
  TaskLinkPayload
} from './schemas/items'
import type {
  PendingPermissionPayload,
  PermissionsListInput,
  PermissionsRespondInput
} from './schemas/permissions'
import type {
  NetworkProxySettingsPayload,
  networkSetSettingsInputSchema
} from './schemas/network'
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
  taskArchiveFinishedInputSchema,
  taskChangesPayloadSchema,
  taskCreateInputSchema,
  taskDecideReviewInputSchema,
  taskRequestChangesInputSchema,
  taskDependencyInputSchema,
  taskHoldDependentsInputSchema,
  taskIdInputSchema,
  taskListInputSchema,
  taskRecordSchema,
  taskRejectInputSchema,
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
  UpdateInstallInput,
  UpdateInstallOutcome,
  UpdateSetAutoCheckInput,
  UpdateSkipInput,
  UpdateState
} from './schemas/updates'
import type {
  BranchRefSummary,
  DiscardSessionResult,
  IpcResult,
  ListSessionsInput,
  OwnedBranchSummary,
  RemoveBranchResult,
  RemoveRepositoryResult,
  RemoveSessionResult,
  ActivitySummaryPayload,
  MergeOutcomePayload,
  MergeRecordPayload,
  RepositorySummary,
  SessionListView,
  SessionSummary,
  TerminalAttachPayload,
  RendererSessionEvent,
  WslDistroListPayload
} from './schemas/ipc'
import type { HarnessDetection } from './domain/harness'
import type {
  ProviderCreateInput,
  ProviderListPayload,
  ProviderSelectInput,
  ProviderTestInput,
  ProviderTestResult,
  ProviderUpdateInput,
  ProviderViewPayload
} from './schemas/provider'
import type { LocaleSetInput, LocaleState } from './schemas/locale'
import type {
  OpenCodeIntegrationSetEnabledInput,
  OpenCodeIntegrationStatePayload
} from './schemas/opencode-integration'
import type {
  ManagedHooksSetEnabledInput,
  ManagedHooksStatePayload
} from './schemas/managed-hooks'
import type { Locale } from './i18n/locales'
import type { SidebarOrderPayload } from './schemas/sidebar-order'

export type RuntimeInfo = {
  appVersion: string
  electron: string | null
  node: string
  platform: string
  packaged: boolean
  locale: Locale
  systemLocale: Locale
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
  pushTo:
    | { status: 'ok'; branch: string; remote: string; remoteBranch: string; upstream: string }
    | WorkspaceUnavailablePayload
  remotes: { status: 'ok'; remotes: string[] } | WorkspaceUnavailablePayload
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
  /** The absolute path of a file the user picked, when the platform exposes one. */
  pathForFile: (file: unknown) => string
  /**
   * Application language. `initial` is resolved by the main process and passed
   * to the renderer at window creation, so the first paint is already correct.
   */
  locale: {
    initial: Locale
    get: () => Promise<IpcResult<LocaleState>>
    set: (input: LocaleSetInput) => Promise<IpcResult<LocaleState>>
    onChanged: (listener: (state: LocaleState) => void) => () => void
  }
  sidebarOrder: {
    get: () => Promise<IpcResult<SidebarOrderPayload>>
    set: (input: SidebarOrderPayload) => Promise<IpcResult<SidebarOrderPayload>>
  }
  network: {
    settings: () => Promise<IpcResult<NetworkProxySettingsPayload>>
    setSettings: (
      input: z.infer<typeof networkSetSettingsInputSchema>
    ) => Promise<IpcResult<NetworkProxySettingsPayload>>
  }
  updates: {
    get: () => Promise<IpcResult<UpdateState>>
    check: () => Promise<IpcResult<UpdateState>>
    download: () => Promise<IpcResult<UpdateState>>
    cancelDownload: () => Promise<IpcResult<UpdateState>>
    install: (input: UpdateInstallInput) => Promise<IpcResult<UpdateInstallOutcome>>
    skip: (input: UpdateSkipInput) => Promise<IpcResult<UpdateState>>
    setAutoCheck: (input: UpdateSetAutoCheckInput) => Promise<IpcResult<UpdateState>>
    onChanged: (listener: (state: UpdateState) => void) => () => void
  }
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
    /** Active and attention-needing cleanup jobs, newest state first. */
    listRemovalJobs: () => Promise<IpcResult<ListRepoRemovalJobsResult>>
    retryRemoval: (input: RepoRemovalJobIdInput) => Promise<IpcResult<RetryRepoRemovalJobResult>>
    discardRemovalSnapshots: (
      input: RepoRemovalJobIdInput
    ) => Promise<IpcResult<DiscardRepoRemovalSnapshotsResult>>
    /** Push-only: reload the job list; the payload is never state. */
    onRemovalEvent: (listener: () => void) => () => void
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
    /**
     * Reopens a non-live session with its harness-native resume command.
     *
     * Restart starts a fresh process; Resume continues the captured
     * conversation and never guesses one.
     */
    resume: (input: z.infer<typeof sessionTargetInputSchema>) => Promise<IpcResult<SessionSummary>>
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
      input: z.infer<typeof recoverWorktreeInputSchema>
    ) => Promise<IpcResult<z.infer<typeof recoverWorktreeResultSchema>>>
  }
  /**
   * Checkout-level removal.
   *
   * A worktree may hold several sessions; removing it stops them, removes the
   * checkout, and deletes every attached session as one operation. Normal
   * removal fails closed on uncommitted or unmerged work; `discard` is the
   * explicit, name-confirmed escape hatch.
   */
  worktrees: {
    remove: (
      input: z.infer<typeof removeWorktreeInputSchema>
    ) => Promise<IpcResult<z.infer<typeof removeWorktreeResultSchema>>>
    discard: (
      input: z.infer<typeof discardWorktreeInputSchema>
    ) => Promise<IpcResult<z.infer<typeof discardWorktreeResultSchema>>>
  }
  branches: {
    list: (input: z.infer<typeof listBranchesInputSchema>) => Promise<IpcResult<OwnedBranchSummary[]>>
    refs: (
      input: z.infer<typeof listBranchRefsInputSchema>
    ) => Promise<IpcResult<BranchRefSummary[]>>
    /** The branch checked out in the repository's primary checkout. */
    current: (
      input: z.infer<typeof currentBranchInputSchema>
    ) => Promise<IpcResult<string | null>>
    remove: (input: z.infer<typeof removeBranchInputSchema>) => Promise<IpcResult<RemoveBranchResult>>
  }
  /**
   * Git remotes for one registered repository.
   *
   * Raw URLs never cross this boundary: `list` returns redacted display values,
   * and `setUrl` requires the new value to be typed again.
   */
  remotes: {
    list: (
      input: z.infer<typeof remoteListInputSchema>
    ) => Promise<IpcResult<RemoteSummaryPayload[]>>
    add: (
      input: z.infer<typeof remoteAddInputSchema>
    ) => Promise<IpcResult<{ status: 'ok'; name: string }>>
    setUrl: (
      input: z.infer<typeof remoteSetUrlInputSchema>
    ) => Promise<IpcResult<{ status: 'ok'; name: string }>>
    remove: (
      input: z.infer<typeof remoteRemoveInputSchema>
    ) => Promise<IpcResult<{ status: 'ok'; name: string }>>
    fetch: (
      input: z.infer<typeof remoteFetchInputSchema>
    ) => Promise<IpcResult<{ status: 'ok'; name: string }>>
  }
  /**
   * Clone a remote into a new project folder.
   *
   * `start` validates and returns immediately; progress arrives on
   * `onProgress` and is correlated by `requestId`.
   */
  clone: {
    start: (
      input: z.infer<typeof cloneStartInputSchema>
    ) => Promise<IpcResult<{ requestId: string }>>
    cancel: (
      input: z.infer<typeof cloneCancelInputSchema>
    ) => Promise<IpcResult<{ cancelled: boolean }>>
    persist: (
      input: z.infer<typeof clonePersistInputSchema>
    ) => Promise<IpcResult<{ status: 'stored' | 'switched' | 'skipped' }>>
    sshStatus: (
      input: z.infer<typeof cloneSshStatusInputSchema>
    ) => Promise<IpcResult<z.infer<typeof cloneSshStatusResultSchema>>>
    sshGenerate: (
      input: z.infer<typeof cloneSshGenerateInputSchema>
    ) => Promise<IpcResult<z.infer<typeof cloneSshGenerateResultSchema>>>
    sshTest: (
      input: z.infer<typeof cloneSshTestInputSchema>
    ) => Promise<IpcResult<z.infer<typeof cloneSshTestResultSchema>>>
    sshTrustHost: (
      input: z.infer<typeof cloneSshTrustHostInputSchema>
    ) => Promise<IpcResult<z.infer<typeof cloneSshTrustHostResultSchema>>>
    onProgress: (listener: (event: CloneProgressEventPayload) => void) => () => void
  }
  merge: {
    start: (
      input: z.infer<typeof mergeStartInputSchema>
    ) => Promise<IpcResult<MergeOutcomePayload>>
    continueMerge: (
      input: z.infer<typeof mergeSessionInputSchema>
    ) => Promise<IpcResult<MergeOutcomePayload>>
    abort: (
      input: z.infer<typeof mergeSessionInputSchema>
    ) => Promise<IpcResult<MergeRecordPayload>>
    state: (
      input: z.infer<typeof mergeSessionInputSchema>
    ) => Promise<IpcResult<MergeRecordPayload | null>>
  }
  activity: {
    /** Snapshot of per-session activity for the sessions this window knows. */
    list: () => Promise<IpcResult<Array<{ sessionId: string; activity: ActivitySummaryPayload }>>>
    clearUnread: (
      input: z.infer<typeof clearActivityUnreadInputSchema>
    ) => Promise<IpcResult<boolean>>
  }
  /**
   * Managed OpenCode status plugin. The setting is default-on and the state
   * reports the exact files/config dir the install touched.
   */
  opencodeIntegration: {
    get: () => Promise<IpcResult<OpenCodeIntegrationStatePayload>>
    setEnabled: (
      input: OpenCodeIntegrationSetEnabledInput
    ) => Promise<IpcResult<OpenCodeIntegrationStatePayload>>
    onChanged: (listener: (state: OpenCodeIntegrationStatePayload) => void) => () => void
  }
  /**
   * Managed status hooks for Gemini, Qwen Code, Cursor and Copilot. The setting
   * is default-on; only marker-owned hook entries are installed or removed.
   */
  managedHooks: {
    get: () => Promise<IpcResult<ManagedHooksStatePayload>>
    setEnabled: (
      input: ManagedHooksSetEnabledInput
    ) => Promise<IpcResult<ManagedHooksStatePayload>>
    onChanged: (listener: (state: ManagedHooksStatePayload) => void) => () => void
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
  /**
   * Machine-level provider configurations.
   *
   * Selecting a provider applies to the *next* launch of that harness; a
   * running session keeps the configuration it started with.
   */
  providers: {
    list: () => Promise<IpcResult<ProviderListPayload>>
    create: (input: ProviderCreateInput) => Promise<IpcResult<ProviderViewPayload>>
    update: (input: ProviderUpdateInput) => Promise<IpcResult<ProviderViewPayload>>
    remove: (input: { providerId: string }) => Promise<IpcResult<null>>
    select: (input: ProviderSelectInput) => Promise<IpcResult<null>>
    /** Sends one tiny request; the stored key never crosses into the renderer. */
    test: (input: ProviderTestInput) => Promise<IpcResult<ProviderTestResult>>
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
    preview: (
      input: z.infer<typeof terminalAttachInputSchema>
    ) => Promise<IpcResult<TerminalAttachPayload>>
    write: (input: z.infer<typeof terminalWriteInputSchema>) => Promise<IpcResult<null>>
    resize: (input: z.infer<typeof terminalResizeInputSchema>) => Promise<IpcResult<null>>
  }
  tasks: {
      list: (input?: z.infer<typeof taskListInputSchema>) => Promise<IpcResult<TaskRecordPayload[]>>
      create: (input: z.infer<typeof taskCreateInputSchema>) => Promise<IpcResult<TaskRecordPayload>>
      approve: (input: z.infer<typeof taskIdInputSchema>) => Promise<IpcResult<TaskRecordPayload>>
      reject: (input: z.infer<typeof taskRejectInputSchema>) => Promise<IpcResult<TaskRecordPayload>>
      cancel: (input: z.infer<typeof taskIdInputSchema>) => Promise<IpcResult<TaskRecordPayload>>
      retry: (input: z.infer<typeof taskIdInputSchema>) => Promise<IpcResult<TaskRecordPayload>>
      resume: (input: z.infer<typeof taskIdInputSchema>) => Promise<IpcResult<TaskRecordPayload>>
      history: (input: z.infer<typeof taskIdInputSchema>) => Promise<IpcResult<TaskRecordPayload[]>>
      /** The changes belonging to this task's own session, from the Git engine. */
      changes: (input: z.infer<typeof taskIdInputSchema>) => Promise<IpcResult<TaskChangesPayload>>
      decideReview: (
        input: z.infer<typeof taskDecideReviewInputSchema>
      ) => Promise<IpcResult<TaskRecordPayload>>
      /** Sends a finished result back for changes; creates a successor attempt. */
      requestChanges: (
        input: z.infer<typeof taskRequestChangesInputSchema>
      ) => Promise<IpcResult<TaskRecordPayload>>
      archive: (input: z.infer<typeof taskIdInputSchema>) => Promise<IpcResult<TaskRecordPayload>>
      unarchive: (input: z.infer<typeof taskIdInputSchema>) => Promise<IpcResult<TaskRecordPayload>>
      archiveFinished: (
        input: z.infer<typeof taskArchiveFinishedInputSchema>
      ) => Promise<IpcResult<number>>
      addDependency: (
        input: z.infer<typeof taskDependencyInputSchema>
      ) => Promise<IpcResult<TaskRecordPayload>>
      removeDependency: (
        input: z.infer<typeof taskDependencyInputSchema>
      ) => Promise<IpcResult<TaskRecordPayload>>
      setHoldDependents: (
        input: z.infer<typeof taskHoldDependentsInputSchema>
      ) => Promise<IpcResult<TaskRecordPayload>>
      settings: () => Promise<IpcResult<TaskSettingsPayload>>
      setSettings: (
        input: z.infer<typeof taskSettingsInputSchema>
      ) => Promise<IpcResult<TaskSettingsPayload>>
    }
    /** One project-scoped control session; opening creates it on first use. */
    supervisor: {
      open: (
        input: z.infer<typeof supervisorOpenInputSchema>
      ) => Promise<IpcResult<SessionSummary>>
    }
    /** Persistent bots: identities, their chat, settings and scoped memory. */
    bots: {
      list: () => Promise<IpcResult<BotSummaryPayload[]>>
      create: (input: z.infer<typeof botCreateInputSchema>) => Promise<IpcResult<BotRecordPayload>>
      update: (input: z.infer<typeof botUpdateInputSchema>) => Promise<IpcResult<BotRecordPayload>>
      archive: (input: z.infer<typeof botArchiveInputSchema>) => Promise<IpcResult<boolean>>
      setPaused: (
        input: z.infer<typeof botSetPausedInputSchema>
      ) => Promise<IpcResult<BotRecordPayload>>
      state: (input: z.infer<typeof botStateInputSchema>) => Promise<IpcResult<AssistantStatePayload>>
      messages: (
        input: z.infer<typeof botMessagesInputSchema>
      ) => Promise<IpcResult<AssistantMessagePayload[]>>
      conversations: (
        input: z.infer<typeof botConversationsInputSchema>
      ) => Promise<IpcResult<AssistantConversationPayload[]>>
      notifications: (
        input: z.infer<typeof botNotificationsInputSchema>
      ) => Promise<IpcResult<AssistantMessagePayload[]>>
      send: (input: z.infer<typeof botSendInputSchema>) => Promise<IpcResult<AssistantSendResult>>
      markRead: (input: z.infer<typeof botMarkReadInputSchema>) => Promise<IpcResult<number>>
      stop: (input: z.infer<typeof botStopInputSchema>) => Promise<IpcResult<null>>
      newConversation: (
        input: z.infer<typeof botNewConversationInputSchema>
      ) => Promise<IpcResult<AssistantNewConversationResult>>
      focus: (input: z.infer<typeof botFocusInputSchema>) => Promise<IpcResult<null>>
      home: (
        input: z.infer<typeof botHomeInputSchema>
      ) => Promise<IpcResult<z.infer<typeof botHomeResultSchema>>>
      automations: {
        list: (
          input: z.infer<typeof botAutomationsInputSchema>
        ) => Promise<IpcResult<BotAutomationPayload[]>>
        create: (
          input: z.infer<typeof botAutomationCreateInputSchema>
        ) => Promise<IpcResult<BotAutomationPayload>>
        update: (
          input: z.infer<typeof botAutomationUpdateInputSchema>
        ) => Promise<IpcResult<BotAutomationPayload | null>>
        remove: (
          input: z.infer<typeof botAutomationRemoveInputSchema>
        ) => Promise<IpcResult<boolean>>
      }
      skills: {
        list: (
          input: z.infer<typeof botSkillsInputSchema>
        ) => Promise<IpcResult<BotSkillPayload[]>>
        read: (
          input: z.infer<typeof botSkillReadInputSchema>
        ) => Promise<IpcResult<string | null>>
        save: (
          input: z.infer<typeof botSkillSaveInputSchema>
        ) => Promise<IpcResult<BotSkillPayload>>
        remove: (
          input: z.infer<typeof botSkillDeleteInputSchema>
        ) => Promise<IpcResult<boolean>>
      }
      settings: (
        input: z.infer<typeof botSettingsInputSchema>
      ) => Promise<IpcResult<AssistantSettingsPayload>>
      setSettings: (
        input: z.infer<typeof botSetSettingsInputSchema>
      ) => Promise<IpcResult<AssistantSettingsPayload>>
      memory: {
        read: (
          input: z.infer<typeof memoryReadInputSchema>
        ) => Promise<IpcResult<MemoryReadResultPayload>>
        add: (
          input: z.infer<typeof memoryAddInputSchema>
        ) => Promise<IpcResult<MemoryReadResultPayload>>
        edit: (
          input: z.infer<typeof memoryEditInputSchema>
        ) => Promise<IpcResult<MemoryReadResultPayload>>
        forget: (
          input: z.infer<typeof memoryForgetInputSchema>
        ) => Promise<IpcResult<MemoryReadResultPayload>>
        undo: (
          input: z.infer<typeof memoryUndoInputSchema>
        ) => Promise<IpcResult<MemoryReadResultPayload>>
        topic: (
          input: z.infer<typeof memoryTopicInputSchema>
        ) => Promise<IpcResult<MemoryTopicResultPayload>>
        tidyUp: (
          input: z.infer<typeof memoryTidyUpInputSchema>
        ) => Promise<IpcResult<MemoryReadResultPayload>>
      }
      onEvent: (listener: (event: BotEventPayload) => void) => () => void
    }
    groups: {
      list: () => Promise<IpcResult<GroupSummaryPayload[]>>
      create: (
        input: z.infer<typeof groupCreateInputSchema>
      ) => Promise<IpcResult<GroupSummaryPayload>>
      update: (
        input: z.infer<typeof groupUpdateInputSchema>
      ) => Promise<IpcResult<GroupSummaryPayload>>
      archive: (
        input: z.infer<typeof groupArchiveInputSchema>
      ) => Promise<IpcResult<GroupSummaryPayload>>
      remove: (input: z.infer<typeof groupDeleteInputSchema>) => Promise<IpcResult<boolean>>
      threads: (
        input: z.infer<typeof groupThreadCreateInputSchema>
      ) => Promise<IpcResult<GroupThreadPayload[]>>
      threadCreate: (
        input: z.infer<typeof groupThreadCreateInputSchema>
      ) => Promise<IpcResult<z.infer<typeof groupThreadCreateResultSchema>>>
      messages: (
        input: z.infer<typeof groupMessagesInputSchema>
      ) => Promise<IpcResult<z.infer<typeof groupMessagesResultSchema>>>
      send: (
        input: z.infer<typeof groupSendInputSchema>
      ) => Promise<IpcResult<z.infer<typeof groupSendResultSchema>>>
      markRead: (
        input: z.infer<typeof groupMarkReadInputSchema>
      ) => Promise<IpcResult<z.infer<typeof groupMarkReadResultSchema>>>
      setRead: (
        input: z.infer<typeof groupSetReadInputSchema>
      ) => Promise<IpcResult<z.infer<typeof groupSetReadResultSchema>>>
      setMuted: (
        input: z.infer<typeof groupSetMutedInputSchema>
      ) => Promise<IpcResult<z.infer<typeof groupSetMutedResultSchema>>>
      stop: (
        input: z.infer<typeof groupStopInputSchema>
      ) => Promise<IpcResult<z.infer<typeof groupStopResultSchema>>>
      onEvent: (listener: (event: GroupEventPayload) => void) => () => void
    }
    items: {
      list: (
        input?: z.infer<typeof itemsListInputSchema>
      ) => Promise<IpcResult<z.infer<typeof itemsListResultSchema>>>
      get: (
        input: z.infer<typeof itemsGetInputSchema>
      ) => Promise<IpcResult<z.infer<typeof itemsGetResultSchema>>>
      comment: (
        input: z.infer<typeof itemsCommentInputSchema>
      ) => Promise<IpcResult<TaskCommentPayload>>
      ask: (input: z.infer<typeof itemsAskInputSchema>) => Promise<IpcResult<TaskCommentPayload>>
      answer: (
        input: z.infer<typeof itemsAnswerInputSchema>
      ) => Promise<IpcResult<{ question: TaskCommentPayload; answer: TaskCommentPayload }>>
      snooze: (
        input: z.infer<typeof itemsSnoozeInputSchema>
      ) => Promise<IpcResult<{ item: ItemPayload | null }>>
      setStatus: (
        input: z.infer<typeof itemsSetStatusInputSchema>
      ) => Promise<IpcResult<{ item: ItemPayload }>>
      linkAdd: (
        input: z.infer<typeof itemsLinkAddInputSchema>
      ) => Promise<IpcResult<TaskLinkPayload>>
      linkRemove: (input: z.infer<typeof itemsLinkRemoveInputSchema>) => Promise<IpcResult<boolean>>
      attach: (
        input: z.infer<typeof itemsAttachInputSchema>
      ) => Promise<IpcResult<TaskAttachmentPayload>>
      removeAttachment: (
        input: z.infer<typeof itemsRemoveAttachmentInputSchema>
      ) => Promise<IpcResult<boolean>>
    }
    permissions: {
      list: (
        input?: PermissionsListInput
      ) => Promise<IpcResult<PendingPermissionPayload[]>>
      respond: (input: PermissionsRespondInput) => Promise<IpcResult<boolean>>
      onEvent: (listener: () => void) => () => void
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
    openExternal: (
      input: z.infer<typeof windowOpenExternalInputSchema>
    ) => Promise<IpcResult<null>>
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
export type TaskSettingsPayload = {
  maxConcurrent: number
  maxConcurrentPerProject: number
}
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
