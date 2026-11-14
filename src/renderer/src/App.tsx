import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { SessionSummary } from '../../shared/schemas/ipc'
import type { TaskRecordPayload } from '../../shared/icode-api'
import AppTabStrip from './components/AppTabStrip'
import WindowChrome from './components/shell/WindowChrome'
import WorkspaceSidebar from './components/shell/WorkspaceSidebar'
import type { ActivityEntry } from './components/NotificationsDrawer'
import SchedulesView from './components/SchedulesView'
import WorkspaceWelcome from './components/shell/WorkspaceWelcome'
import SessionsSurface from './components/sessions/SessionsSurface'
import SettingsPage from './pages/SettingsPage'
import TasksSurface from './components/tasks/TasksSurface'
import TaskComposerDialog from './components/tasks/TaskComposerDialog'
import type { TaskAction } from './components/TaskWorkbench'
import AssistantPage from './pages/AssistantPage'
import type { AssistantTaskAction } from './components/AssistantCardView'
import NoticeToast from './components/shell/NoticeToast'
import SidebarStatus from './components/shell/SidebarStatus'
import AppLayout from './layouts/AppLayout'
import GlobalOverlays from './layouts/GlobalOverlays'
import AppRoutes from './router/AppRoutes'
import { useAppNavigation } from './router/use-app-navigation'
import { useGlobalShortcuts } from './router/use-global-shortcuts'
import { useSessionPanes } from './state/use-session-panes'
import { taskAttention } from './components/task-status'
import { useWorkspace, type CreateSessionRequest } from './state/use-workspace'
import {
  createPendingCreate,
  pendingCreateStillVisible,
  type PendingCreate
} from './state/pending-create'
import { useTaskQueue } from './state/use-task-queue'
import { useAssistant } from './state/use-assistant'
import { useThemePreference } from './theme/use-theme'
import { useLocale } from './i18n/use-i18n'
import { translate } from './i18n/i18n-store'
import { activeRepo, activeSession } from './state/workspace'
import { hostStatus } from './state/host-status'
import type { Surface } from './router/routes'
import { callApi, errorNotice } from './lib/api'
import { sendAgentText, type AgentSendResult } from './lib/agent-send'
import { setRendererPlatform } from './lib/platform'
import { harnessLabel, isAgentHarness } from '../../shared/domain/harness'
import { WorkbenchDraftStore } from './review/drafts'
import { openFilesStore } from './files/open-files'
import { pruneTreeStates } from './files/tree-state'
import { filesClipboardStore } from './files/files-clipboard'

const NEEDS_ORDER = { Approval: 0, Answer: 1, Retry: 2, Blocked: 3, Review: 4 } as const
export default function App(): React.JSX.Element {
  const workspace = useWorkspace()
  const { state } = workspace
  const tasks = useTaskQueue(workspace.notify)
  const theme = useThemePreference()
  // The root subscribes to language changes so label helpers that read the
  // module store (status, activity, task wording) repaint without threading a
  // translator through every call site.
  useLocale()

  const {
    displaySurface,
    activeTab,
    auxTabs,
    taskSession,
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
  } = useAppNavigation({ workspace, tasks })

  const assistant = useAssistant(workspace.notify, (event) =>
    commands.showAssistant({ threadId: event.threadId, messageId: event.messageId })
  )

  const runAssistantTaskAction = useCallback(
    async (action: AssistantTaskAction, taskId: string): Promise<void> => {
      const result = await (() => {
        switch (action) {
          case 'approve':
            return window.icode.tasks.approve({ taskId })
          case 'reject':
            return window.icode.tasks.reject({ taskId })
          case 'retry':
            return window.icode.tasks.retry({ taskId })
          case 'continue':
            return window.icode.tasks.resume({ taskId })
          case 'cancel':
            return window.icode.tasks.cancel({ taskId })
          default: {
            const never: never = action
            throw new Error(`Unknown task action: ${String(never)}`)
          }
        }
      })()
      if (!result.ok) {
        workspace.notify({ tone: 'error', message: result.error.message })
        return
      }
      await tasks.reload()
      await assistant.reload()
    },
    [assistant.reload, tasks.reload, workspace]
  )

  const runTaskWorkbenchAction = useCallback(
    async (task: TaskRecordPayload, action: TaskAction): Promise<void> => {
      const request = (() => {
        switch (action) {
          case 'approve':
            return window.icode.tasks.approve({ taskId: task.id })
          case 'reject':
            return window.icode.tasks.reject({ taskId: task.id })
          case 'cancel':
            return window.icode.tasks.cancel({ taskId: task.id })
          case 'retry':
            return window.icode.tasks.retry({ taskId: task.id })
          case 'resume':
            return window.icode.tasks.resume({ taskId: task.id })
          case 'archive':
            return window.icode.tasks.archive({ taskId: task.id })
          case 'unarchive':
            return window.icode.tasks.unarchive({ taskId: task.id })
        }
      })()
      const result = await request
      if (!result.ok) {
        workspace.notify(errorNotice(result.error))
        return
      }
      const updated = result.value
      const message =
        action === 'approve'
          ? translate('tasks.notice.approved', { title: task.title })
          : action === 'reject'
            ? translate('tasks.notice.rejected', { title: task.title })
            : action === 'cancel'
              ? translate('tasks.notice.cancelled', { title: task.title })
              : action === 'retry'
                ? translate('tasks.notice.retrying', { count: updated.attempt })
                : action === 'resume'
                  ? translate('tasks.notice.continuing', { count: updated.attempt })
                  : action === 'archive'
                    ? translate('tasks.notice.archived', { title: task.title })
                    : translate('tasks.notice.restored', { title: task.title })
      workspace.notify({
        tone: action === 'reject' || action === 'archive' ? 'info' : 'success',
        message
      })
      await tasks.reload()
      if (action === 'retry' || action === 'resume') {
        commands.openTask(updated)
      }
    },
    [commands, tasks.reload, workspace]
  )

  // Tabs belong to live sessions only. Keeping a removed session's dirty text
  // would make the close guard ask about a session the user can no longer see.
  // Include the sessions currently on screen so a transient list refresh cannot
  // drop the text the user is looking at.
  useEffect(() => {
    if (state.boot !== 'ready') return
    const ids = new Set(state.sessions.map((session) => session.id))
    for (const task of tasks.tasks) {
      if (task.sessionId !== null) ids.add(task.sessionId)
    }
    if (state.activeSessionId !== null) ids.add(state.activeSessionId)
    if (taskSession !== null) ids.add(taskSession.sessionId)
    if (projectSession !== null) ids.add(projectSession.id)
    openFilesStore.retain(ids)
    pruneTreeStates(ids)
    const clipboard = filesClipboardStore.get()
    if (clipboard !== null && !ids.has(clipboard.sessionId)) filesClipboardStore.clear()
  }, [projectSession, state.activeSessionId, state.boot, state.sessions, taskSession, tasks.tasks])

  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [terminalFocus, setTerminalFocus] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [quickOpenOpen, setQuickOpenOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [markingActivity, setMarkingActivity] = useState(false)
  const [refreshToken, setRefreshToken] = useState(0)
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const [taskComposer, setTaskComposer] = useState<{
    repoId: string
    afterTaskId: string | null
  } | null>(null)
  const composerRepo =
    taskComposer === null
      ? null
      : (state.repos.find((entry) => entry.id === taskComposer.repoId) ?? null)
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null)
  const createInFlight = useRef(false)
  const submitCreateRef = useRef<(request: CreateSessionRequest) => Promise<boolean>>(
    async () => false
  )
  const [removalBusy, setRemovalBusy] = useState(false)
  const [cleanupBusy, setCleanupBusy] = useState(false)
  /** Line notes and commit messages survive panel and task switches. */
  const drafts = useMemo(() => new WorkbenchDraftStore(), [])

  useGlobalShortcuts({
    hasActiveSession: state.activeSessionId !== null,
    hasQuickOpenSession: quickOpenSession !== null,
    focusableSessionId,
    platform: workspace.runtime?.platform ?? null,
    requestView: commands.requestView,
    setPaletteOpen,
    setQuickOpenOpen,
    setTerminalFocus
  })

  const repo = activeRepo(state)
  const active = activeSession(state)
  const hostUnreachable = hostStatus(state) === 'unreachable'

  // A project selection is not persisted across launches; with registered
  // projects the shell stays on the sessions surface instead of the welcome.
  useEffect(() => {
    if (state.repos.length === 0 || repo !== null) return
    const first = state.repos[0]
    if (first !== undefined) workspace.selectRepo(first.id)
  }, [repo, state.repos, workspace])

  const sidebarSessions = useMemo(
    () => state.sessions.filter((session) => !taskSessionIds.has(session.id)),
    [state.sessions, taskSessionIds]
  )
  const activeTaskId = displaySurface === 'tasks' ? selectedTaskId : null
  const taskSlotCount = tasks.tasks.filter((task) =>
    ['dispatching', 'running', 'waiting'].includes(task.status)
  ).length
  const needsTasks = useMemo(
    () =>
      tasks.tasks
        .filter((task) => taskAttention(task) !== null)
        .map((task) => ({
          task,
          repoName: state.repos.find((entry) => entry.id === task.repoId)?.displayName ?? translate('common.unknownProject')
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
        .filter((session) => session.role !== 'supervisor')
        .filter((session) => session.activity !== null && session.activity.state !== 'unknown')
        .map((session) => ({
          session,
          repoName: state.repos.find((repo) => repo.id === session.repoId)?.displayName ?? translate('common.unknownProject')
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

  const focusActive = terminalFocus && focusableSessionId !== null

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
          setSidebarOpen((current) => !current)
          return
        }
        if (focusableSessionId !== null) setTerminalFocus((current) => !current)
      }),
    [focusableSessionId]
  )

  useEffect(() => {
    setRendererPlatform(workspace.runtime?.platform ?? null)
  }, [workspace.runtime?.platform])

  const sendToAgent = useCallback(
    async (
      text: string,
      targetSession: SessionSummary | null = active
    ): Promise<AgentSendResult> => {
      if (!targetSession) {
        return { ok: false, message: translate('app.noActiveAgent') }
      }
      const target = targetSession
      if (!isAgentHarness(target.harness)) {
        const message = translate('app.harnessCannotReceive', {
          harness: harnessLabel(target.harness)
        })
        workspace.notify({ tone: 'error', message })
        return { ok: false, message }
      }
      if (target.activity?.state === 'waiting') {
        const message = translate('app.harnessWaiting', {
          harness: harnessLabel(target.harness)
        })
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
        const message = translate('app.terminalNotRunning')
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
      workspace.notify({
        tone: 'success',
        message: translate('app.sentTo', { harness: harnessLabel(target.harness) })
      })
      return sent
    },
    [active, workspace]
  )

  const refreshEverything = useCallback((): void => {
    setRefreshToken((current) => current + 1)
    void workspace.refreshAll()
    void tasks.reload(true)
  }, [tasks, workspace])

  const openQueueTask = useCallback(
    (repoId?: string, afterTaskId: string | null = null): void => {
      if (state.repos.length === 0) {
        setAddOpen(true)
        return
      }
      const target =
        (repoId === undefined ? null : state.repos.find((entry) => entry.id === repoId)) ??
        repo ??
        state.repos[0]
      if (!target) return
      if (target.id !== state.activeRepoId) workspace.selectRepo(target.id)
      setTaskComposer({ repoId: target.id, afterTaskId })
    },
    [repo, state.activeRepoId, state.repos, workspace]
  )

  const openNewSession = (): void => {
    if (hostUnreachable) {
      workspace.notify({
        tone: 'error',
        message: translate('app.hostUnreachable')
      })
      return
    }
    if (state.repos.length === 0) {
      setAddOpen(true)
      return
    }
    setNewSessionOpen(true)
  }

  const submitCreate = useCallback(
    async (input: CreateSessionRequest): Promise<boolean> => {
      if (createInFlight.current) {
        workspace.notify({ tone: 'info', message: translate('newSession.oneAtATime') })
        return false
      }
      createInFlight.current = true
      const pending = createPendingCreate(input, state.repos)
      setPendingCreate(pending)
      setNewSessionOpen(false)
      // The dialog no longer blocks on the round trip, so navigation must happen
      // now rather than after a success that may take seconds on WSL.
      workspace.selectRepo(input.repoId)
      commands.showSessions()
      try {
        const outcome = await workspace.createSession(input)
        if (!outcome.ok) {
          // The dialog is gone; its values live in `pending.request`. The Retry
          // action resubmits exactly those values, so a failure loses nothing.
          workspace.notify({
            ...errorNotice(outcome.error),
            action: {
              label: translate('newSession.retry'),
              run: () => {
                void submitCreateRef.current(input)
              }
            }
          })
          return false
        }
        commands.showSessions()
        return true
      } finally {
        createInFlight.current = false
        setPendingCreate((current) => (current?.id === pending.id ? null : current))
      }
    },
    [commands, state.repos, workspace]
  )

  useEffect(() => {
    submitCreateRef.current = submitCreate
  }, [submitCreate])

  const addRepository = useCallback(
    async (input: Parameters<typeof workspace.addRepository>[0]): Promise<Awaited<ReturnType<typeof workspace.addRepository>>> => {
      const failure = await workspace.addRepository(input)
      if (failure === null) commands.showSessions()
      return failure
    },
    [commands.showSessions, workspace]
  )

  const initializeRepository = useCallback(
    async (
      input: Parameters<typeof workspace.initializeRepository>[0]
    ): Promise<Awaited<ReturnType<typeof workspace.initializeRepository>>> => {
      const failure = await workspace.initializeRepository(input)
      if (failure === null) commands.showSessions()
      return failure
    },
    [commands.showSessions, workspace]
  )

  const confirmRemoval = async (): Promise<void> => {
    const prompt = state.removal
    if (!prompt) return
    setRemovalBusy(true)
    await workspace.confirmRemoval()
    setRemovalBusy(false)
  }

  const paneSessions = useSessionPanes(state.sessions)
  /**
   * The create event is emitted before the create IPC response, so the real row
   * can be visible while the descriptor is still set. Hide the pending surface
   * as soon as a matching non-failed session exists; the descriptor itself is
   * cleared by the submit's outcome.
   */
  const pendingCreateView =
    pendingCreate !== null && pendingCreateStillVisible(pendingCreate, state.sessions)
      ? pendingCreate
      : null

  const pages: Record<Surface, ReactNode> = {
    projects: <WorkspaceWelcome onAddRepository={() => setAddOpen(true)} />,
    sessions: (
      <SessionsSurface
        repo={repo}
        sessions={projectDirectSessions}
        activeSession={projectSession}
        pendingCreate={pendingCreateView}
        pending={state.pending}
        focusActive={focusActive}
        paneSessions={paneSessions}
        refreshToken={refreshToken}
        openRequest={openRequest}
        viewRequest={viewRequest}
        drafts={drafts}
        sendToAgent={sendToAgent}
        onSelectSession={commands.openDirectSession}
        onNewSession={openNewSession}
        onRestartSession={(sessionId) => void workspace.restartSession(sessionId)}
        onSleepSession={(sessionId) => void workspace.sleepSession(sessionId)}
        onWakeSession={(sessionId) => void workspace.wakeSession(sessionId)}
        onRecheckSession={(sessionId) => void workspace.recheckSession(sessionId)}
        onRemoveSession={(sessionId) => void workspace.requestRemoveSession(sessionId)}
        onRecoverWorktree={(sessionId) => void workspace.recoverWorktree(sessionId)}
        onError={workspace.reportError}
        notify={workspace.notify}
        onClearOpenRequest={commands.clearOpenRequest}
        onClearViewRequest={commands.clearViewRequest}
      />
    ),
    tasks: (
      <TasksSurface
        repo={repo}
        tasks={tasks.tasks}
        archivedTasks={tasks.archivedTasks}
        sessions={state.sessions}
        selectedTaskId={selectedTaskId}
        loading={tasks.loading}
        focusActive={focusActive}
        refreshToken={refreshToken}
        openRequest={openRequest}
        taskViewRequest={taskViewRequest}
        drafts={drafts}
        notify={workspace.notify}
        onOpenRequestHandled={commands.clearOpenRequest}
        onTaskViewRequestHandled={commands.clearTaskViewRequest}
        onQueueTask={() => openQueueTask()}
        onQueueFollowUp={(task) => openQueueTask(task.repoId, task.id)}
        onSelectTask={(task) => commands.openTask(task)}
        onOpenSession={(sessionId) => commands.openTaskSession(sessionId, 'terminal')}
        onStopSession={(sessionId) => void workspace.stopSession(sessionId)}
        onRestartSession={(sessionId) => void workspace.restartSession(sessionId)}
        onRecheckSession={(sessionId) => void workspace.recheckSession(sessionId)}
        onError={workspace.reportError}
        onSendToAgent={sendToAgent}
        onReload={() => tasks.reload()}
        onChanged={() => void tasks.reload()}
        onTaskAction={(task, action) => void runTaskWorkbenchAction(task, action)}
      />
    ),
    assistant: (
      <AssistantPage
        assistant={assistant}
        request={assistantTarget}
        repos={state.repos}
        tasks={tasks.tasks}
        onOpenTask={(taskId) => {
          const task = tasks.tasks.find((entry) => entry.id === taskId)
          if (task) commands.openTask(task)
        }}
        onTaskAction={(action, taskId) => void runAssistantTaskAction(action, taskId)}
        onOpenSettings={commands.showSettings}
      />
    ),
    schedules: (
      <SchedulesView
        repos={state.repos}
        schedules={tasks.schedules}
        notify={workspace.notify}
        onReload={() => tasks.reload()}
      />
    ),
    settings: (
      <SettingsPage
        state={state}
        runtime={workspace.runtime}
        maxConcurrent={tasks.maxConcurrent}
        maxConcurrentPerProject={tasks.maxConcurrentPerProject}
        onSetMaxConcurrent={tasks.setMaxConcurrent}
        onSetMaxConcurrentPerProject={tasks.setMaxConcurrentPerProject}
        refreshing={state.refreshing}
        onRefresh={refreshEverything}
        themePreference={theme.preference}
        resolvedTheme={theme.resolved}
        onSetTheme={theme.setPreference}
        assistantSettings={assistant.settings}
        assistantStatus={assistant.status}
        assistantHarness={assistant.harness}
        assistantTarget={assistant.target}
        onSaveAssistantSettings={assistant.saveSettings}
      />
    )
  }

  return (
    <>
    <AppLayout
      focusActive={focusActive}
      platform={workspace.runtime?.platform ?? null}
      sidebarOpen={sidebarOpen}
      onOpenSidebar={() => setSidebarOpen(true)}
      onCloseSidebar={() => setSidebarOpen(false)}
      sidebar={
        <WorkspaceSidebar
          repos={state.repos}
          sessions={sidebarSessions}
          tasks={tasks.tasks}
          archivedTasks={tasks.archivedTasks}
          activeRepoId={state.activeRepoId}
          activeSessionId={state.activeSessionId}
          activeTaskId={activeTaskId}
          branches={state.branches}
          orphans={state.orphans}
          assistantName={assistant.personaName}
          assistantUnread={assistant.unread}
          assistantStatus={assistant.status}
          hostUnreachable={hostUnreachable}
          platform={workspace.runtime?.platform ?? null}
          onOpenProject={(repoId, mode) => {
            commands.openProject(repoId, mode)
            setSidebarOpen(false)
          }}
          onOpenSession={(sessionId) => {
            commands.openDirectSession(sessionId)
            setSidebarOpen(false)
          }}
          onOpenTask={(task) => {
            commands.openTask(task)
            setSidebarOpen(false)
          }}
          onNewSession={() => {
            openNewSession()
            setSidebarOpen(false)
          }}
          onNewSessionInRepo={(repoId) => {
            workspace.selectRepo(repoId)
            openNewSession()
            setSidebarOpen(false)
          }}
          onQueueTask={() => {
            openQueueTask()
            setSidebarOpen(false)
          }}
          onQueueTaskInRepo={(repoId) => {
            openQueueTask(repoId)
            setSidebarOpen(false)
          }}
          onAddProject={() => {
            setAddOpen(true)
            setSidebarOpen(false)
          }}
          onOpenSchedules={() => {
            commands.showSchedules()
            setSidebarOpen(false)
          }}
          onOpenAssistant={() => {
            commands.showAssistant()
            setSidebarOpen(false)
          }}
          onOpenSettings={() => {
            commands.showSettings()
            setSidebarOpen(false)
          }}
          onOpenSearch={() => {
            setQuickOpenOpen(false)
            setPaletteOpen(true)
          }}
          onOpenNotifications={() => setNotificationsOpen(true)}
          onRefresh={refreshEverything}
          onRetryPreparation={(repoId) => void workspace.retryPreparation(repoId)}
          onRemoveRepository={(repoId) => void workspace.removeRepository(repoId)}
          onRemoveBranch={(branch) => void workspace.requestRemoveBranch(branch)}
          onNotify={workspace.notify}
          footerStatus={
            <SidebarStatus
              state={state}
              taskSlotCount={taskSlotCount}
              maxConcurrent={tasks.maxConcurrent}
              runtime={workspace.runtime}
              refreshing={state.refreshing}
              onRefresh={refreshEverything}
              onRetryHost={refreshEverything}
            />
          }
        />
      }
      appTabs={
        <AppTabStrip
          activeTab={activeTab}
          auxTabs={auxTabs}
          assistantName={assistant.personaName}
          assistantUnread={assistant.unread}
          platform={workspace.runtime?.platform ?? null}
          onActivate={(tab) => commands.openAppTab(tab)}
          onClose={(tab) => commands.closeAppTab(tab)}
        />
      }
      windowChrome={<WindowChrome platform={workspace.runtime?.platform ?? null} />}
      overlays={
        <GlobalOverlays
          notifications={{
            open: notificationsOpen,
            needsTasks,
            activity: activityEntries,
            assistantName: assistant.personaName,
            assistantMessages: assistant.notifications,
            markingRead: markingActivity,
            onClose: () => setNotificationsOpen(false),
            onOpenTask: commands.openTask,
            onOpenSession: commands.openDirectSession,
            onOpenAssistant: (target) => {
              commands.showAssistant(target)
              if (target.messageId) {
                void window.icode.assistant.focus({ messageId: target.messageId })
              }
            },
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
            activeRepoId: repo?.id ?? null,
            onOpenAssistant: () => commands.showAssistant(),
            onSchedules: commands.showSchedules,
            onSettings: commands.showSettings,
            onSourceControl: () => commands.requestView('changes'),
            onToggleTheme: () =>
              theme.setPreference(theme.resolved === 'dark' ? 'light' : 'dark'),
            onOpenProject: commands.openProject,
            onOpenSession: commands.openDirectSession,
            onOpenTask: commands.openTask,
            onOpenFile: commands.openFileFromPalette
          }}
          quickOpen={
            quickOpenSession !== null
              ? {
                  open: quickOpenOpen,
                  sessionId: quickOpenSession.id,
                  notify: workspace.notify,
                  onClose: () => setQuickOpenOpen(false),
                  onOpen: (path, line) => {
                    commands.openFileFromPalette(path, line)
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
                  onInitialize: initializeRepository,
                  platform: workspace.runtime?.platform ?? null
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
                  onClose: () => setNewSessionOpen(false),
                  onCreate: submitCreate,
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
      <AppRoutes
        boot={state.boot}
        bootError={state.bootError}
        onRetryBoot={refreshEverything}
        surface={displaySurface}
        pages={pages}
      />
    </AppLayout>
    <NoticeToast notice={state.notice} onDismiss={workspace.dismissNotice} />
    {taskComposer !== null && composerRepo !== null ? (
      <TaskComposerDialog
        repo={composerRepo}
        tasks={tasks.tasks}
        notify={workspace.notify}
        initialAfterTaskId={taskComposer.afterTaskId}
        onClose={() => setTaskComposer(null)}
        onCreated={(task) => {
          setTaskComposer(null)
          void tasks.reload().then(() => commands.openTask(task))
        }}
      />
    ) : null}
    </>
  )
}
