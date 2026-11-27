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
import { localizeAppError } from '../../shared/i18n'
import { createProviderProbe } from '../providers/provider-probe'
import type {
  BotGroupMessage,
  BotGroupRecord,
  BotGroupThread,
  BotGroupTurn
} from '../../shared/domain/group'

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
  IPC_CHANNELS.sidebarOrderGet,
  IPC_CHANNELS.sidebarOrderSet,
  IPC_CHANNELS.reposList,
  IPC_CHANNELS.reposAdd,
  IPC_CHANNELS.reposInspect,
  IPC_CHANNELS.reposInitialize,
  IPC_CHANNELS.reposRetryPreparation,
  IPC_CHANNELS.reposPickFolder,
  IPC_CHANNELS.reposRemove,
  IPC_CHANNELS.reposRemovalJobsList,
  IPC_CHANNELS.reposRemovalJobRetry,
  IPC_CHANNELS.reposRemovalJobDiscardSnapshots,
  IPC_CHANNELS.sessionsList,
  IPC_CHANNELS.sessionsGet,
  IPC_CHANNELS.sessionsCreate,
  IPC_CHANNELS.sessionsClose,
  IPC_CHANNELS.sessionsRestart,
  IPC_CHANNELS.sessionsResume,
  IPC_CHANNELS.sessionsSleep,
  IPC_CHANNELS.sessionsWake,
  IPC_CHANNELS.sessionsRemove,
  IPC_CHANNELS.sessionsDiscard,
  IPC_CHANNELS.sessionsRecoverWorktree,
  IPC_CHANNELS.worktreesRemove,
  IPC_CHANNELS.worktreesDiscard,
  IPC_CHANNELS.branchesList,
  IPC_CHANNELS.branchesRefs,
  IPC_CHANNELS.branchesCurrent,
  IPC_CHANNELS.branchesRemove,
  IPC_CHANNELS.remotesList,
  IPC_CHANNELS.remotesAdd,
  IPC_CHANNELS.remotesSetUrl,
  IPC_CHANNELS.remotesRemove,
  IPC_CHANNELS.remotesFetch,
  IPC_CHANNELS.cloneStart,
  IPC_CHANNELS.cloneCancel,
  IPC_CHANNELS.clonePersist,
  IPC_CHANNELS.cloneSshStatus,
  IPC_CHANNELS.cloneSshGenerate,
  IPC_CHANNELS.cloneSshTest,
  IPC_CHANNELS.cloneSshTrustHost,
  IPC_CHANNELS.mergeStart,
  IPC_CHANNELS.mergeContinue,
  IPC_CHANNELS.mergeAbort,
  IPC_CHANNELS.mergeState,
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
  IPC_CHANNELS.tasksResume,
  IPC_CHANNELS.tasksHistory,
  IPC_CHANNELS.tasksChanges,
  IPC_CHANNELS.tasksDecideReview,
  IPC_CHANNELS.tasksRequestChanges,
  IPC_CHANNELS.tasksArchive,
  IPC_CHANNELS.tasksUnarchive,
  IPC_CHANNELS.tasksArchiveFinished,
  IPC_CHANNELS.tasksAddDependency,
  IPC_CHANNELS.tasksRemoveDependency,
  IPC_CHANNELS.tasksSetHoldDependents,
  IPC_CHANNELS.tasksSettings,
  IPC_CHANNELS.tasksSetSettings,
  IPC_CHANNELS.supervisorOpen,
  IPC_CHANNELS.botsList,
  IPC_CHANNELS.botsCreate,
  IPC_CHANNELS.botsUpdate,
  IPC_CHANNELS.botsArchive,
  IPC_CHANNELS.botsSetPaused,
  IPC_CHANNELS.botsState,
  IPC_CHANNELS.botsMessages,
  IPC_CHANNELS.botsConversations,
  IPC_CHANNELS.botsNotifications,
  IPC_CHANNELS.botsSend,
  IPC_CHANNELS.botsMarkRead,
  IPC_CHANNELS.botsStop,
  IPC_CHANNELS.botsNewConversation,
  IPC_CHANNELS.botsNewHomeChat,
  IPC_CHANNELS.botsChats,
  IPC_CHANNELS.botsChatCreate,
  IPC_CHANNELS.botsHistorySearch,
  IPC_CHANNELS.botsFocus,
  IPC_CHANNELS.botsHome,
  IPC_CHANNELS.botsAutomationsList,
  IPC_CHANNELS.botsAutomationsCreate,
  IPC_CHANNELS.botsAutomationsUpdate,
  IPC_CHANNELS.botsAutomationsRemove,
  IPC_CHANNELS.botsSkillsList,
  IPC_CHANNELS.botsSkillsRead,
  IPC_CHANNELS.botsSkillsSave,
  IPC_CHANNELS.botsSkillsDelete,
  IPC_CHANNELS.botsSettingsGet,
  IPC_CHANNELS.botsSettingsSet,
  IPC_CHANNELS.botsMemoryRead,
  IPC_CHANNELS.botsMemoryAdd,
  IPC_CHANNELS.botsMemoryEdit,
  IPC_CHANNELS.botsMemoryForget,
  IPC_CHANNELS.botsMemoryUndo,
  IPC_CHANNELS.botsMemoryTopic,
  IPC_CHANNELS.botsMemoryTidyUp,
  IPC_CHANNELS.groupsList,
  IPC_CHANNELS.groupsCreate,
  IPC_CHANNELS.groupsUpdate,
  IPC_CHANNELS.groupsArchive,
  IPC_CHANNELS.groupsDelete,
  IPC_CHANNELS.groupsThreads,
  IPC_CHANNELS.groupsThreadCreate,
  IPC_CHANNELS.groupsMessages,
  IPC_CHANNELS.groupsSend,
  IPC_CHANNELS.groupsMarkRead,
  IPC_CHANNELS.groupsSetRead,
  IPC_CHANNELS.groupsSetMuted,
  IPC_CHANNELS.groupsStop,
  IPC_CHANNELS.itemsList,
  IPC_CHANNELS.itemsGet,
  IPC_CHANNELS.itemsComment,
  IPC_CHANNELS.itemsAsk,
  IPC_CHANNELS.itemsAnswer,
  IPC_CHANNELS.itemsSnooze,
  IPC_CHANNELS.itemsSetStatus,
  IPC_CHANNELS.itemsLinkAdd,
  IPC_CHANNELS.itemsLinkRemove,
  IPC_CHANNELS.itemsAttach,
  IPC_CHANNELS.itemsRemoveAttachment,
  IPC_CHANNELS.permissionsList,
  IPC_CHANNELS.permissionsRespond,
  IPC_CHANNELS.networkSettingsGet,
  IPC_CHANNELS.networkSetSettings,
  IPC_CHANNELS.updatesGet,
  IPC_CHANNELS.updatesCheck,
  IPC_CHANNELS.updatesDownload,
  IPC_CHANNELS.updatesCancelDownload,
  IPC_CHANNELS.updatesInstall,
  IPC_CHANNELS.updatesSkip,
  IPC_CHANNELS.updatesSetAutoCheck,
  IPC_CHANNELS.schedulesList,
  IPC_CHANNELS.schedulesCreate,
  IPC_CHANNELS.schedulesUpdate,
  IPC_CHANNELS.schedulesSetEnabled,
  IPC_CHANNELS.schedulesRunNow,
  IPC_CHANNELS.schedulesRemove,
  IPC_CHANNELS.activityList,
  IPC_CHANNELS.activityClearUnread,
  IPC_CHANNELS.opencodeIntegrationGet,
  IPC_CHANNELS.opencodeIntegrationSetEnabled,
  IPC_CHANNELS.managedHooksGet,
  IPC_CHANNELS.managedHooksSetEnabled,
  IPC_CHANNELS.harnessList,
  IPC_CHANNELS.providersList,
  IPC_CHANNELS.providersCreate,
  IPC_CHANNELS.providersUpdate,
  IPC_CHANNELS.providersRemove,
  IPC_CHANNELS.providersSelect,
  IPC_CHANNELS.providersTest,
  IPC_CHANNELS.aiCommitMessage,
  IPC_CHANNELS.aiCancelCommitMessage,
  IPC_CHANNELS.wslListDistros,
  IPC_CHANNELS.terminalAttach,
  IPC_CHANNELS.terminalPreview,
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
  // The probe uses the app's configured session, so the same proxy policy that
  // applies to Chromium applies here.
  const providerProbe = createProviderProbe({
    fetch: (url, init) => runtime.network.fetch(url, init)
  })
  const groupThreadPayload = (thread: BotGroupThread) => ({
    ...thread,
    unread: Math.max(
      runtime.groupChat.unreadCount(thread.id),
      runtime.groupChat.hasUnreadActivity(thread.id) ? 1 : 0
    )
  })
  const groupSummaryPayload = (group: BotGroupRecord) => {
    const threads = runtime.groupChat.listThreads(group.id).map(groupThreadPayload)
    return {
      ...group,
      memberBotIds: runtime.groupChat.memberIds(group.id),
      threads,
      unread: threads.reduce((total, thread) => total + thread.unread, 0)
    }
  }
  const groupTurnPayload = (turn: BotGroupTurn) => {
    const { context: _context, ...rest } = turn
    return rest
  }
  const groupMessagePayload = (message: BotGroupMessage, turns: BotGroupTurn[]) => ({
    ...message,
    turns: turns.map(groupTurnPayload)
  })
  const botChatPayload = (thread: {
    id: string
    title: string
    isHome: boolean
    harness: import('../../shared/domain/harness').ModelHarness | null
    unread: number
    createdAt: number
    updatedAt: number
    lastMessageAt: number | null
    archivedAt: number | null
  }) => ({
    id: thread.id,
    title: thread.title,
    isHome: thread.isHome,
    harness: thread.harness,
    unread: thread.unread,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    lastMessageAt: thread.lastMessageAt,
    archivedAt: thread.archivedAt
  })
  const memoryRead = async (botId: string) => {
    const [read, history] = await Promise.all([
      runtime.memoryFiles.read(botId),
      runtime.memoryFiles.history(botId)
    ])
    return { ...read, history }
  }
  return createDispatcher({
    sidebarOrderGet: async () => getPersistence().sidebarOrder.get(),
    sidebarOrderSet: async (input) => getPersistence().sidebarOrder.set(input),
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
      const result = await picker.pick(input.target, {
        source: input.source,
        ...(input.purpose === undefined ? {} : { purpose: input.purpose })
      })
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
    reposRemove: async (input) => runtime.removals.start(input.repoId),
    reposRemovalJobsList: async () => ({ jobs: runtime.removals.listJobs() }),
    reposRemovalJobRetry: async (input) => runtime.removals.retry(input.jobId),
    reposRemovalJobDiscardSnapshots: async (input) =>
      runtime.removals.discardSnapshots(input.jobId),
    sessionsList: (input) => runtime.sessions.list(input.repoId),
    sessionsGet: (input) =>
      runtime.sessions.get(input.sessionId),
    sessionsCreate: (input) => runtime.sessions.create(input),
    sessionsClose: async (input) => {
      await runtime.sessions.stop(input.sessionId)
      return null
    },
    sessionsRestart: (input) => runtime.sessions.restart(input.sessionId),
    sessionsResume: (input) => runtime.sessions.resume(input.sessionId),
    sessionsSleep: (input) => runtime.sessions.sleep(input.sessionId),
    sessionsWake: (input) => runtime.sessions.wake(input.sessionId),
    sessionsRemove: (input) =>
      runtime.sessionRemovals.remove(input.sessionId, {
        stopIfLive: input.stopIfLive === true,
        deleteBranch: input.deleteBranch === true
      }),
    sessionsDiscard: (input) =>
      runtime.sessionRemovals.discard(input.sessionId, input.confirmBranch, {
        deleteBranch: input.deleteBranch === true
      }),
    sessionsRecoverWorktree: (input) =>
      runtime.sessions.recoverWorktree(input.sessionId, {
        keepExistingAsAside: input.keepExistingAsAside === true
      }),
    worktreesRemove: (input) =>
      runtime.sessionRemovals.removeWorktree(input.worktreeId, {
        deleteBranch: input.deleteBranch === true
      }),
    worktreesDiscard: (input) =>
      runtime.sessionRemovals.discardWorktree(input.worktreeId, input.confirmBranch, {
        deleteBranch: input.deleteBranch === true
      }),
    branchesList: (input) => runtime.sessionRemovals.listBranches(input.repoId),
    branchesRefs: (input) => runtime.branchRefs.listRefs(input.repoId as never),
    branchesCurrent: (input) => runtime.branchRefs.currentBranch(input.repoId as never),
    branchesRemove: (input) =>
      runtime.sessionRemovals.removeBranch(input.repoId, input.branch, input.confirmBranch),
    remotesList: (input) => runtime.remotes.list(input.repoId as never),
    remotesAdd: (input) =>
      runtime.remotes.add(input.repoId as never, { name: input.name, url: input.url }),
    remotesSetUrl: (input) =>
      runtime.remotes.setUrl(input.repoId as never, { name: input.name, url: input.url }),
    remotesRemove: (input) => runtime.remotes.remove(input.repoId as never, input.name),
    remotesFetch: (input) =>
      runtime.remotes.fetch(input.repoId as never, {
        name: input.name,
        ...(input.prune === undefined ? {} : { prune: input.prune })
      }),
    cloneStart: (input) =>
      runtime.clone.start({
        requestId: input.requestId,
        url: input.url,
        target: input.target as never,
        parentPath: input.parentPath,
        name: input.name,
        ...(input.auth === undefined ? {} : { auth: input.auth })
      }),
    cloneCancel: async (input) => ({ cancelled: runtime.clone.cancel(input.requestId) }),
    clonePersist: async (input) =>
      runtime.clone.persist(input.requestId, input.mode, input.sshUrl),
    cloneSshStatus: (input) => runtime.cloneSsh.status(input.target as never),
    cloneSshGenerate: (input) =>
      runtime.cloneSsh.generate(input.target as never, input.consent),
    cloneSshTest: (input) =>
      runtime.cloneSsh.test(input.target as never, input.url),
    cloneSshTrustHost: (input) =>
      runtime.cloneSsh.trustHost(
        input.target as never,
        input.host,
        input.port,
        input.fingerprints
      ),
    mergeStart: (input) => runtime.merges.start(input),
    mergeContinue: (input) => runtime.merges.continueMerge(input.sessionId),
    mergeAbort: (input) => runtime.merges.abort(input.sessionId),
    mergeState: async (input) => runtime.merges.state(input.sessionId),
    activityList: async () => runtime.activity.list(),
    activityClearUnread: async (input) => runtime.activity.clearUnread(input.sessionId),
    opencodeIntegrationGet: async () => runtime.integrations.getState(),
    opencodeIntegrationSetEnabled: async (input) =>
      runtime.integrations.setEnabled(input.enabled),
    managedHooksGet: async () => runtime.managedHooks.getState(),
    managedHooksSetEnabled: async (input) => runtime.managedHooks.setEnabled(input.enabled),
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
    filesWatch: (input) =>
      runtime.filesWatcher.setActive(input.sessionId, input.active, input.roots),
    gitInvoke: (input) => invokeGitCommand(runtime, input),
    tasksList: (input) => Promise.resolve(runtime.tasks.list(input as never)),
    tasksCreate: (input) => Promise.resolve(outcomeOrThrow(runtime.tasks.create(input as never))),
    tasksApprove: (input) => Promise.resolve(outcomeOrThrow(runtime.tasks.approve(input.taskId))),
    tasksReject: (input) =>
      Promise.resolve(outcomeOrThrow(runtime.tasks.reject(input.taskId, input.note ?? null))),
    tasksCancel: (input) => outcomeOrThrowAsync(runtime.tasks.cancel(input.taskId)),
    tasksRetry: (input) => Promise.resolve(outcomeOrThrow(runtime.tasks.retry(input.taskId))),
    tasksResume: (input) => Promise.resolve(outcomeOrThrow(runtime.tasks.resume(input.taskId))),
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
    tasksRequestChanges: (input) =>
      Promise.resolve(
        outcomeOrThrow(runtime.tasks.requestChanges(input.taskId, input.note ?? null))
      ),
    tasksArchive: (input) => Promise.resolve(outcomeOrThrow(runtime.tasks.archive(input.taskId))),
    tasksUnarchive: (input) =>
      Promise.resolve(outcomeOrThrow(runtime.tasks.unarchive(input.taskId))),
    tasksArchiveFinished: (input) =>
      Promise.resolve(outcomeOrThrow(runtime.tasks.archiveFinished(input.repoId as never))),
    tasksAddDependency: (input) =>
      Promise.resolve(outcomeOrThrow(runtime.tasks.addDependency(input.taskId, input.blockerId))),
    tasksRemoveDependency: (input) =>
      Promise.resolve(
        outcomeOrThrow(runtime.tasks.removeDependency(input.taskId, input.blockerId))
      ),
    tasksSetHoldDependents: (input) =>
      Promise.resolve(outcomeOrThrow(runtime.tasks.setHoldDependents(input.taskId, input.hold))),
    tasksSettings: () =>
      Promise.resolve({
        maxConcurrent: runtime.tasks.maxConcurrent(),
        maxConcurrentPerProject: runtime.tasks.maxConcurrentPerProject()
      }),
    tasksSetSettings: (input) => {
      if (input.maxConcurrent !== undefined) {
        outcomeOrThrow(runtime.tasks.setMaxConcurrent(input.maxConcurrent))
      }
      if (input.maxConcurrentPerProject !== undefined) {
        outcomeOrThrow(runtime.tasks.setMaxConcurrentPerProject(input.maxConcurrentPerProject))
      }
      return Promise.resolve({
        maxConcurrent: runtime.tasks.maxConcurrent(),
        maxConcurrentPerProject: runtime.tasks.maxConcurrentPerProject()
      })
    },
    supervisorOpen: (input) => runtime.supervisor.open(input.repoId as never),
    botsList: () => Promise.resolve(runtime.bots.listSummaries()),
    botsCreate: (input) => Promise.resolve(runtime.bots.createBot(input)),
    botsUpdate: (input) => Promise.resolve(runtime.bots.updateBot(input)),
    botsArchive: (input) => {
      const archived = runtime.bots.archiveBot(input.botId)
      if (archived) runtime.groupChat.removeBotFromGroups(input.botId)
      return Promise.resolve(archived)
    },
    botsSetPaused: (input) => Promise.resolve(runtime.bots.setPaused(input.botId, input.paused)),
    botsState: (input) =>
      Promise.resolve(
        runtime.botRuntimes.ensureChat(input.botId, input.threadId).service.state()
      ),
    botsMessages: (input) => {
      const runtimeForBot = runtime.botRuntimes.ensureChat(input.botId, input.threadId)
      const {
        botId: _botId,
        threadId: _threadId,
        ...rest
      } = input
      return Promise.resolve(
        runtimeForBot.service.listMessages({
          threadId: runtimeForBot.threadId,
          ...rest
        })
      )
    },
    botsConversations: (input) =>
      Promise.resolve(
        runtime.botRuntimes.ensureChat(input.botId, input.threadId).service.listConversations()
      ),
    botsNotifications: (input) =>
      Promise.resolve(
        runtime.botRuntimes
          .ensureChat(input.botId, input.threadId)
          .service.listNotifications({ limit: input.limit })
      ),
    botsSend: (input) =>
      runtime.botRuntimes.ensureChat(input.botId, input.threadId).service.send({
        text: input.text,
        ...(input.repoId === undefined ? {} : { repoId: input.repoId })
      }),
    botsMarkRead: (input) => {
      const runtimeForBot = runtime.botRuntimes.ensureChat(input.botId, input.threadId)
      return Promise.resolve(
        runtimeForBot.service.markRead({
          threadId: runtimeForBot.threadId,
          ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
          ...(input.read === undefined ? {} : { read: input.read })
        })
      )
    },
    botsStop: (input) => {
      runtime.botRuntimes.ensureChat(input.botId, input.threadId).service.stop()
      return Promise.resolve(null)
    },
    botsNewConversation: (input) =>
      Promise.resolve(
        runtime.botRuntimes
          .ensureChat(input.botId, input.threadId)
          .service.newConversation()
      ),
    botsNewHomeChat: (input) => {
      const result = runtime.botRuntimes.newHomeChat(input.botId)
      return Promise.resolve({
        thread: botChatPayload({ ...result.thread, unread: 0 }),
        replacedThreadId: result.replacedThreadId
      })
    },
    botsChats: (input) =>
      Promise.resolve(runtime.botRuntimes.listChats(input.botId).map(botChatPayload)),
    botsChatCreate: (input) => {
      const thread = runtime.botRuntimes.createSideChat(input.botId, input.harness)
      return Promise.resolve(botChatPayload({ ...thread, unread: 0 }))
    },
    botsHistorySearch: (input) =>
      Promise.resolve(runtime.botRuntimes.searchHistory(input.query, input.limit ?? 50)),
    botsFocus: (input) => {
      runtime.botRuntimes.ensureChat(input.botId, input.threadId).service.focus(input.messageId)
      return Promise.resolve(null)
    },
    botsAutomationsList: (input) =>
      Promise.resolve(runtime.botAutomations.list(input.botId)),
    botsAutomationsCreate: (input) =>
      Promise.resolve(runtime.botAutomations.create(input)),
    botsAutomationsUpdate: (input) =>
      Promise.resolve(runtime.botAutomations.update(input.id, input)),
    botsAutomationsRemove: (input) =>
      Promise.resolve(runtime.botAutomations.remove(input.id)),
    botsSkillsList: (input) => Promise.resolve(runtime.botSkills.list(input.botId)),
    botsSkillsRead: (input) =>
      Promise.resolve(runtime.botSkills.read(input.botId, input.folder)),
    botsSkillsSave: (input) =>
      Promise.resolve(runtime.botSkills.save(input.botId, input.folder, input.text)),
    botsSkillsDelete: (input) =>
      Promise.resolve(runtime.botSkills.remove(input.botId, input.folder)),
    botsHome: async (input) => {
      const path = runtime.bots.ensureHome(input.botId)
      if (path === null) throw new Error('That bot has no home folder.')
      const error = await shell.openPath(path)
      return { path, opened: error === '' }
    },
    botsSettingsGet: (input) => Promise.resolve(runtime.bots.settingsFor(input.botId)),
    botsSettingsSet: (input) =>
      Promise.resolve(
        runtime.bots.saveSettings(input.botId, input.settings as never)
      ),
    botsMemoryRead: (input) => memoryRead(input.botId),
    botsMemoryAdd: async (input) => {
      await runtime.memoryFiles.add(input.botId, input.text, { kind: 'owner' })
      return memoryRead(input.botId)
    },
    botsMemoryEdit: async (input) => {
      await runtime.memoryFiles.edit(input.botId, input.fact, input.text)
      return memoryRead(input.botId)
    },
    botsMemoryForget: async (input) => {
      await runtime.memoryFiles.forget(input.botId, input.fact)
      return memoryRead(input.botId)
    },
    botsMemoryUndo: async (input) => {
      await runtime.memoryFiles.undo(input.botId, input.rowId)
      return memoryRead(input.botId)
    },
    botsMemoryTopic: async (input) => {
      const text = await runtime.memoryFiles.readTopic(input.botId, input.name)
      return text === null ? null : { name: input.name, text }
    },
    botsMemoryTidyUp: async (input) => {
      await runtime.memoryFiles.tidyUp(input.botId)
      return memoryRead(input.botId)
    },
    groupsList: () =>
      Promise.resolve(runtime.groupChat.listGroups().map(groupSummaryPayload)),
    groupsCreate: async (input) => {
      const group = await runtime.groupChat.createGroup(input)
      return groupSummaryPayload(group)
    },
    groupsUpdate: (input) => Promise.resolve(groupSummaryPayload(runtime.groupChat.updateGroup(input))),
    groupsArchive: (input) =>
      Promise.resolve(groupSummaryPayload(runtime.groupChat.archiveGroup(input.groupId))),
    groupsDelete: (input) => Promise.resolve(runtime.groupChat.deleteGroup(input.groupId)),
    groupsThreads: (input) =>
      Promise.resolve(
        runtime.groupChat.listThreads(input.groupId).map(groupThreadPayload)
      ),
    groupsThreadCreate: (input) =>
      Promise.resolve({ thread: groupThreadPayload(runtime.groupChat.createThread(input.groupId)) }),
    groupsMessages: (input) => {
      const limit = input.limit ?? 40
      const page = runtime.groupChat.messages(input.threadId, {
        ...(input.beforeSeq === undefined ? {} : { beforeSeq: input.beforeSeq }),
        limit
      })
      return Promise.resolve({
        messages: page.messages.map((message) =>
          groupMessagePayload(
            message,
            page.turns.filter((turn) => turn.messageId === message.id)
          )
        ),
        hasEarlier: page.messages.length >= limit
      })
    },
    groupsSend: async (input) => {
      const result = await runtime.groupChat.sendOwnerMessage(input)
      return {
        message: groupMessagePayload(result.message, result.turns)
      }
    },
    groupsMarkRead: (input) =>
      Promise.resolve({ unread: runtime.groupChat.markRead(input.threadId, input.seq) }),
    groupsSetRead: (input) =>
      Promise.resolve({
        unread: runtime.groupChat.setGroupRead(input.groupId, input.read)
      }),
    groupsSetMuted: (input) =>
      Promise.resolve({
        group: groupSummaryPayload(
          runtime.groupChat.setGroupMuted(input.groupId, input.muted)
        )
      }),
    groupsStop: (input) =>
      Promise.resolve({
        turns: runtime.groupChat.stop(input).map(groupTurnPayload)
      }),
    itemsList: (input) => Promise.resolve(runtime.items.list(input)),
    itemsGet: (input) => Promise.resolve({ item: runtime.items.get(input.taskId) }),
    itemsComment: (input) =>
      Promise.resolve(
        runtime.items.comment({
          taskId: input.taskId,
          body: input.body,
          authorKind: 'owner'
        })
      ),
    itemsAsk: (input) =>
      Promise.resolve(
        runtime.items.ask({
          taskId: input.taskId,
          body: input.body,
          ...(input.options === undefined ? {} : { options: input.options }),
          authorKind: 'owner'
        })
      ),
    itemsAnswer: (input) =>
      Promise.resolve(
        runtime.items.answer({
          taskId: input.taskId,
          questionId: input.commentId,
          body: input.body,
          authorKind: 'owner'
        })
      ),
    itemsSnooze: (input) => {
      runtime.items.snooze(input.taskId, input.until)
      return Promise.resolve({ item: runtime.items.get(input.taskId) })
    },
    itemsSetStatus: (input) =>
      Promise.resolve({ item: runtime.items.setStatus(input.taskId, input.status) }),
    itemsLinkAdd: (input) => Promise.resolve(runtime.items.linkAdd(input)),
    itemsLinkRemove: (input) => Promise.resolve(runtime.items.linkRemove(input)),
    itemsAttach: (input) => Promise.resolve(runtime.items.attach(input)),
    itemsRemoveAttachment: (input) =>
      Promise.resolve(runtime.items.removeAttachment(input.taskId, input.id)),
    permissionsList: (input) => Promise.resolve(runtime.permissions.list(input.groupId)),
    permissionsRespond: (input) =>
      Promise.resolve(runtime.permissions.respond(input.id, input.decision)),
    networkSettingsGet: () => Promise.resolve(runtime.network.settings()),
    networkSetSettings: (input) =>
      runtime.network.saveSettings(input.settings as never),
    updatesGet: () => Promise.resolve(runtime.updates.getState()),
    updatesCheck: () => runtime.updates.check(),
    updatesDownload: () => runtime.updates.download(),
    updatesCancelDownload: () => Promise.resolve(runtime.updates.cancelDownload()),
    updatesInstall: (input) => runtime.updates.install(input),
    updatesSkip: (input) => Promise.resolve(runtime.updates.skip(input.version)),
    updatesSetAutoCheck: (input) =>
      Promise.resolve(runtime.updates.setAutoCheck(input.enabled)),
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
    harnessList: (input) =>
      runtime.listHarnesses({
        ...(input?.repoId === undefined ? {} : { repoId: input.repoId }),
        ...(input?.force === true ? { force: true } : {})
      }),
    providersList: async () => {
      const persistence = getPersistence()
      return {
        providers: persistence.providers.list(),
        selections: persistence.providers.selections(),
        secretStorage: persistence.providers.storageStatus()
      }
    },
    providersCreate: async (input) => {
      const persistence = getPersistence()
      const created = persistence.providers.createAndSelect(input, Date.now())
      runtime.invalidateHarnessDetection()
      return created
    },
    providersUpdate: async (input) => {
      const persistence = getPersistence()
      const updated = persistence.providers.update(input, Date.now())
      runtime.invalidateHarnessDetection()
      return updated
    },
    providersRemove: async (input) => {
      const persistence = getPersistence()
      persistence.providers.remove(input.providerId)
      runtime.removeProviderFiles(input.providerId)
      runtime.invalidateHarnessDetection()
      return null
    },
    providersSelect: async (input) => {
      const persistence = getPersistence()
      persistence.providers.select(input.harness, input.providerId, Date.now())
      runtime.invalidateHarnessDetection()
      return null
    },
    providersTest: async (input) => {
      const persistence = getPersistence()
      const provider = persistence.providers.findLaunchConfig(input.providerId)
      if (provider === null) {
        throw makeAppError('INVALID_ARGUMENT', 'The provider does not exist.', {
          context: { providerId: input.providerId }
        })
      }
      return providerProbe.test(provider)
    },
    aiCommitMessage: (input) =>
      runtime.commitMessages.generate(input.sessionId, input.requestId),
    aiCancelCommitMessage: async (input) => ({
      cancelled: runtime.commitMessages.cancel(input.requestId)
    }),
    wslListDistros: () => runtime.listWslDistros(),
    terminalAttach: (input) => runtime.sessions.attach(input.sessionId),
    terminalPreview: (input) => runtime.sessions.preview(input.sessionId),
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

  const unsubscribeRemovals = runtime.onRemovalChange(() => {
    broadcast(IPC_CHANNELS.reposRemovalEvent, { type: 'removal-changed' })
  })

  const unsubscribeGitStatus = runtime.gitStatusWatcher.subscribe((event) => {
    broadcast(IPC_CHANNELS.gitStatusEvent, event)
  })

  const unsubscribeFilesChanged = runtime.filesWatcher.subscribe((event) => {
    broadcast(IPC_CHANNELS.filesChangedEvent, event)
  })



  const unsubscribeBotChanges = runtime.onBotChange(() => {
    broadcast(IPC_CHANNELS.botsEvent, { type: 'changed', botId: null })
  })
  const unsubscribeBotChat = runtime.botRuntimes.subscribe((botId, threadId, event) => {
    broadcast(IPC_CHANNELS.botsEvent, {
      type: 'chat',
      botId,
      threadId,
      event
    })
  })
  const unsubscribePermissions = runtime.permissions.subscribe(() => {
    broadcast(IPC_CHANNELS.permissionsEvent, { type: 'changed' })
  })

  const unsubscribeGroups = runtime.groupChat.subscribe((event) => {
    // Service messages carry no turns; the wire contract pairs every message
    // with its turn list, and later turn events fill it in.
    broadcast(
      IPC_CHANNELS.groupsEvent,
      event.type === 'message'
        ? { ...event, message: { ...event.message, turns: [] } }
        : event
    )
  })

  const unsubscribeOpenCode = runtime.integrations.subscribe((state) => {
    broadcast(IPC_CHANNELS.opencodeIntegrationEvent, state)
  })
  const unsubscribeManagedHooks = runtime.managedHooks.subscribe((state) => {
    broadcast(IPC_CHANNELS.managedHooksEvent, state)
  })
  const unsubscribeUpdates = runtime.updates.subscribe((state) => {
    broadcast(IPC_CHANNELS.updatesEvent, state)
  })

  /**
   * Clone failures are normalized at the process boundary, like every other
   * dispatcher result, so the dialog can render a localized message key.
   */
  const unsubscribeClone = runtime.clone.subscribe((event) => {
    broadcast(
      IPC_CHANNELS.cloneProgress,
      event.type === 'failed'
        ? { ...event, error: localizeAppError(event.error, getMainLocale()) }
        : event
    )
  })

  return () => {
    unsubscribeOpenCode()
    unsubscribeManagedHooks()
    unsubscribeUpdates()
    unsubscribeClone()
    unsubscribeBotChanges()
    unsubscribeBotChat()
    unsubscribePermissions()
    unsubscribeGroups()
    unsubscribeFilesChanged()
    unsubscribeGitStatus()
    unsubscribeRepos()
    unsubscribeRemovals()
    unsubscribeTasks()
    unsubscribe()
    for (const channel of handlers) ipcMain.removeHandler(channel)
  }
}
