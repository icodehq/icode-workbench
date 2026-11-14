import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TaskRecordPayload } from '../../../shared/icode-api'
import type { SessionSummary } from '../../../shared/schemas/ipc'
import type { TaskQueue } from '../state/use-task-queue'
import { activeRepo, activeSession, type WorkspaceState } from '../state/workspace'
import type { AppTab, AuxAppTab } from '../components/shell/app-tabs'
import {
  closeAuxTab as removeAuxTab,
  nextActiveAfterClose,
  openAuxTab
} from '../components/shell/app-tabs'
import type { AssistantTarget, ProjectMode, Surface } from './routes'

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

export type TaskViewRequest = {
  tab: 'terminal' | 'changes' | 'files'
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
  activeTab: AppTab
  auxTabs: AuxAppTab[]
  taskSession: TaskSessionRoute | null
  taskSessionTask: TaskRecordPayload | null
  taskSessionLive: SessionSummary | null
  focusTaskId: string | null
  focusComposerNonce: number
  taskSelectionByRepo: Record<string, string>
  selectedTaskId: string | null

  // Route-context projections
  taskSessionIds: Set<string>
  projectDirectSessions: SessionSummary[]
  projectSession: SessionSummary | null
  quickOpenSession: SessionSummary | null
  focusableSessionId: string | null

  // Route-dependent requests
  viewRequest: ViewRequest | null
  taskViewRequest: TaskViewRequest | null
  openRequest: OpenFileRequest | null
  assistantTarget: (AssistantTarget & { nonce: number }) | null

  commands: {
    showSchedules: () => void
    showSettings: () => void
    showAssistant: (target?: AssistantTarget) => void
    clearAssistantTarget: () => void
    showSessions: () => void
    openAppTab: (tab: AppTab) => void
    closeAppTab: (tab: AuxAppTab) => void
    backToTasks: () => void
    openProject: (repoId: string, mode?: ProjectMode) => void
    switchProject: (repoId: string) => void
    changeMode: (mode: ProjectMode) => void
    openDirectSession: (sessionId: string) => void
    openTask: (task: TaskRecordPayload) => void
    openTaskSession: (sessionId: string, view?: ViewName) => void
    openTaskComposer: () => void
    requestView: (view: ViewName) => void
    requestOpenInFiles: (path: string, line: number) => void
    clearOpenRequest: () => void
    clearViewRequest: () => void
    clearTaskViewRequest: () => void
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
  const [surface, setSurface] = useState<Surface>('sessions')
  const [auxTabs, setAuxTabs] = useState<AuxAppTab[]>([])
  const [taskSession, setTaskSession] = useState<TaskSessionRoute | null>(null)
  const [focusTaskId, setFocusTaskId] = useState<string | null>(null)
  const [focusComposerNonce, setFocusComposerNonce] = useState(0)
  const [taskSelectionByRepo, setTaskSelectionByRepo] = useState<Record<string, string>>({})
  const [viewRequest, setViewRequest] = useState<ViewRequest | null>(null)
  const [taskViewRequest, setTaskViewRequest] = useState<TaskViewRequest | null>(null)
  const [openRequest, setOpenRequest] = useState<OpenFileRequest | null>(null)
  const [assistantTarget, setAssistantTarget] = useState<
    (AssistantTarget & { nonce: number }) | null
  >(null)

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
  const activeTab: AppTab =
    displaySurface === 'assistant'
      ? 'mira'
      : displaySurface === 'settings'
        ? 'settings'
        : displaySurface === 'schedules'
          ? 'schedules'
          : 'sessions'
  const selectedId = focusTaskId ?? (repo === null ? null : taskSelectionByRepo[repo.id] ?? null)
  const selectedWorkbenchTask =
    displaySurface !== 'tasks' || repo === null
      ? null
      : ([...tasks.tasks, ...tasks.archivedTasks].find(
          (task) => task.repoId === repo.id && task.id === selectedId
        ) ??
          tasks.tasks.find((task) => task.repoId === repo.id) ??
          null)
  const selectedTaskId = selectedWorkbenchTask?.id ?? null
  const taskWorkbenchSession =
    selectedWorkbenchTask?.sessionId === null || selectedWorkbenchTask?.sessionId === undefined
      ? null
      : (state.sessions.find((session) => session.id === selectedWorkbenchTask.sessionId) ?? null)

  const focusableSessionId =
    displaySurface === 'sessions'
      ? projectSession?.id ?? null
      : displaySurface === 'tasks'
        ? taskWorkbenchSession?.id ?? null
        : null

  const quickOpenSession =
    taskSession !== null
      ? active
      : displaySurface === 'sessions'
        ? projectSession
        : displaySurface === 'tasks'
          ? taskWorkbenchSession
          : null

  // Remember the task that was actually shown so re-opening project tasks
  // restores it instead of falling back to the first row.
  useEffect(() => {
    if (displaySurface !== 'tasks' || repo === null || selectedTaskId === null) return
    setTaskSelectionByRepo((current) =>
      current[repo.id] === selectedTaskId
        ? current
        : { ...current, [repo.id]: selectedTaskId }
    )
  }, [displaySurface, repo, selectedTaskId])

  useEffect(() => {
    if (repo === null) {
      if (surface === 'sessions' || surface === 'tasks') setSurface('projects')
      return
    }
    // Repositories load asynchronously; the welcome surface is only for an
    // empty workspace and must yield once a project exists.
    if (surface === 'projects') setSurface('sessions')
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

  const showSchedules = useCallback((): void => {
    clearProjectView()
    setAuxTabs((current) => openAuxTab(current, 'schedules'))
    setSurface('schedules')
  }, [clearProjectView])

  const showSettings = useCallback((): void => {
    clearProjectView()
    setAuxTabs((current) => openAuxTab(current, 'settings'))
    setSurface('settings')
  }, [clearProjectView])

  const showAssistant = useCallback(
    (target?: AssistantTarget): void => {
      clearProjectView()
      setAuxTabs((current) => openAuxTab(current, 'mira'))
      setSurface('assistant')
      setAssistantTarget(target === undefined ? null : { ...target, nonce: Date.now() })
    },
    [clearProjectView]
  )

  const clearAssistantTarget = useCallback((): void => {
    setAssistantTarget(null)
  }, [])

  const showSessions = useCallback((): void => {
    setSurface('sessions')
    setTaskSession(null)
    setViewRequest(null)
  }, [])

  const openAppTab = useCallback(
    (tab: AppTab): void => {
      if (tab === 'sessions') {
        if (repo === null) {
          setSurface('projects')
          return
        }
        const selectedId = focusTaskId ?? taskSelectionByRepo[repo.id] ?? null
        const selectedTask =
          selectedId === null
            ? null
            : tasks.tasks.find(
                (task) => task.id === selectedId && task.repoId === repo.id
              ) ?? null
        setSurface(selectedTask !== null ? 'tasks' : 'sessions')
        return
      }
      setAuxTabs((current) => openAuxTab(current, tab))
      setSurface(tab === 'mira' ? 'assistant' : tab)
    },
    [focusTaskId, repo, taskSelectionByRepo, tasks.tasks]
  )

  const closeAppTab = useCallback(
    (tab: AuxAppTab): void => {
      const next = nextActiveAfterClose(auxTabs, tab, activeTab)
      setAuxTabs((current) => removeAuxTab(current, tab))
      if (activeTab === tab) openAppTab(next)
    },
    [activeTab, auxTabs, openAppTab]
  )

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
        setTaskViewRequest({ tab: 'terminal', nonce: Date.now() })
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
      setTaskViewRequest(null)
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
      setViewRequest(null)
      setTaskViewRequest({ tab: view ?? 'terminal', nonce: Date.now() })
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

  const requestView = useCallback(
    (view: ViewName): void => {
      if (displaySurface === 'tasks' && selectedWorkbenchTask !== null) {
        setTaskViewRequest({ tab: view, nonce: Date.now() })
        return
      }
      setViewRequest({ view, nonce: Date.now() })
    },
    [displaySurface, selectedWorkbenchTask]
  )

  const requestOpenInFiles = useCallback((path: string, line: number): void => {
    setOpenRequest({ path, line, nonce: Date.now() })
  }, [])

  const clearOpenRequest = useCallback((): void => {
    setOpenRequest(null)
  }, [])

  const clearViewRequest = useCallback((): void => {
    setViewRequest(null)
  }, [])

  const clearTaskViewRequest = useCallback((): void => {
    setTaskViewRequest(null)
  }, [])

  const openFileFromPalette = useCallback(
    (path: string, line: number): void => {
      if (quickOpenSession === null) return
      requestOpenInFiles(path, line)
      if (displaySurface === 'tasks' && selectedWorkbenchTask !== null) {
        setTaskViewRequest({ tab: 'files', nonce: Date.now() })
      } else if (displaySurface === 'sessions' || taskSession !== null) {
        setViewRequest({ view: 'files', nonce: Date.now() })
      }
    },
    [displaySurface, quickOpenSession, requestOpenInFiles, selectedWorkbenchTask, taskSession]
  )

  const commands = useMemo(
    () => ({
      showSchedules,
      showSettings,
      showAssistant,
      clearAssistantTarget,
      showSessions,
      openAppTab,
      closeAppTab,
      backToTasks,
      openProject,
      switchProject,
      changeMode,
      openDirectSession,
      openTask,
      openTaskSession,
      openTaskComposer,
      requestView,
      requestOpenInFiles,
      clearOpenRequest,
      clearViewRequest,
      clearTaskViewRequest,
      openFileFromPalette
    }),
    [
      backToTasks,
      changeMode,
      clearOpenRequest,
      clearViewRequest,
      clearTaskViewRequest,
      openDirectSession,
      openFileFromPalette,
      openProject,
      openAppTab,
      closeAppTab,
      openTask,
      openTaskComposer,
      openTaskSession,
      requestOpenInFiles,
      requestView,
      showSchedules,
      showSessions,
      showSettings,
      showAssistant,
      clearAssistantTarget,
      switchProject
    ]
  )

  return {
    displaySurface,
    activeTab,
    auxTabs,
    taskSession,
    taskSessionTask,
    taskSessionLive,
    focusTaskId,
    focusComposerNonce,
    taskSelectionByRepo,
    selectedTaskId,
    taskSessionIds,
    projectDirectSessions,
    projectSession,
    quickOpenSession,
    focusableSessionId,
    viewRequest,
    taskViewRequest,
    openRequest,
    assistantTarget,
    commands
  }
}
