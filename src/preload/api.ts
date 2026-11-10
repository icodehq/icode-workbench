import type { GitApi, IcodeApi, RuntimeInfo, ViewCommand } from '../shared/icode-api'
import type { GitStatusWatchEvent } from '../shared/domain/git-workspace'
import { GIT_COMMAND_NAMES } from '../shared/ipc/git-commands'
import type { FilesChangedEvent } from '../shared/domain/workspace-files'
import { IPC_CHANNELS } from '../shared/schemas/ipc'
import type { IpcResult, RendererSessionEvent } from '../shared/schemas/ipc'
import type { LocaleState } from '../shared/schemas/locale'
import type { Locale } from '../shared/i18n/locales'

export type InvokeFn = (channel: string, input?: unknown) => Promise<unknown>
export type SubscribeFn = (channel: string, listener: (payload: unknown) => void) => () => void

/**
 * Builds the frozen renderer API from injected IPC primitives, so the exposed
 * surface can be tested without Electron. The renderer gets named operations
 * only: no channel strings, no ipcRenderer, no Node primitives.
 */

/**
 * One renderer method per Git command, generated from the shared registry.
 * Call sites keep their names; only the transport is unified.
 */
function createGitApi(
  call: <T>(channel: string, input?: unknown) => Promise<IpcResult<T>>,
  subscribe: SubscribeFn
): GitApi {
  const methods: Record<string, unknown> = {}
  for (const op of GIT_COMMAND_NAMES) {
    methods[op] = (input?: unknown) => call(IPC_CHANNELS.gitInvoke, { op, input })
  }
  methods.onStatusChange = (listener: (event: GitStatusWatchEvent) => void) =>
    subscribe(IPC_CHANNELS.gitStatusEvent, (payload) =>
      listener(payload as GitStatusWatchEvent)
    )
  return Object.freeze(methods) as unknown as GitApi
}

export function createIcodeApi(
  invoke: InvokeFn,
  subscribe: SubscribeFn,
  initialLocale: Locale = 'en'
): IcodeApi {
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
    locale: {
      // Synchronous: the renderer reads this before React mounts.
      initial: initialLocale,
      get: () => call(IPC_CHANNELS.localeGet),
      set: (input) => call(IPC_CHANNELS.localeSet, input),
      onChanged: (listener) =>
        subscribe(IPC_CHANNELS.localeChangedEvent, (payload) =>
          listener(payload as LocaleState)
        )
    },
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
    files: {
      list: (input) => call(IPC_CHANNELS.filesList, input),
      read: (input) => call(IPC_CHANNELS.filesRead, input),
      write: (input) => call(IPC_CHANNELS.filesWrite, input),
      search: (input) => call(IPC_CHANNELS.filesSearch, input),
      cancelSearch: (input) => call(IPC_CHANNELS.filesCancelSearch, input),
      replace: (input) => call(IPC_CHANNELS.filesReplace, input),
      create: (input) => call(IPC_CHANNELS.filesCreate, input),
      rename: (input) => call(IPC_CHANNELS.filesRename, input),
      remove: (input) => call(IPC_CHANNELS.filesRemove, input),
      removeMany: (input) => call(IPC_CHANNELS.filesRemoveMany, input),
      moveMany: (input) => call(IPC_CHANNELS.filesMoveMany, input),
      copyMany: (input) => call(IPC_CHANNELS.filesCopyMany, input),
      copyPaths: (input) => call(IPC_CHANNELS.filesCopyPaths, input),
      stat: (input) => call(IPC_CHANNELS.filesStat, input),
      trashMany: (input) => call(IPC_CHANNELS.filesTrash, input),
      restoreTrash: (input) => call(IPC_CHANNELS.filesRestoreTrash, input),
      listTrash: (input) => call(IPC_CHANNELS.filesListTrash, input),
      watch: (input) => call(IPC_CHANNELS.filesWatch, input),
      onChanged: (listener) =>
        subscribe(IPC_CHANNELS.filesChangedEvent, (payload) =>
          listener(payload as FilesChangedEvent)
        )
    },
    git: createGitApi(call, subscribe),
    tasks: {
      list: (input) => call(IPC_CHANNELS.tasksList, input ?? {}),
      create: (input) => call(IPC_CHANNELS.tasksCreate, input),
      approve: (input) => call(IPC_CHANNELS.tasksApprove, input),
      reject: (input) => call(IPC_CHANNELS.tasksReject, input),
      cancel: (input) => call(IPC_CHANNELS.tasksCancel, input),
      retry: (input) => call(IPC_CHANNELS.tasksRetry, input),
      resume: (input) => call(IPC_CHANNELS.tasksResume, input),
      history: (input) => call(IPC_CHANNELS.tasksHistory, input),
      changes: (input) => call(IPC_CHANNELS.tasksChanges, input),
      decideReview: (input) => call(IPC_CHANNELS.tasksDecideReview, input),
      archive: (input) => call(IPC_CHANNELS.tasksArchive, input),
      unarchive: (input) => call(IPC_CHANNELS.tasksUnarchive, input),
      archiveFinished: (input) => call(IPC_CHANNELS.tasksArchiveFinished, input),
      settings: () => call(IPC_CHANNELS.tasksSettings),
      setSettings: (input) => call(IPC_CHANNELS.tasksSetSettings, input)
    },
    supervisor: {
      open: (input) => call(IPC_CHANNELS.supervisorOpen, input)
    },
    assistant: {
      state: () => call(IPC_CHANNELS.assistantState),
      messages: (input) => call(IPC_CHANNELS.assistantMessagesList, input),
      conversations: () => call(IPC_CHANNELS.assistantConversationsList, {}),
      notifications: (input) => call(IPC_CHANNELS.assistantNotificationsList, input),
      focus: (input) => call(IPC_CHANNELS.assistantFocus, input),
      send: (input) => call(IPC_CHANNELS.assistantSend, input),
      markRead: (input) => call(IPC_CHANNELS.assistantMarkRead, input),
      stop: () => call(IPC_CHANNELS.assistantStop),
      newConversation: () => call(IPC_CHANNELS.assistantNewConversation, {}),
      settings: () => call(IPC_CHANNELS.assistantSettingsGet),
      setSettings: (input) => call(IPC_CHANNELS.assistantSetSettings, input),
      onEvent: (listener) =>
        subscribe(IPC_CHANNELS.assistantEvent, (payload) =>
          listener(payload as import('../shared/schemas/assistant').AssistantEventPayload)
        )
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
    providers: {
      list: () => call(IPC_CHANNELS.providersList),
      create: (input) => call(IPC_CHANNELS.providersCreate, input),
      update: (input) => call(IPC_CHANNELS.providersUpdate, input),
      remove: (input) => call(IPC_CHANNELS.providersRemove, input),
      select: (input) => call(IPC_CHANNELS.providersSelect, input),
      test: (input) => call(IPC_CHANNELS.providersTest, input)
    },
    ai: {
      commitMessage: (input) => call(IPC_CHANNELS.aiCommitMessage, input),
      cancelCommitMessage: (input) => call(IPC_CHANNELS.aiCancelCommitMessage, input)
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
      openExternal: (input) => call(IPC_CHANNELS.windowOpenExternal, input),
      onMaximizedChange: (listener) =>
        subscribe(IPC_CHANNELS.windowMaximizedEvent, (payload) => listener(Boolean(payload))),
      onBeforeClose: (listener) =>
        subscribe(IPC_CHANNELS.windowBeforeClose, () => listener()),
      respondClose: (action) => call(IPC_CHANNELS.windowCloseResponse, { action })
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
  Object.freeze(api.locale)
  Object.freeze(api.repos)
  Object.freeze(api.sessions)
  Object.freeze(api.assistant)
  Object.freeze(api.harness)
  Object.freeze(api.branches)
  Object.freeze(api.files)
  Object.freeze(api.git)
  Object.freeze(api.activity)
  Object.freeze(api.terminal)
  Object.freeze(api.window)
  return Object.freeze(api)
}
