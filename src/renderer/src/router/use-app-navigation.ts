import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TaskRecordPayload } from '../../../shared/icode-api'
import type { SessionSummary } from '../../../shared/schemas/ipc'
import type { TaskQueue } from '../state/use-task-queue'
import { activeRepo, activeSession, type WorkspaceState } from '../state/workspace'
import type { ProjectMode, Surface } from './routes'

export type ViewName = 'terminal' | 'changes' | 'files'

export type TaskSessionRoute = {
  taskId: string
  sessionId: string
}

export type ViewRequest = {
  view: ViewName
  nonce: number
}

export type OpenFileRequest = {
  path: string
  line: number
  nonce: number
}

type NavigationWorkspace = {
  state: WorkspaceState
  selectRepo: (repoId: string) => void
  selectSession: (sessionId: string) => void
}

type UseAppNavigationInput = {
  workspace: NavigationWorkspace
  tasks: TaskQueue
}

export type AppNavigation = {
  // Route state
  displaySurface: Surface
  taskSession: TaskSessionRoute | null
  taskSessionTask: TaskRecordPayload | null
  taskSessionLive: SessionSummary | null
  focusTaskId: string | null
  focusComposerNonce: number
  taskSelectionByRepo: Record<string, string>

  // Route-context projections
  taskSessionIds: Set<string>
  projectDirectSessions: SessionSummary[]
  projectSession: SessionSummary | null
  quickOpenSession: SessionSummary | null
  focusableSessionId: string | null

  // Route-dependent requests
  viewRequest: ViewRequest | null
  openRequest: OpenFileRequest | null

  commands: {
    showProjects: () => void
    showSchedules: () => void
    showSettings: () => void
    showSessions: () => void
    backToTasks: () => void
    openProject: (repoId: string, mode?: ProjectMode) => void
    switchProject: (repoId: string) => void
    changeMode: (mode: ProjectMode) => void
    openDirectSession: (sessionId: string) => void
    openTask: (task: TaskRecordPayload) => void
    openTaskSession: (sessionId: string, view?: ViewName) => void
    openTaskComposer: () => void
    rememberTaskSelection: (taskId: string) => void
    requestView: (view: ViewName) => void
    requestOpenInFiles: (path: string, line: number) => void
    clearOpenRequest: () => void
    clearViewRequest: () => void
    openFileFromPalette: (path: string, line: number) => void
  }
}

/**
 * Owns the shell's route state and every navigation command.
 *
 * It only decides which page and project mode are shown; workspace data,
 * overlays, shell chrome state, terminal panes and page composition stay with
 * their existing owners.
 */
export function useAppNavigation({
  workspace,
  tasks
}: UseAppNavigationInput): AppNavigation {
  const { state } = workspace
  const [surface, setSurface] = useState<Surface>('projects')
  const [taskSession, setTaskSession] = useState<TaskSessionRoute | null>(null)
  const [focusTaskId, setFocusTaskId] = useState<string | null>(null)
  const [focusComposerNonce, setFocusComposerNonce] = useState(0)
  const [taskSelectionByRepo, setTaskSelectionByRepo] = useState<Record<string, string>>({})
  const [viewRequest, setViewRequest] = useState<ViewRequest | null>(null)
  const [openRequest, setOpenRequest] = useState<OpenFileRequest | null>(null)

  const repo = activeRepo(state)
  const active = activeSession(state)
  const taskSessionIds = useMemo(
    () =>
      new Set(
        tasks.tasks
          .map((task) => task.sessionId)
          .filter((id): id is string => id !== null)
      ),
    [tasks.tasks]
  )

  const directSessions = useMemo(
    () => state.sessions.filter((session) => !taskSessionIds.has(session.id)),
    [state.sessions, taskSessionIds]
  )
  const projectDirectSessions = useMemo(
    () => (repo === null ? [] : directSessions.filter((session) => session.repoId === repo.id)),
    [directSessions, repo]
  )
  const projectSession = useMemo(
    () => projectDirectSessions.find((session) => session.id === state.activeSessionId) ?? null,
    [projectDirectSessions, state.activeSessionId]
  )

  const taskSessionTask = taskSession === null
    ? null
    : tasks.tasks.find((task) => task.id === taskSession.taskId) ?? null
  const taskSessionLive = taskSession === null
    ? null
    : state.sessions.find((session) => session.id === taskSession.sessionId) ?? null

  // A project surface without a project is the wall. The status and task stores
  // can change under a removed repository, so this is derived on every render.
  const displaySurface: Surface =
    (surface === 'sessions' || surface === 'tasks') && repo === null ? 'projects' : surface
  const focusableSessionId =
    displaySurface === 'sessions'
      ? projectSession?.id ?? null
      : displaySurface === 'tasks'
        ? taskSessionLive?.id ?? null
        : null

  const selectedWorkbenchTask =
    displaySurface !== 'tasks' || repo === null
      ? null
      : (tasks.tasks.find(
          (task) =>
            task.repoId === repo.id &&
            task.id === (focusTaskId ?? taskSelectionByRepo[repo.id] ?? null)
        ) ?? null)
  const taskWorkbenchSession =
    selectedWorkbenchTask?.sessionId === null || selectedWorkbenchTask?.sessionId === undefined
      ? null
      : (state.sessions.find((session) => session.id === selectedWorkbenchTask.sessionId) ?? null)

  const quickOpenSession =
    taskSession !== null
      ? active
      : displaySurface === 'sessions'
        ? projectSession
        : displaySurface === 'tasks'
          ? taskWorkbenchSession
          : null

  useEffect(() => {
    if ((surface === 'sessions' || surface === 'tasks') && repo === null) setSurface('projects')
  }, [repo, surface])

  useEffect(() => {
    if (taskSession === null) return
    if (taskSessionTask === null || taskSessionLive === null) setTaskSession(null)
  }, [taskSession, taskSessionLive, taskSessionTask])

  // Sessions is a direct-session mode. If the remembered row belongs to a task,
  // choose a direct session rather than silently showing a task-owned PTY.
  useEffect(() => {
    if (surface !== 'sessions' || repo === null) return
    if (projectDirectSessions.length === 0) return
    if (projectDirectSessions.some((session) => session.id === state.activeSessionId)) return
    const first = projectDirectSessions[0]
    if (first) workspace.selectSession(first.id)
  }, [projectDirectSessions, repo, state.activeSessionId, surface, workspace])

  useEffect(() => {
    if (taskSession !== null && taskSession.taskId !== taskSessionTask?.id) setTaskSession(null)
  }, [taskSession, taskSessionTask])

  const clearProjectView = useCallback((): void => {
    setTaskSession(null)
    setViewRequest(null)
    setFocusTaskId(null)
  }, [])

  const showProjects = useCallback((): void => {
    clearProjectView()
    setSurface('projects')
  }, [clearProjectView])

  const showSchedules = useCallback((): void => {
    clearProjectView()
    setSurface('schedules')
  }, [clearProjectView])

  const showSettings = useCallback((): void => {
    clearProjectView()
    setSurface('settings')
  }, [clearProjectView])

  const showSessions = useCallback((): void => {
    setSurface('sessions')
    setTaskSession(null)
    setViewRequest(null)
  }, [])

  const backToTasks = useCallback((): void => {
    setTaskSession(null)
  }, [])

  const openProject = useCallback(
    (repoId: string, mode?: ProjectMode): void => {
      const direct = state.sessions.filter(
        (session) => session.repoId === repoId && !taskSessionIds.has(session.id)
      )
      const repoTasks = tasks.tasks.filter((task) => task.repoId === repoId)
      const nextMode: ProjectMode =
        mode ?? (direct.length > 0 ? 'sessions' : repoTasks.length > 0 ? 'tasks' : 'sessions')
      if (nextMode === 'sessions' && direct.length > 0) {
        const first = direct[0]
        if (first) workspace.selectSession(first.id)
      } else {
        workspace.selectRepo(repoId)
      }
      setSurface(nextMode)
      clearProjectView()
    },
    [clearProjectView, state.sessions, taskSessionIds, tasks.tasks, workspace]
  )

  const switchProject = useCallback(
    (repoId: string): void => {
      openProject(repoId, displaySurface === 'tasks' ? 'tasks' : 'sessions')
    },
    [displaySurface, openProject]
  )

  const changeMode = useCallback(
    (mode: ProjectMode): void => {
      if (repo === null) return
      setTaskSession(null)
      setViewRequest(null)
      setSurface(mode)
      if (mode === 'sessions') {
        const direct = state.sessions.filter(
          (session) => session.repoId === repo.id && !taskSessionIds.has(session.id)
        )
        if (direct.length > 0 && !direct.some((session) => session.id === state.activeSessionId)) {
          const first = direct[0]
          if (first) workspace.selectSession(first.id)
        }
      }
    },
    [repo, state.activeSessionId, state.sessions, taskSessionIds, workspace]
  )

  const openDirectSession = useCallback(
    (sessionId: string): void => {
      const session = state.sessions.find((entry) => entry.id === sessionId)
      if (!session) return
      const owningTask = tasks.tasks.find((task) => task.sessionId === sessionId)
      if (owningTask) {
        workspace.selectSession(sessionId)
        setSurface('tasks')
        setTaskSession({ taskId: owningTask.id, sessionId })
        setFocusTaskId(owningTask.id)
        setViewRequest(null)
        return
      }
      workspace.selectSession(sessionId)
      setSurface('sessions')
      setTaskSession(null)
      setViewRequest(null)
    },
    [state.sessions, tasks.tasks, workspace]
  )

  const openTask = useCallback(
    (task: TaskRecordPayload): void => {
      workspace.selectRepo(task.repoId)
      setSurface('tasks')
      setTaskSession(null)
      setFocusTaskId(task.id)
      setViewRequest(null)
    },
    [workspace]
  )

  const openTaskSession = useCallback(
    (sessionId: string, view?: ViewName): void => {
      const owningTask = tasks.tasks.find((task) => task.sessionId === sessionId)
      if (!owningTask) {
        workspace.selectSession(sessionId)
        setSurface('sessions')
        setTaskSession(null)
        if (view) setViewRequest({ view, nonce: Date.now() })
        return
      }
      workspace.selectSession(sessionId)
      setSurface('tasks')
      setTaskSession({ taskId: owningTask.id, sessionId })
      setFocusTaskId(owningTask.id)
      setViewRequest(view ? { view, nonce: Date.now() } : null)
    },
    [tasks.tasks, workspace]
  )

  const openTaskComposer = useCallback((): void => {
    setSurface('tasks')
    setTaskSession(null)
    setFocusTaskId(null)
    setViewRequest(null)
    setFocusComposerNonce((current) => current + 1)
  }, [])

  const rememberTaskSelection = useCallback(
    (taskId: string): void => {
      if (repo === null) return
      setTaskSelectionByRepo((current) =>
        current[repo.id] === taskId ? current : { ...current, [repo.id]: taskId }
      )
    },
    [repo]
  )

  const requestView = useCallback((view: ViewName): void => {
    setViewRequest({ view, nonce: Date.now() })
  }, [])

  const requestOpenInFiles = useCallback((path: string, line: number): void => {
    setOpenRequest({ path, line, nonce: Date.now() })
  }, [])

  const clearOpenRequest = useCallback((): void => {
    setOpenRequest(null)
  }, [])

  const clearViewRequest = useCallback((): void => {
    setViewRequest(null)
  }, [])

  const openFileFromPalette = useCallback(
    (path: string, line: number): void => {
      if (quickOpenSession === null) return
      requestOpenInFiles(path, line)
      if (displaySurface === 'sessions' || taskSession !== null) {
        setViewRequest({ view: 'files', nonce: Date.now() })
      }
    },
    [displaySurface, quickOpenSession, requestOpenInFiles, taskSession]
  )

  const commands = useMemo(
    () => ({
      showProjects,
      showSchedules,
      showSettings,
      showSessions,
      backToTasks,
      openProject,
      switchProject,
      changeMode,
      openDirectSession,
      openTask,
      openTaskSession,
      openTaskComposer,
      rememberTaskSelection,
      requestView,
      requestOpenInFiles,
      clearOpenRequest,
      clearViewRequest,
      openFileFromPalette
    }),
    [
      backToTasks,
      changeMode,
      clearOpenRequest,
      clearViewRequest,
      openDirectSession,
      openFileFromPalette,
      openProject,
      openTask,
      openTaskComposer,
      openTaskSession,
      rememberTaskSelection,
      requestOpenInFiles,
      requestView,
      showProjects,
      showSchedules,
      showSessions,
      showSettings,
      switchProject
    ]
  )

  return {
    displaySurface,
    taskSession,
    taskSessionTask,
    taskSessionLive,
    focusTaskId,
    focusComposerNonce,
    taskSelectionByRepo,
    taskSessionIds,
    projectDirectSessions,
    projectSession,
    quickOpenSession,
    focusableSessionId,
    viewRequest,
    openRequest,
    commands
  }
}
