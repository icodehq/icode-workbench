import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { RendererSessionEvent, SessionSummary } from '../../shared/schemas/ipc'
import type { TaskRecordPayload } from '../../shared/icode-api'
import WindowChrome from './components/shell/WindowChrome'
import WorkspaceSidebar from './components/shell/WorkspaceSidebar'
import type { ActivityEntry, BotsNotificationEntry } from './components/NotificationsDrawer'
import SchedulesView from './components/SchedulesView'
import WorkspaceWelcome from './components/shell/WorkspaceWelcome'
import SessionsSurface from './components/sessions/SessionsSurface'
import { TerminalProvider } from './terminal/terminal-provider'
import type { TerminalInteractionHost } from './terminal/terminal-interaction-host'
import SettingsPage from './pages/SettingsPage'
import TasksSurface from './components/tasks/TasksSurface'
import TaskComposerDialog from './components/tasks/TaskComposerDialog'
import type { TaskAction } from './components/TaskWorkbench'
import BotsSidebarSection from './components/bots/BotsSidebarSection'
import BotsSurface from './components/bots/BotsSurface'
import type { AssistantTaskAction } from './components/AssistantCardView'
import { requestTaskAction } from './lib/task-action-request'
import NoticeToast from './components/shell/NoticeToast'
import SidebarStatus from './components/shell/SidebarStatus'
import AppLayout from './layouts/AppLayout'
import GlobalOverlays from './layouts/GlobalOverlays'
import UpdateBanner from './updates/UpdateBanner'
import { bootstrapUpdates } from './updates/updates-store'
import AppRoutes from './router/AppRoutes'
import { useAppNavigation } from './router/use-app-navigation'
import { useGlobalShortcuts } from './router/use-global-shortcuts'
import { useSessionPanes } from './state/use-session-panes'
import { taskAttention } from './components/task-status'
import { useWorkspace, type CreateSessionRequest } from './state/use-workspace'
import { useSessionActions } from './state/use-session-actions'
import {
  createPendingCreate,
  pendingCreateStillVisible,
  type PendingCreate
} from './state/pending-create'
import { useTaskQueue } from './state/use-task-queue'
import { useRemovalJobs } from './state/use-removal-jobs'
import { useBots } from './state/use-bots'
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
import { headerRightInset } from './components/shell/window-chrome'
import { workspaceKeyForSession } from './workspace/workspace-key'

/** What the New Session dialog should preselect when it opens. */
type NewSessionInitialCheckout =
  | { kind: 'default' }
  | { kind: 'worktree'; worktreeId: string }
  | null

const NEEDS_ORDER = { Approval: 0, Answer: 1, Retry: 2, Blocked: 3, Review: 4 } as const
export default function App(): React.JSX.Element {
  const workspace = useWorkspace()
  const sessionActions = useSessionActions(workspace)
  const { state } = workspace
  const tasks = useTaskQueue(workspace.notify)
  const theme = useThemePreference()
  // The root subscribes to language changes so label helpers that read the
  // module store (status, activity, task wording) repaint without threading a
  // translator through every call site.
  useLocale()

  const {
    displaySurface,
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
    commands
  } = useAppNavigation({ workspace, tasks })

  // Session events are registered once, but navigation commands are recreated
  // every render; the ref keeps the subscription stable.
  const commandsRef = useRef(commands)
  commandsRef.current = commands

  const botsState = useBots(workspace.notify)

  const openBotsGroup = useCallback(
    (groupId: string, threadId?: string): void => {
      botsState.openGroup(groupId, threadId)
      commands.openAppTab('bots')
    },
    [commands, botsState]
  )
  const openBotsBot = useCallback(
    (botId: string): void => {
      botsState.selectBot(botId)
      commands.openAppTab('bots')
    },
    [commands, botsState]
  )
  const openBotsChat = useCallback(
    (botId: string, threadId: string): void => {
      botsState.openBotChat(botId, threadId)
      commands.openAppTab('bots')
    },
    [botsState, commands]
  )
  const botsNotifications = useMemo<BotsNotificationEntry[]>(() => {
    const needsByGroup = new Map<string, number>()
    const needsByBot = new Map<string, number>()
    for (const task of tasks.tasks) {
      if (taskAttention(task) === null) continue
      if (task.groupId !== null && task.groupId !== undefined) {
        needsByGroup.set(task.groupId, (needsByGroup.get(task.groupId) ?? 0) + 1)
      }
      if (task.botId !== null && task.botId !== undefined) {
        needsByBot.set(task.botId, (needsByBot.get(task.botId) ?? 0) + 1)
      }
    }
    const entries: BotsNotificationEntry[] = []
    for (const group of botsState.groups) {
      const thread = group.threads.find((entry) => entry.isDefault) ?? group.threads[0]
      if (thread === undefined) continue
      const needs = needsByGroup.get(group.id) ?? 0
      const unread = botsState.groupHomeUnread(group)
      if (unread === 0 && needs === 0) continue
      entries.push({
        key: `group:${group.id}`,
        kind: 'group',
        tab: { kind: 'group', groupId: group.id, threadId: thread.id },
        label: group.name,
        unread,
        needs
      })
    }
    for (const bot of botsState.bots) {
      const needs = needsByBot.get(bot.id) ?? 0
      if (bot.unread === 0 && needs === 0) continue
      entries.push({
        key: `bot:${bot.id}`,
        kind: 'bot',
        tab: { kind: 'bot', botId: bot.id },
        label: bot.name,
        unread: bot.unread,
        needs
      })
    }
    return entries.sort(
      (left, right) => right.needs - left.needs || right.unread - left.unread
    )
  }, [botsState.bots, botsState.groupHomeUnread, botsState.groups, tasks.tasks])

  const runBotsTaskAction = useCallback(
    async (action: AssistantTaskAction, taskId: string): Promise<void> => {
      const result = await requestTaskAction(
        taskId,
        action === 'continue' ? 'resume' : action
      )
      if (!result.ok) {
        workspace.notify({ tone: 'error', message: result.error.message })
        return
      }
      await tasks.reload()
      await botsState.reload()
    },
    [botsState.reload, tasks.reload, workspace]
  )

  const runTaskWorkbenchAction = useCallback(
    async (task: TaskRecordPayload, action: TaskAction): Promise<void> => {
      const result = await requestTaskAction(task.id, action)
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

  // One bridge for the whole shell: the initial snapshot plus main's pushes.
  useEffect(() => {
    bootstrapUpdates()
  }, [])

  // Tabs belong to live sessions only. Keeping a removed session's dirty text
  // would make the close guard ask about a session the user can no longer see.
  // Include the sessions currently on screen so a transient list refresh cannot
  // drop the text the user is looking at.
  useEffect(() => {
    if (state.boot !== 'ready') return
    // Direct tabs are worktree-scoped; task buffers stay session-scoped.
    const sessionIds = new Set(state.sessions.map((session) => session.id))
    const scopes = new Set<string>()
    for (const session of state.sessions) {
      scopes.add(
        taskSessionIds.has(session.id) ? session.id : workspaceKeyForSession(session)
      )
    }
    for (const task of tasks.tasks) {
      if (task.sessionId !== null) {
        sessionIds.add(task.sessionId)
        scopes.add(task.sessionId)
      }
    }
    if (state.activeSessionId !== null) {
      sessionIds.add(state.activeSessionId)
      const active = state.sessions.find((session) => session.id === state.activeSessionId)
      scopes.add(
        active !== undefined && !taskSessionIds.has(active.id)
          ? workspaceKeyForSession(active)
          : state.activeSessionId
      )
    }
    if (taskSession !== null) {
      sessionIds.add(taskSession.sessionId)
      scopes.add(taskSession.sessionId)
    }
    if (projectSession !== null) {
      sessionIds.add(projectSession.id)
      scopes.add(workspaceKeyForSession(projectSession))
    }
    openFilesStore.retain(scopes)
    // Direct tree snapshots use the workspace key; task/legacy ones use the
    // session id. Keep a key while either identity is still live.
    pruneTreeStates(new Set([...scopes, ...sessionIds]))
    const clipboard = filesClipboardStore.get()
    if (clipboard !== null && !scopes.has(clipboard.scopeKey)) filesClipboardStore.clear()
  }, [
    projectSession,
    state.activeSessionId,
    state.boot,
    state.sessions,
    taskSession,
    taskSessionIds,
    tasks.tasks
  ])

  // Legacy hot-exit state was session-keyed. Map it onto worktree scopes once
  // the session list is known; task sessions keep their session scope.
  useEffect(() => {
    if (state.boot !== 'ready') return
    void openFilesStore.migrateLegacy({
      sessions: state.sessions,
      taskSessionIds,
      activeSessionId: state.activeSessionId
    })
  }, [state.activeSessionId, state.boot, state.sessions, taskSessionIds])

  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [terminalFocus, setTerminalFocus] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [quickOpenOpen, setQuickOpenOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [markingActivity, setMarkingActivity] = useState(false)
  const [refreshToken, setRefreshToken] = useState(0)
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  /** The checkout the dialog should preselect; null means "create a new worktree". */
  const [newSessionInitialCheckout, setNewSessionInitialCheckout] =
    useState<NewSessionInitialCheckout>(null)
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
  const hasWorkspaceStrip =
    (displaySurface === 'sessions' && projectSession !== null) ||
    (displaySurface === 'bots' && botsState.selected !== null)
  const chromeBarLabel =
    displaySurface === 'settings'
      ? translate('settings.title')
      : displaySurface === 'schedules'
        ? translate('rail.schedules')
        : displaySurface === 'bots'
          ? translate('bots.label')
          : displaySurface === 'tasks'
            ? translate('tasks.title')
            : ''
  const chromeBar = hasWorkspaceStrip ? null : (
    <div
      className="icode-titlebar window-chrome-safe flex h-9 shrink-0 items-center border-b border-border bg-card px-3 text-[10.5px] text-muted-foreground"
      style={{ paddingRight: headerRightInset(workspace.runtime?.platform ?? null) + 8 }}
      data-testid="workspace-titlebar"
    >
      {chromeBarLabel}
    </div>
  )

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

  // An OS notification click is a navigation command from main. Route both
  // shapes through the same commands the sidebar uses so the surface and the
  // project mode change together.
  useEffect(
    () =>
      window.icode.onSessionEvent((event: RendererSessionEvent) => {
        if (event.type === 'activity-focus') {
          commandsRef.current.openDirectSession(event.sessionId)
          setSidebarOpen(false)
          return
        }
        if (event.type !== 'notification-focus') return
        if (event.destination.kind === 'session') {
          commandsRef.current.openTaskSession(event.destination.sessionId, event.destination.view)
        } else {
          commandsRef.current.openTaskById(event.destination.taskId)
        }
        setSidebarOpen(false)
      }),
    []
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

  const terminalInteractionHost = useMemo<TerminalInteractionHost>(
    () => ({
      openFile: (path, line = 1) => commands.openFileFromPalette(path, line),
      openExternal: async (url) => {
        const result = await window.icode.window.openExternal({ url })
        if (!result.ok) {
          workspace.notify({ tone: 'error', message: result.error.message })
        }
      },
      notify: (notice) => workspace.notify(notice),
      getSession: (sessionId) =>
        state.sessions.find((session) => session.id === sessionId) ?? null,
      statFile: async (sessionId, path) => {
        try {
          const result = await window.icode.files.stat({ sessionId, path })
          return result.ok && result.value.status === 'ok'
        } catch {
          return false
        }
      },
      readClipboard: async () => {
        try {
          return await navigator.clipboard.readText()
        } catch {
          return ''
        }
      },
      writeClipboard: async (text) => {
        try {
          await navigator.clipboard.writeText(text)
          return true
        } catch {
          return false
        }
      },
      sendToAgent: async (sessionId, text) => {
        const session = state.sessions.find((entry) => entry.id === sessionId) ?? null
        return sendToAgent(text, session)
      }
    }),
    [commands.openFileFromPalette, sendToAgent, state.sessions, workspace]
  )

  /*
   * Depend on the stable functions, not the hook result objects. Both
   * `workspace` and `tasks` are new literals every render, and a callback that
   * changes every render used to make the removal-jobs subscription reload
   * forever.
   */
  const refreshAll = workspace.refreshAll
  const reloadTasks = tasks.reload
  const refreshEverything = useCallback((): void => {
    setRefreshToken((current) => current + 1)
    void refreshAll()
    void reloadTasks(true)
  }, [refreshAll, reloadTasks])

  const cleanup = useRemovalJobs({
    notify: workspace.notify,
    onChanged: refreshEverything
  })

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

  const openNewSession = (initialCheckout: NewSessionInitialCheckout = null): void => {
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
    // React can hand a click event to a handler typed as optional-argument;
    // only the two explicit checkout descriptors count as a preselection.
    setNewSessionInitialCheckout(
      initialCheckout?.kind === 'default' || initialCheckout?.kind === 'worktree'
        ? initialCheckout
        : null
    )
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
        recovery={state.recovery}
        focusActive={focusActive}
        paneSessions={paneSessions}
        refreshToken={refreshToken}
        openRequest={openRequest}
        viewRequest={viewRequest}
        drafts={drafts}
        sendToAgent={sendToAgent}
        onSelectSession={commands.openDirectSession}
        onCreateSession={workspace.createSession}
        onNewSession={openNewSession}
        sessionActions={sessionActions}
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
        sessionActions={sessionActions}
        onError={workspace.reportError}
        onSendToAgent={sendToAgent}
        onReload={() => tasks.reload()}
        onChanged={() => void tasks.reload()}
        onTaskAction={(task, action) => void runTaskWorkbenchAction(task, action)}
        bots={botsState.bots}
      />
    ),
    bots: (
      <BotsSurface
        state={botsState}
        repos={state.repos}
        tasks={tasks.tasks}
        notify={workspace.notify}
        onOpenTask={commands.openTaskById}
        onOpenSession={(sessionId) => commands.openTaskSession(sessionId, 'terminal')}
        onOpenHistory={() => setHistoryOpen(true)}
        onTaskAction={(action, taskId) => void runBotsTaskAction(action, taskId)}
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
      />
    )
  }

  return (
    <TerminalProvider sessions={state.sessions} host={terminalInteractionHost}>
    <>
    <AppLayout
      focusActive={focusActive}
      platform={workspace.runtime?.platform ?? null}
      sidebarOpen={sidebarOpen}
      onOpenSidebar={() => setSidebarOpen(true)}
      onCloseSidebar={() => setSidebarOpen(false)}
      sidebar={
        <WorkspaceSidebar
          botsSection={
            <BotsSidebarSection
              state={botsState}
              tasks={tasks.tasks}
              notify={workspace.notify}
              onOpenGroup={openBotsGroup}
              onOpenBot={openBotsBot}
            />
          }
          repos={state.repos}
          sessions={sidebarSessions}
          tasks={tasks.tasks}
          archivedTasks={tasks.archivedTasks}
          activeRepoId={state.activeRepoId}
          activeSessionId={state.activeSessionId}
          branches={state.branches}
          orphans={state.orphans}
          pending={state.pending}
          botsUnread={botsState.unread}
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
          sessionActions={sessionActions}
          onRemoveWorktree={workspace.requestRemoveWorktree}
          onDiscardWorktree={workspace.discardWorktree}
          onNewSession={() => {
            openNewSession()
            setSidebarOpen(false)
          }}
          onNewSessionInRepo={(repoId) => {
            workspace.selectRepo(repoId)
            openNewSession()
            setSidebarOpen(false)
          }}
          onNewSessionInDefaultCheckout={(repoId) => {
            workspace.selectRepo(repoId)
            openNewSession({ kind: 'default' })
            setSidebarOpen(false)
          }}
          onNewSessionInWorktree={(repoId, worktreeId) => {
            workspace.selectRepo(repoId)
            openNewSession({ kind: 'worktree', worktreeId })
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
          onOpenSettings={() => {
            commands.showSettings()
            setSidebarOpen(false)
          }}
          onOpenSearch={() => {
            setQuickOpenOpen(false)
            setPaletteOpen(true)
          }}
          onOpenHistory={() => setHistoryOpen(true)}
          onOpenNotifications={() => setNotificationsOpen(true)}
          onRefresh={refreshEverything}
          onRetryPreparation={(repoId) => void workspace.retryPreparation(repoId)}
          onRemoveRepository={(repoId) => {
            void workspace.removeRepository(repoId).then(() => tasks.reload(true))
          }}
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
              cleanupJobs={cleanup.jobs}
              onRetryRemoval={(jobId) => void cleanup.retry(jobId)}
              onDiscardRemovalSnapshots={(jobId) => void cleanup.discard(jobId)}
            />
          }
        />
      }
      chromeBar={chromeBar}
      banner={<UpdateBanner platform={workspace.runtime?.platform ?? null} />}
      windowChrome={<WindowChrome platform={workspace.runtime?.platform ?? null} />}
      overlays={
        <GlobalOverlays
          notifications={{
            open: notificationsOpen,
            needsTasks,
            bots: botsNotifications,
            activity: activityEntries,
            markingRead: markingActivity,
            onClose: () => setNotificationsOpen(false),
            onOpenTask: commands.openTask,
            onOpenSession: commands.openDirectSession,
            onOpenBots: (tab) => {
              if (tab.kind === 'group') openBotsGroup(tab.groupId, tab.threadId)
              else openBotsBot(tab.botId)
              setNotificationsOpen(false)
            },
            onMarkRead: () => void markActivityRead()
          }}
          palette={{
            open: paletteOpen,
            repos: state.repos,
            sessions: state.sessions,
            tasks: [...tasks.tasks, ...tasks.archivedTasks],
            fileSession:
              quickOpenSession === null
                ? null
                : {
                    ...quickOpenSession,
                    scopeKey: taskSessionIds.has(quickOpenSession.id)
                      ? quickOpenSession.id
                      : workspaceKeyForSession(quickOpenSession)
                  },
            canStartSession: !hostUnreachable,
            resolvedTheme: theme.resolved,
            notify: workspace.notify,
            onClose: () => setPaletteOpen(false),
            onNewSession: openNewSession,
            onQueueTask: openQueueTask,
            activeRepoId: repo?.id ?? null,
            onBots: () => commands.openAppTab('bots'),
            onHistory: () => setHistoryOpen(true),
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
          history={
            historyOpen
              ? {
                  open: true,
                  repos: state.repos,
                  onClose: () => setHistoryOpen(false),
                  onOpenSession: commands.openDirectSession,
                  onOpenTask: commands.openTaskById,
                  onOpenGroup: openBotsGroup,
                  onOpenBotChat: openBotsChat
                }
              : null
          }
          quickOpen={
            quickOpenSession !== null
              ? {
                  open: quickOpenOpen,
                  sessionId: quickOpenSession.id,
                  scopeKey: taskSessionIds.has(quickOpenSession.id)
                    ? quickOpenSession.id
                    : workspaceKeyForSession(quickOpenSession),
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
                  initialCheckout: newSessionInitialCheckout,
                  harnesses: state.harnesses,
                  harnessLoading: state.harnessLoading,
                  harnessError: state.harnessError,
                  onClose: () => {
                    setNewSessionOpen(false)
                    setNewSessionInitialCheckout(null)
                  },
                  onCreate: submitCreate,
                  onRefreshHarnesses: workspace.refreshHarnesses
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
                    sessionActions.recoverWorktree(state.sessionCleanup!.sessionId),
                  onDiscard: async (confirmBranch) => {
                    setCleanupBusy(true)
                    const removed = await workspace.discardSession(
                      state.sessionCleanup!.sessionId,
                      confirmBranch,
                      { deleteBranch: state.sessionCleanup!.deleteBranch }
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
          resolveFileScopeOwner={(scopeKey) => {
            const direct = state.sessions.find(
              (session) =>
                !taskSessionIds.has(session.id) &&
                workspaceKeyForSession(session) === scopeKey
            )
            if (direct !== undefined) return direct.id
            return state.sessions.some((session) => session.id === scopeKey)
              ? scopeKey
              : null
          }}
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
    </TerminalProvider>
  )
}
