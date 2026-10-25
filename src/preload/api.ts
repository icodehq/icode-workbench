import type { AdeApi, RuntimeInfo } from '../shared/ade-api'
import { IPC_CHANNELS } from '../shared/schemas/ipc'
import type { IpcResult, RendererSessionEvent } from '../shared/schemas/ipc'

export type InvokeFn = (channel: string, input?: unknown) => Promise<unknown>
export type SubscribeFn = (channel: string, listener: (payload: unknown) => void) => () => void

/**
 * Builds the frozen renderer API from injected IPC primitives, so the exposed
 * surface can be tested without Electron. The renderer gets named operations
 * only: no channel strings, no ipcRenderer, no Node primitives.
 */
export function createAdeApi(invoke: InvokeFn, subscribe: SubscribeFn): AdeApi {
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

  const api: AdeApi = {
    getRuntimeInfo: (): Promise<RuntimeInfo> =>
      invoke(IPC_CHANNELS.runtimeInfo) as Promise<RuntimeInfo>,
    repos: {
      list: () => call(IPC_CHANNELS.reposList),
      add: (input) => call(IPC_CHANNELS.reposAdd, input),
      remove: (input) => call(IPC_CHANNELS.reposRemove, input)
    },
    sessions: {
      list: (input) => call(IPC_CHANNELS.sessionsList, input),
      get: (input) => call(IPC_CHANNELS.sessionsGet, input),
      create: (input) => call(IPC_CHANNELS.sessionsCreate, input),
      close: (input) => call(IPC_CHANNELS.sessionsClose, input),
      restart: (input) => call(IPC_CHANNELS.sessionsRestart, input),
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
      list: (input) => call(IPC_CHANNELS.reviewList, input),
      diff: (input) => call(IPC_CHANNELS.reviewDiff, input)
    },
    files: {
      list: (input) => call(IPC_CHANNELS.filesList, input),
      read: (input) => call(IPC_CHANNELS.filesRead, input),
      write: (input) => call(IPC_CHANNELS.filesWrite, input),
      search: (input) => call(IPC_CHANNELS.filesSearch, input)
    },
    git: {
      status: (input) => call(IPC_CHANNELS.gitStatus, input),
      stageAll: (input) => call(IPC_CHANNELS.gitStageAll, input),
      unstageAll: (input) => call(IPC_CHANNELS.gitUnstageAll, input),
      commit: (input) => call(IPC_CHANNELS.gitCommit, input),
      discardPath: (input) => call(IPC_CHANNELS.gitDiscardPath, input)
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
  return Object.freeze(api)
}
