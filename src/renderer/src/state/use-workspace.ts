import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type {
  AddRepositoryResultPayload,
  InitializeRepositoryResultPayload,
  RuntimeInfo
} from '../../../shared/icode-api'
import { makeAppError, type AppError } from '../../../shared/domain/errors'
import type { HarnessId } from '../../../shared/domain/harness'
import type { ExecutionTarget } from '../../../shared/domain/repository'
import { isActiveSessionState, isTerminalSessionState } from '../../../shared/domain/session'
import { wakeDescription, wakePlan } from '../../../shared/domain/session-sleep'
import { callApi, errorNotice, isAbsolutePathLike } from '../lib/api'
import { getLocale, translate, translatePlural } from '../i18n/i18n-store'
import { readTerminalSize } from '../terminal/terminal-size'
import {
  createInitialState,
  workspaceReducer,
  type Notice,
  type WorkspaceState
} from './workspace'

const REPO_STORAGE_KEY = 'icode.activeRepoId'
const SESSION_STORAGE_KEY = 'icode.activeSessionId'
const STOP_RECONCILE_MS = 5000

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function store(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    // A disabled storage backend must not block the workspace.
  }
}

export type CreateSessionRequest = {
  repoId: string
  harness: HarnessId
  title?: string
}

export type AddRepositoryRequest = {
  path: string
  /** The execution target to persist. Always explicit: local is a choice too. */
  target: ExecutionTarget
}

export type InitializeRepositoryRequest = AddRepositoryRequest & {
  identity?: { name: string; email: string }
}

export function useWorkspace(): {
  state: WorkspaceState
  runtime: RuntimeInfo | null
  creating: boolean
  /**
   * Registers a repository and reports the failure to the caller.
   *
   * `null` means success. The dialog needs the error itself: closing the dialog
   * and leaving only a toast makes the user retype an absolute path.
   */
  addRepository: (input: AddRepositoryRequest) => Promise<AppError | null>
  /** Registers a project and starts any needed first-commit preparation. */
  initializeRepository: (input: InitializeRepositoryRequest) => Promise<AppError | null>
  /** Retries a failed or interrupted background first commit. */
  retryPreparation: (repoId: string) => Promise<void>
  removeRepository: (repoId: string) => Promise<void>
  confirmRemoval: () => Promise<void>
  dismissRemoval: () => void
  createSession: (input: CreateSessionRequest) => Promise<boolean>
  stopSession: (sessionId: string) => Promise<void>
  restartSession: (sessionId: string) => Promise<void>
  sleepSession: (sessionId: string) => Promise<void>
  wakeSession: (sessionId: string) => Promise<void>
  recheckSession: (sessionId: string) => Promise<void>
  requestRemoveSession: (sessionId: string) => Promise<void>
  discardSession: (sessionId: string, confirmBranch: string) => Promise<boolean>
  recoverWorktree: (sessionId: string) => Promise<void>
  dismissSessionCleanup: () => void
  requestRemoveBranch: (branch: string, confirmBranch?: string) => Promise<void>
  dismissBranchCleanup: () => void
  selectRepo: (repoId: string) => void
  selectSession: (sessionId: string) => void
  /**
   * Re-detect Harnesses for a repository's target.
   *
   * `repoId` is the *question*, not a hint: a WSL repository's Agents run inside
   * the distro, so this machine's probes do not answer for it.
   */
  refreshHarnesses: (force: boolean, repoId?: string | null) => Promise<void>
  refreshAll: () => Promise<void>
  dismissNotice: () => void
  reportError: (error: AppError) => void
  /** Shared notice channel, for panels outside the workspace state machine. */
  notify: (notice: Notice | null) => void
} {
  const [state, dispatch] = useReducer(
    workspaceReducer,
    undefined,
    () =>
      createInitialState({
        repoId: readStored(REPO_STORAGE_KEY),
        sessionId: readStored(SESSION_STORAGE_KEY)
      })
  )
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null)
  const [creating, setCreating] = useState(false)
  const booted = useRef(false)
  const stopTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  // Event callbacks are registered once; they read the latest selection here.
  const stateRef = useRef(state)
  stateRef.current = state

  /**
   * Unread is cleared only when a focused window is actually showing the
   * session. It is idempotent in the main process, so a redundant call is
   * harmless and a missed one is repaired by the next focus or selection.
   */
  const clearUnreadIfFocused = useCallback((sessionId: string | null): void => {
    if (sessionId === null) return
    if (typeof document !== 'undefined' && !document.hasFocus()) return
    void window.icode.activity.clearUnread({ sessionId }).catch(() => undefined)
  }, [])

  const notify = useCallback((notice: Notice | null) => {
    dispatch({ type: 'notice', notice })
  }, [])

  const reportError = useCallback(
    (error: AppError) => {
      notify(errorNotice(error))
    },
    [notify]
  )

  const refreshRepos = useCallback(async (): Promise<boolean> => {
    const result = await callApi(window.icode.repos.list())
    if (!result.ok) {
      notify(errorNotice(result.error))
      return false
    }
    dispatch({ type: 'reposLoaded', repos: result.value })
    return true
  }, [notify])

  const refreshSessions = useCallback(async (): Promise<boolean> => {
    const result = await callApi(window.icode.sessions.list({}))
    if (!result.ok) {
      notify(errorNotice(result.error))
      return false
    }
    dispatch({
      type: 'sessionsLoaded',
      sessions: result.value.sessions,
      orphans: result.value.orphans
    })
    return true
  }, [notify])

  const refreshBranches = useCallback(async (): Promise<void> => {
    const repoId = state.activeRepoId
    if (repoId === null) {
      dispatch({ type: 'branchesLoaded', branches: [] })
      return
    }
    const result = await callApi(window.icode.branches.list({ repoId }))
    if (!result.ok) {
      dispatch({ type: 'branchesLoaded', branches: [] })
      return
    }
    dispatch({ type: 'branchesLoaded', branches: result.value })
  }, [state.activeRepoId])

  const refreshHarnesses = useCallback(
    async (force: boolean, repoId?: string | null): Promise<void> => {
      dispatch({ type: 'harnessesLoading' })
      const result = await callApi(
        window.icode.harness.list({
          ...(force ? { force: true } : {}),
          ...(repoId ? { repoId } : {})
        })
      )
      if (!result.ok) {
        dispatch({ type: 'harnessFailed', error: result.error })
        return
      }
      dispatch({ type: 'harnessesLoaded', harnesses: result.value })
    },
    []
  )

  const refreshAll = useCallback(async (): Promise<void> => {
    dispatch({ type: 'refreshing', value: true })
    await Promise.all([
      refreshRepos(),
      refreshSessions(),
      refreshHarnesses(false),
      refreshBranches()
    ])
    dispatch({ type: 'refreshing', value: false })
  }, [refreshBranches, refreshHarnesses, refreshRepos, refreshSessions])

  useEffect(() => {
    void refreshBranches()
  }, [state.activeRepoId, refreshBranches])

  // Startup: metadata first, then real Harness probes. Each failure is shown
  // without blocking the rest of the workspace.
  useEffect(() => {
    if (booted.current) return
    booted.current = true
    void (async () => {
      void window.icode
        .getRuntimeInfo()
        .then(setRuntime)
        .catch(() => setRuntime(null))

      const reposOk = await refreshRepos()
      await refreshSessions()
      if (!reposOk) {
        dispatch({ type: 'bootFailed', message: translate('workspace.bootFailed') })
      } else {
        dispatch({ type: 'booted' })
      }
      await refreshHarnesses(false)
    })()
  }, [refreshHarnesses, refreshRepos, refreshSessions])

  useEffect(
    () =>
      window.icode.onSessionEvent((event) => {
        if (event.type === 'state') {
          dispatch({ type: 'sessionUpserted', session: event.session })
          if (isTerminalSessionState(event.session.state)) {
            const timer = stopTimers.current.get(event.session.id)
            if (timer !== undefined) {
              clearTimeout(timer)
              stopTimers.current.delete(event.session.id)
            }
          }
          return
        }
        if (event.type === 'activity') {
          dispatch({
            type: 'activityUpdated',
            sessionId: event.sessionId,
            activity: event.activity
          })
          return
        }
        if (event.type === 'activity-focus') {
          dispatch({ type: 'selectSession', sessionId: event.sessionId })
          clearUnreadIfFocused(event.sessionId)
        }
      }),
    [clearUnreadIfFocused]
  )

  // Repository preparation is main-process work. Re-read the rows when it
  // changes; the renderer never guesses progress from elapsed time.
  useEffect(
    () =>
      window.icode.onRepoEvent(() => {
        void refreshRepos()
      }),
    [refreshRepos]
  )

  // The selected session is on screen, so its unread marker is consumed as soon
  // as the window has focus: on selection, on new activity, and on window focus.
  const activeActivityUnread =
    state.sessions.find((entry) => entry.id === state.activeSessionId)?.activity?.unread ??
    false
  useEffect(() => {
    const clear = (): void => {
      const session = stateRef.current.sessions.find(
        (entry) => entry.id === stateRef.current.activeSessionId
      )
      if (session?.activity?.unread) clearUnreadIfFocused(session.id)
    }
    window.addEventListener('focus', clear)
    clear()
    return () => window.removeEventListener('focus', clear)
  }, [activeActivityUnread, clearUnreadIfFocused, state.activeSessionId])

  useEffect(() => {
    store(REPO_STORAGE_KEY, state.activeRepoId)
  }, [state.activeRepoId])

  useEffect(() => {
    store(SESSION_STORAGE_KEY, state.activeSessionId)
  }, [state.activeSessionId])

  useEffect(() => {
    const timers = stopTimers.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }, [])

  const selectRepo = useCallback((repoId: string) => {
    dispatch({ type: 'selectRepo', repoId })
  }, [])

  const selectSession = useCallback((sessionId: string) => {
    dispatch({ type: 'selectSession', sessionId })
  }, [])

  const validateAddPath = useCallback(
    (input: AddRepositoryRequest): AppError | null => {
      const candidate = input.path.trim()
      if (candidate.length === 0) {
        return makeAppError('INVALID_ARGUMENT', 'Enter the absolute path of a Git repository.', {
          detail:
            input.target.kind === 'wsl'
              ? translate('workspace.pathInsideDistro', { distro: input.target.distro })
              : translate('workspace.pathOnMachine')
        })
      }
      // A guest path is POSIX because the distro is Linux; a local path follows
      // the platform. Neither is accepted as the other.
      if (!isAbsolutePathLike(candidate)) {
        return makeAppError('INVALID_ARGUMENT', 'Repository paths must be absolute.', {
          detail: candidate
        })
      }
      return null
    },
    []
  )

  const finishRepositoryAdd = useCallback(
    async (value: AddRepositoryResultPayload, message: string): Promise<AppError | null> => {
      const reposOk = await refreshRepos()
      if (!reposOk) {
        return makeAppError(
          'INTERNAL',
          'The repository was registered but the list could not be refreshed.',
          { messageKey: 'workspace.notice.repoRefreshFailed' }
        )
      }
      dispatch({ type: 'selectRepo', repoId: value.id })
      await refreshSessions()
      notify({
        tone: value.alreadyRegistered ? 'info' : 'success',
        message
      })
      return null
    },
    [notify, refreshRepos, refreshSessions]
  )

  const addRepository = useCallback(
    async (input: AddRepositoryRequest): Promise<AppError | null> => {
      const validation = validateAddPath(input)
      if (validation !== null) return validation
      const candidate = input.path.trim()
      const result = await callApi(window.icode.repos.add({ path: candidate, target: input.target }))
      if (!result.ok) {
        // Reported to the dialog *and* as a notice: the dialog stays open with the
        // typed path, and the workspace log keeps the failure.
        notify(errorNotice(result.error))
        return result.error
      }
      /*
       * The service answers whether this row already existed, and that answer is
       * authoritative: it de-duplicates by canonical path, by Git common
       * directory, and within one execution target. A client-side path compare
       * cannot see the last two, so reporting from the response is what makes the
       * message true for a linked worktree or a differently-spelled path.
       */
      return finishRepositoryAdd(
        result.value,
        result.value.alreadyRegistered
          ? translate('workspace.notice.alreadySelected', { name: result.value.displayName })
          : translate('workspace.notice.registered', { name: result.value.displayName })
      )
    },
    [finishRepositoryAdd, notify, validateAddPath]
  )

  const initializeRepository = useCallback(
    async (input: InitializeRepositoryRequest): Promise<AppError | null> => {
      const validation = validateAddPath(input)
      if (validation !== null) return validation
      const candidate = input.path.trim()
      const result = await callApi(
        window.icode.repos.initialize({
          path: candidate,
          target: input.target,
          ...(input.identity === undefined ? {} : { identity: input.identity })
        })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return result.error
      }
      const value: InitializeRepositoryResultPayload = result.value
      const preparing = value.initialized && value.preparation?.state === 'preparing'
      const message = value.alreadyRegistered
        ? preparing
          ? translate('workspace.notice.alreadyPreparing', { name: value.displayName })
          : translate('workspace.notice.alreadySelected', { name: value.displayName })
        : preparing
          ? translate('workspace.notice.preparing', { name: value.displayName })
          : translate('workspace.notice.registered', { name: value.displayName })
      return finishRepositoryAdd(value, message)
    },
    [finishRepositoryAdd, notify, validateAddPath]
  )

  const retryPreparation = useCallback(
    async (repoId: string): Promise<void> => {
      const result = await callApi(window.icode.repos.retryPreparation({ repoId }))
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      await refreshRepos()
      notify({
        tone: 'info',
        message: translate('workspace.notice.retryingFirstCommit', {
          project: result.value.displayName
        })
      })
    },
    [notify, refreshRepos]
  )

  const removeRepository = useCallback(
    async (repoId: string): Promise<void> => {
      const result = await callApi(window.icode.repos.remove({ repoId }))
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      const outcome = result.value
      if (outcome.status === 'removed') {
        dispatch({ type: 'removalPrompt', prompt: null })
        notify({ tone: 'success', message: translate('workspace.notice.repositoryRemoved') })
        await Promise.all([refreshRepos(), refreshSessions()])
        return
      }
      if (outcome.status === 'confirmation_required') {
        const repo = state.repos.find((entry) => entry.id === repoId)
        dispatch({
          type: 'removalPrompt',
          prompt: {
            repoId,
            repoName: repo?.displayName ?? repoId,
            sessions: outcome.sessions
          }
        })
        return
      }
      if (outcome.status === 'blocked_live_sessions') {
        notify({
          tone: 'error',
          message: translate('workspace.notice.repositoryStillLive'),
          detail: outcome.sessions.map((session) => session.title).join(', ')
        })
        return
      }
      if (outcome.status === 'blocked_worktree_changes') {
        notify({
          tone: 'error',
          message: translate('workspace.notice.worktreesHoldWork'),
          detail: outcome.blockers
            .map((entry) => `${entry.session.title}: ${entry.blocker.kind}`)
            .join(', ')
        })
        return
      }
      notify({
        tone: 'error',
        message: translate('workspace.notice.couldNotVerify'),
        detail: outcome.error.message
      })
    },
    [notify, refreshRepos, refreshSessions, state.repos]
  )

  const confirmRemoval = useCallback(async (): Promise<void> => {
    const prompt = state.removal
    if (!prompt) return
    const result = await callApi(
      window.icode.repos.remove({
        repoId: prompt.repoId,
        acknowledgeDependentSessions: true
      })
    )
    if (!result.ok) {
      notify(errorNotice(result.error))
      return
    }
    const outcome = result.value
    if (outcome.status === 'removed') {
      dispatch({ type: 'removalPrompt', prompt: null })
      notify({
        tone: 'success',
        message: translate('workspace.notice.projectRemoved', { project: prompt.repoName })
      })
      await Promise.all([refreshRepos(), refreshSessions()])
      return
    }
    if (outcome.status === 'blocked_live_sessions') {
      dispatch({ type: 'removalPrompt', prompt: null })
      notify({
        tone: 'error',
        message: translate('workspace.notice.removalLive'),
        detail: outcome.sessions.map((session) => session.title).join(', ')
      })
      return
    }
    if (outcome.status === 'blocked_worktree_changes') {
      dispatch({ type: 'removalPrompt', prompt: null })
      notify({
        tone: 'error',
        message: translate('workspace.notice.removalWorktrees'),
        detail: outcome.blockers
          .map((entry) => `${entry.session.title}: ${entry.blocker.kind}`)
          .join(', ')
      })
      return
    }
    dispatch({ type: 'removalPrompt', prompt: null })
    notify({
      tone: 'error',
      message: translate('workspace.notice.removalIncomplete'),
      ...(outcome.status === 'host_unavailable' ? { detail: outcome.error.message } : {})
    })
  }, [notify, refreshRepos, refreshSessions, state.removal])

  const dismissRemoval = useCallback(() => {
    dispatch({ type: 'removalPrompt', prompt: null })
  }, [])

  /** Ordinary removal: blocks on live, dirty, unmerged, missing or inconsistent worktrees. */
  const requestRemoveSession = useCallback(
    async (sessionId: string): Promise<void> => {
      const session = state.sessions.find((entry) => entry.id === sessionId)
      dispatch({ type: 'pendingSet', sessionId, action: 'removing' })
      const result = await callApi(window.icode.sessions.remove({ sessionId, stopIfLive: true }))
      if (!result.ok) {
        dispatch({ type: 'pendingClear', sessionId })
        notify(errorNotice(result.error))
        return
      }
      const outcome = result.value
      if (outcome.status === 'removed') {
        // The backend has deleted the row. Drop it from this window immediately
        // instead of making the user wait for a full Host/Git refresh first.
        dispatch({ type: 'sessionRemoved', sessionId })
        notify({ tone: 'success', message: translate('workspace.notice.sessionRemoved') })
        void Promise.all([refreshSessions(), refreshBranches()])
        return
      }
      dispatch({ type: 'pendingClear', sessionId })
      if (outcome.status === 'blocked_live_sessions') {
        notify({
          tone: 'error',
          message: translate('workspace.notice.sessionStillRunning')
        })
        return
      }
      if (outcome.status === 'host_unavailable') {
        notify({
          tone: 'error',
          message: translate('workspace.notice.terminalUnavailable'),
          detail: outcome.error.message
        })
        return
      }
      // Dirty/unmerged/missing/inconsistent: only now surface the exceptional
      // state. The normal removal path never explains worktrees or Git internals.
      dispatch({
        type: 'sessionCleanup',
        prompt: {
          sessionId,
          title: session?.title ?? outcome.session.title,
          branch: outcome.session.worktree?.branch ?? '',
          blocker: outcome.blocker
        }
      })
      await refreshSessions()
    },
    [notify, refreshBranches, refreshSessions, state.sessions]
  )

  const discardSession = useCallback(
    async (sessionId: string, confirmBranch: string): Promise<boolean> => {
      const result = await callApi(
        window.icode.sessions.discard({ sessionId, confirmBranch })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return false
      }
      const outcome = result.value
      if (outcome.status === 'discarded') {
        dispatch({ type: 'sessionCleanup', prompt: null })
        notify({
          tone: 'success',
          message: translate('workspace.notice.discarded', { branch: outcome.branch }),
          detail: translate('workspace.discard.summary', {
            files: translatePlural('workspace.discard.files', outcome.files.length),
            commits: translatePlural('workspace.discard.commits', outcome.commits)
          })
        })
        await Promise.all([refreshSessions(), refreshBranches()])
        return true
      }
      if (outcome.status === 'blocked_worktree') {
        dispatch({
          type: 'sessionCleanup',
          prompt: {
            sessionId,
            title:
              state.sessions.find((entry) => entry.id === sessionId)?.title ??
              translate('workspace.notice.sessionFallback'),
            branch: state.sessions.find((entry) => entry.id === sessionId)?.worktree?.branch ?? '',
            blocker: outcome.blocker
          }
        })
        notify({
          tone: 'error',
          message: translate('workspace.notice.discardBlocked'),
          detail: outcome.blocker.detail ?? outcome.blocker.kind
        })
        return false
      }
      notify({
        tone: 'error',
        message:
          outcome.status === 'host_unavailable'
            ? translate('workspace.notice.hostUnreachableNothingDiscarded')
            : translate('workspace.notice.liveBlocksDiscard')
      })
      return false
    },
    [notify, refreshBranches, refreshSessions, state.sessions]
  )

  const recoverWorktree = useCallback(
    async (sessionId: string): Promise<void> => {
      const result = await callApi(window.icode.sessions.recoverWorktree({ sessionId }))
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      dispatch({ type: 'sessionUpserted', session: result.value })
      dispatch({ type: 'sessionCleanup', prompt: null })
      notify({
        tone: 'success',
        message: translate('workspace.notice.recovered')
      })
      await refreshSessions()
    },
    [notify, refreshSessions]
  )

  const dismissSessionCleanup = useCallback(() => {
    dispatch({ type: 'sessionCleanup', prompt: null })
  }, [])

  const requestRemoveBranch = useCallback(
    async (branch: string, confirmBranch?: string): Promise<void> => {
      const repoId = state.activeRepoId
      if (repoId === null) return
      const result = await callApi(
        window.icode.branches.remove({
          repoId,
          branch,
          ...(confirmBranch === undefined ? {} : { confirmBranch })
        })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      const outcome = result.value
      if (outcome.status === 'removed') {
        dispatch({ type: 'branchCleanup', prompt: null })
        notify({
          tone: 'success',
          message: translate('workspace.notice.branchDeleted', { branch: outcome.branch })
        })
        await refreshBranches()
        return
      }
      if (outcome.status === 'confirmation_required') {
        dispatch({
          type: 'branchCleanup',
          prompt: { repoId, branch: outcome.branch, commits: outcome.commits }
        })
        return
      }
      if (outcome.status === 'blocked_worktree') {
        notify({
          tone: 'error',
          message: translate('workspace.notice.branchWorktree'),
          detail: outcome.path
        })
        return
      }
      notify({
        tone: 'error',
        message: translate('workspace.notice.branchNotOwned')
      })
    },
    [notify, refreshBranches, state.activeRepoId]
  )

  const dismissBranchCleanup = useCallback(() => {
    dispatch({ type: 'branchCleanup', prompt: null })
  }, [])

  const createSession = useCallback(
    async (input: CreateSessionRequest): Promise<boolean> => {
      const detection = state.harnesses.find((entry) => entry.harness === input.harness)
      if (!detection || detection.state !== 'available') {
        notify({
          tone: 'error',
          message: translate('workspace.notice.harnessUnavailable')
        })
        return false
      }
      setCreating(true)
      /*
       * Start the PTY at the grid the terminal last occupied. A hardcoded
       * 100x30 was always wrong at least once and forced a visible reflow on
       * every first attach; the fit still corrects changes in window size.
       */
      const terminalSize = readTerminalSize() ?? { cols: 100, rows: 30 }
      const result = await callApi(
        window.icode.sessions.create({
          repoId: input.repoId,
          harness: input.harness,
          ...(input.title && input.title.trim().length > 0 ? { title: input.title.trim() } : {}),
          cols: terminalSize.cols,
          rows: terminalSize.rows
        })
      )
      setCreating(false)
      if (!result.ok) {
        notify(errorNotice(result.error))
        // A failed create may still leave a durable failed row; load the truth
        // rather than adding a phantom session locally.
        await refreshSessions()
        if (
          result.error.code === 'HARNESS_UNAVAILABLE' ||
          result.error.code === 'HARNESS_DETECTION_FAILED'
        ) {
          await refreshHarnesses(true)
        }
        return false
      }
      dispatch({ type: 'sessionUpserted', session: result.value })
      dispatch({ type: 'selectSession', sessionId: result.value.id })
      notify({
        tone: 'success',
        message: translate('workspace.notice.started', { title: result.value.title })
      })
      return true
    },
    [notify, refreshHarnesses, refreshSessions, state.harnesses]
  )

  const stopSession = useCallback(
    async (sessionId: string): Promise<void> => {
      const session = state.sessions.find((entry) => entry.id === sessionId)
      dispatch({ type: 'pendingSet', sessionId, action: 'stopping' })
      const result = await callApi(window.icode.sessions.close({ sessionId }))
      if (!result.ok) {
        dispatch({ type: 'pendingClear', sessionId })
        notify(errorNotice(result.error))
        await refreshSessions()
        return
      }
      notify({
        tone: 'info',
        message: translate('workspace.notice.stopRequested', {
          title: session?.title ?? translate('workspace.notice.theSession')
        })
      })
      const existing = stopTimers.current.get(sessionId)
      if (existing !== undefined) clearTimeout(existing)
      stopTimers.current.set(
        sessionId,
        setTimeout(() => {
          stopTimers.current.delete(sessionId)
          void (async () => {
            const fresh = await callApi(window.icode.sessions.get({ sessionId }))
            if (!fresh.ok) {
              dispatch({ type: 'pendingClear', sessionId })
              notify(errorNotice(fresh.error))
              await refreshSessions()
              return
            }
            dispatch({ type: 'sessionUpserted', session: fresh.value })
            if (isActiveSessionState(fresh.value.state)) {
              dispatch({ type: 'pendingClear', sessionId })
              notify({
                tone: 'error',
                message: translate('workspace.notice.stillRunning'),
                ...(fresh.value.error ? { detail: fresh.value.error.message } : {})
              })
            } else {
              dispatch({ type: 'pendingClear', sessionId })
            }
          })()
        }, STOP_RECONCILE_MS)
      )
    },
    [notify, refreshSessions, state.sessions]
  )

  const restartSession = useCallback(
    async (sessionId: string): Promise<void> => {
      const session = state.sessions.find((entry) => entry.id === sessionId)
      const pendingStop = stopTimers.current.get(sessionId)
      if (pendingStop !== undefined) {
        clearTimeout(pendingStop)
        stopTimers.current.delete(sessionId)
      }
      dispatch({ type: 'pendingSet', sessionId, action: 'restarting' })
      const result = await callApi(window.icode.sessions.restart({ sessionId }))
      dispatch({ type: 'pendingClear', sessionId })
      if (!result.ok) {
        notify(errorNotice(result.error))
        await refreshSessions()
        return
      }
      dispatch({ type: 'sessionUpserted', session: result.value })
      notify({
        tone: 'success',
        message: translate('workspace.notice.restarted', {
          title: session?.title ?? translate('workspace.notice.theSession')
        })
      })
    },
    [notify, refreshSessions, state.sessions]
  )

  const sleepSession = useCallback(
    async (sessionId: string): Promise<void> => {
      const session = state.sessions.find((entry) => entry.id === sessionId)
      dispatch({ type: 'pendingSet', sessionId, action: 'sleeping' })
      const result = await callApi(window.icode.sessions.sleep({ sessionId }))
      dispatch({ type: 'pendingClear', sessionId })
      if (!result.ok) {
        notify(errorNotice(result.error))
        await refreshSessions()
        return
      }
      dispatch({ type: 'sessionUpserted', session: result.value })
      notify({
        tone: 'info',
        message: translate('workspace.notice.slept', {
          title: session?.title ?? translate('workspace.notice.theSession')
        }),
        detail:
          session === undefined
            ? undefined
            : wakeDescription(session.harness, getLocale())
      })
    },
    [notify, refreshSessions, state.sessions]
  )

  const wakeSession = useCallback(
    async (sessionId: string): Promise<void> => {
      const session = state.sessions.find((entry) => entry.id === sessionId)
      dispatch({ type: 'pendingSet', sessionId, action: 'waking' })
      const result = await callApi(window.icode.sessions.wake({ sessionId }))
      dispatch({ type: 'pendingClear', sessionId })
      if (!result.ok) {
        notify(errorNotice(result.error))
        await refreshSessions()
        return
      }
      dispatch({ type: 'sessionUpserted', session: result.value })
      notify({
        tone: 'success',
        message: translate('workspace.notice.woke', {
          title: session?.title ?? translate('workspace.notice.theSession')
        }),
        detail:
          session === undefined
            ? undefined
            : wakePlan(session.harness, null).resumesConversation
              ? translate('workspace.resumed')
              : translate('workspace.notice.newShell')
      })
    },
    [notify, refreshSessions, state.sessions]
  )

  const recheckSession = useCallback(
    async (sessionId: string): Promise<void> => {
      const result = await callApi(window.icode.sessions.get({ sessionId }))
      if (!result.ok) {
        notify(errorNotice(result.error))
        await refreshSessions()
        return
      }
      dispatch({ type: 'sessionUpserted', session: result.value })
      if (isTerminalSessionState(result.value.state)) {
        notify({
          tone: 'info',
          message: translate('workspace.notice.sessionState', {
            state: translate(`session.state.${result.value.state}`)
          }),
          ...(result.value.exitCode !== null
            ? { detail: translate('workspace.notice.exitCode', { code: result.value.exitCode }) }
            : {})
        })
      }
    },
    [notify, refreshSessions]
  )

  const dismissNotice = useCallback(() => {
    dispatch({ type: 'notice', notice: null })
  }, [])

  return {
    state,
    runtime,
    creating,
    addRepository,
    initializeRepository,
    retryPreparation,
    removeRepository,
    confirmRemoval,
    dismissRemoval,
    createSession,
    stopSession,
    restartSession,
    sleepSession,
    wakeSession,
    recheckSession,
    requestRemoveSession,
    discardSession,
    recoverWorktree,
    dismissSessionCleanup,
    requestRemoveBranch,
    dismissBranchCleanup,
    selectRepo,
    selectSession,
    refreshHarnesses,
    refreshAll,
    dismissNotice,
    reportError,
    notify
  }
}
