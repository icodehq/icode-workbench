import type { AppError } from '../../../shared/domain/errors'
import type { HarnessDetection } from '../../../shared/domain/harness'
import { isTerminalSessionState } from '../../../shared/domain/session'
import type {
  OrphanedHostSession,
  OwnedBranchSummary,
  RepositorySummary,
  SessionSummary,
  WorktreeBlocker
} from '../../../shared/schemas/ipc'

export type BootPhase = 'loading' | 'ready' | 'failed'
export type PendingAction = 'stopping' | 'restarting' | 'sleeping' | 'waking' | 'removing'
export type NoticeTone = 'info' | 'success' | 'error'

export type Notice = {
  tone: NoticeTone
  message: string
  detail?: string
  /** Optional inline recovery action, such as Undo for a file operation. */
  action?: {
    label: string
    run: () => void
  }
}

export type SessionCleanupPrompt = {
  sessionId: string
  title: string
  branch: string
  blocker: WorktreeBlocker | null
}

export type BranchCleanupPrompt = {
  repoId: string
  branch: string
  commits: number
}

export type WorkspaceState = {
  boot: BootPhase
  bootError: string | null
  repos: RepositorySummary[]
  sessions: SessionSummary[]
  orphans: OrphanedHostSession[]
  harnesses: HarnessDetection[]
  harnessLoading: boolean
  harnessError: AppError | null
  activeRepoId: string | null
  activeSessionId: string | null
  pending: Record<string, PendingAction>
  notice: Notice | null
  /** Repos removed optimistically; late session events for them are ignored. */
  removingRepoIds: string[]
  branches: OwnedBranchSummary[]
  sessionCleanup: SessionCleanupPrompt | null
  branchCleanup: BranchCleanupPrompt | null
  refreshing: boolean
}

export type WorkspaceAction =
  | { type: 'booted' }
  | { type: 'bootFailed'; message: string }
  | { type: 'reposLoaded'; repos: RepositorySummary[] }
  | { type: 'sessionsLoaded'; sessions: SessionSummary[]; orphans: OrphanedHostSession[] }
  | { type: 'harnessesLoading' }
  | { type: 'harnessesLoaded'; harnesses: HarnessDetection[] }
  | { type: 'harnessFailed'; error: AppError }
  | { type: 'selectRepo'; repoId: string }
  | { type: 'selectSession'; sessionId: string }
  | { type: 'sessionUpserted'; session: SessionSummary }
  | { type: 'sessionRemoved'; sessionId: string }
  | {
      type: 'activityUpdated'
      sessionId: string
      activity: SessionSummary['activity']
    }
  | { type: 'pendingSet'; sessionId: string; action: PendingAction }
  | { type: 'pendingClear'; sessionId: string }
  | { type: 'notice'; notice: Notice | null }
  | { type: 'repoRemoving'; repoId: string }
  | {
      type: 'repoRemovalRollback'
      repoId: string
      repos: RepositorySummary[]
      sessions: SessionSummary[]
      activeRepoId: string | null
      activeSessionId: string | null
    }
  | { type: 'branchesLoaded'; branches: OwnedBranchSummary[] }
  | { type: 'sessionCleanup'; prompt: SessionCleanupPrompt | null }
  | { type: 'branchCleanup'; prompt: BranchCleanupPrompt | null }
  | { type: 'refreshing'; value: boolean }

export function createInitialState(
  selection: { repoId?: string | null; sessionId?: string | null } = {}
): WorkspaceState {
  return {
    boot: 'loading',
    bootError: null,
    repos: [],
    sessions: [],
    orphans: [],
    harnesses: [],
    harnessLoading: false,
    harnessError: null,
    activeRepoId: selection.repoId ?? null,
    activeSessionId: selection.sessionId ?? null,
    pending: {},
    notice: null,
    removingRepoIds: [],
    branches: [],
    sessionCleanup: null,
    branchCleanup: null,
    refreshing: false
  }
}

function firstSessionForRepo(
  sessions: readonly SessionSummary[],
  repoId: string | null
): SessionSummary | null {
  if (repoId === null) return null
  return sessions.find((session) => session.repoId === repoId) ?? null
}

function sameActivity(
  left: SessionSummary['activity'],
  right: SessionSummary['activity']
): boolean {
  if (left === null || right === null) return left === right
  return (
    left.state === right.state &&
    left.toolName === right.toolName &&
    left.unread === right.unread &&
    left.outcome === right.outcome &&
    left.since === right.since
  )
}

function withoutPending(
  pending: Record<string, PendingAction>,
  sessions: readonly SessionSummary[]
): Record<string, PendingAction> {
  const next: Record<string, PendingAction> = {}
  for (const [sessionId, action] of Object.entries(pending)) {
    const session = sessions.find((entry) => entry.id === sessionId)
    if (!session) continue
    if (action === 'stopping' && isTerminalSessionState(session.state)) continue
    if (action === 'sleeping' && session.sleeping === true) continue
    if (action === 'waking' && session.state === 'live') continue
    next[sessionId] = action
  }
  return next
}

export function workspaceReducer(
  state: WorkspaceState,
  action: WorkspaceAction
): WorkspaceState {
  switch (action.type) {
    case 'booted':
      return { ...state, boot: 'ready', bootError: null }
    case 'bootFailed':
      return { ...state, boot: 'failed', bootError: action.message }
    case 'reposLoaded': {
      const repos = action.repos.filter(
        (repo) => !state.removingRepoIds.includes(repo.id)
      )
      const activeRepoId =
        state.activeRepoId !== null &&
        repos.some((repo) => repo.id === state.activeRepoId)
          ? state.activeRepoId
          : (repos[0]?.id ?? null)
      return { ...state, repos, activeRepoId }
    }
    case 'sessionsLoaded': {
      const sessions = action.sessions.filter(
        (session) => !state.removingRepoIds.includes(session.repoId)
      )
      const activeSessionId =
        state.activeSessionId !== null &&
        sessions.some((session) => session.id === state.activeSessionId)
          ? state.activeSessionId
          : (firstSessionForRepo(sessions, state.activeRepoId)?.id ?? null)
      let activeRepoId = state.activeRepoId
      const activeSession = sessions.find((session) => session.id === activeSessionId)
      if (activeSession && activeRepoId === null) activeRepoId = activeSession.repoId
      return {
        ...state,
        sessions,
        orphans: action.orphans,
        activeSessionId,
        activeRepoId,
        pending: withoutPending(state.pending, sessions),
        sessionCleanup:
          state.sessionCleanup !== null &&
          sessions.some((entry) => entry.id === state.sessionCleanup?.sessionId)
            ? state.sessionCleanup
            : null
      }
    }
    case 'harnessesLoading':
      return { ...state, harnessLoading: true, harnessError: null }
    case 'harnessesLoaded':
      return { ...state, harnesses: action.harnesses, harnessLoading: false, harnessError: null }
    case 'harnessFailed':
      return { ...state, harnessLoading: false, harnessError: action.error }
    case 'selectRepo': {
      if (!state.repos.some((repo) => repo.id === action.repoId)) return state
      const next = firstSessionForRepo(state.sessions, action.repoId)
      return { ...state, activeRepoId: action.repoId, activeSessionId: next?.id ?? null }
    }
    case 'selectSession': {
      const session = state.sessions.find((entry) => entry.id === action.sessionId)
      if (!session) return state
      return { ...state, activeSessionId: session.id, activeRepoId: session.repoId }
    }
    case 'activityUpdated': {
      // Advisory only: never touches state, reason, authority or pending actions.
      const index = state.sessions.findIndex((session) => session.id === action.sessionId)
      // A late event for a session this window no longer lists must not resurrect it.
      const current = index === -1 ? null : state.sessions[index]
      if (!current) return state
      if (sameActivity(current.activity, action.activity)) return state
      const sessions = state.sessions.map((session, position) =>
        position === index ? { ...session, activity: action.activity } : session
      )
      return { ...state, sessions }
    }
    case 'sessionUpserted': {
      if (state.removingRepoIds.includes(action.session.repoId)) return state
      const index = state.sessions.findIndex((session) => session.id === action.session.id)
      const sessions =
        index === -1
          ? [...state.sessions, action.session]
          : state.sessions.map((session, position) =>
              position === index ? action.session : session
            )
      const pending = { ...state.pending }
      if (isTerminalSessionState(action.session.state)) delete pending[action.session.id]
      return { ...state, sessions, pending }
    }
    case 'sessionRemoved': {
      const sessions = state.sessions.filter((session) => session.id !== action.sessionId)
      const activeSessionId =
        state.activeSessionId === action.sessionId
          ? (firstSessionForRepo(sessions, state.activeRepoId)?.id ?? null)
          : state.activeSessionId
      const pending = { ...state.pending }
      delete pending[action.sessionId]
      return {
        ...state,
        sessions,
        activeSessionId,
        pending,
        sessionCleanup:
          state.sessionCleanup?.sessionId === action.sessionId ? null : state.sessionCleanup
      }
    }
    case 'pendingSet':
      return {
        ...state,
        pending: { ...state.pending, [action.sessionId]: action.action }
      }
    case 'pendingClear': {
      if (state.pending[action.sessionId] === undefined) return state
      const pending = { ...state.pending }
      delete pending[action.sessionId]
      return { ...state, pending }
    }
    case 'notice':
      return { ...state, notice: action.notice }
    case 'repoRemoving': {
      const removingRepoIds = state.removingRepoIds.includes(action.repoId)
        ? state.removingRepoIds
        : [...state.removingRepoIds, action.repoId]
      return {
        ...state,
        repos: state.repos.filter((repo) => repo.id !== action.repoId),
        sessions: state.sessions.filter((session) => session.repoId !== action.repoId),
        removingRepoIds,
        activeRepoId: state.activeRepoId === action.repoId ? null : state.activeRepoId,
        activeSessionId:
          state.sessions.find(
            (session) =>
              session.id === state.activeSessionId && session.repoId === action.repoId
          ) !== undefined
            ? null
            : state.activeSessionId
      }
    }
    case 'repoRemovalRollback': {
      const removingRepoIds = state.removingRepoIds.filter(
        (repoId) => repoId !== action.repoId
      )
      return {
        ...state,
        repos: action.repos,
        sessions: action.sessions,
        removingRepoIds,
        activeRepoId: action.activeRepoId,
        activeSessionId: action.activeSessionId
      }
    }
    case 'branchesLoaded':
      return { ...state, branches: action.branches }
    case 'sessionCleanup':
      return { ...state, sessionCleanup: action.prompt }
    case 'branchCleanup':
      return { ...state, branchCleanup: action.prompt }
    case 'refreshing':
      return { ...state, refreshing: action.value }
    default:
      return state
  }
}

export function activeRepo(state: WorkspaceState): RepositorySummary | null {
  return state.repos.find((repo) => repo.id === state.activeRepoId) ?? null
}

export function activeSession(state: WorkspaceState): SessionSummary | null {
  return state.sessions.find((session) => session.id === state.activeSessionId) ?? null
}

export function sessionsForRepo(
  state: WorkspaceState,
  repoId: string
): SessionSummary[] {
  return state.sessions.filter((session) => session.repoId === repoId)
}

export function pendingAction(
  state: WorkspaceState,
  sessionId: string
): PendingAction | null {
  return state.pending[sessionId] ?? null
}

export function availableHarnesses(state: WorkspaceState): HarnessDetection[] {
  return state.harnesses.filter((detection) => detection.state === 'available')
}
