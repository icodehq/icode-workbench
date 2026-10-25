import type { z } from 'zod'
import type {
  addRepositoryInputSchema,
  createSessionInputSchema,
  discardSessionInputSchema,
  listBranchesInputSchema,
  removeBranchInputSchema,
  harnessListInputSchema,
  removeRepositoryInputSchema,
  sessionTargetInputSchema,
  terminalAttachInputSchema,
  terminalResizeInputSchema,
  terminalWriteInputSchema
} from './schemas/ipc'
import type { clearActivityUnreadInputSchema } from './schemas/activity'
import type {
  reviewDiffInputSchema,
  reviewListInputSchema,
  ReviewDiffResult,
  ReviewListResult
} from './schemas/review'
import type {
  filesListInputSchema,
  filesReadInputSchema,
  filesSearchInputSchema,
  filesWriteInputSchema,
  gitCommitInputSchema,
  gitDiscardPathInputSchema,
  gitStageAllInputSchema,
  gitStatusInputSchema,
  gitUnstageAllInputSchema
} from './schemas/workspace'
import type { FileContent, FileListing, FileSearchResult } from './domain/workspace-files'
import type { GitCommitResult, GitStatusEntry, GitWorkspaceStatus } from './domain/git-workspace'
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
    ) => Promise<IpcResult<RepositorySummary>>
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
    /** Removes metadata and a clean worktree; retains the branch. */
    remove: (input: z.infer<typeof sessionTargetInputSchema>) => Promise<IpcResult<RemoveSessionResult>>
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
    list: (
      input: z.infer<typeof reviewListInputSchema>
    ) => Promise<IpcResult<ReviewListResult>>
    diff: (
      input: z.infer<typeof reviewDiffInputSchema>
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
  }
  /** Worktree-scoped Git state and the common change operations. */
  git: {
    status: (input: z.infer<typeof gitStatusInputSchema>) => Promise<IpcResult<GitStatusPayload>>
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
  onSessionEvent: (listener: (event: RendererSessionEvent) => void) => () => void
}

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
export type FilesWritePayload =
  | ({ status: 'ok'; size: number })
  | WorkspaceUnavailablePayload
export type GitOpPayload =
  | ({ status: 'ok'; staged?: number; unstaged?: number })
  | WorkspaceUnavailablePayload
export type GitCommitPayload =
  | ({ status: 'ok' } & GitCommitResult)
  | WorkspaceUnavailablePayload
export type GitStatusPayload =
  | ({ status: 'ok'; snapshot: GitWorkspaceStatus })
  | WorkspaceUnavailablePayload

export type { FileContent, FileListing, FileSearchResult, GitCommitResult, GitStatusEntry, GitWorkspaceStatus }

/** Implemented renderer surface: diagnostics plus the product API. */
export type AdeApi = {
  getRuntimeInfo: () => Promise<RuntimeInfo>
} & AdeProductApi
