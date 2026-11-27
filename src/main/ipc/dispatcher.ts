import type { z } from 'zod'
import { appErrorSchema } from '../../shared/schemas/domain'
import {
  IPC_CHANNELS,
  addRepositoryInputSchema,
  inspectRepositoryInputSchema,
  initializeRepositoryInputSchema,
  retryRepositoryPreparationInputSchema,
  pickRepositoryFolderInputSchema,
  createSessionInputSchema,
  harnessListInputSchema,
  discardSessionInputSchema,
  currentBranchInputSchema,
  listBranchesInputSchema,
  listBranchRefsInputSchema,
  listSessionsInputSchema,
  mergeSessionInputSchema,
  mergeStartInputSchema,
  removeBranchInputSchema,
  removeRepositoryInputSchema,
  removeSessionInputSchema,
  discardWorktreeInputSchema,
  removeWorktreeInputSchema,
  recoverWorktreeInputSchema,
  sessionTargetInputSchema,
  supervisorOpenInputSchema,
  terminalAttachInputSchema,
  terminalResizeInputSchema,
  terminalWriteInputSchema
} from '../../shared/schemas/ipc'
import { repoRemovalJobIdInputSchema } from '../../shared/schemas/repo-removal'
import {
  filesListInputSchema,
  filesReadInputSchema,
  filesCreateInputSchema,
  filesCancelSearchInputSchema,
  filesCopyManyInputSchema,
  filesCopyPathsInputSchema,
  filesMoveManyInputSchema,
  filesRemoveInputSchema,
  filesRemoveManyInputSchema,
  filesRenameInputSchema,
  filesReplaceInputSchema,
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
  taskCreateInputSchema,
  taskArchiveFinishedInputSchema,
  taskDecideReviewInputSchema,
  taskRequestChangesInputSchema,
  taskDependencyInputSchema,
  taskHoldDependentsInputSchema,
  taskIdInputSchema,
  taskListInputSchema,
  taskRejectInputSchema,
  taskSettingsInputSchema
} from '../../shared/schemas/workspace'
import { clearActivityUnreadInputSchema } from '../../shared/schemas/activity'
import { openCodeIntegrationSetEnabledInputSchema } from '../../shared/schemas/opencode-integration'
import { managedHooksSetEnabledInputSchema } from '../../shared/schemas/managed-hooks'
import {
  cloneCancelInputSchema,
  clonePersistInputSchema,
  cloneSshGenerateInputSchema,
  cloneSshStatusInputSchema,
  cloneSshTestInputSchema,
  cloneSshTrustHostInputSchema,
  cloneStartInputSchema,
  remoteAddInputSchema,
  remoteFetchInputSchema,
  remoteListInputSchema,
  remoteRemoveInputSchema,
  remoteSetUrlInputSchema
} from '../../shared/schemas/remotes'
import {
  aiCancelCommitMessageInputSchema,
  aiCommitMessageInputSchema
} from '../../shared/schemas/ai'
import {
  botArchiveInputSchema,
  botSetPausedInputSchema,
  botConversationsInputSchema,
  botFocusInputSchema,
  botAutomationCreateInputSchema,
  botAutomationRemoveInputSchema,
  botAutomationUpdateInputSchema,
  botAutomationsInputSchema,
  botHomeInputSchema,
  botSkillDeleteInputSchema,
  botSkillReadInputSchema,
  botSkillSaveInputSchema,
  botSkillsInputSchema,
  botMarkReadInputSchema,
  botMessagesInputSchema,
  botNewConversationInputSchema,
  botNotificationsInputSchema,
  botSendInputSchema,
  botSettingsInputSchema,
  botSetSettingsInputSchema,
  botChatCreateInputSchema,
  botHistorySearchInputSchema,
  botChatsInputSchema,
  botNewHomeChatInputSchema,
  botStateInputSchema,
  botStopInputSchema,
  botUpdateInputSchema,
  botCreateInputSchema
} from '../../shared/schemas/bots'
import {
  memoryAddInputSchema,
  memoryEditInputSchema,
  memoryForgetInputSchema,
  memoryReadInputSchema,
  memoryTidyUpInputSchema,
  memoryTopicInputSchema,
  memoryUndoInputSchema,
  type MemoryFactPayload
} from '../../shared/schemas/memory'
import {
  groupCreateInputSchema,
  groupMessagesInputSchema,
  groupSendInputSchema,
  groupMarkReadInputSchema,
  groupSetReadInputSchema,
  groupSetMutedInputSchema,
  groupStopInputSchema,
  groupThreadCreateInputSchema,
  groupArchiveInputSchema,
  groupDeleteInputSchema,
  groupUpdateInputSchema
} from '../../shared/schemas/groups'
import {
  itemsAskInputSchema,
  itemsAnswerInputSchema,
  itemsCommentInputSchema,
  itemsGetInputSchema,
  itemsLinkAddInputSchema,
  itemsLinkRemoveInputSchema,
  itemsAttachInputSchema,
  itemsRemoveAttachmentInputSchema,
  itemsListInputSchema,
  itemsSnoozeInputSchema,
  itemsSetStatusInputSchema
} from '../../shared/schemas/items'
import { networkSetSettingsInputSchema } from '../../shared/schemas/network'
import {
  permissionsListInputSchema,
  permissionsRespondInputSchema
} from '../../shared/schemas/permissions'
import {
  sidebarOrderPayloadSchema,
  type SidebarOrderPayload
} from '../../shared/schemas/sidebar-order'
import {
  updateInstallInputSchema,
  updateSetAutoCheckInputSchema,
  updateSkipInputSchema
} from '../../shared/schemas/updates'
import type { IpcResult } from '../../shared/schemas/ipc'
import {
  providerCreateInputSchema,
  providerRemoveInputSchema,
  providerSelectInputSchema,
  providerTestInputSchema,
  providerUpdateInputSchema
} from '../../shared/schemas/provider'
import type {
  ProviderCreateInput,
  ProviderSelectInput,
  ProviderTestInput,
  ProviderUpdateInput
} from '../../shared/schemas/provider'
import { makeAppError } from '../../shared/domain/errors'
import type { AppError } from '../../shared/domain/errors'
import { DatabaseError } from '../persistence/database'
import { RepositoryPathError } from '../repositories/repository-path'
import type { ExecutionTarget } from '../../shared/domain/repository'
import { SessionServiceError } from '../sessions/session-service'
import { localizeAppError } from '../../shared/i18n'
import { getMainLocale } from '../i18n/main-i18n'

export type DispatcherServices = {
  sidebarOrderGet: () => Promise<unknown>
  sidebarOrderSet: (input: SidebarOrderPayload) => Promise<unknown>
  reposList: () => Promise<unknown>
  reposAdd: (input: { path: string; target?: ExecutionTarget }) => Promise<unknown>
  reposInspect: (input: { path: string; target: ExecutionTarget }) => Promise<unknown>
  reposInitialize: (input: {
    path: string
    target: ExecutionTarget
    identity?: { name: string; email: string }
  }) => Promise<unknown>
  reposRetryPreparation: (input: { repoId: string }) => Promise<unknown>
  reposPickFolder: (input: {
    target: ExecutionTarget
    source?: 'wsl' | 'windows'
    purpose?: 'repository' | 'clone-parent'
  }) => Promise<unknown>
  reposRemove: (input: { repoId: string }) => Promise<unknown>
  reposRemovalJobsList: () => Promise<unknown>
  reposRemovalJobRetry: (input: { jobId: string }) => Promise<unknown>
  reposRemovalJobDiscardSnapshots: (input: { jobId: string }) => Promise<unknown>
  sessionsList: (input: { repoId?: string }) => Promise<unknown>
  sessionsGet: (input: { sessionId: string }) => Promise<unknown>
  sessionsCreate: (input: z.infer<typeof createSessionInputSchema>) => Promise<unknown>
  sessionsClose: (input: { sessionId: string }) => Promise<unknown>
  sessionsRestart: (input: { sessionId: string }) => Promise<unknown>
  sessionsResume: (input: { sessionId: string }) => Promise<unknown>
  sessionsSleep: (input: { sessionId: string }) => Promise<unknown>
  sessionsWake: (input: { sessionId: string }) => Promise<unknown>
  sessionsRemove: (input: {
    sessionId: string
    stopIfLive?: boolean
    deleteBranch?: boolean
  }) => Promise<unknown>
  sessionsDiscard: (input: {
    sessionId: string
    confirmBranch: string
    deleteBranch?: boolean
  }) => Promise<unknown>
  sessionsRecoverWorktree: (input: {
    sessionId: string
    keepExistingAsAside?: boolean
  }) => Promise<unknown>
  worktreesRemove: (input: { worktreeId: string; deleteBranch?: boolean }) => Promise<unknown>
  worktreesDiscard: (input: {
    worktreeId: string
    confirmBranch: string
    deleteBranch?: boolean
  }) => Promise<unknown>
  branchesList: (input: { repoId: string }) => Promise<unknown>
  branchesRefs: (input: { repoId: string }) => Promise<unknown>
  branchesCurrent: (input: { repoId: string }) => Promise<unknown>
  remotesList: (input: { repoId: string }) => Promise<unknown>
  remotesAdd: (input: { repoId: string; name: string; url: string }) => Promise<unknown>
  remotesSetUrl: (input: { repoId: string; name: string; url: string }) => Promise<unknown>
  remotesRemove: (input: { repoId: string; name: string }) => Promise<unknown>
  remotesFetch: (input: { repoId: string; name: string; prune?: boolean }) => Promise<unknown>
  cloneStart: (input: z.infer<typeof cloneStartInputSchema>) => Promise<unknown>
  cloneCancel: (input: { requestId: string }) => Promise<unknown>
  clonePersist: (input: z.infer<typeof clonePersistInputSchema>) => Promise<unknown>
  cloneSshStatus: (input: z.infer<typeof cloneSshStatusInputSchema>) => Promise<unknown>
  cloneSshGenerate: (input: z.infer<typeof cloneSshGenerateInputSchema>) => Promise<unknown>
  cloneSshTest: (input: z.infer<typeof cloneSshTestInputSchema>) => Promise<unknown>
  cloneSshTrustHost: (input: z.infer<typeof cloneSshTrustHostInputSchema>) => Promise<unknown>
  mergeStart: (input: z.infer<typeof mergeStartInputSchema>) => Promise<unknown>
  mergeContinue: (input: { sessionId: string }) => Promise<unknown>
  mergeAbort: (input: { sessionId: string }) => Promise<unknown>
  mergeState: (input: { sessionId: string }) => Promise<unknown>
  branchesRemove: (input: { repoId: string; branch: string; confirmBranch?: string }) => Promise<unknown>
  gitInvoke: (input: unknown) => Promise<unknown>
  filesList: (input: { sessionId: string; path: string }) => Promise<unknown>
  filesRead: (input: { sessionId: string; path: string }) => Promise<unknown>
  filesWrite: (input: {
    sessionId: string
    path: string
    text: string
    expectedEtag?: string | null
  }) => Promise<unknown>
  filesSearch: (input: {
    sessionId: string
    query: string
    caseSensitive: boolean
    wholeWord: boolean
    regex: boolean
    include: string[]
    exclude: string[]
    limit: number
  }) => Promise<unknown>
  filesCancelSearch: (input: { sessionId: string }) => Promise<unknown>
  filesReplace: (input: {
    sessionId: string
    query: string
    replacement: string
    caseSensitive: boolean
    wholeWord: boolean
    regex: boolean
    include: string[]
    exclude: string[]
    paths: string[]
  }) => Promise<unknown>
  filesCreate: (input: { sessionId: string; path: string; kind: 'file' | 'directory' }) => Promise<unknown>
  filesRename: (input: { sessionId: string; from: string; to: string }) => Promise<unknown>
  filesRemove: (input: { sessionId: string; path: string }) => Promise<unknown>
  filesRemoveMany: (input: { sessionId: string; paths: string[] }) => Promise<unknown>
  filesMoveMany: (input: {
    sessionId: string
    paths: string[]
    destination: string
  }) => Promise<unknown>
  filesCopyMany: (input: {
    sessionId: string
    paths: string[]
    destination: string
  }) => Promise<unknown>
  filesCopyPaths: (input: {
    sessionId: string
    paths: string[]
    format: 'absolute' | 'relative'
  }) => Promise<unknown>
  filesStat: (input: { sessionId: string; path: string }) => Promise<unknown>
  filesTrash: (input: { sessionId: string; paths: string[] }) => Promise<unknown>
  filesRestoreTrash: (input: { sessionId: string; opId: string }) => Promise<unknown>
  filesListTrash: (input: { sessionId: string }) => Promise<unknown>
  filesWatch: (input: { sessionId: string; active: boolean; roots?: string[] }) => Promise<unknown>
  aiCommitMessage: (input: { sessionId: string; requestId: string }) => Promise<unknown>
  aiCancelCommitMessage: (input: { requestId: string }) => Promise<unknown>
  tasksList: (input: {
    repoId?: string
    statuses?: string[]
    approvals?: string[]
    includeArchived?: boolean
    limit?: number
  }) => Promise<unknown>
  tasksCreate: (input: { repoId: string; title?: string; prompt: string; harness: string }) => Promise<unknown>
  tasksApprove: (input: { taskId: string }) => Promise<unknown>
  tasksReject: (input: { taskId: string; note?: string | null }) => Promise<unknown>
  tasksCancel: (input: { taskId: string }) => Promise<unknown>
  tasksRetry: (input: { taskId: string }) => Promise<unknown>
  tasksResume: (input: { taskId: string }) => Promise<unknown>
  tasksHistory: (input: { taskId: string }) => Promise<unknown>
  tasksChanges: (input: { taskId: string }) => Promise<unknown>
  tasksDecideReview: (input: {
    taskId: string
    decision: 'accepted' | 'rejected'
    note?: string | null
    replace?: boolean
  }) => Promise<unknown>
  tasksRequestChanges: (input: { taskId: string; note?: string | null }) => Promise<unknown>
  tasksArchive: (input: { taskId: string }) => Promise<unknown>
  tasksUnarchive: (input: { taskId: string }) => Promise<unknown>
  tasksArchiveFinished: (input: { repoId?: string }) => Promise<unknown>
  tasksAddDependency: (input: { taskId: string; blockerId: string }) => Promise<unknown>
  tasksRemoveDependency: (input: { taskId: string; blockerId: string }) => Promise<unknown>
  tasksSetHoldDependents: (input: { taskId: string; hold: boolean }) => Promise<unknown>
  tasksSettings: () => Promise<unknown>
  tasksSetSettings: (input: {
    maxConcurrent?: number
    maxConcurrentPerProject?: number
  }) => Promise<unknown>
  supervisorOpen: (input: { repoId: string }) => Promise<unknown>
  botsList: () => Promise<unknown>
  botsCreate: (input: z.infer<typeof botCreateInputSchema>) => Promise<unknown>
  botsUpdate: (input: z.infer<typeof botUpdateInputSchema>) => Promise<unknown>
  botsArchive: (input: { botId: string }) => Promise<unknown>
  botsSetPaused: (input: { botId: string; paused: boolean }) => Promise<unknown>
  botsState: (input: { botId: string; threadId?: string }) => Promise<unknown>
  botsMessages: (input: {
    botId: string
    threadId?: string
    beforeSeq?: number
    limit?: number
    conversationId?: string
  }) => Promise<unknown>
  botsConversations: (input: { botId: string; threadId?: string }) => Promise<unknown>
  botsNotifications: (input: {
    botId: string
    threadId?: string
    limit?: number
  }) => Promise<unknown>
  botsSend: (input: {
    botId: string
    threadId?: string
    text: string
    repoId?: string
  }) => Promise<unknown>
  botsMarkRead: (input: {
    botId: string
    threadId?: string
    messageId?: string
    read?: boolean
  }) => Promise<unknown>
  botsStop: (input: { botId: string; threadId?: string }) => Promise<unknown>
  botsNewConversation: (input: { botId: string; threadId?: string }) => Promise<unknown>
  botsNewHomeChat: (input: { botId: string }) => Promise<unknown>
  botsChats: (input: { botId: string }) => Promise<unknown>
  botsChatCreate: (input: {
    botId: string
    harness?: 'claude' | 'codex' | 'opencode'
  }) => Promise<unknown>
  botsHistorySearch: (input: {
    query: string
    limit?: number
  }) => Promise<unknown>
  botsFocus: (input: {
    botId: string
    threadId?: string
    messageId: string
  }) => Promise<unknown>
  botsHome: (input: { botId: string }) => Promise<unknown>
  botsAutomationsList: (input: { botId: string }) => Promise<unknown>
  botsAutomationsCreate: (input: {
    botId: string
    name: string
    prompt: string
    intervalMinutes: number
    enabled?: boolean
  }) => Promise<unknown>
  botsAutomationsUpdate: (input: {
    id: string
    name?: string
    prompt?: string
    intervalMinutes?: number
    enabled?: boolean
  }) => Promise<unknown>
  botsAutomationsRemove: (input: { id: string }) => Promise<unknown>
  botsSkillsList: (input: { botId: string }) => Promise<unknown>
  botsSkillsRead: (input: { botId: string; folder: string }) => Promise<unknown>
  botsSkillsSave: (input: {
    botId: string
    folder: string
    text: string
  }) => Promise<unknown>
  botsSkillsDelete: (input: { botId: string; folder: string }) => Promise<unknown>
  botsSettingsGet: (input: { botId: string }) => Promise<unknown>
  botsSettingsSet: (input: { botId: string; settings: unknown }) => Promise<unknown>
  botsMemoryRead: (input: { botId: string }) => Promise<unknown>
  botsMemoryAdd: (input: { botId: string; text: string }) => Promise<unknown>
  botsMemoryEdit: (input: {
    botId: string
    fact: MemoryFactPayload
    text: string
  }) => Promise<unknown>
  botsMemoryForget: (input: { botId: string; fact: MemoryFactPayload }) => Promise<unknown>
  botsMemoryUndo: (input: { botId: string; rowId: string }) => Promise<unknown>
  botsMemoryTopic: (input: { botId: string; name: string }) => Promise<unknown>
  botsMemoryTidyUp: (input: { botId: string }) => Promise<unknown>
  groupsList: () => Promise<unknown>
  groupsCreate: (input: {
    name: string
    memberBotIds: string[]
    defaultBotId?: string
    replyMode?: import('../../shared/domain/group').GroupReplyMode
  }) => Promise<unknown>
  groupsUpdate: (input: {
    groupId: string
    revision: number
    name?: string
    memberBotIds?: string[]
    defaultBotId?: string | null
    replyMode?: import('../../shared/domain/group').GroupReplyMode
  }) => Promise<unknown>
  groupsThreads: (input: { groupId: string }) => Promise<unknown>
  groupsArchive: (input: { groupId: string }) => Promise<unknown>
  groupsDelete: (input: { groupId: string }) => Promise<unknown>
  groupsThreadCreate: (input: { groupId: string }) => Promise<unknown>
  groupsMessages: (input: { threadId: string; beforeSeq?: number; limit?: number }) => Promise<unknown>
  groupsSend: (input: {
    groupId: string
    threadId: string
    text: string
    messageId?: string
    revision?: number
    repoId?: string
  }) => Promise<unknown>
  groupsMarkRead: (input: { threadId: string; seq: number }) => Promise<unknown>
  groupsSetRead: (input: { groupId: string; read: boolean }) => Promise<unknown>
  groupsSetMuted: (input: { groupId: string; muted: boolean }) => Promise<unknown>
  groupsStop: (input: { groupId: string; threadId: string; botId?: string }) => Promise<unknown>
  itemsList: (input: z.infer<typeof itemsListInputSchema>) => Promise<unknown>
  itemsGet: (input: z.infer<typeof itemsGetInputSchema>) => Promise<unknown>
  itemsComment: (input: z.infer<typeof itemsCommentInputSchema>) => Promise<unknown>
  itemsAsk: (input: z.infer<typeof itemsAskInputSchema>) => Promise<unknown>
  itemsAnswer: (input: z.infer<typeof itemsAnswerInputSchema>) => Promise<unknown>
  itemsSnooze: (input: z.infer<typeof itemsSnoozeInputSchema>) => Promise<unknown>
  itemsSetStatus: (input: z.infer<typeof itemsSetStatusInputSchema>) => Promise<unknown>
  itemsLinkAdd: (input: z.infer<typeof itemsLinkAddInputSchema>) => Promise<unknown>
  itemsLinkRemove: (input: z.infer<typeof itemsLinkRemoveInputSchema>) => Promise<unknown>
  itemsAttach: (input: z.infer<typeof itemsAttachInputSchema>) => Promise<unknown>
  itemsRemoveAttachment: (input: z.infer<typeof itemsRemoveAttachmentInputSchema>) => Promise<unknown>
  permissionsList: (input: z.infer<typeof permissionsListInputSchema>) => Promise<unknown>
  permissionsRespond: (input: z.infer<typeof permissionsRespondInputSchema>) => Promise<unknown>
  networkSettingsGet: () => Promise<unknown>
  networkSetSettings: (input: { settings: unknown }) => Promise<unknown>
  updatesGet: () => Promise<unknown>
  updatesCheck: () => Promise<unknown>
  updatesDownload: () => Promise<unknown>
  updatesCancelDownload: () => Promise<unknown>
  updatesInstall: (input: z.infer<typeof updateInstallInputSchema>) => Promise<unknown>
  updatesSkip: (input: z.infer<typeof updateSkipInputSchema>) => Promise<unknown>
  updatesSetAutoCheck: (input: z.infer<typeof updateSetAutoCheckInputSchema>) => Promise<unknown>
  schedulesList: (input: { repoId?: string }) => Promise<unknown>
  schedulesCreate: (input: {
    repoId: string
    title?: string
    prompt: string
    harness: string
    shape: unknown
    overlap?: 'queue' | 'skip'
  }) => Promise<unknown>
  schedulesUpdate: (input: {
    scheduleId: string
    repoId: string
    title?: string
    prompt: string
    harness: string
    shape: unknown
    overlap?: 'queue' | 'skip'
  }) => Promise<unknown>
  schedulesSetEnabled: (input: { scheduleId: string; enabled: boolean }) => Promise<unknown>
  schedulesRunNow: (input: { scheduleId: string }) => Promise<unknown>
  schedulesRemove: (input: { scheduleId: string }) => Promise<unknown>
  activityList: () => Promise<unknown>
  activityClearUnread: (input: { sessionId: string }) => Promise<unknown>
  opencodeIntegrationGet: () => Promise<unknown>
  opencodeIntegrationSetEnabled: (input: { enabled: boolean }) => Promise<unknown>
  managedHooksGet: () => Promise<unknown>
  managedHooksSetEnabled: (input: { enabled: boolean }) => Promise<unknown>
  harnessList: (input: { force?: boolean; repoId?: string }) => Promise<unknown>
  providersList: () => Promise<unknown>
  providersCreate: (input: ProviderCreateInput) => Promise<unknown>
  providersUpdate: (input: ProviderUpdateInput) => Promise<unknown>
  providersRemove: (input: { providerId: string }) => Promise<unknown>
  providersSelect: (input: ProviderSelectInput) => Promise<unknown>
  providersTest: (input: ProviderTestInput) => Promise<unknown>
  wslListDistros: () => Promise<unknown>
  terminalAttach: (input: { sessionId: string }) => Promise<unknown>
  terminalPreview: (input: { sessionId: string }) => Promise<unknown>
  terminalWrite: (input: { sessionId: string; incarnationId: string; data: string }) => Promise<unknown>
  terminalResize: (input: {
    sessionId: string
    incarnationId: string
    cols: number
    rows: number
  }) => Promise<unknown>
}

export type Dispatcher = (channel: string, rawInput?: unknown) => Promise<IpcResult<unknown>>

function toAppError(error: unknown): AppError {
  if (error instanceof DatabaseError) return error.appError
  if (error instanceof RepositoryPathError) return error.appError
  if (error instanceof SessionServiceError) return error.appError
  const parsed = appErrorSchema.safeParse(
    error && typeof error === 'object' && 'appError' in error
      ? (error as { appError: unknown }).appError
      : null
  )
  if (parsed.success) return parsed.data
  return makeAppError('INTERNAL', 'Unexpected application error.', {
    detail: error instanceof Error ? error.message : String(error)
  })
}

function invalidInput(message: string, path: string): AppError {
  return makeAppError('INVALID_ARGUMENT', message, { detail: path })
}

function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> | AppError {
  const result = schema.safeParse(input)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  return invalidInput('Invalid request payload.', issue?.path.join('.') || 'input')
}

async function run<T>(work: () => Promise<T> | T): Promise<IpcResult<unknown>> {
  try {
    const value = await work()
    return { ok: true, value: value ?? null }
  } catch (error) {
    // Localize once at the process boundary. Service-level errors keep their
    // English message and optional key, so persisted rows are not rewritten.
    return { ok: false, error: localizeAppError(toAppError(error), getMainLocale()) }
  }
}

/**
 * Validates every renderer request against the Work 2 schemas and maps failures
 * to stable app errors. IPC registration only forwards channels to this table.
 */
export function createDispatcher(services: DispatcherServices): Dispatcher {
  return async (channel, rawInput) => {
    switch (channel) {
      case IPC_CHANNELS.sidebarOrderGet:
        return run(() => services.sidebarOrderGet())

      case IPC_CHANNELS.sidebarOrderSet: {
        const input = parse(sidebarOrderPayloadSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.sidebarOrderSet(input))
      }

      case IPC_CHANNELS.reposList:
        return run(() => services.reposList())

      case IPC_CHANNELS.reposAdd: {
        const input = parse(addRepositoryInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.reposAdd(input))
      }

      case IPC_CHANNELS.reposInspect: {
        const input = parse(inspectRepositoryInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.reposInspect(input))
      }

      case IPC_CHANNELS.reposInitialize: {
        const input = parse(initializeRepositoryInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.reposInitialize(input))
      }

      case IPC_CHANNELS.reposRetryPreparation: {
        const input = parse(retryRepositoryPreparationInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.reposRetryPreparation(input))
      }

      case IPC_CHANNELS.reposPickFolder: {
        const input = parse(pickRepositoryFolderInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.reposPickFolder(input))
      }

      case IPC_CHANNELS.reposRemove: {
        const input = parse(removeRepositoryInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.reposRemove(input))
      }

      case IPC_CHANNELS.reposRemovalJobsList: {
        return run(() => services.reposRemovalJobsList())
      }

      case IPC_CHANNELS.reposRemovalJobRetry: {
        const input = parse(repoRemovalJobIdInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.reposRemovalJobRetry(input))
      }

      case IPC_CHANNELS.reposRemovalJobDiscardSnapshots: {
        const input = parse(repoRemovalJobIdInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.reposRemovalJobDiscardSnapshots(input))
      }

      case IPC_CHANNELS.sessionsList: {
        const input = parse(listSessionsInputSchema, rawInput ?? {})
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.sessionsList(input))
      }

      case IPC_CHANNELS.sessionsGet: {
        const input = parse(sessionTargetInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.sessionsGet(input))
      }

      case IPC_CHANNELS.sessionsCreate: {
        const input = parse(createSessionInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.sessionsCreate(input))
      }

      case IPC_CHANNELS.sessionsClose: {
        const input = parse(sessionTargetInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.sessionsClose(input))
      }

      case IPC_CHANNELS.sessionsRestart: {
        const input = parse(sessionTargetInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.sessionsRestart(input))
      }

      case IPC_CHANNELS.sessionsResume: {
        const input = parse(sessionTargetInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.sessionsResume(input))
      }

      case IPC_CHANNELS.sessionsSleep: {
        const input = parse(sessionTargetInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.sessionsSleep(input))
      }

      case IPC_CHANNELS.sessionsWake: {
        const input = parse(sessionTargetInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.sessionsWake(input))
      }

      case IPC_CHANNELS.sessionsRemove: {
        const input = parse(removeSessionInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.sessionsRemove(input))
      }

      case IPC_CHANNELS.sessionsDiscard: {
        const input = parse(discardSessionInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.sessionsDiscard(input))
      }

      case IPC_CHANNELS.sessionsRecoverWorktree: {
        const input = parse(recoverWorktreeInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.sessionsRecoverWorktree(input))
      }

      case IPC_CHANNELS.worktreesRemove: {
        const input = parse(removeWorktreeInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.worktreesRemove(input))
      }

      case IPC_CHANNELS.worktreesDiscard: {
        const input = parse(discardWorktreeInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.worktreesDiscard(input))
      }

      case IPC_CHANNELS.branchesList: {
        const input = parse(listBranchesInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.branchesList(input))
      }

      case IPC_CHANNELS.branchesRefs: {
        const input = parse(listBranchRefsInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.branchesRefs(input))
      }

      case IPC_CHANNELS.branchesCurrent: {
        const input = parse(currentBranchInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.branchesCurrent(input))
      }

      case IPC_CHANNELS.branchesRemove: {
        const input = parse(removeBranchInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.branchesRemove(input))
      }

      case IPC_CHANNELS.remotesList: {
        const input = parse(remoteListInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.remotesList(input))
      }

      case IPC_CHANNELS.remotesAdd: {
        const input = parse(remoteAddInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.remotesAdd(input))
      }

      case IPC_CHANNELS.remotesSetUrl: {
        const input = parse(remoteSetUrlInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.remotesSetUrl(input))
      }

      case IPC_CHANNELS.remotesRemove: {
        const input = parse(remoteRemoveInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.remotesRemove(input))
      }

      case IPC_CHANNELS.remotesFetch: {
        const input = parse(remoteFetchInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.remotesFetch(input))
      }

      case IPC_CHANNELS.cloneStart: {
        const input = parse(cloneStartInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.cloneStart(input))
      }

      case IPC_CHANNELS.cloneCancel: {
        const input = parse(cloneCancelInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.cloneCancel(input))
      }

      case IPC_CHANNELS.clonePersist: {
        const input = parse(clonePersistInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.clonePersist(input))
      }

      case IPC_CHANNELS.cloneSshStatus: {
        const input = parse(cloneSshStatusInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.cloneSshStatus(input))
      }

      case IPC_CHANNELS.cloneSshGenerate: {
        const input = parse(cloneSshGenerateInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.cloneSshGenerate(input))
      }

      case IPC_CHANNELS.cloneSshTest: {
        const input = parse(cloneSshTestInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.cloneSshTest(input))
      }

      case IPC_CHANNELS.cloneSshTrustHost: {
        const input = parse(cloneSshTrustHostInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.cloneSshTrustHost(input))
      }

      case IPC_CHANNELS.mergeStart: {
        const input = parse(mergeStartInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.mergeStart(input))
      }

      case IPC_CHANNELS.mergeContinue: {
        const input = parse(mergeSessionInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.mergeContinue(input))
      }

      case IPC_CHANNELS.mergeAbort: {
        const input = parse(mergeSessionInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.mergeAbort(input))
      }

      case IPC_CHANNELS.mergeState: {
        const input = parse(mergeSessionInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.mergeState(input))
      }

      case IPC_CHANNELS.gitInvoke:
        return run(() => services.gitInvoke(rawInput))

      case IPC_CHANNELS.aiCommitMessage: {
        const input = parse(aiCommitMessageInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.aiCommitMessage(input))
      }

      case IPC_CHANNELS.aiCancelCommitMessage: {
        const input = parse(aiCancelCommitMessageInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.aiCancelCommitMessage(input))
      }

      case IPC_CHANNELS.filesList: {
        const input = parse(filesListInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.filesList(input))
      }

      case IPC_CHANNELS.filesRead: {
        const input = parse(filesReadInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.filesRead(input))
      }

      case IPC_CHANNELS.filesWrite: {
        const input = parse(filesWriteInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.filesWrite(input))
      }

      case IPC_CHANNELS.filesSearch: {
        const input = parse(filesSearchInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.filesSearch(input))
      }

      case IPC_CHANNELS.filesCancelSearch: {
        const input = parse(filesCancelSearchInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.filesCancelSearch(input))
      }

      case IPC_CHANNELS.filesReplace: {
        const input = parse(filesReplaceInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.filesReplace(input))
      }

      case IPC_CHANNELS.filesCreate: {
        const input = parse(filesCreateInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.filesCreate(input))
      }

      case IPC_CHANNELS.filesRename: {
        const input = parse(filesRenameInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.filesRename(input))
      }

      case IPC_CHANNELS.filesRemove: {
        const input = parse(filesRemoveInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.filesRemove(input))
      }

      case IPC_CHANNELS.filesRemoveMany: {
        const input = parse(filesRemoveManyInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.filesRemoveMany(input))
      }

      case IPC_CHANNELS.filesMoveMany: {
        const input = parse(filesMoveManyInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.filesMoveMany(input))
      }

      case IPC_CHANNELS.filesCopyMany: {
        const input = parse(filesCopyManyInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.filesCopyMany(input))
      }

      case IPC_CHANNELS.filesCopyPaths: {
        const input = parse(filesCopyPathsInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.filesCopyPaths(input))
      }

      case IPC_CHANNELS.filesStat: {
        const input = parse(filesStatInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.filesStat(input))
      }

      case IPC_CHANNELS.filesTrash: {
        const input = parse(filesTrashInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.filesTrash(input))
      }

      case IPC_CHANNELS.filesRestoreTrash: {
        const input = parse(filesRestoreTrashInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.filesRestoreTrash(input))
      }

      case IPC_CHANNELS.filesListTrash: {
        const input = parse(filesListTrashInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.filesListTrash(input))
      }

      case IPC_CHANNELS.filesWatch: {
        const input = parse(filesWatchInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.filesWatch(input))
      }

      case IPC_CHANNELS.tasksList: {
        const input = parse(taskListInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.tasksList(input))
      }

      case IPC_CHANNELS.tasksCreate: {
        const input = parse(taskCreateInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.tasksCreate(input))
      }

      case IPC_CHANNELS.tasksApprove: {
        const input = parse(taskIdInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.tasksApprove(input))
      }

      case IPC_CHANNELS.tasksReject: {
        const input = parse(taskRejectInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.tasksReject(input))
      }

      case IPC_CHANNELS.tasksCancel: {
        const input = parse(taskIdInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.tasksCancel(input))
      }

      case IPC_CHANNELS.tasksRetry: {
        const input = parse(taskIdInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.tasksRetry(input))
      }

      case IPC_CHANNELS.tasksResume: {
        const input = parse(taskIdInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.tasksResume(input))
      }

      case IPC_CHANNELS.tasksHistory: {
        const input = parse(taskIdInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.tasksHistory(input))
      }

      case IPC_CHANNELS.tasksChanges: {
        const input = parse(taskIdInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.tasksChanges(input))
      }

      case IPC_CHANNELS.tasksDecideReview: {
        const input = parse(taskDecideReviewInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.tasksDecideReview(input))
      }

      case IPC_CHANNELS.tasksRequestChanges: {
        const input = parse(taskRequestChangesInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.tasksRequestChanges(input))
      }

      case IPC_CHANNELS.tasksArchive: {
        const input = parse(taskIdInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.tasksArchive(input))
      }

      case IPC_CHANNELS.tasksUnarchive: {
        const input = parse(taskIdInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.tasksUnarchive(input))
      }

      case IPC_CHANNELS.tasksArchiveFinished: {
        const input = parse(taskArchiveFinishedInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.tasksArchiveFinished(input))
      }

      case IPC_CHANNELS.tasksAddDependency: {
        const input = parse(taskDependencyInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.tasksAddDependency(input))
      }

      case IPC_CHANNELS.tasksRemoveDependency: {
        const input = parse(taskDependencyInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.tasksRemoveDependency(input))
      }

      case IPC_CHANNELS.tasksSetHoldDependents: {
        const input = parse(taskHoldDependentsInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.tasksSetHoldDependents(input))
      }

      case IPC_CHANNELS.tasksSettings: {
        return run(() => services.tasksSettings())
      }

      case IPC_CHANNELS.tasksSetSettings: {
        const input = parse(taskSettingsInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.tasksSetSettings(input))
      }

      case IPC_CHANNELS.supervisorOpen: {
        const input = parse(supervisorOpenInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.supervisorOpen(input))
      }

      case IPC_CHANNELS.botsList:
        return run(() => services.botsList())

      case IPC_CHANNELS.botsCreate: {
        const input = parse(botCreateInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsCreate(input))
      }

      case IPC_CHANNELS.botsUpdate: {
        const input = parse(botUpdateInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsUpdate(input))
      }

      case IPC_CHANNELS.botsArchive: {
        const input = parse(botArchiveInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsArchive(input))
      }

      case IPC_CHANNELS.botsSetPaused: {
        const input = parse(botSetPausedInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsSetPaused(input))
      }

      case IPC_CHANNELS.botsState: {
        const input = parse(botStateInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsState(input))
      }

      case IPC_CHANNELS.botsMessages: {
        const input = parse(botMessagesInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsMessages(input))
      }

      case IPC_CHANNELS.botsConversations: {
        const input = parse(botConversationsInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsConversations(input))
      }

      case IPC_CHANNELS.botsNotifications: {
        const input = parse(botNotificationsInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsNotifications(input))
      }

      case IPC_CHANNELS.botsSend: {
        const input = parse(botSendInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsSend(input))
      }

      case IPC_CHANNELS.botsMarkRead: {
        const input = parse(botMarkReadInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsMarkRead(input))
      }

      case IPC_CHANNELS.botsStop: {
        const input = parse(botStopInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsStop(input))
      }

      case IPC_CHANNELS.botsNewConversation: {
        const input = parse(botNewConversationInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsNewConversation(input))
      }

      case IPC_CHANNELS.botsNewHomeChat: {
        const input = parse(botNewHomeChatInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsNewHomeChat(input))
      }

      case IPC_CHANNELS.botsChats: {
        const input = parse(botChatsInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsChats(input))
      }

      case IPC_CHANNELS.botsChatCreate: {
        const input = parse(botChatCreateInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsChatCreate(input))
      }

      case IPC_CHANNELS.botsHistorySearch: {
        const input = parse(botHistorySearchInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsHistorySearch(input))
      }

      case IPC_CHANNELS.botsFocus: {
        const input = parse(botFocusInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsFocus(input))
      }

      case IPC_CHANNELS.botsHome: {
        const input = parse(botHomeInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsHome(input))
      }

      case IPC_CHANNELS.botsAutomationsList: {
        const input = parse(botAutomationsInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsAutomationsList(input))
      }

      case IPC_CHANNELS.botsAutomationsCreate: {
        const input = parse(botAutomationCreateInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsAutomationsCreate(input))
      }

      case IPC_CHANNELS.botsAutomationsUpdate: {
        const input = parse(botAutomationUpdateInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsAutomationsUpdate(input))
      }

      case IPC_CHANNELS.botsAutomationsRemove: {
        const input = parse(botAutomationRemoveInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsAutomationsRemove(input))
      }

      case IPC_CHANNELS.botsSkillsList: {
        const input = parse(botSkillsInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsSkillsList(input))
      }

      case IPC_CHANNELS.botsSkillsRead: {
        const input = parse(botSkillReadInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsSkillsRead(input))
      }

      case IPC_CHANNELS.botsSkillsSave: {
        const input = parse(botSkillSaveInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsSkillsSave(input))
      }

      case IPC_CHANNELS.botsSkillsDelete: {
        const input = parse(botSkillDeleteInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsSkillsDelete(input))
      }

      case IPC_CHANNELS.botsSettingsGet: {
        const input = parse(botSettingsInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsSettingsGet(input))
      }

      case IPC_CHANNELS.botsSettingsSet: {
        const input = parse(botSetSettingsInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsSettingsSet(input))
      }

      case IPC_CHANNELS.botsMemoryRead: {
        const input = parse(memoryReadInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsMemoryRead(input))
      }

      case IPC_CHANNELS.botsMemoryAdd: {
        const input = parse(memoryAddInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsMemoryAdd(input))
      }

      case IPC_CHANNELS.botsMemoryEdit: {
        const input = parse(memoryEditInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsMemoryEdit(input))
      }

      case IPC_CHANNELS.botsMemoryForget: {
        const input = parse(memoryForgetInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsMemoryForget(input))
      }

      case IPC_CHANNELS.botsMemoryUndo: {
        const input = parse(memoryUndoInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsMemoryUndo(input))
      }

      case IPC_CHANNELS.botsMemoryTopic: {
        const input = parse(memoryTopicInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsMemoryTopic(input))
      }

      case IPC_CHANNELS.botsMemoryTidyUp: {
        const input = parse(memoryTidyUpInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.botsMemoryTidyUp(input))
      }

      case IPC_CHANNELS.groupsList:
        return run(() => services.groupsList())

      case IPC_CHANNELS.groupsCreate: {
        const input = parse(groupCreateInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.groupsCreate(input))
      }

      case IPC_CHANNELS.groupsUpdate: {
        const input = parse(groupUpdateInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.groupsUpdate(input))
      }

      case IPC_CHANNELS.groupsArchive: {
        const input = parse(groupArchiveInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.groupsArchive(input))
      }

      case IPC_CHANNELS.groupsDelete: {
        const input = parse(groupDeleteInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.groupsDelete(input))
      }

      case IPC_CHANNELS.groupsThreads: {
        const input = parse(groupThreadCreateInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.groupsThreads(input))
      }

      case IPC_CHANNELS.groupsThreadCreate: {
        const input = parse(groupThreadCreateInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.groupsThreadCreate(input))
      }

      case IPC_CHANNELS.groupsMessages: {
        const input = parse(groupMessagesInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.groupsMessages(input))
      }

      case IPC_CHANNELS.groupsSend: {
        const input = parse(groupSendInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.groupsSend(input))
      }

      case IPC_CHANNELS.groupsMarkRead: {
        const input = parse(groupMarkReadInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.groupsMarkRead(input))
      }

      case IPC_CHANNELS.groupsSetRead: {
        const input = parse(groupSetReadInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.groupsSetRead(input))
      }

      case IPC_CHANNELS.groupsSetMuted: {
        const input = parse(groupSetMutedInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.groupsSetMuted(input))
      }

      case IPC_CHANNELS.groupsStop: {
        const input = parse(groupStopInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.groupsStop(input))
      }

      case IPC_CHANNELS.itemsList: {
        const input = parse(itemsListInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.itemsList(input))
      }

      case IPC_CHANNELS.itemsGet: {
        const input = parse(itemsGetInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.itemsGet(input))
      }

      case IPC_CHANNELS.itemsComment: {
        const input = parse(itemsCommentInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.itemsComment(input))
      }

      case IPC_CHANNELS.itemsAsk: {
        const input = parse(itemsAskInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.itemsAsk(input))
      }

      case IPC_CHANNELS.itemsAnswer: {
        const input = parse(itemsAnswerInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.itemsAnswer(input))
      }

      case IPC_CHANNELS.itemsSnooze: {
        const input = parse(itemsSnoozeInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.itemsSnooze(input))
      }

      case IPC_CHANNELS.itemsSetStatus: {
        const input = parse(itemsSetStatusInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.itemsSetStatus(input))
      }

      case IPC_CHANNELS.itemsAttach: {
        const input = parse(itemsAttachInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.itemsAttach(input))
      }

      case IPC_CHANNELS.itemsRemoveAttachment: {
        const input = parse(itemsRemoveAttachmentInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.itemsRemoveAttachment(input))
      }

      case IPC_CHANNELS.permissionsList: {
        const input = parse(permissionsListInputSchema, rawInput ?? {})
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.permissionsList(input))
      }

      case IPC_CHANNELS.permissionsRespond: {
        const input = parse(permissionsRespondInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.permissionsRespond(input))
      }

      case IPC_CHANNELS.itemsLinkAdd: {
        const input = parse(itemsLinkAddInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.itemsLinkAdd(input))
      }

      case IPC_CHANNELS.itemsLinkRemove: {
        const input = parse(itemsLinkRemoveInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.itemsLinkRemove(input))
      }

      case IPC_CHANNELS.networkSettingsGet:
        return run(() => services.networkSettingsGet())

      case IPC_CHANNELS.networkSetSettings: {
        const input = parse(networkSetSettingsInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.networkSetSettings(input))
      }

      case IPC_CHANNELS.updatesGet:
        return run(() => services.updatesGet())

      case IPC_CHANNELS.updatesCheck:
        return run(() => services.updatesCheck())

      case IPC_CHANNELS.updatesDownload:
        return run(() => services.updatesDownload())

      case IPC_CHANNELS.updatesCancelDownload:
        return run(() => services.updatesCancelDownload())

      case IPC_CHANNELS.updatesInstall: {
        const input = parse(updateInstallInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.updatesInstall(input))
      }

      case IPC_CHANNELS.updatesSkip: {
        const input = parse(updateSkipInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.updatesSkip(input))
      }

      case IPC_CHANNELS.updatesSetAutoCheck: {
        const input = parse(updateSetAutoCheckInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.updatesSetAutoCheck(input))
      }

      case IPC_CHANNELS.schedulesList: {
        const input = parse(scheduleListInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.schedulesList(input))
      }

      case IPC_CHANNELS.schedulesCreate: {
        const input = parse(scheduleCreateInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.schedulesCreate(input))
      }

      case IPC_CHANNELS.schedulesUpdate: {
        const input = parse(scheduleUpdateInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.schedulesUpdate(input))
      }

      case IPC_CHANNELS.schedulesSetEnabled: {
        const input = parse(scheduleEnabledInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.schedulesSetEnabled(input))
      }

      case IPC_CHANNELS.schedulesRunNow: {
        const input = parse(scheduleIdInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.schedulesRunNow(input))
      }

      case IPC_CHANNELS.schedulesRemove: {
        const input = parse(scheduleIdInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.schedulesRemove(input))
      }

      case IPC_CHANNELS.activityList:
        return run(() => services.activityList())

      case IPC_CHANNELS.activityClearUnread: {
        const input = parse(clearActivityUnreadInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.activityClearUnread(input))
      }

      case IPC_CHANNELS.opencodeIntegrationGet:
        return run(() => services.opencodeIntegrationGet())

      case IPC_CHANNELS.opencodeIntegrationSetEnabled: {
        const input = parse(openCodeIntegrationSetEnabledInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.opencodeIntegrationSetEnabled(input))
      }

      case IPC_CHANNELS.managedHooksGet:
        return run(() => services.managedHooksGet())

      case IPC_CHANNELS.managedHooksSetEnabled: {
        const input = parse(managedHooksSetEnabledInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.managedHooksSetEnabled(input))
      }

      case IPC_CHANNELS.harnessList: {
        const input = parse(harnessListInputSchema, rawInput ?? {})
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.harnessList(input))
      }

      case IPC_CHANNELS.providersList:
        return run(() => services.providersList())

      case IPC_CHANNELS.providersCreate: {
        const input = parse(providerCreateInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.providersCreate(input))
      }

      case IPC_CHANNELS.providersUpdate: {
        const input = parse(providerUpdateInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.providersUpdate(input))
      }

      case IPC_CHANNELS.providersRemove: {
        const input = parse(providerRemoveInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.providersRemove(input))
      }

      case IPC_CHANNELS.providersSelect: {
        const input = parse(providerSelectInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.providersSelect(input))
      }

      case IPC_CHANNELS.providersTest: {
        const input = parse(providerTestInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.providersTest(input))
      }

      case IPC_CHANNELS.wslListDistros:
        // No input: discovery is machine-wide and takes no parameters.
        return run(() => services.wslListDistros())

      case IPC_CHANNELS.terminalAttach: {
        const input = parse(terminalAttachInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.terminalAttach(input))
      }

      case IPC_CHANNELS.terminalPreview: {
        const input = parse(terminalAttachInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.terminalPreview(input))
      }

      case IPC_CHANNELS.terminalWrite: {
        const input = parse(terminalWriteInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.terminalWrite(input))
      }

      case IPC_CHANNELS.terminalResize: {
        const input = parse(terminalResizeInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.terminalResize(input))
      }

      default:
        return {
          ok: false,
          error: makeAppError('INVALID_ARGUMENT', 'Unknown IPC channel.', {
            context: { channel: String(channel).slice(0, 100) }
          })
        }
    }
  }
}
