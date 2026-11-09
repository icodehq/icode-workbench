import {
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  shell,
  type IpcMainInvokeEvent,
  type WebFrameMain
} from 'electron'
import { IPC_CHANNELS, type IpcResult } from '../../shared/schemas/ipc'
import { makeAppError } from '../../shared/domain/errors'
import type { AppRuntime } from '../app/runtime'
import { createDispatcher, type Dispatcher } from './dispatcher'
import { invokeGitCommand } from './git-commands'
import { toRepositorySummary } from './repository-summary'
import { RepositoryFolderPicker } from '../repositories/folder-picker'
import {
  pickRepositoryFolderResultSchema,
  windowOpenExternalInputSchema
} from '../../shared/schemas/ipc'
import { app } from 'electron'
import { respondToWindowClose } from '../window-close'
import { localeSetInputSchema } from '../../shared/schemas/locale'
import type { LocaleService } from '../i18n/locale-service'
import { getMainLocale } from '../i18n/main-i18n'

export const WINDOW_CONTROL_CHANNELS: readonly string[] = [
  IPC_CHANNELS.windowMinimize,
  IPC_CHANNELS.windowToggleMaximize,
  IPC_CHANNELS.windowClose,
  IPC_CHANNELS.windowCloseResponse,
  IPC_CHANNELS.windowIsMaximized,
  IPC_CHANNELS.windowOpenExternal
]

export const LOCALE_CHANNELS: readonly string[] = [
  IPC_CHANNELS.localeGet,
  IPC_CHANNELS.localeSet
]

export const HANDLED_CHANNELS: readonly string[] = [
  ...LOCALE_CHANNELS,
  IPC_CHANNELS.reposList,
  IPC_CHANNELS.reposAdd,
  IPC_CHANNELS.reposInspect,
  IPC_CHANNELS.reposInitialize,
  IPC_CHANNELS.reposRetryPreparation,
  IPC_CHANNELS.reposPickFolder,
  IPC_CHANNELS.reposRemove,
  IPC_CHANNELS.sessionsList,
  IPC_CHANNELS.sessionsGet,
  IPC_CHANNELS.sessionsCreate,
  IPC_CHANNELS.sessionsClose,
  IPC_CHANNELS.sessionsRestart,
  IPC_CHANNELS.sessionsSleep,
  IPC_CHANNELS.sessionsWake,
  IPC_CHANNELS.sessionsRemove,
  IPC_CHANNELS.sessionsDiscard,
  IPC_CHANNELS.sessionsRecoverWorktree,
  IPC_CHANNELS.branchesList,
  IPC_CHANNELS.branchesRemove,
  IPC_CHANNELS.filesList,
  IPC_CHANNELS.filesRead,
  IPC_CHANNELS.filesWrite,
  IPC_CHANNELS.filesSearch,
  IPC_CHANNELS.filesCancelSearch,
  IPC_CHANNELS.filesReplace,
  IPC_CHANNELS.filesCreate,
  IPC_CHANNELS.filesRename,
  IPC_CHANNELS.filesRemove,
  IPC_CHANNELS.filesRemoveMany,
  IPC_CHANNELS.filesMoveMany,
  IPC_CHANNELS.filesCopyMany,
  IPC_CHANNELS.filesCopyPaths,
  IPC_CHANNELS.filesStat,
  IPC_CHANNELS.filesTrash,
  IPC_CHANNELS.filesRestoreTrash,
  IPC_CHANNELS.filesListTrash,
  IPC_CHANNELS.filesWatch,
  IPC_CHANNELS.gitInvoke,
  IPC_CHANNELS.tasksList,
  IPC_CHANNELS.tasksCreate,
  IPC_CHANNELS.tasksApprove,
  IPC_CHANNELS.tasksReject,
  IPC_CHANNELS.tasksCancel,
  IPC_CHANNELS.tasksRetry,
  IPC_CHANNELS.tasksHistory,
  IPC_CHANNELS.tasksChanges,
  IPC_CHANNELS.tasksDecideReview,
  IPC_CHANNELS.tasksArchive,
  IPC_CHANNELS.tasksUnarchive,
  IPC_CHANNELS.tasksArchiveFinished,
  IPC_CHANNELS.tasksSettings,
  IPC_CHANNELS.tasksSetSettings,
  IPC_CHANNELS.supervisorOpen,
  IPC_CHANNELS.assistantState,
  IPC_CHANNELS.assistantMessagesList,
  IPC_CHANNELS.assistantConversationsList,
  IPC_CHANNELS.assistantNotificationsList,
  IPC_CHANNELS.assistantFocus,
  IPC_CHANNELS.assistantSend,
  IPC_CHANNELS.assistantMarkRead,
  IPC_CHANNELS.assistantStop,
  IPC_CHANNELS.assistantNewConversation,
  IPC_CHANNELS.assistantSettingsGet,
  IPC_CHANNELS.assistantSetSettings,
  IPC_CHANNELS.schedulesList,
  IPC_CHANNELS.schedulesCreate,
  IPC_CHANNELS.schedulesUpdate,
  IPC_CHANNELS.schedulesSetEnabled,
  IPC_CHANNELS.schedulesRunNow,
  IPC_CHANNELS.schedulesRemove,
  IPC_CHANNELS.activityList,
  IPC_CHANNELS.activityClearUnread,
  IPC_CHANNELS.harnessList,
  IPC_CHANNELS.aiCommitMessage,
  IPC_CHANNELS.aiCancelCommitMessage,
  IPC_CHANNELS.wslListDistros,
  IPC_CHANNELS.terminalAttach,
  IPC_CHANNELS.terminalWrite,
  IPC_CHANNELS.terminalResize,
  ...WINDOW_CONTROL_CHANNELS
]

/**
 * Only the app's own renderer may call these handlers. A compromised or
 * unexpected frame cannot reach business operations.
 */
export function isTrustedFrame(frame: WebFrameMain | null, devServerUrl?: string): boolean {
  if (!frame) return false
  const url = frame.url
  if (url.startsWith('file://')) return true
  if (devServerUrl && url.startsWith(devServerUrl)) return true
  return false
}

export function createAppDispatcher(
  runtime: AppRuntime,
  getPersistence: () => import('../persistence').AppPersistence
): Dispatcher {
  return createDispatcher({
    reposList: async () => {
      const persistence = getPersistence()
      // Remote projects are asked about by their own host before the list is
      // built; a distro that cannot answer becomes `unknown`, not `missing`.
      await persistence.repositoryService.refreshTargetAvailability()
      // One mapper for both call sites: these hand-built payloads drifting apart
      // is how `target` vanished from the list while still present on add.
      return persistence.repositoryService
        .listRepositories()
        .map((entry) => toRepositorySummary(entry.repository))
    },
    reposAdd: async (input) => {
      const persistence = getPersistence()
      const result = await persistence.repositoryService.addRepository(
        input.path,
        input.target
      )
      return {
        ...toRepositorySummary(result.repository),
        alreadyRegistered: !result.created
      }
    },
    reposInspect: (input) => runtime.projectFolders.inspect(input),
    reposInitialize: async (input) => {
      const result = await runtime.projectFolders.initialize(input)
      return {
        ...toRepositorySummary(result.repository),
        alreadyRegistered: !result.created,
        initialized: result.initialized,
        committedFiles: result.committedFiles
      }
    },
    reposRetryPreparation: async (input) => {
      const persistence = getPersistence()
      const found = persistence.repositoryService.getRepository(input.repoId)
      if (found === null) {
        throw makeAppError('INVALID_ARGUMENT', 'Repository is not registered.', {
          context: { repoId: input.repoId }
        })
      }
      const preparation = runtime.repositoryPreparations.start(found.repository)
      return toRepositorySummary({ ...found.repository, preparation })
    },
    reposPickFolder: async (input) => {
      /*
       * The picker is composed here because only this layer may touch Electron.
       * The dialog is parented to the window that asked, so it behaves like a
       * sheet over iCode rather than a stray window, and the distro's home is read
       * through the same WSL runner every other guest call uses.
       */
      const picker = new RepositoryFolderPicker({
        showOpenDialog: (options) => {
          const parent = BrowserWindow.getFocusedWindow()
          return parent === null
            ? dialog.showOpenDialog(options)
            : dialog.showOpenDialog(parent, options)
        },
        locale: getMainLocale(),
        localHome: () => app.getPath('home'),
        readGuestHome: (distro) => runtime.readGuestHome(distro)
      })
      const result = await picker.pick(input.target, { source: input.source })
      if (result.status !== 'selected') {
        return pickRepositoryFolderResultSchema.parse(result)
      }
      try {
        const resolved = await runtime.projectFolders.resolveLocation({
          path: result.path,
          target: input.target
        })
        return pickRepositoryFolderResultSchema.parse({
          status: 'selected',
          path: resolved.path,
          ...(resolved.translatedFrom === undefined
            ? {}
            : { translatedFrom: resolved.translatedFrom })
        })
      } catch (error) {
        /*
         * A folder the dialog returned is not automatically usable: it may be on
         * a drive the selected distro does not mount, or it may have disappeared
         * between the dialog closing and validation. Return the reason as an
         * unavailable pick so the dialog can keep the user in the flow.
         */
        const appError =
          error !== null && typeof error === 'object' && 'appError' in error
            ? (error as { appError?: { message?: string; detail?: string } }).appError
            : null
        const detail =
          appError?.detail ??
          appError?.message ??
          (error instanceof Error ? error.message : String(error))
        return pickRepositoryFolderResultSchema.parse({
          status: 'unavailable',
          reason: 'path_unavailable',
          detail: (detail.length > 0 ? detail : 'The selected folder could not be used.').slice(
            0,
            500
          )
        })
      }
    },
    reposRemove: async (input) =>
      runtime.removals.remove(input.repoId, {
        ...(input.acknowledgeDependentSessions === undefined
          ? {}
          : { acknowledgeDependentSessions: input.acknowledgeDependentSessions })
      }),
    sessionsList: (input) => runtime.sessions.list(input.repoId),
    sessionsGet: (input) =>
      runtime.sessions.get(input.sessionId),
    sessionsCreate: (input) => runtime.sessions.create(input),
    sessionsClose: async (input) => {
      await runtime.sessions.stop(input.sessionId)
      return null
    },
    sessionsRestart: (input) => runtime.sessions.restart(input.sessionId),
    sessionsSleep: (input) => runtime.sessions.sleep(input.sessionId),
    sessionsWake: (input) => runtime.sessions.wake(input.sessionId),
    sessionsRemove: (input) =>
      runtime.sessionRemovals.remove(input.sessionId, {
        stopIfLive: input.stopIfLive === true
      }),
    sessionsDiscard: (input) =>
      runtime.sessionRemovals.discard(input.sessionId, input.confirmBranch),
    sessionsRecoverWorktree: (input) => runtime.sessions.recoverWorktree(input.sessionId),
    branchesList: (input) => runtime.sessionRemovals.listBranches(input.repoId),
    branchesRemove: (input) =>
      runtime.sessionRemovals.removeBranch(input.repoId, input.branch, input.confirmBranch),
    activityList: async () => runtime.activity.list(),
    activityClearUnread: async (input) => runtime.activity.clearUnread(input.sessionId),
    filesList: (input) => runtime.files.list(input.sessionId, input.path),
    filesRead: (input) => runtime.files.read(input.sessionId, input.path),
    filesWrite: (input) =>
      runtime.files.write(input.sessionId, input.path, input.text, input.expectedEtag),
    filesSearch: (input) =>
      runtime.files.search(input.sessionId, input.query, {
        caseSensitive: input.caseSensitive,
        wholeWord: input.wholeWord,
        regex: input.regex,
        include: input.include,
        exclude: input.exclude,
        limit: input.limit
      }),
    filesCancelSearch: async (input) => ({
      cancelled: runtime.files.cancelSearch(input.sessionId)
    }),
    filesReplace: (input) =>
      runtime.files.replace(input.sessionId, input.query, input.replacement, {
        caseSensitive: input.caseSensitive,
        wholeWord: input.wholeWord,
        regex: input.regex,
        include: input.include,
        exclude: input.exclude,
        paths: input.paths
      }),
    filesCreate: (input) => runtime.files.create(input.sessionId, input.path, input.kind),
    filesRename: (input) => runtime.files.rename(input.sessionId, input.from, input.to),
    filesRemove: (input) => runtime.files.remove(input.sessionId, input.path),
    filesRemoveMany: (input) => runtime.files.removeMany(input.sessionId, input.paths),
    filesMoveMany: (input) =>
      runtime.files.moveMany(input.sessionId, input.paths, input.destination),
    filesCopyMany: (input) =>
      runtime.files.copyMany(input.sessionId, input.paths, input.destination),
    filesCopyPaths: async (input) => {
      const result = await runtime.files.copyPaths(
        input.sessionId,
        input.paths,
        input.format
      )
      if (result.status !== 'ok') return result
      clipboard.writeText(result.paths.join('\n'))
      return { status: 'ok' as const, count: result.paths.length }
    },
    filesStat: (input) => runtime.files.stat(input.sessionId, input.path),
    filesTrash: (input) => runtime.files.trashMany(input.sessionId, input.paths),
    filesRestoreTrash: (input) => runtime.files.restoreTrash(input.sessionId, input.opId),
    filesListTrash: (input) => runtime.files.listTrash(input.sessionId),
    filesWatch: (input) => runtime.filesWatcher.setActive(input.sessionId, input.active),
    gitInvoke: (input) => invokeGitCommand(runtime, input),
    tasksList: (input) => Promise.resolve(runtime.tasks.list(input as never)),
    tasksCreate: (input) => Promise.resolve(outcomeOrThrow(runtime.tasks.create(input as never))),
    tasksApprove: (input) => Promise.resolve(outcomeOrThrow(runtime.tasks.approve(input.taskId))),
    tasksReject: (input) =>
      Promise.resolve(outcomeOrThrow(runtime.tasks.reject(input.taskId, input.note ?? null))),
    tasksCancel: (input) => outcomeOrThrowAsync(runtime.tasks.cancel(input.taskId)),
    tasksRetry: (input) => Promise.resolve(outcomeOrThrow(runtime.tasks.retry(input.taskId))),
    tasksHistory: (input) => Promise.resolve(runtime.tasks.history(input.taskId)),
    tasksChanges: async (input) => outcomeOrThrowAsync(runtime.tasks.changes(input.taskId)),
    tasksDecideReview: (input) =>
      Promise.resolve(
        outcomeOrThrow(
          runtime.tasks.decideReview(input.taskId, input.decision, {
            note: input.note ?? null,
            replace: input.replace === true
          })
        )
      ),
    tasksArchive: (input) => Promise.resolve(outcomeOrThrow(runtime.tasks.archive(input.taskId))),
    tasksUnarchive: (input) =>
      Promise.resolve(outcomeOrThrow(runtime.tasks.unarchive(input.taskId))),
    tasksArchiveFinished: (input) =>
      Promise.resolve(outcomeOrThrow(runtime.tasks.archiveFinished(input.repoId as never))),
    tasksSettings: () => Promise.resolve({ maxConcurrent: runtime.tasks.maxConcurrent() }),
    tasksSetSettings: (input) => Promise.resolve(outcomeOrThrow(runtime.tasks.setMaxConcurrent(input.maxConcurrent))),
    supervisorOpen: (input) => runtime.supervisor.open(input.repoId as never),
    assistantState: () => Promise.resolve(runtime.assistant.state()),
    assistantMessagesList: (input) => Promise.resolve(runtime.assistant.listMessages(input)),
    assistantConversationsList: () =>
      Promise.resolve(runtime.assistant.listConversations()),
    assistantNotificationsList: (input) =>
      Promise.resolve(runtime.assistant.listNotifications(input)),
    assistantFocus: (input) => Promise.resolve(runtime.assistant.focus(input.messageId)),
    assistantSend: (input) => runtime.assistant.send(input),
    assistantMarkRead: (input) => Promise.resolve(runtime.assistant.markRead(input)),
    assistantStop: () => Promise.resolve(runtime.assistant.stop()),
    assistantNewConversation: () =>
      Promise.resolve(runtime.assistant.newConversation()),
    assistantSettingsGet: () => Promise.resolve(runtime.assistant.settings()),
    assistantSetSettings: (input) =>
      Promise.resolve(runtime.assistant.saveSettings(input.settings as never)),
    schedulesList: (input) => Promise.resolve(runtime.schedules.list(input.repoId as never)),
    schedulesCreate: (input) => Promise.resolve(outcomeOrThrow(runtime.schedules.create(input as never))),
    schedulesUpdate: (input) =>
      Promise.resolve(outcomeOrThrow(runtime.schedules.update(input.scheduleId, input as never))),
    schedulesSetEnabled: (input) =>
      Promise.resolve(outcomeOrThrow(runtime.schedules.setEnabled(input.scheduleId, input.enabled))),
    schedulesRunNow: (input) => Promise.resolve(runtime.schedules.runNow(input.scheduleId)),
    schedulesRemove: (input) => Promise.resolve(runtime.schedules.remove(input.scheduleId)),
    // Detection is per execution target: a WSL repository's Harnesses live in its
    // distro, so the repository is part of the question, not just a UI detail.
    harnessList: (input) => runtime.listHarnesses(input?.repoId === undefined ? {} : { repoId: input.repoId }),
    aiCommitMessage: (input) =>
      runtime.commitMessages.generate(input.sessionId, input.requestId),
    aiCancelCommitMessage: async (input) => ({
      cancelled: runtime.commitMessages.cancel(input.requestId)
    }),
    wslListDistros: () => runtime.listWslDistros(),
    terminalAttach: (input) => runtime.sessions.attach(input.sessionId),
    terminalWrite: async (input) => {
      await runtime.sessions.write(input.sessionId, input.incarnationId, input.data)
      return null
    },
    terminalResize: async (input) => {
      await runtime.sessions.resize(input.sessionId, input.incarnationId, input.cols, input.rows)
      return null
    }
  })
}

/**
 * Task services return an outcome union rather than throwing, so a refusal (a
 * duplicate retry, a task already finished) carries its message to the UI
 * instead of becoming an unhandled rejection.
 */
function outcomeOrThrow<T>(outcome: { ok: true; value: T } | { ok: false; error: import('../../shared/domain/errors').AppError }): T {
  if (!outcome.ok) throw outcome.error
  return outcome.value
}

async function outcomeOrThrowAsync<T>(
  pending: Promise<{ ok: true; value: T } | { ok: false; error: import('../../shared/domain/errors').AppError }>
): Promise<T> {
  return outcomeOrThrow(await pending)
}

export function registerAppIpc(
  runtime: AppRuntime,
  getPersistence: () => import('../persistence').AppPersistence,
  options: { devServerUrl?: string; locale?: LocaleService } = {}
): () => void {
  const dispatcher = createAppDispatcher(runtime, getPersistence)
  const windowChannels = new Set<string>(WINDOW_CONTROL_CHANNELS)
  const localeChannels = new Set<string>(LOCALE_CHANNELS)
  const handlers: string[] = []

  for (const channel of WINDOW_CONTROL_CHANNELS) {
    const handler = async (
      event: IpcMainInvokeEvent,
      rawInput?: unknown
    ): Promise<IpcResult<unknown>> => {
      if (!isTrustedFrame(event.senderFrame, options.devServerUrl)) {
        return {
          ok: false,
          error: makeAppError('INVALID_ARGUMENT', 'Request did not come from the iCode renderer.')
        }
      }
      const window = BrowserWindow.fromWebContents(event.sender)
      if (window === null || window.isDestroyed()) {
        return {
          ok: false,
          error: makeAppError('INVALID_ARGUMENT', 'The window is no longer available.')
        }
      }
      if (channel === IPC_CHANNELS.windowMinimize) {
        window.minimize()
        return { ok: true, value: null }
      }
      if (channel === IPC_CHANNELS.windowToggleMaximize) {
        if (window.isMaximized()) window.unmaximize()
        else window.maximize()
        return { ok: true, value: window.isMaximized() }
      }
      if (channel === IPC_CHANNELS.windowClose) {
        window.close()
        return { ok: true, value: null }
      }
      if (channel === IPC_CHANNELS.windowCloseResponse) {
        const raw =
          typeof rawInput === 'object' && rawInput !== null
            ? (rawInput as { action?: unknown }).action
            : undefined
        const action = raw === 'ack' || raw === 'close' ? raw : 'cancel'
        respondToWindowClose(window, action)
        return { ok: true, value: null }
      }
      if (channel === IPC_CHANNELS.windowOpenExternal) {
        const input = windowOpenExternalInputSchema.safeParse(rawInput)
        if (!input.success) {
          return {
            ok: false,
            error: makeAppError('INVALID_ARGUMENT', 'Only http(s) links can be opened.')
          }
        }
        await shell.openExternal(input.data.url)
        return { ok: true, value: null }
      }
      return { ok: true, value: window.isMaximized() }
    }
    ipcMain.handle(channel, handler as Parameters<typeof ipcMain.handle>[1])
    handlers.push(channel)
  }

  for (const channel of LOCALE_CHANNELS) {
    const handler = async (
      event: IpcMainInvokeEvent,
      rawInput?: unknown
    ): Promise<IpcResult<unknown>> => {
      if (!isTrustedFrame(event.senderFrame, options.devServerUrl)) {
        return {
          ok: false,
          error: makeAppError('INVALID_ARGUMENT', 'Request did not come from the iCode renderer.')
        }
      }
      if (options.locale === undefined) {
        return {
          ok: false,
          error: makeAppError('INTERNAL', 'Language settings are unavailable.')
        }
      }
      if (channel === IPC_CHANNELS.localeGet) {
        return { ok: true, value: options.locale.state() }
      }
      const parsed = localeSetInputSchema.safeParse(rawInput)
      if (!parsed.success) {
        return {
          ok: false,
          error: makeAppError('INVALID_ARGUMENT', 'Invalid language preference.', {
            context: { path: parsed.error.issues[0]?.path.join('.') ?? 'input' }
          })
        }
      }
      return { ok: true, value: options.locale.set(parsed.data.preference) }
    }
    ipcMain.handle(channel, handler as Parameters<typeof ipcMain.handle>[1])
    handlers.push(channel)
  }

  for (const channel of HANDLED_CHANNELS.filter(
    (entry) => !windowChannels.has(entry) && !localeChannels.has(entry)
  )) {
    const handler = async (event: IpcMainInvokeEvent, input?: unknown): Promise<IpcResult<unknown>> => {
      if (!isTrustedFrame(event.senderFrame, options.devServerUrl)) {
        return {
          ok: false,
          error: makeAppError('INVALID_ARGUMENT', 'Request did not come from the iCode renderer.')
        }
      }
      return dispatcher(channel, input)
    }
    ipcMain.handle(channel, handler as Parameters<typeof ipcMain.handle>[1])
    handlers.push(channel)
  }

  const broadcast = (channel: string, payload: unknown): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue
      window.webContents.send(channel, payload)
    }
  }

  const unsubscribe = runtime.sessions.subscribe((payload) => {
    broadcast(IPC_CHANNELS.sessionEvent, payload)
  })

  // The queue changes because main observed something, so main says when.
  // The renderer re-reads instead of guessing from a diff.
  const unsubscribeTasks = runtime.onTaskChange(() => {
    broadcast(IPC_CHANNELS.taskEvent, { type: 'tasks-changed' })
  })

  // Repository preparation is durable main-process work; the renderer re-reads
  // the row when its state changes instead of polling a spinner.
  const unsubscribeRepos = runtime.onRepoChange(() => {
    broadcast(IPC_CHANNELS.reposEvent, { type: 'repos-changed' })
  })

  const unsubscribeGitStatus = runtime.gitStatusWatcher.subscribe((event) => {
    broadcast(IPC_CHANNELS.gitStatusEvent, event)
  })

  const unsubscribeFilesChanged = runtime.filesWatcher.subscribe((event) => {
    broadcast(IPC_CHANNELS.filesChangedEvent, event)
  })

  const unsubscribeAssistant = runtime.assistant.subscribe((event) => {
    broadcast(IPC_CHANNELS.assistantEvent, event)
  })

  return () => {
    unsubscribeAssistant()
    unsubscribeFilesChanged()
    unsubscribeGitStatus()
    unsubscribeRepos()
    unsubscribeTasks()
    unsubscribe()
    for (const channel of handlers) ipcMain.removeHandler(channel)
  }
}
