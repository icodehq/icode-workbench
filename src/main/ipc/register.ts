import { BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebFrameMain } from 'electron'
import { IPC_CHANNELS, type IpcResult } from '../../shared/schemas/ipc'
import { makeAppError } from '../../shared/domain/errors'
import type { AppRuntime } from '../app/runtime'
import { createDispatcher, type Dispatcher } from './dispatcher'
import { toRepositorySummary } from './repository-summary'

const HANDLED_CHANNELS: readonly string[] = [
  IPC_CHANNELS.reposList,
  IPC_CHANNELS.reposAdd,
  IPC_CHANNELS.reposRemove,
  IPC_CHANNELS.sessionsList,
  IPC_CHANNELS.sessionsGet,
  IPC_CHANNELS.sessionsCreate,
  IPC_CHANNELS.sessionsClose,
  IPC_CHANNELS.sessionsRestart,
  IPC_CHANNELS.sessionsRemove,
  IPC_CHANNELS.sessionsDiscard,
  IPC_CHANNELS.sessionsRecoverWorktree,
  IPC_CHANNELS.branchesList,
  IPC_CHANNELS.branchesRemove,
  IPC_CHANNELS.reviewList,
  IPC_CHANNELS.reviewDiff,
  IPC_CHANNELS.filesList,
  IPC_CHANNELS.filesRead,
  IPC_CHANNELS.filesWrite,
  IPC_CHANNELS.filesSearch,
  IPC_CHANNELS.gitStatus,
  IPC_CHANNELS.gitStageAll,
  IPC_CHANNELS.gitUnstageAll,
  IPC_CHANNELS.gitCommit,
  IPC_CHANNELS.gitDiscardPath,
  IPC_CHANNELS.activityList,
  IPC_CHANNELS.activityClearUnread,
  IPC_CHANNELS.harnessList,
  IPC_CHANNELS.wslListDistros,
  IPC_CHANNELS.terminalAttach,
  IPC_CHANNELS.terminalWrite,
  IPC_CHANNELS.terminalResize
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
      return toRepositorySummary(result.repository)
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
    sessionsRemove: (input) => runtime.sessionRemovals.remove(input.sessionId),
    sessionsDiscard: (input) =>
      runtime.sessionRemovals.discard(input.sessionId, input.confirmBranch),
    sessionsRecoverWorktree: (input) => runtime.sessions.recoverWorktree(input.sessionId),
    branchesList: (input) => runtime.sessionRemovals.listBranches(input.repoId),
    branchesRemove: (input) =>
      runtime.sessionRemovals.removeBranch(input.repoId, input.branch, input.confirmBranch),
    activityList: async () => runtime.activity.list(),
    activityClearUnread: async (input) => runtime.activity.clearUnread(input.sessionId),
    reviewList: (input) => runtime.review.list(input.sessionId),
    reviewDiff: (input) => runtime.review.diff(input.sessionId, input.path, input.oldPath ?? null),
    filesList: (input) => runtime.files.list(input.sessionId, input.path),
    filesRead: (input) => runtime.files.read(input.sessionId, input.path),
    filesWrite: (input) => runtime.files.write(input.sessionId, input.path, input.text),
    filesSearch: (input) =>
      runtime.files.search(input.sessionId, input.query, {
        caseSensitive: input.caseSensitive,
        limit: input.limit
      }),
    gitStatus: (input) => runtime.gitWorkspace.status(input.sessionId),
    gitStageAll: (input) => runtime.gitWorkspace.stageAll(input.sessionId),
    gitUnstageAll: (input) => runtime.gitWorkspace.unstageAll(input.sessionId),
    gitCommit: (input) => runtime.gitWorkspace.commit(input.sessionId, input.message),
    gitDiscardPath: (input) => runtime.gitWorkspace.discardPath(input.sessionId, input.path),
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

export function registerAppIpc(
  runtime: AppRuntime,
  getPersistence: () => import('../persistence').AppPersistence,
  options: { devServerUrl?: string } = {}
): () => void {
  const dispatcher = createAppDispatcher(runtime, getPersistence)

  const handlers = HANDLED_CHANNELS.map((channel) => {
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
    return channel
  })

  const unsubscribe = runtime.sessions.subscribe((payload) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue
      window.webContents.send(IPC_CHANNELS.sessionEvent, payload)
    }
  })

  return () => {
    unsubscribe()
    for (const channel of handlers) ipcMain.removeHandler(channel)
  }
}
