import type { IcodeApi, RuntimeInfo, ViewCommand } from '../shared/icode-api'
import type { GitStatusWatchEvent } from '../shared/domain/git-workspace'
import { IPC_CHANNELS } from '../shared/schemas/ipc'
import type { IpcResult, RendererSessionEvent } from '../shared/schemas/ipc'

export type InvokeFn = (channel: string, input?: unknown) => Promise<unknown>
export type SubscribeFn = (channel: string, listener: (payload: unknown) => void) => () => void

/**
 * Builds the frozen renderer API from injected IPC primitives, so the exposed
 * surface can be tested without Electron. The renderer gets named operations
 * only: no channel strings, no ipcRenderer, no Node primitives.
 */
export function createIcodeApi(invoke: InvokeFn, subscribe: SubscribeFn): IcodeApi {
  const listeners = new Set<(event: RendererSessionEvent) => void>()
  let disposeChannel: (() => void) | null = null

  const ensureSubscription = (): void => {
    if (disposeChannel) return
    disposeChannel = subscribe(IPC_CHANNELS.sessionEvent, (payload) => {
      for (const listener of listeners) listener(payload as RendererSessionEvent)
    })
  }

  const releaseIfEmpty = (): void => {
    if (listeners.size > 0 || !disposeChannel) return
    disposeChannel()
    disposeChannel = null
  }

  const call = <T>(channel: string, input?: unknown): Promise<IpcResult<T>> =>
    invoke(channel, input) as Promise<IpcResult<T>>

  const api: IcodeApi = {
    getRuntimeInfo: (): Promise<RuntimeInfo> =>
      invoke(IPC_CHANNELS.runtimeInfo) as Promise<RuntimeInfo>,
    repos: {
      list: () => call(IPC_CHANNELS.reposList),
      add: (input) => call(IPC_CHANNELS.reposAdd, input),
      inspect: (input) => call(IPC_CHANNELS.reposInspect, input),
      initialize: (input) => call(IPC_CHANNELS.reposInitialize, input),
      retryPreparation: (input) => call(IPC_CHANNELS.reposRetryPreparation, input),
      pickFolder: (input) => call(IPC_CHANNELS.reposPickFolder, input),
      remove: (input) => call(IPC_CHANNELS.reposRemove, input)
    },
    sessions: {
      list: (input) => call(IPC_CHANNELS.sessionsList, input),
      get: (input) => call(IPC_CHANNELS.sessionsGet, input),
      create: (input) => call(IPC_CHANNELS.sessionsCreate, input),
      close: (input) => call(IPC_CHANNELS.sessionsClose, input),
      restart: (input) => call(IPC_CHANNELS.sessionsRestart, input),
      sleep: (input) => call(IPC_CHANNELS.sessionsSleep, input),
      wake: (input) => call(IPC_CHANNELS.sessionsWake, input),
      remove: (input) => call(IPC_CHANNELS.sessionsRemove, input),
      discard: (input) => call(IPC_CHANNELS.sessionsDiscard, input),
      recoverWorktree: (input) => call(IPC_CHANNELS.sessionsRecoverWorktree, input)
    },
    branches: {
      list: (input) => call(IPC_CHANNELS.branchesList, input),
      remove: (input) => call(IPC_CHANNELS.branchesRemove, input)
    },
    activity: {
      list: () => call(IPC_CHANNELS.activityList),
      clearUnread: (input) => call(IPC_CHANNELS.activityClearUnread, input)
    },
    review: {
      areaDiff: (input) => call(IPC_CHANNELS.reviewAreaDiff, input)
    },
    files: {
      list: (input) => call(IPC_CHANNELS.filesList, input),
      read: (input) => call(IPC_CHANNELS.filesRead, input),
      write: (input) => call(IPC_CHANNELS.filesWrite, input),
      search: (input) => call(IPC_CHANNELS.filesSearch, input),
      create: (input) => call(IPC_CHANNELS.filesCreate, input),
      rename: (input) => call(IPC_CHANNELS.filesRename, input),
      remove: (input) => call(IPC_CHANNELS.filesRemove, input)
    },
    git: {
      status: (input) => call(IPC_CHANNELS.gitStatus, input),
      cancelStatus: (input) => call(IPC_CHANNELS.gitCancelStatus, input),
      operationState: (input) => call(IPC_CHANNELS.gitOperationState, input),
      continueOperation: (input) => call(IPC_CHANNELS.gitOperationContinue, input),
      abortOperation: (input) => call(IPC_CHANNELS.gitOperationAbort, input),
      rangeDiff: (input) => call(IPC_CHANNELS.gitRangeDiff, input),
      watchStatus: (input) => call(IPC_CHANNELS.gitWatchStatus, input),
      onStatusChange: (listener) =>
        subscribe(IPC_CHANNELS.gitStatusEvent, (payload) => listener(payload as GitStatusWatchEvent)),
      stageAll: (input) => call(IPC_CHANNELS.gitStageAll, input),
      unstageAll: (input) => call(IPC_CHANNELS.gitUnstageAll, input),
      commit: (input) => call(IPC_CHANNELS.gitCommit, input),
      discardPath: (input) => call(IPC_CHANNELS.gitDiscardPath, input),
      setPathStaged: (input) => call(IPC_CHANNELS.gitSetPathStaged, input),
      setPathsStaged: (input) => call(IPC_CHANNELS.gitSetPathsStaged, input),
      discardPaths: (input) => call(IPC_CHANNELS.gitDiscardPaths, input),
      branches: (input) => call(IPC_CHANNELS.gitBranches, input),
      switchBranch: (input) => call(IPC_CHANNELS.gitSwitchBranch, input),
      createBranch: (input) => call(IPC_CHANNELS.gitCreateBranch, input),
      createTag: (input) => call(IPC_CHANNELS.gitCreateTag, input),
      deleteTag: (input) => call(IPC_CHANNELS.gitDeleteTag, input),
      tags: (input) => call(IPC_CHANNELS.gitTags, input),
      checkoutRef: (input) => call(IPC_CHANNELS.gitCheckoutRef, input),
      fileAtRevision: (input) => call(IPC_CHANNELS.gitFileAtRevision, input),
      indexFile: (input) => call(IPC_CHANNELS.gitIndexFile, input),
      applyPatch: (input) => call(IPC_CHANNELS.gitApplyPatch, input),
      conflictFile: (input) => call(IPC_CHANNELS.gitConflictFile, input),
      resolveConflict: (input) => call(IPC_CHANNELS.gitResolveConflict, input),
      stashList: (input) => call(IPC_CHANNELS.gitStashList, input),
      stashPush: (input) => call(IPC_CHANNELS.gitStashPush, input),
      stashDiff: (input) => call(IPC_CHANNELS.gitStashDiff, input),
      stashAction: (input) => call(IPC_CHANNELS.gitStashAction, input),
      worktreeList: (input) => call(IPC_CHANNELS.gitWorktreeList, input),
      worktreeAction: (input) => call(IPC_CHANNELS.gitWorktreeAction, input),
      submoduleList: (input) => call(IPC_CHANNELS.gitSubmoduleList, input),
      submoduleAction: (input) => call(IPC_CHANNELS.gitSubmoduleAction, input),
      blame: (input) => call(IPC_CHANNELS.gitBlame, input),
      renameBranch: (input) => call(IPC_CHANNELS.gitRenameBranch, input),
      deleteBranch: (input) => call(IPC_CHANNELS.gitDeleteBranch, input),
      mergeBranch: (input) => call(IPC_CHANNELS.gitMergeBranch, input),
      rebaseBranch: (input) => call(IPC_CHANNELS.gitRebaseBranch, input),
      cherryPick: (input) => call(IPC_CHANNELS.gitCherryPick, input),
      revert: (input) => call(IPC_CHANNELS.gitRevert, input),
      reset: (input) => call(IPC_CHANNELS.gitReset, input),
      push: (input) => call(IPC_CHANNELS.gitPush, input),
      pull: (input) => call(IPC_CHANNELS.gitPull, input),
      publish: (input) => call(IPC_CHANNELS.gitPublish, input),
      fetch: (input) => call(IPC_CHANNELS.gitFetch, input),
      remotes: (input) => call(IPC_CHANNELS.gitRemotes, input),
      fetchRemote: (input) => call(IPC_CHANNELS.gitFetchRemote, input),
      addRemote: (input) => call(IPC_CHANNELS.gitAddRemote, input),
      removeRemote: (input) => call(IPC_CHANNELS.gitRemoveRemote, input),
      pushTags: (input) => call(IPC_CHANNELS.gitPushTags, input),
      forcePush: (input) => call(IPC_CHANNELS.gitForcePush, input),
      remoteBranches: (input) => call(IPC_CHANNELS.gitRemoteBranches, input),
      setUpstream: (input) => call(IPC_CHANNELS.gitSetUpstream, input),
      amend: (input) => call(IPC_CHANNELS.gitAmend, input),
      history: (input) => call(IPC_CHANNELS.gitHistory, input),
      log: (input) => call(IPC_CHANNELS.gitLog, input),
      commitDetail: (input) => call(IPC_CHANNELS.gitCommitDetail, input),
      revisionFileDiff: (input) => call(IPC_CHANNELS.gitRevisionFileDiff, input),
      compare: (input) => call(IPC_CHANNELS.gitCompare, input)
    },
    tasks: {
      list: (input) => call(IPC_CHANNELS.tasksList, input ?? {}),
      create: (input) => call(IPC_CHANNELS.tasksCreate, input),
      cancel: (input) => call(IPC_CHANNELS.tasksCancel, input),
      retry: (input) => call(IPC_CHANNELS.tasksRetry, input),
      history: (input) => call(IPC_CHANNELS.tasksHistory, input),
      changes: (input) => call(IPC_CHANNELS.tasksChanges, input),
      decideReview: (input) => call(IPC_CHANNELS.tasksDecideReview, input),
      settings: () => call(IPC_CHANNELS.tasksSettings),
      setSettings: (input) => call(IPC_CHANNELS.tasksSetSettings, input)
    },
    schedules: {
      list: (input) => call(IPC_CHANNELS.schedulesList, input ?? {}),
      create: (input) => call(IPC_CHANNELS.schedulesCreate, input),
      update: (input) => call(IPC_CHANNELS.schedulesUpdate, input),
      setEnabled: (input) => call(IPC_CHANNELS.schedulesSetEnabled, input),
      runNow: (input) => call(IPC_CHANNELS.schedulesRunNow, input),
      remove: (input) => call(IPC_CHANNELS.schedulesRemove, input)
    },
    harness: {
      list: (input) => call(IPC_CHANNELS.harnessList, input ?? {})
    },
    wsl: {
      listDistros: () => call(IPC_CHANNELS.wslListDistros)
    },
    terminal: {
      attach: (input) => call(IPC_CHANNELS.terminalAttach, input),
      write: (input) => call(IPC_CHANNELS.terminalWrite, input),
      resize: (input) => call(IPC_CHANNELS.terminalResize, input)
    },
    window: {
      minimize: () => call(IPC_CHANNELS.windowMinimize),
      toggleMaximize: () => call(IPC_CHANNELS.windowToggleMaximize),
      close: () => call(IPC_CHANNELS.windowClose),
      isMaximized: () => call(IPC_CHANNELS.windowIsMaximized),
      onMaximizedChange: (listener) =>
        subscribe(IPC_CHANNELS.windowMaximizedEvent, (payload) => listener(Boolean(payload)))
    },
    onTaskEvent: (listener: () => void) => {
      const handler = (): void => listener()
      // A separate channel, so a terminal byte-stream never wakes the queue UI.
      const off = subscribe(IPC_CHANNELS.taskEvent, handler as never)
      return off
    },
    onRepoEvent: (listener: () => void) => {
      const handler = (): void => listener()
      return subscribe(IPC_CHANNELS.reposEvent, handler as never)
    },
    onViewCommand: (listener: (command: ViewCommand) => void) =>
      subscribe(IPC_CHANNELS.viewCommand, (payload) => listener(payload as ViewCommand)),
    onSessionEvent: (listener) => {
      listeners.add(listener)
      ensureSubscription()
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        listeners.delete(listener)
        releaseIfEmpty()
      }
    }
  }
  Object.freeze(api.repos)
  Object.freeze(api.sessions)
  Object.freeze(api.harness)
  Object.freeze(api.branches)
  Object.freeze(api.review)
  Object.freeze(api.files)
  Object.freeze(api.git)
  Object.freeze(api.activity)
  Object.freeze(api.terminal)
  Object.freeze(api.window)
  return Object.freeze(api)
}
