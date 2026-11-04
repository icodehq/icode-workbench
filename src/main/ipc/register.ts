import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type WebFrameMain } from 'electron'
import { IPC_CHANNELS, type IpcResult } from '../../shared/schemas/ipc'
import { makeAppError } from '../../shared/domain/errors'
import type { AppRuntime } from '../app/runtime'
import { createDispatcher, type Dispatcher } from './dispatcher'
import { toRepositorySummary } from './repository-summary'
import { RepositoryFolderPicker } from '../repositories/folder-picker'
import { pickRepositoryFolderResultSchema } from '../../shared/schemas/ipc'
import { app } from 'electron'

export const WINDOW_CONTROL_CHANNELS: readonly string[] = [
  IPC_CHANNELS.windowMinimize,
  IPC_CHANNELS.windowToggleMaximize,
  IPC_CHANNELS.windowClose,
  IPC_CHANNELS.windowIsMaximized
]

export const HANDLED_CHANNELS: readonly string[] = [
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
  IPC_CHANNELS.reviewAreaDiff,
  IPC_CHANNELS.filesList,
  IPC_CHANNELS.filesRead,
  IPC_CHANNELS.filesWrite,
  IPC_CHANNELS.filesSearch,
  IPC_CHANNELS.filesCreate,
  IPC_CHANNELS.filesRename,
  IPC_CHANNELS.filesRemove,
  IPC_CHANNELS.gitStatus,
  IPC_CHANNELS.gitCancelStatus,
  IPC_CHANNELS.gitOperationState,
  IPC_CHANNELS.gitOperationContinue,
  IPC_CHANNELS.gitOperationAbort,
  IPC_CHANNELS.gitRangeDiff,
  IPC_CHANNELS.gitWatchStatus,
  IPC_CHANNELS.gitStageAll,
  IPC_CHANNELS.gitUnstageAll,
  IPC_CHANNELS.gitCommit,
  IPC_CHANNELS.gitDiscardPath,
  IPC_CHANNELS.gitSetPathStaged,
  IPC_CHANNELS.gitSetPathsStaged,
  IPC_CHANNELS.gitDiscardPaths,
  IPC_CHANNELS.gitBranches,
  IPC_CHANNELS.gitSwitchBranch,
  IPC_CHANNELS.gitCreateBranch,
  IPC_CHANNELS.gitCreateTag,
  IPC_CHANNELS.gitDeleteTag,
  IPC_CHANNELS.gitTags,
  IPC_CHANNELS.gitCheckoutRef,
  IPC_CHANNELS.gitFileAtRevision,
  IPC_CHANNELS.gitIndexFile,
  IPC_CHANNELS.gitApplyPatch,
  IPC_CHANNELS.gitConflictFile,
  IPC_CHANNELS.gitResolveConflict,
  IPC_CHANNELS.gitStashList,
  IPC_CHANNELS.gitStashPush,
  IPC_CHANNELS.gitStashDiff,
  IPC_CHANNELS.gitStashAction,
  IPC_CHANNELS.gitWorktreeList,
  IPC_CHANNELS.gitWorktreeAction,
  IPC_CHANNELS.gitSubmoduleList,
  IPC_CHANNELS.gitSubmoduleAction,
  IPC_CHANNELS.gitBlame,
  IPC_CHANNELS.gitRenameBranch,
  IPC_CHANNELS.gitDeleteBranch,
  IPC_CHANNELS.gitMergeBranch,
  IPC_CHANNELS.gitRebaseBranch,
  IPC_CHANNELS.gitCherryPick,
  IPC_CHANNELS.gitRevert,
  IPC_CHANNELS.gitReset,
  IPC_CHANNELS.gitPush,
  IPC_CHANNELS.gitPull,
  IPC_CHANNELS.gitPublish,
  IPC_CHANNELS.gitFetch,
  IPC_CHANNELS.gitRemotes,
  IPC_CHANNELS.gitFetchRemote,
  IPC_CHANNELS.gitAddRemote,
  IPC_CHANNELS.gitRemoveRemote,
  IPC_CHANNELS.gitPushTags,
  IPC_CHANNELS.gitForcePush,
  IPC_CHANNELS.gitRemoteBranches,
  IPC_CHANNELS.gitSetUpstream,
  IPC_CHANNELS.gitAmend,
  IPC_CHANNELS.gitHistory,
  IPC_CHANNELS.gitLog,
  IPC_CHANNELS.gitCommitDetail,
  IPC_CHANNELS.gitRevisionFileDiff,
  IPC_CHANNELS.gitCompare,
  IPC_CHANNELS.tasksList,
  IPC_CHANNELS.tasksCreate,
  IPC_CHANNELS.tasksCancel,
  IPC_CHANNELS.tasksRetry,
  IPC_CHANNELS.tasksHistory,
  IPC_CHANNELS.tasksChanges,
  IPC_CHANNELS.tasksDecideReview,
  IPC_CHANNELS.tasksSettings,
  IPC_CHANNELS.tasksSetSettings,
  IPC_CHANNELS.schedulesList,
  IPC_CHANNELS.schedulesCreate,
  IPC_CHANNELS.schedulesUpdate,
  IPC_CHANNELS.schedulesSetEnabled,
  IPC_CHANNELS.schedulesRunNow,
  IPC_CHANNELS.schedulesRemove,
  IPC_CHANNELS.activityList,
  IPC_CHANNELS.activityClearUnread,
  IPC_CHANNELS.harnessList,
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
       * sheet over ADE rather than a stray window, and the distro's home is read
       * through the same WSL runner every other guest call uses.
       */
      const picker = new RepositoryFolderPicker({
        showOpenDialog: (options) => {
          const parent = BrowserWindow.getFocusedWindow()
          return parent === null
            ? dialog.showOpenDialog(options)
            : dialog.showOpenDialog(parent, options)
        },
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
    reviewAreaDiff: (input) => runtime.review.diffArea(input),
    filesList: (input) => runtime.files.list(input.sessionId, input.path),
    filesRead: (input) => runtime.files.read(input.sessionId, input.path),
    filesWrite: (input) => runtime.files.write(input.sessionId, input.path, input.text),
    filesSearch: (input) =>
      runtime.files.search(input.sessionId, input.query, {
        caseSensitive: input.caseSensitive,
        limit: input.limit
      }),
    filesCreate: (input) => runtime.files.create(input.sessionId, input.path, input.kind),
    filesRename: (input) => runtime.files.rename(input.sessionId, input.from, input.to),
    filesRemove: (input) => runtime.files.remove(input.sessionId, input.path),
    gitStatus: (input) => runtime.gitWorkspace.status(input.sessionId),
    gitCancelStatus: async (input) => ({
      cancelled: runtime.gitWorkspace.cancelReads(input.sessionId)
    }),
    gitOperationState: (input) => runtime.gitWorkspace.operationState(input.sessionId),
    gitOperationContinue: (input) => runtime.gitWorkspace.continueOperation(input.sessionId),
    gitOperationAbort: (input) => runtime.gitWorkspace.abortOperation(input.sessionId),
    gitRangeDiff: (input) => runtime.gitWorkspace.rangeDiff(input.sessionId, input.from, input.to),
    gitWatchStatus: (input) => runtime.gitStatusWatcher.setActive(input.sessionId, input.active),
    gitStageAll: (input) => runtime.gitWorkspace.stageAll(input.sessionId),
    gitUnstageAll: (input) => runtime.gitWorkspace.unstageAll(input.sessionId),
    gitCommit: (input) =>
      runtime.gitWorkspace.commit(input.sessionId, input.message, {
        ...(input.all === undefined ? {} : { all: input.all }),
        ...(input.signOff === undefined ? {} : { signOff: input.signOff })
      }),
    gitDiscardPath: (input) => runtime.gitWorkspace.discardPath(input.sessionId, input.path),
    gitSetPathStaged: (input) =>
      runtime.gitWorkspace.setPathStaged(input.sessionId, input.path, input.staged),
    gitSetPathsStaged: (input) =>
      runtime.gitWorkspace.setPathsStaged(input.sessionId, input.targets, input.staged),
    gitDiscardPaths: (input) =>
      runtime.gitWorkspace.discardPaths(input.sessionId, input.targets, input.expectedRevision),
    gitBranches: (input) => runtime.gitWorkspace.branches(input.sessionId),
    gitSwitchBranch: (input) => runtime.gitWorkspace.switchBranch(input.sessionId, input.branch),
    gitCreateBranch: (input) =>
      runtime.gitWorkspace.createBranch(input.sessionId, input.branch, input.at),
    gitCreateTag: (input) =>
      runtime.gitWorkspace.createTag(input.sessionId, input.name, input.oid),
    gitDeleteTag: (input) => runtime.gitWorkspace.deleteTag(input.sessionId, input.name),
    gitTags: (input) => runtime.gitWorkspace.tags(input.sessionId),
    gitCheckoutRef: (input) => runtime.gitWorkspace.checkoutRef(input.sessionId, input.ref),
    gitFileAtRevision: (input) =>
      runtime.gitWorkspace.fileAtRevision(input.sessionId, input.rev, input.path),
    gitIndexFile: (input) => runtime.gitWorkspace.indexFile(input.sessionId, input.path),
    gitApplyPatch: (input) =>
      runtime.gitWorkspace.applyPatch(input.sessionId, input.patch, input.path, input.mode),
    gitConflictFile: (input) => runtime.gitWorkspace.conflictFile(input.sessionId, input.path),
    gitResolveConflict: (input) =>
      runtime.gitWorkspace.resolveConflict(input.sessionId, input.path),
    gitStashList: (input) => runtime.gitWorkspace.stashList(input.sessionId),
    gitStashPush: (input) =>
      runtime.gitWorkspace.stashPush(
        input.sessionId,
        input.message,
        input.includeUntracked,
        input.keepIndex
      ),
    gitStashDiff: (input) =>
      runtime.gitWorkspace.stashDiff(input.sessionId, input.index),
    gitStashAction: (input) =>
      runtime.gitWorkspace.stashAction(input.sessionId, input.index, input.action),
    gitWorktreeList: (input) => runtime.gitWorkspace.worktreeList(input.sessionId),
    gitWorktreeAction: (input) =>
      runtime.gitWorkspace.worktreeAction(
        input.sessionId,
        input.action,
        input.path,
        input.reason
      ),
    gitSubmoduleList: (input) => runtime.gitWorkspace.submoduleStatus(input.sessionId),
    gitSubmoduleAction: (input) =>
      runtime.gitWorkspace.submoduleAction(input.sessionId, input.action, input.path),
    gitBlame: (input) => runtime.gitWorkspace.blame(input.sessionId, input.path),
    gitRenameBranch: (input) =>
      runtime.gitWorkspace.renameBranch(input.sessionId, input.from, input.to),
    gitDeleteBranch: (input) =>
      runtime.gitWorkspace.deleteBranch(input.sessionId, input.branch),
    gitMergeBranch: (input) => runtime.gitWorkspace.mergeBranch(input.sessionId, input.branch),
    gitRebaseBranch: (input) => runtime.gitWorkspace.rebaseBranch(input.sessionId, input.branch),
    gitCherryPick: (input) => runtime.gitWorkspace.cherryPick(input.sessionId, input.oid),
    gitRevert: (input) => runtime.gitWorkspace.revert(input.sessionId, input.oid),
    gitReset: (input) =>
      runtime.gitWorkspace.resetTo(input.sessionId, input.oid, input.mode),
    gitPush: (input) => runtime.gitWorkspace.push(input.sessionId),
    gitPull: (input) => runtime.gitWorkspace.pull(input.sessionId, input.rebase === true),
    gitPublish: (input) => runtime.gitWorkspace.publish(input.sessionId),
    gitFetch: (input) => runtime.gitWorkspace.fetch(input.sessionId),
    gitRemotes: (input) => runtime.gitWorkspace.remotes(input.sessionId),
    gitFetchRemote: (input) =>
      runtime.gitWorkspace.fetchRemote(input.sessionId, input.remote, input.prune),
    gitAddRemote: (input) =>
      runtime.gitWorkspace.addRemote(input.sessionId, input.name, input.url),
    gitRemoveRemote: (input) =>
      runtime.gitWorkspace.removeRemote(input.sessionId, input.name),
    gitPushTags: (input) => runtime.gitWorkspace.pushTags(input.sessionId),
    gitForcePush: (input) => runtime.gitWorkspace.forcePush(input.sessionId),
    gitRemoteBranches: (input) => runtime.gitWorkspace.remoteBranches(input.sessionId),
    gitSetUpstream: (input) =>
      runtime.gitWorkspace.setUpstream(input.sessionId, input.upstream),
    gitAmend: (input) =>
      runtime.gitWorkspace.amend(input.sessionId, input.message, { sign: input.sign }),
    gitHistory: (input) => runtime.gitWorkspace.history(input.sessionId, input.limit),
    gitLog: (input) =>
      runtime.gitWorkspace.log(input.sessionId, {
        limit: input.limit,
        skip: input.skip,
        ...(input.ref === undefined ? {} : { ref: input.ref }),
        ...(input.allRefs === undefined ? {} : { allRefs: input.allRefs }),
        ...(input.path === undefined ? {} : { path: input.path })
      }),
    gitCommitDetail: (input) =>
      runtime.gitWorkspace.commitDetail(input.sessionId, input.oid, input.parent),
    gitRevisionFileDiff: (input) =>
      runtime.gitWorkspace.revisionFileDiff(
        input.sessionId,
        input.from,
        input.to,
        input.path,
        input.oldPath
      ),
    gitCompare: (input) => runtime.gitWorkspace.compare(input.sessionId),
    tasksList: (input) => Promise.resolve(runtime.tasks.list(input as never)),
    tasksCreate: (input) => Promise.resolve(outcomeOrThrow(runtime.tasks.create(input as never))),
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
    tasksSettings: () => Promise.resolve({ maxConcurrent: runtime.tasks.maxConcurrent() }),
    tasksSetSettings: (input) => Promise.resolve(outcomeOrThrow(runtime.tasks.setMaxConcurrent(input.maxConcurrent))),
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
  options: { devServerUrl?: string } = {}
): () => void {
  const dispatcher = createAppDispatcher(runtime, getPersistence)
  const windowChannels = new Set<string>(WINDOW_CONTROL_CHANNELS)
  const handlers: string[] = []

  for (const channel of WINDOW_CONTROL_CHANNELS) {
    const handler = async (event: IpcMainInvokeEvent): Promise<IpcResult<unknown>> => {
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
      return { ok: true, value: window.isMaximized() }
    }
    ipcMain.handle(channel, handler as Parameters<typeof ipcMain.handle>[1])
    handlers.push(channel)
  }

  for (const channel of HANDLED_CHANNELS.filter((entry) => !windowChannels.has(entry))) {
    const handler = async (event: IpcMainInvokeEvent, input?: unknown): Promise<IpcResult<unknown>> => {
      if (!isTrustedFrame(event.senderFrame, options.devServerUrl)) {
        return {
          ok: false,
          error: makeAppError('INVALID_ARGUMENT', 'Request did not come from the ADE renderer.')
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

  return () => {
    unsubscribeGitStatus()
    unsubscribeRepos()
    unsubscribeTasks()
    unsubscribe()
    for (const channel of handlers) ipcMain.removeHandler(channel)
  }
}
