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
  listBranchesInputSchema,
  listSessionsInputSchema,
  removeBranchInputSchema,
  removeRepositoryInputSchema,
  removeSessionInputSchema,
  sessionTargetInputSchema,
  terminalAttachInputSchema,
  terminalResizeInputSchema,
  terminalWriteInputSchema
} from '../../shared/schemas/ipc'
import { reviewAreaDiffInputSchema } from '../../shared/schemas/review'
import {
  filesListInputSchema,
  filesReadInputSchema,
  filesCreateInputSchema,
  filesRemoveInputSchema,
  filesRenameInputSchema,
  filesSearchInputSchema,
  filesWriteInputSchema,
  gitAddRemoteInputSchema,
  gitAmendInputSchema,
  gitPullInputSchema,
  gitBlameInputSchema,
  gitBranchesInputSchema,
  gitCancelStatusInputSchema,
  gitCommitActionInputSchema,
  gitCommitInputSchema,
  gitCommitDetailInputSchema,
  gitCreateBranchInputSchema,
  gitCheckoutRefInputSchema,
  gitCreateTagInputSchema,
  gitDeleteBranchInputSchema,
  gitDeleteTagInputSchema,
  gitMergeBranchInputSchema,
  gitRebaseBranchInputSchema,
  gitRenameBranchInputSchema,
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
  gitResetInputSchema,
  gitRevisionFileDiffInputSchema,
  gitWatchStatusInputSchema,
  gitStageAllInputSchema,
  gitRemoteOpInputSchema,
  gitRemoveRemoteInputSchema,
  gitSetPathStagedInputSchema,
  gitSetPathsStagedInputSchema,
  gitSetUpstreamInputSchema,
  gitStatusInputSchema,
  gitSwitchBranchInputSchema,
  scheduleCreateInputSchema,
  scheduleEnabledInputSchema,
  scheduleIdInputSchema,
  scheduleListInputSchema,
  scheduleUpdateInputSchema,
  taskCreateInputSchema,
  taskDecideReviewInputSchema,
  taskIdInputSchema,
  taskListInputSchema,
  taskSettingsInputSchema,
  gitUnstageAllInputSchema
} from '../../shared/schemas/workspace'
import { clearActivityUnreadInputSchema } from '../../shared/schemas/activity'
import type { IpcResult } from '../../shared/schemas/ipc'
import { makeAppError } from '../../shared/domain/errors'
import type { AppError } from '../../shared/domain/errors'
import { DatabaseError } from '../persistence/database'
import { RepositoryPathError } from '../repositories/repository-path'
import type { ExecutionTarget } from '../../shared/domain/repository'
import { SessionServiceError } from '../sessions/session-service'

export type DispatcherServices = {
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
  }) => Promise<unknown>
  reposRemove: (input: { repoId: string; acknowledgeDependentSessions?: boolean }) => Promise<unknown>
  sessionsList: (input: { repoId?: string }) => Promise<unknown>
  sessionsGet: (input: { sessionId: string }) => Promise<unknown>
  sessionsCreate: (input: z.infer<typeof createSessionInputSchema>) => Promise<unknown>
  sessionsClose: (input: { sessionId: string }) => Promise<unknown>
  sessionsRestart: (input: { sessionId: string }) => Promise<unknown>
  sessionsSleep: (input: { sessionId: string }) => Promise<unknown>
  sessionsWake: (input: { sessionId: string }) => Promise<unknown>
  sessionsRemove: (input: { sessionId: string; stopIfLive?: boolean }) => Promise<unknown>
  sessionsDiscard: (input: { sessionId: string; confirmBranch: string }) => Promise<unknown>
  sessionsRecoverWorktree: (input: { sessionId: string }) => Promise<unknown>
  branchesList: (input: { repoId: string }) => Promise<unknown>
  branchesRemove: (input: { repoId: string; branch: string; confirmBranch?: string }) => Promise<unknown>
  reviewAreaDiff: (input: {
    sessionId: string
    path: string
    oldPath?: string | null
    scope: 'staged' | 'unstaged' | 'untracked' | 'conflict'
    status: 'modified' | 'added' | 'deleted' | 'renamed'
    binary: boolean
    symlink: boolean | null
    additions: number | null
    deletions: number | null
  }) => Promise<unknown>
  filesList: (input: { sessionId: string; path: string }) => Promise<unknown>
  filesRead: (input: { sessionId: string; path: string }) => Promise<unknown>
  filesWrite: (input: { sessionId: string; path: string; text: string }) => Promise<unknown>
  filesSearch: (input: {
    sessionId: string
    query: string
    caseSensitive: boolean
    limit: number
  }) => Promise<unknown>
  filesCreate: (input: { sessionId: string; path: string; kind: 'file' | 'directory' }) => Promise<unknown>
  filesRename: (input: { sessionId: string; from: string; to: string }) => Promise<unknown>
  filesRemove: (input: { sessionId: string; path: string }) => Promise<unknown>
  gitStatus: (input: { sessionId: string }) => Promise<unknown>
  gitCancelStatus: (input: { sessionId: string }) => Promise<unknown>
  gitOperationState: (input: { sessionId: string }) => Promise<unknown>
  gitOperationContinue: (input: { sessionId: string }) => Promise<unknown>
  gitOperationAbort: (input: { sessionId: string }) => Promise<unknown>
  gitRangeDiff: (input: { sessionId: string; from: string; to: string }) => Promise<unknown>
  gitWatchStatus: (input: { sessionId: string; active: boolean }) => Promise<unknown>
  gitStageAll: (input: { sessionId: string }) => Promise<unknown>
  gitUnstageAll: (input: { sessionId: string }) => Promise<unknown>
  gitCommit: (input: {
    sessionId: string
    message: string
    all?: boolean
    signOff?: boolean
    sign?: boolean
  }) => Promise<unknown>
  gitDiscardPath: (input: { sessionId: string; path: string }) => Promise<unknown>
  gitSetPathStaged: (input: { sessionId: string; path: string; staged: boolean }) => Promise<unknown>
  gitSetPathsStaged: (input: z.infer<typeof gitSetPathsStagedInputSchema>) => Promise<unknown>
  gitDiscardPaths: (input: z.infer<typeof gitDiscardPathsInputSchema>) => Promise<unknown>
  gitBranches: (input: { sessionId: string }) => Promise<unknown>
  gitSwitchBranch: (input: { sessionId: string; branch: string }) => Promise<unknown>
  gitCreateBranch: (input: { sessionId: string; branch: string; at?: string }) => Promise<unknown>
  gitCreateTag: (input: { sessionId: string; name: string; oid: string }) => Promise<unknown>
  gitDeleteTag: (input: { sessionId: string; name: string }) => Promise<unknown>
  gitTags: (input: { sessionId: string }) => Promise<unknown>
  gitCheckoutRef: (input: { sessionId: string; ref: string }) => Promise<unknown>
  gitFileAtRevision: (input: { sessionId: string; rev: string; path: string }) => Promise<unknown>
  gitIndexFile: (input: { sessionId: string; path: string }) => Promise<unknown>
  gitApplyPatch: (input: {
    sessionId: string
    path: string
    patch: string
    mode: 'stage' | 'unstage' | 'discard'
  }) => Promise<unknown>
  gitConflictFile: (input: { sessionId: string; path: string }) => Promise<unknown>
  gitResolveConflict: (input: { sessionId: string; path: string }) => Promise<unknown>
  gitStashList: (input: { sessionId: string }) => Promise<unknown>
  gitStashPush: (input: {
    sessionId: string
    message: string
    includeUntracked: boolean
    keepIndex: boolean
  }) => Promise<unknown>
  gitStashDiff: (input: { sessionId: string; index: number }) => Promise<unknown>
  gitStashAction: (input: {
    sessionId: string
    index: number
    action: 'apply' | 'pop' | 'drop'
  }) => Promise<unknown>
  gitWorktreeList: (input: { sessionId: string }) => Promise<unknown>
  gitWorktreeAction: (input: {
    sessionId: string
    action: 'lock' | 'unlock' | 'prune' | 'remove'
    path?: string
    reason?: string
  }) => Promise<unknown>
  gitSubmoduleList: (input: { sessionId: string }) => Promise<unknown>
  gitSubmoduleAction: (input: {
    sessionId: string
    action: 'init' | 'update' | 'sync' | 'stage'
    path?: string
  }) => Promise<unknown>
  gitBlame: (input: { sessionId: string; path: string }) => Promise<unknown>
  gitRenameBranch: (input: { sessionId: string; from: string; to: string }) => Promise<unknown>
  gitDeleteBranch: (input: { sessionId: string; branch: string }) => Promise<unknown>
  gitMergeBranch: (input: { sessionId: string; branch: string }) => Promise<unknown>
  gitRebaseBranch: (input: { sessionId: string; branch: string }) => Promise<unknown>
  gitCherryPick: (input: { sessionId: string; oid: string }) => Promise<unknown>
  gitRevert: (input: { sessionId: string; oid: string }) => Promise<unknown>
  gitReset: (input: {
    sessionId: string
    oid: string
    mode: 'soft' | 'mixed' | 'hard'
  }) => Promise<unknown>
  gitPush: (input: { sessionId: string }) => Promise<unknown>
  gitPull: (input: { sessionId: string; rebase?: boolean }) => Promise<unknown>
  gitPublish: (input: { sessionId: string }) => Promise<unknown>
  gitFetch: (input: { sessionId: string }) => Promise<unknown>
  gitRemotes: (input: { sessionId: string }) => Promise<unknown>
  gitFetchRemote: (input: { sessionId: string; remote: string; prune?: boolean }) => Promise<unknown>
  gitAddRemote: (input: { sessionId: string; name: string; url: string }) => Promise<unknown>
  gitRemoveRemote: (input: { sessionId: string; name: string }) => Promise<unknown>
  gitPushTags: (input: { sessionId: string }) => Promise<unknown>
  gitForcePush: (input: { sessionId: string }) => Promise<unknown>
  gitRemoteBranches: (input: { sessionId: string }) => Promise<unknown>
  gitSetUpstream: (input: { sessionId: string; upstream: string }) => Promise<unknown>
  gitAmend: (input: { sessionId: string; message?: string; sign?: boolean }) => Promise<unknown>
  gitHistory: (input: { sessionId: string; limit: number }) => Promise<unknown>
  gitLog: (input: {
    sessionId: string
    limit: number
    skip: number
    ref?: string
    allRefs?: boolean
    path?: string
  }) => Promise<unknown>
  gitCommitDetail: (input: { sessionId: string; oid: string; parent?: string }) => Promise<unknown>
  gitRevisionFileDiff: (input: {
    sessionId: string
    from: string
    to: string
    path: string
    oldPath?: string
  }) => Promise<unknown>
  gitCompare: (input: { sessionId: string }) => Promise<unknown>
  tasksList: (input: { repoId?: string; statuses?: string[]; limit?: number }) => Promise<unknown>
  tasksCreate: (input: { repoId: string; title?: string; prompt: string; harness: string }) => Promise<unknown>
  tasksCancel: (input: { taskId: string }) => Promise<unknown>
  tasksRetry: (input: { taskId: string }) => Promise<unknown>
  tasksHistory: (input: { taskId: string }) => Promise<unknown>
  tasksChanges: (input: { taskId: string }) => Promise<unknown>
  tasksDecideReview: (input: {
    taskId: string
    decision: 'accepted' | 'rejected'
    note?: string | null
    replace?: boolean
  }) => Promise<unknown>
  tasksSettings: () => Promise<unknown>
  tasksSetSettings: (input: { maxConcurrent: number }) => Promise<unknown>
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
  harnessList: (input: { force?: boolean; repoId?: string }) => Promise<unknown>
  wslListDistros: () => Promise<unknown>
  terminalAttach: (input: { sessionId: string }) => Promise<unknown>
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
    return { ok: false, error: toAppError(error) }
  }
}

/**
 * Validates every renderer request against the Work 2 schemas and maps failures
 * to stable app errors. IPC registration only forwards channels to this table.
 */
export function createDispatcher(services: DispatcherServices): Dispatcher {
  return async (channel, rawInput) => {
    switch (channel) {
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
        const input = parse(sessionTargetInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.sessionsRecoverWorktree(input))
      }

      case IPC_CHANNELS.branchesList: {
        const input = parse(listBranchesInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.branchesList(input))
      }

      case IPC_CHANNELS.branchesRemove: {
        const input = parse(removeBranchInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.branchesRemove(input))
      }

      case IPC_CHANNELS.reviewAreaDiff: {
        const input = parse(reviewAreaDiffInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.reviewAreaDiff(input))
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

      case IPC_CHANNELS.gitStatus: {
        const input = parse(gitStatusInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitStatus(input))
      }

      case IPC_CHANNELS.gitCancelStatus: {
        const input = parse(gitCancelStatusInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitCancelStatus(input))
      }

      case IPC_CHANNELS.gitOperationState: {
        const input = parse(gitOperationStateInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitOperationState(input))
      }

      case IPC_CHANNELS.gitOperationContinue: {
        const input = parse(gitOperationActionInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitOperationContinue(input))
      }

      case IPC_CHANNELS.gitOperationAbort: {
        const input = parse(gitOperationActionInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitOperationAbort(input))
      }

      case IPC_CHANNELS.gitRangeDiff: {
        const input = parse(gitRangeDiffInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitRangeDiff(input))
      }

      case IPC_CHANNELS.gitWatchStatus: {
        const input = parse(gitWatchStatusInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitWatchStatus(input))
      }

      case IPC_CHANNELS.gitStageAll: {
        const input = parse(gitStageAllInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitStageAll(input))
      }

      case IPC_CHANNELS.gitUnstageAll: {
        const input = parse(gitUnstageAllInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitUnstageAll(input))
      }

      case IPC_CHANNELS.gitCommit: {
        const input = parse(gitCommitInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitCommit(input))
      }

      case IPC_CHANNELS.gitDiscardPath: {
        const input = parse(gitDiscardPathInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitDiscardPath(input))
      }

      case IPC_CHANNELS.gitSetPathStaged: {
        const input = parse(gitSetPathStagedInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitSetPathStaged(input))
      }

      case IPC_CHANNELS.gitSetPathsStaged: {
        const input = parse(gitSetPathsStagedInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitSetPathsStaged(input))
      }

      case IPC_CHANNELS.gitDiscardPaths: {
        const input = parse(gitDiscardPathsInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitDiscardPaths(input))
      }

      case IPC_CHANNELS.gitBranches: {
        const input = parse(gitBranchesInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitBranches(input))
      }

      case IPC_CHANNELS.gitSwitchBranch: {
        const input = parse(gitSwitchBranchInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitSwitchBranch(input))
      }

      case IPC_CHANNELS.gitCreateBranch: {
        const input = parse(gitCreateBranchInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitCreateBranch(input))
      }

      case IPC_CHANNELS.gitCreateTag: {
        const input = parse(gitCreateTagInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitCreateTag(input))
      }

      case IPC_CHANNELS.gitDeleteTag: {
        const input = parse(gitDeleteTagInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitDeleteTag(input))
      }

      case IPC_CHANNELS.gitTags: {
        const input = parse(gitRemoteOpInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitTags(input))
      }

      case IPC_CHANNELS.gitCheckoutRef: {
        const input = parse(gitCheckoutRefInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitCheckoutRef(input))
      }

      case IPC_CHANNELS.gitFileAtRevision: {
        const input = parse(gitFileAtRevisionInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitFileAtRevision(input))
      }

      case IPC_CHANNELS.gitIndexFile: {
        const input = parse(gitIndexFileInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitIndexFile(input))
      }

      case IPC_CHANNELS.gitApplyPatch: {
        const input = parse(gitApplyPatchInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitApplyPatch(input))
      }

      case IPC_CHANNELS.gitConflictFile: {
        const input = parse(gitConflictFileInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitConflictFile(input))
      }

      case IPC_CHANNELS.gitResolveConflict: {
        const input = parse(gitResolveConflictInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitResolveConflict(input))
      }

      case IPC_CHANNELS.gitStashList: {
        const input = parse(gitRemoteOpInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitStashList(input))
      }

      case IPC_CHANNELS.gitStashPush: {
        const input = parse(gitStashPushInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitStashPush(input))
      }

      case IPC_CHANNELS.gitStashDiff: {
        const input = parse(gitStashTargetInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitStashDiff(input))
      }

      case IPC_CHANNELS.gitStashAction: {
        const input = parse(gitStashActionInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitStashAction(input))
      }

      case IPC_CHANNELS.gitWorktreeList: {
        const input = parse(gitRemoteOpInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitWorktreeList(input))
      }

      case IPC_CHANNELS.gitWorktreeAction: {
        const input = parse(gitWorktreeActionInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitWorktreeAction(input))
      }

      case IPC_CHANNELS.gitSubmoduleList: {
        const input = parse(gitRemoteOpInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitSubmoduleList(input))
      }

      case IPC_CHANNELS.gitSubmoduleAction: {
        const input = parse(gitSubmoduleActionInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitSubmoduleAction(input))
      }

      case IPC_CHANNELS.gitBlame: {
        const input = parse(gitBlameInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitBlame(input))
      }

      case IPC_CHANNELS.gitRenameBranch: {
        const input = parse(gitRenameBranchInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitRenameBranch(input))
      }

      case IPC_CHANNELS.gitDeleteBranch: {
        const input = parse(gitDeleteBranchInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitDeleteBranch(input))
      }

      case IPC_CHANNELS.gitMergeBranch: {
        const input = parse(gitMergeBranchInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitMergeBranch(input))
      }

      case IPC_CHANNELS.gitRebaseBranch: {
        const input = parse(gitRebaseBranchInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitRebaseBranch(input))
      }

      case IPC_CHANNELS.gitCherryPick: {
        const input = parse(gitCommitActionInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitCherryPick(input))
      }

      case IPC_CHANNELS.gitRevert: {
        const input = parse(gitCommitActionInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitRevert(input))
      }

      case IPC_CHANNELS.gitReset: {
        const input = parse(gitResetInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitReset(input))
      }

      case IPC_CHANNELS.gitPush: {
        const input = parse(gitRemoteOpInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitPush(input))
      }

      case IPC_CHANNELS.gitPull: {
        const input = parse(gitPullInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitPull(input))
      }

      case IPC_CHANNELS.gitPublish: {
        const input = parse(gitRemoteOpInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitPublish(input))
      }

      case IPC_CHANNELS.gitFetch: {
        const input = parse(gitRemoteOpInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitFetch(input))
      }

      case IPC_CHANNELS.gitRemotes: {
        const input = parse(gitRemoteOpInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitRemotes(input))
      }

      case IPC_CHANNELS.gitFetchRemote: {
        const input = parse(gitFetchRemoteInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitFetchRemote(input))
      }

      case IPC_CHANNELS.gitAddRemote: {
        const input = parse(gitAddRemoteInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitAddRemote(input))
      }

      case IPC_CHANNELS.gitRemoveRemote: {
        const input = parse(gitRemoveRemoteInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitRemoveRemote(input))
      }

      case IPC_CHANNELS.gitPushTags: {
        const input = parse(gitRemoteOpInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitPushTags(input))
      }

      case IPC_CHANNELS.gitForcePush: {
        const input = parse(gitRemoteOpInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitForcePush(input))
      }

      case IPC_CHANNELS.gitRemoteBranches: {
        const input = parse(gitRemoteOpInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitRemoteBranches(input))
      }

      case IPC_CHANNELS.gitSetUpstream: {
        const input = parse(gitSetUpstreamInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitSetUpstream(input))
      }

      case IPC_CHANNELS.gitAmend: {
        const input = parse(gitAmendInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitAmend(input))
      }

      case IPC_CHANNELS.gitHistory: {
        const input = parse(gitHistoryInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitHistory(input))
      }

      case IPC_CHANNELS.gitLog: {
        const input = parse(gitLogInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitLog(input))
      }

      case IPC_CHANNELS.gitCommitDetail: {
        const input = parse(gitCommitDetailInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitCommitDetail(input))
      }

      case IPC_CHANNELS.gitRevisionFileDiff: {
        const input = parse(gitRevisionFileDiffInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitRevisionFileDiff(input))
      }

      case IPC_CHANNELS.gitCompare: {
        const input = parse(gitRemoteOpInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitCompare(input))
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

      case IPC_CHANNELS.tasksSettings: {
        return run(() => services.tasksSettings())
      }

      case IPC_CHANNELS.tasksSetSettings: {
        const input = parse(taskSettingsInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.tasksSetSettings(input))
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

      case IPC_CHANNELS.harnessList: {
        const input = parse(harnessListInputSchema, rawInput ?? {})
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.harnessList(input))
      }

      case IPC_CHANNELS.wslListDistros:
        // No input: discovery is machine-wide and takes no parameters.
        return run(() => services.wslListDistros())

      case IPC_CHANNELS.terminalAttach: {
        const input = parse(terminalAttachInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.terminalAttach(input))
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
