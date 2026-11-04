import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { FolderGit2, Plus } from 'lucide-react'
import type { TaskRecordPayload } from '../../shared/icode-api'
import type { SessionSummary } from '../../shared/schemas/ipc'
import AppRail from './components/AppRail'
import GlobalTopBar from './components/GlobalTopBar'
import type { ActivityEntry } from './components/NotificationsDrawer'
import ProjectHeader, { type ProjectStat } from './components/ProjectHeader'
import ProjectSessionsList from './components/ProjectSessionsList'
import ProjectTasksView from './components/ProjectTasksView'
import ProjectsWall from './components/ProjectsWall'
import RepositoriesView from './components/RepositoriesView'
import SchedulesView from './components/SchedulesView'
import SessionWorkspace from './components/SessionWorkspace'
import SettingsPage from './pages/SettingsPage'
import StatusBar from './components/StatusBar'
import AppLayout from './layouts/AppLayout'
import GlobalOverlays from './layouts/GlobalOverlays'
import AppRoutes from './router/AppRoutes'
import { taskAttention, taskAttentionCounts } from './components/task-status'
import { useWorkspace } from './state/use-workspace'
import { useTaskQueue } from './state/use-task-queue'
import { useThemePreference } from './theme/use-theme'
import { activeRepo, activeSession, pendingAction } from './state/workspace'
import { hostStatus } from './state/host-status'
import { type ProjectMode, type Surface } from './router/routes'
import { callApi } from './lib/api'
import { sendAgentText, type AgentSendResult } from './lib/agent-send'
import { harnessLabel, isAgentHarness } from '../../shared/domain/harness'
import { WorkbenchDraftStore } from './review/drafts'

function paneKey(sessionId: string, incarnationId: string | null): string {
  return `${sessionId}:${incarnationId ?? 'pending'}`
}

type TaskSessionRoute = {
  taskId: string
  sessionId: string
}

const NEEDS_ORDER = { Answer: 0, Retry: 1, Review: 2 } as const
const SESSIONS_LIST_KEY = 'icode.sessionsListOpen'

/**
 * The session list is useful for switching between several terminals, but at
 * the default window width its fixed 326px leaves the terminal cramped. Respect
 * an explicit preference; otherwise start collapsed on narrow windows.
 */
function initialSessionsListOpen(): boolean {
  try {
    const stored = window.localStorage.getItem(SESSIONS_LIST_KEY)
    if (stored !== null) return stored === 'true'
  } catch {
    // A disabled storage backend must not block the workspace.
  }
  return window.innerWidth >= 1100
}

export default function App(): React.JSX.Element {
  const workspace = useWorkspace()
  const { state } = workspace
  const tasks = useTaskQueue(workspace.notify)
  const theme = useThemePreference()
  const [surface, setSurface] = useState<Surface>('projects')
  const [sessionsListOpen, setSessionsListOpen] = useState<boolean>(initialSessionsListOpen)
  const [terminalFocus, setTerminalFocus] = useState(false)
  const [taskSession, setTaskSession] = useState<TaskSessionRoute | null>(null)
  const [focusTaskId, setFocusTaskId] = useState<string | null>(null)
  const [focusComposerNonce, setFocusComposerNonce] = useState(0)
  const [addOpen, setAddOpen] = useState(false)
  const [quickOpenOpen, setQuickOpenOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [markingActivity, setMarkingActivity] = useState(false)
  const quickOpenSessionRef = useRef<SessionSummary | null>(null)
  const activeSessionIdRef = useRef<string | null>(state.activeSessionId)
  const [refreshToken, setRefreshToken] = useState(0)
  const [openRequest, setOpenRequest] = useState<{ path: string; line: number; nonce: number } | null>(null)
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const [removalBusy, setRemovalBusy] = useState(false)
  const [viewRequest, setViewRequest] = useState<{
    view: 'terminal' | 'changes' | 'files'
    nonce: number
  } | null>(null)
  const [cleanupBusy, setCleanupBusy] = useState(false)
  const [mounted, setMounted] = useState<Set<string>>(new Set())
  const [taskSelectionByRepo, setTaskSelectionByRepo] = useState<Record<string, string>>({})
  /** Line notes and commit messages survive panel and task switches. */
  const drafts = useMemo(() => new WorkbenchDraftStore(), [])

  const repo = activeRepo(state)
  const active = activeSession(state)
  const hostUnreachable = hostStatus(state) === 'unreachable'
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
  const projectStats = useMemo(() => {
    const byRepo: Record<string, ProjectStat> = {}
    for (const entry of state.repos) {
      const repoTasks = tasks.tasks.filter((task) => task.repoId === entry.id)
      const sessions = state.sessions.filter(
        (session) => session.repoId === entry.id && !taskSessionIds.has(session.id)
      )
      byRepo[entry.id] = {
        sessions: sessions.length,
        live: state.sessions.filter(
          (session) =>
            session.repoId === entry.id &&
            (session.state === 'live' || session.state === 'starting')
        ).length,
        tasks: repoTasks.length,
        needs: taskAttentionCounts(repoTasks).total
      }
    }
    return byRepo
  }, [state.repos, state.sessions, taskSessionIds, tasks.tasks])

  const needsTasks = useMemo(
    () =>
      tasks.tasks
        .filter((task) => taskAttention(task) !== null)
        .map((task) => ({
          task,
          repoName: state.repos.find((entry) => entry.id === task.repoId)?.displayName ?? 'unknown project'
        }))
        .sort((left, right) => {
          const leftKind = taskAttention(left.task)
          const rightKind = taskAttention(right.task)
          return (
            (leftKind === null ? 9 : NEEDS_ORDER[leftKind]) -
              (rightKind === null ? 9 : NEEDS_ORDER[rightKind]) ||
            right.task.updatedAt - left.task.updatedAt
          )
        }),
    [state.repos, tasks.tasks]
  )

  const activityEntries = useMemo<ActivityEntry[]>(
    () =>
      state.sessions
        .filter((session) => session.activity !== null && session.activity.state !== 'unknown')
        .map((session) => ({
          session,
          repoName: state.repos.find((repo) => repo.id === session.repoId)?.displayName ?? 'unknown project'
        }))
        .sort(
          (left, right) =>
            Number(right.session.activity?.unread === true) -
              Number(left.session.activity?.unread === true) ||
            right.session.updatedAt - left.session.updatedAt
        ),
    [state.repos, state.sessions]
  )

  const markActivityRead = useCallback(async (): Promise<void> => {
    const unread = state.sessions.filter((session) => session.activity?.unread === true)
    if (unread.length === 0 || markingActivity) return
    setMarkingActivity(true)
    try {
      for (const session of unread) {
        const result = await callApi<boolean>(window.icode.activity.clearUnread({ sessionId: session.id }))
        if (!result.ok) workspace.notify({ tone: 'error', message: result.error.message })
      }
      await workspace.refreshAll()
    } finally {
      setMarkingActivity(false)
    }
  }, [markingActivity, state.sessions, workspace])

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
  const focusActive = terminalFocus && focusableSessionId !== null

  useEffect(() => {
    if ((surface === 'sessions' || surface === 'tasks') && repo === null) setSurface('projects')
  }, [repo, surface])

  useEffect(() => {
    try {
      window.localStorage.setItem(SESSIONS_LIST_KEY, String(sessionsListOpen))
    } catch {
      // The preference is a convenience; storage failure is not fatal.
    }
  }, [sessionsListOpen])

  // A different session or surface is a different navigation context; never
  // leave the app in a chrome-less mode where the exit control belongs to a
  // terminal the user can no longer see.
  useEffect(() => {
    setTerminalFocus(false)
  }, [displaySurface, focusableSessionId])

  useEffect(
    () =>
      window.icode.onViewCommand((command) => {
        if (command === 'sessions') {
          setSessionsListOpen((current) => !current)
          return
        }
        if (focusableSessionId !== null) setTerminalFocus((current) => !current)
      }),
    [focusableSessionId]
  )

  useEffect(() => {
    if (focusableSessionId === null) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'F11') return
      // Capture before xterm: the terminal should not receive a function key
      // whose whole purpose here is to give the terminal more room.
      event.preventDefault()
      event.stopPropagation()
      setTerminalFocus((current) => !current)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [focusableSessionId])

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

  const sendToAgent = useCallback(
    async (
      text: string,
      targetSession: SessionSummary | null = active
    ): Promise<AgentSendResult> => {
      if (!targetSession) {
        return { ok: false, message: 'There is no active Agent session.' }
      }
      const target = targetSession
      if (!isAgentHarness(target.harness)) {
        const message = `${harnessLabel(target.harness)} cannot receive notes.`
        workspace.notify({ tone: 'error', message })
        return { ok: false, message }
      }
      if (target.activity?.state === 'waiting') {
        const message = `${harnessLabel(target.harness)} is waiting for your answer. Answer it in the terminal first.`
        workspace.notify({ tone: 'error', message })
        return { ok: false, message }
      }
      const attach = await callApi(window.icode.terminal.attach({ sessionId: target.id }))
      if (!attach.ok) {
        workspace.reportError(attach.error)
        return { ok: false, message: attach.error.message }
      }
      const incarnationId = attach.value?.incarnationId
      if (!incarnationId) {
        const message = 'The Agent terminal is not running.'
        workspace.notify({ tone: 'error', message })
        return { ok: false, message }
      }
      const write = async (data: string): Promise<AgentSendResult> => {
        const result = await callApi(
          window.icode.terminal.write({ sessionId: target.id, incarnationId, data })
        )
        if (!result.ok) {
          workspace.reportError(result.error)
          return { ok: false, message: result.error.message }
        }
        return { ok: true }
      }
      const sent = await sendAgentText(text, write)
      if (!sent.ok) return sent
      workspace.notify({ tone: 'success', message: `Sent to ${harnessLabel(target.harness)}.` })
      return sent
    },
    [active, workspace]
  )

  const refreshEverything = useCallback((): void => {
    setRefreshToken((current) => current + 1)
    void workspace.refreshAll()
    void tasks.reload(true)
  }, [tasks, workspace])

  const requestOpenInFiles = useCallback((path: string, line: number): void => {
    setOpenRequest({ path, line, nonce: Date.now() })
  }, [])

  const clearProjectView = (): void => {
    setTaskSession(null)
    setViewRequest(null)
    setFocusTaskId(null)
  }

  const openProject = useCallback(
    (repoId: string, mode?: ProjectMode): void => {
      const direct = state.sessions.filter(
        (session) => session.repoId === repoId && !taskSessionIds.has(session.id)
      )
      const repoTasks = tasks.tasks.filter((task) => task.repoId === repoId)
      const nextMode: ProjectMode = mode ?? (direct.length > 0 ? 'sessions' : repoTasks.length > 0 ? 'tasks' : 'sessions')
      if (nextMode === 'sessions' && direct.length > 0) {
        const first = direct[0]
        if (first) workspace.selectSession(first.id)
      } else {
        workspace.selectRepo(repoId)
      }
      setSurface(nextMode)
      clearProjectView()
    },
    [state.sessions, taskSessionIds, tasks.tasks, workspace]
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
    (sessionId: string, view?: 'terminal' | 'changes' | 'files'): void => {
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

  const openQueueTask = useCallback((): void => {
    if (state.repos.length === 0) {
      setAddOpen(true)
      return
    }
    const target = repo ?? state.repos[0]
    if (!target) return
    if (target.id !== state.activeRepoId) workspace.selectRepo(target.id)
    setSurface('tasks')
    setTaskSession(null)
    setFocusTaskId(null)
    setViewRequest(null)
    setFocusComposerNonce((current) => current + 1)
  }, [repo, state.activeRepoId, state.repos, workspace])

  const openNewSession = (): void => {
    if (hostUnreachable) {
      workspace.notify({
        tone: 'error',
        message: 'The terminal Host is unreachable. Retry from the status bar before starting a session.'
      })
      return
    }
    if (state.repos.length === 0) {
      setAddOpen(true)
      return
    }
    setNewSessionOpen(true)
  }

  const createSession = useCallback(
    async (input: Parameters<typeof workspace.createSession>[0]): Promise<boolean> => {
      const created = await workspace.createSession(input)
      if (created) {
        setSurface('sessions')
        setTaskSession(null)
        setViewRequest(null)
      }
      return created
    },
    [workspace]
  )

  const addRepository = useCallback(
    async (input: Parameters<typeof workspace.addRepository>[0]): Promise<Awaited<ReturnType<typeof workspace.addRepository>>> => {
      const failure = await workspace.addRepository(input)
      if (failure === null) {
        setSurface('projects')
        clearProjectView()
      }
      return failure
    },
    [workspace]
  )

  const initializeRepository = useCallback(
    async (
      input: Parameters<typeof workspace.initializeRepository>[0]
    ): Promise<Awaited<ReturnType<typeof workspace.initializeRepository>>> => {
      const failure = await workspace.initializeRepository(input)
      if (failure === null) {
        setSurface('projects')
        clearProjectView()
      }
      return failure
    },
    [workspace]
  )

  const confirmRemoval = async (): Promise<void> => {
    const prompt = state.removal
    if (!prompt) return
    setRemovalBusy(true)
    await workspace.confirmRemoval()
    setRemovalBusy(false)
  }

  useEffect(() => {
    activeSessionIdRef.current = state.activeSessionId
  }, [state.activeSessionId])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // Ctrl+K and Ctrl+P are line/history bindings inside a shell. Leave them
      // to xterm when the terminal owns focus; the palette remains one click
      // away in the command bar.
      const target = event.target
      if (target instanceof Element && target.closest('.xterm') !== null) return
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        (event.key.toLowerCase() === 'g' || event.key.toLowerCase() === 'e')
      ) {
        if (activeSessionIdRef.current !== null) {
          event.preventDefault()
          setPaletteOpen(false)
          setQuickOpenOpen(false)
          setViewRequest({
            view: event.key.toLowerCase() === 'g' ? 'changes' : 'files',
            nonce: Date.now()
          })
        }
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setQuickOpenOpen(false)
        setPaletteOpen((current) => !current)
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'p' && !event.shiftKey) {
        if (quickOpenSessionRef.current !== null) {
          event.preventDefault()
          setPaletteOpen(false)
          setQuickOpenOpen((current) => !current)
        }
      }
      if (event.key === 'Escape') {
        setPaletteOpen(false)
        setQuickOpenOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    setMounted((previous) => {
      const next = new Set<string>()
      const byId = new Map(state.sessions.map((entry) => [entry.id, entry]))
      for (const key of previous) {
        const separator = key.lastIndexOf(':')
        const id = key.slice(0, separator)
        const incarnation = key.slice(separator + 1)
        const current = byId.get(id)
        if (!current) continue
        if (
          current.incarnationId !== null &&
          current.incarnationId !== incarnation &&
          (current.state === 'live' || current.state === 'starting')
        ) {
          continue
        }
        next.add(key)
      }
      for (const entry of state.sessions) {
        if (entry.state === 'live' || entry.state === 'starting') {
          next.add(paneKey(entry.id, entry.incarnationId))
        }
      }
      if (next.size === previous.size && [...next].every((key) => previous.has(key))) {
        return previous
      }
      return next
    })
  }, [state.sessions])

  const paneSessions = useMemo(
    () =>
      state.sessions.filter((entry) => mounted.has(paneKey(entry.id, entry.incarnationId))),
    [mounted, state.sessions]
  )

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
  quickOpenSessionRef.current = quickOpenSession

  /**
   * A palette file belongs to the active workbench, not to whichever surface
   * happens to be mounted. Direct sessions switch the view explicitly; a task
   * workbench consumes the same request through its own Files pane.
   */
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

  const renderSession = (
    session: NonNullable<typeof projectSession>,
    sessionsListHidden = false,
    allowSleep = true
  ): React.JSX.Element => (
    <SessionWorkspace
      session={session}
      repo={repo}
      pending={pendingAction(state, session.id)}
      panes={paneSessions}
      onRestart={(sessionId) => void workspace.restartSession(sessionId)}
      onSleep={(sessionId) => void workspace.sleepSession(sessionId)}
      onWake={(sessionId) => void workspace.wakeSession(sessionId)}
      allowSleep={allowSleep}
      onRecheck={(sessionId) => void workspace.recheckSession(sessionId)}
      onRemove={(sessionId) => void workspace.requestRemoveSession(sessionId)}
      onRecoverWorktree={(sessionId) => void workspace.recoverWorktree(sessionId)}
      onError={workspace.reportError}
      notify={workspace.notify}
      refreshToken={refreshToken}
      openRequest={openRequest}
      onOpenRequestHandled={() => setOpenRequest(null)}
      onSendToAgent={(text) => sendToAgent(text, session)}
      drafts={drafts}
      onRequestOpenInFiles={requestOpenInFiles}
      viewRequest={viewRequest}
      onViewRequestHandled={() => setViewRequest(null)}
      sessionsListHidden={sessionsListHidden}
      onShowSessionsList={sessionsListHidden ? () => setSessionsListOpen(true) : undefined}
    />
  )

  const renderProjectSessions = (): React.JSX.Element => {
    if (repo === null) return <></>
    const showSessionsList =
      projectSession === null || (sessionsListOpen && !focusActive)
    return (
      <div className="flex min-h-0 flex-1 max-[900px]:flex-col">
        {showSessionsList ? (
          <ProjectSessionsList
            repo={repo}
            sessions={projectDirectSessions}
            activeSessionId={projectSession?.id ?? null}
            pending={state.pending}
            branches={state.branches}
            orphans={state.orphans}
            onSelectSession={openDirectSession}
            onNewSession={openNewSession}
            onRemoveBranch={(branch) => void workspace.requestRemoveBranch(branch)}
            onCollapse={() => setSessionsListOpen(false)}
          />
        ) : null}
        <div className="flex min-w-0 flex-1">
          {projectSession !== null ? (
            renderSession(projectSession, !sessionsListOpen && !focusActive)
          ) : (
            <div className="flex flex-1 items-center justify-center p-8">
              <div className="w-full max-w-md rounded-lg border border-border bg-card p-6">
                <h1 className="text-[14px] font-semibold">No direct sessions in {repo.displayName}</h1>
                <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                  Direct sessions open a live terminal immediately. Tasks have their own list and do not
                  appear here.
                </p>
                <button
                  type="button"
                  className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[11px] font-medium text-accent-ink hover:opacity-90"
                  onClick={openNewSession}
                  data-testid="empty-new-session"
                >
                  <Plus size={12} />
                  New session
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  const renderProjectTasks = (): React.JSX.Element => {
    if (repo === null) return <></>
    if (taskSession !== null && taskSessionTask !== null && taskSessionLive !== null) {
      return (
        <div className="flex min-h-0 flex-1 flex-col" data-testid="task-session-view">
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-[10px] text-muted-foreground">
            <button
              type="button"
              className="rounded px-1 py-0.5 hover:bg-muted hover:text-foreground"
              onClick={() => setTaskSession(null)}
              data-testid="task-session-back"
            >
              ← Tasks
            </button>
            <span className="min-w-0 truncate text-foreground">{taskSessionTask.title}</span>
            <span className="shrink-0">attempt {taskSessionTask.attempt}</span>
          </div>
          {renderSession(taskSessionLive, false, false)}
        </div>
      )
    }
    return (
      <ProjectTasksView
        repo={repo}
        tasks={tasks.tasks}
        sessions={state.sessions}
        loading={tasks.loading}
        focusTaskId={focusTaskId}
        focusComposerNonce={focusComposerNonce}
        rememberedTaskId={taskSelectionByRepo[repo.id] ?? null}
        notify={workspace.notify}
        refreshToken={refreshToken}
        drafts={drafts}
        openRequest={openRequest}
        onOpenRequestHandled={() => setOpenRequest(null)}
        onReload={() => tasks.reload()}
        onTaskSelected={(taskId) =>
          setTaskSelectionByRepo((current) =>
            current[repo.id] === taskId ? current : { ...current, [repo.id]: taskId }
          )
        }
        onOpenSession={(sessionId) => openTaskSession(sessionId)}
        onStopSession={(sessionId) => void workspace.stopSession(sessionId)}
        onRestartSession={(sessionId) => void workspace.restartSession(sessionId)}
        onRecheckSession={(sessionId) => void workspace.recheckSession(sessionId)}
        onError={workspace.reportError}
        onSendToAgent={(text, session) => sendToAgent(text, session)}
      />
    )
  }

  const pages: Record<Surface, ReactNode> = {
    projects:
      state.repos.length === 0 && displaySurface === 'projects' ? (
        <div className="flex flex-1 items-center justify-center p-8" data-testid="empty-workspace">
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-6">
            <div className="flex items-center gap-2">
              <FolderGit2 size={15} className="text-muted-foreground" />
              <h1 className="text-[14px] font-semibold">Add a project</h1>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              iCode runs coding agents in isolated worktrees on this machine or in a WSL distro.
              Add an existing Git checkout, or initialize a folder once to make it usable.
            </p>
            <button
              type="button"
              className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[11px] font-medium text-accent-ink hover:opacity-90"
              onClick={() => setAddOpen(true)}
              data-testid="empty-add-repo"
            >
              <Plus size={12} />
              Add project
            </button>
          </div>
        </div>
      ) : (
        <ProjectsWall
          repos={state.repos}
          sessions={state.sessions}
          tasks={tasks.tasks}
          maxConcurrent={tasks.maxConcurrent}
          onOpenProject={openProject}
          onOpenTask={openTask}
          onManageRepositories={() => {
            clearProjectView()
            setSurface('repositories')
          }}
          onAddRepository={() => setAddOpen(true)}
          onRetryPreparation={(repoId) => void workspace.retryPreparation(repoId)}
        />
      ),
    sessions: renderProjectSessions(),
    tasks: renderProjectTasks(),
    schedules: (
      <SchedulesView
        repos={state.repos}
        schedules={tasks.schedules}
        notify={workspace.notify}
        onReload={() => tasks.reload()}
      />
    ),
    repositories: (
      <RepositoriesView
        repos={state.repos}
        sessions={state.sessions}
        tasks={tasks.tasks}
        onBack={() => setSurface('projects')}
        onAdd={() => setAddOpen(true)}
        onRemove={(repoId) => void workspace.removeRepository(repoId)}
        onOpenProject={(repoId) => openProject(repoId)}
      />
    ),
    settings: (
      <SettingsPage
        state={state}
        runtime={workspace.runtime}
        maxConcurrent={tasks.maxConcurrent}
        onSetMaxConcurrent={tasks.setMaxConcurrent}
        refreshing={state.refreshing}
        onRefresh={refreshEverything}
        themePreference={theme.preference}
        resolvedTheme={theme.resolved}
        onSetTheme={theme.setPreference}
      />
    )
  }

  const projectLabel =
    (displaySurface === 'sessions' || displaySurface === 'tasks') && repo !== null
      ? `${repo.displayName} · ${repo.currentBranch ?? 'no branch'}`
      : displaySurface === 'projects'
        ? `All projects · ${state.repos.length} repo${state.repos.length === 1 ? '' : 's'}`
        : displaySurface === 'schedules'
          ? 'Schedules · all projects'
          : displaySurface === 'repositories'
            ? 'Repositories · all projects'
            : 'Settings'

  return (
    <AppLayout
      focusActive={focusActive}
      topBar={
        <GlobalTopBar
          needsTasks={needsTasks}
          hostUnreachable={hostUnreachable}
          onSearch={() => {
            setQuickOpenOpen(false)
            setPaletteOpen(true)
          }}
          onNewSession={openNewSession}
          onQueueTask={openQueueTask}
          onSchedules={() => {
            clearProjectView()
            setSurface('schedules')
          }}
          onOpenNotifications={() => setNotificationsOpen(true)}
          onProjects={() => {
            clearProjectView()
            setSurface('projects')
          }}
          themePreference={theme.preference}
          resolvedTheme={theme.resolved}
          onSetTheme={theme.setPreference}
        />
      }
      rail={
        <AppRail
          surface={displaySurface}
          onProjects={() => {
            clearProjectView()
            setSurface('projects')
          }}
          onSchedules={() => {
            clearProjectView()
            setSurface('schedules')
          }}
          onSettings={() => {
            clearProjectView()
            setSurface('settings')
          }}
        />
      }
      statusBar={
        <StatusBar
          state={state}
          tasks={tasks.tasks}
          maxConcurrent={tasks.maxConcurrent}
          runtime={workspace.runtime}
          projectLabel={projectLabel}
          refreshing={state.refreshing}
          onRefresh={refreshEverything}
          onRetryHost={refreshEverything}
          notice={state.notice}
          onDismissNotice={workspace.dismissNotice}
          onFocusSourceControl={() =>
            setViewRequest({ view: 'changes', nonce: Date.now() })
          }
        />
      }
      overlays={
        <GlobalOverlays
          notifications={{
            open: notificationsOpen,
            needsTasks,
            activity: activityEntries,
            markingRead: markingActivity,
            onClose: () => setNotificationsOpen(false),
            onOpenTask: openTask,
            onOpenSession: openDirectSession,
            onMarkRead: () => void markActivityRead()
          }}
          palette={{
            open: paletteOpen,
            repos: state.repos,
            sessions: state.sessions,
            tasks: tasks.tasks,
            fileSession: quickOpenSession,
            canStartSession: !hostUnreachable,
            resolvedTheme: theme.resolved,
            notify: workspace.notify,
            onClose: () => setPaletteOpen(false),
            onNewSession: openNewSession,
            onQueueTask: openQueueTask,
            onProjects: () => {
              clearProjectView()
              setSurface('projects')
            },
            onSchedules: () => {
              clearProjectView()
              setSurface('schedules')
            },
            onRepositories: () => {
              clearProjectView()
              setSurface('repositories')
            },
            onSettings: () => {
              clearProjectView()
              setSurface('settings')
            },
            onSourceControl: () =>
              setViewRequest({ view: 'changes', nonce: Date.now() }),
            onToggleTheme: () =>
              theme.setPreference(theme.resolved === 'dark' ? 'light' : 'dark'),
            onOpenProject: openProject,
            onOpenSession: openDirectSession,
            onOpenTask: openTask,
            onOpenFile: openFileFromPalette
          }}
          quickOpen={
            quickOpenSession !== null
              ? {
                  open: quickOpenOpen,
                  sessionId: quickOpenSession.id,
                  notify: workspace.notify,
                  onClose: () => setQuickOpenOpen(false),
                  onOpen: (path, line) => {
                    openFileFromPalette(path, line)
                    setQuickOpenOpen(false)
                  }
                }
              : null
          }
          addRepository={
            addOpen
              ? {
                  onClose: () => setAddOpen(false),
                  onSubmit: addRepository,
                  onInitialize: initializeRepository
                }
              : null
          }
          newSession={
            newSessionOpen
              ? {
                  repos: state.repos,
                  activeRepoId: state.activeRepoId,
                  harnesses: state.harnesses,
                  harnessLoading: state.harnessLoading,
                  harnessError: state.harnessError,
                  creating: workspace.creating,
                  onClose: () => setNewSessionOpen(false),
                  onCreate: createSession,
                  onRefreshHarnesses: workspace.refreshHarnesses
                }
              : null
          }
          removal={
            state.removal
              ? {
                  prompt: state.removal,
                  busy: removalBusy,
                  onCancel: workspace.dismissRemoval,
                  onConfirm: () => void confirmRemoval()
                }
              : null
          }
          sessionCleanup={
            state.sessionCleanup
              ? {
                  prompt: state.sessionCleanup,
                  busy: cleanupBusy,
                  onClose: workspace.dismissSessionCleanup,
                  onRecover: () =>
                    void workspace.recoverWorktree(state.sessionCleanup!.sessionId),
                  onDiscard: async (confirmBranch) => {
                    setCleanupBusy(true)
                    const removed = await workspace.discardSession(
                      state.sessionCleanup!.sessionId,
                      confirmBranch
                    )
                    setCleanupBusy(false)
                    return removed
                  }
                }
              : null
          }
          branchCleanup={
            state.branchCleanup
              ? {
                  prompt: state.branchCleanup,
                  busy: cleanupBusy,
                  onClose: workspace.dismissBranchCleanup,
                  onConfirm: async (confirmBranch) => {
                    setCleanupBusy(true)
                    await workspace.requestRemoveBranch(
                      state.branchCleanup!.branch,
                      confirmBranch
                    )
                    setCleanupBusy(false)
                  }
                }
              : null
          }
        />
      }
    >
      {!focusActive &&
      (displaySurface === 'sessions' || displaySurface === 'tasks') &&
      repo !== null ? (
        <ProjectHeader
          repos={state.repos}
          repo={repo}
          mode={displaySurface === 'tasks' ? 'tasks' : 'sessions'}
          stats={projectStats}
          onBack={() => {
            clearProjectView()
            setSurface('projects')
          }}
          onSwitch={switchProject}
          onMode={changeMode}
          onRetryPreparation={(repoId) => void workspace.retryPreparation(repoId)}
        />
      ) : null}
      <AppRoutes
        boot={state.boot}
        bootError={state.bootError}
        onRetryBoot={refreshEverything}
        surface={displaySurface}
        pages={pages}
      />
    </AppLayout>
  )
}
