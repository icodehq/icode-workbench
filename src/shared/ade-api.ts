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
  RendererSessionEvent
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
  harness: {
    list: (
      input?: z.infer<typeof harnessListInputSchema>
    ) => Promise<IpcResult<HarnessDetection[]>>
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

/** Implemented renderer surface: diagnostics plus the product API. */
export type AdeApi = {
  getRuntimeInfo: () => Promise<RuntimeInfo>
} & AdeProductApi
