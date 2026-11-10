import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { SessionSummary } from '../../shared/schemas/ipc'
import AppRail from './components/AppRail'
import GlobalTopBar from './components/GlobalTopBar'
import type { ActivityEntry } from './components/NotificationsDrawer'
import ProjectHeader, { type ProjectStat } from './components/ProjectHeader'
import {
  projectHeaderStats,
  projectStats as computeProjectStats
} from './components/projects-wall-model'
import SchedulesView from './components/SchedulesView'
import ProjectsPage from './pages/ProjectsPage'
import SessionsPage from './pages/SessionsPage'
import SettingsPage from './pages/SettingsPage'
import TasksPage from './pages/TasksPage'
import AssistantPage from './pages/AssistantPage'
import type { AssistantTaskAction } from './components/AssistantCardView'
import StatusBar from './components/StatusBar'
import AppLayout from './layouts/AppLayout'
import GlobalOverlays from './layouts/GlobalOverlays'
import AppRoutes from './router/AppRoutes'
import { useAppNavigation } from './router/use-app-navigation'
import { useGlobalShortcuts } from './router/use-global-shortcuts'
import { useSessionPanes } from './state/use-session-panes'
import { taskAttention } from './components/task-status'
import { useWorkspace } from './state/use-workspace'
import { useTaskQueue } from './state/use-task-queue'
import { useAssistant } from './state/use-assistant'
import { useThemePreference } from './theme/use-theme'
import { useLocale } from './i18n/use-i18n'
import { translate, translatePlural } from './i18n/i18n-store'
import { activeRepo, activeSession } from './state/workspace'
import { hostStatus } from './state/host-status'
import type { Surface } from './router/routes'
import { callApi } from './lib/api'
import { sendAgentText, type AgentSendResult } from './lib/agent-send'
import { setRendererPlatform } from './lib/platform'
import { harnessLabel, isAgentHarness } from '../../shared/domain/harness'
import { WorkbenchDraftStore } from './review/drafts'
import { openFilesStore } from './files/open-files'
import { pruneTreeStates } from './files/tree-state'
import { filesClipboardStore } from './files/files-clipboard'

const NEEDS_ORDER = { Approval: 0, Answer: 1, Retry: 2, Review: 3 } as const
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
  // The root subscribes to language changes so label helpers that read the
  // module store (status, activity, task wording) repaint without threading a
  // translator through every call site.
  useLocale()

  const {
    displaySurface,
    taskSession,
    taskSessionTask,
    taskSessionLive,
    focusTaskId,
    focusComposerNonce,
    taskSelectionByRepo,
    projectDirectSessions,
    projectSession,
    quickOpenSession,
    focusableSessionId,
    viewRequest,
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

  const [sessionsListOpen, setSessionsListOpen] = useState<boolean>(initialSessionsListOpen)
  const [terminalFocus, setTerminalFocus] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [quickOpenOpen, setQuickOpenOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [markingActivity, setMarkingActivity] = useState(false)
  const [refreshToken, setRefreshToken] = useState(0)
  const [newSessionOpen, setNewSessionOpen] = useState(false)
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
  const projectStats = useMemo(() => {
    const byRepo: Record<string, ProjectStat> = {}
    for (const entry of state.repos) {
      byRepo[entry.id] = projectHeaderStats(
        computeProjectStats(entry, state.sessions, tasks.tasks)
      )
    }
    return byRepo
  }, [state.repos, state.sessions, tasks.tasks])

  const supervisorProposals = useMemo(
    () =>
      repo === null
        ? 0
        : tasks.tasks.filter(
            (task) =>
              task.repoId === repo.id && task.approval === 'pending' && task.status === 'queued'
          ).length,
    [repo, tasks.tasks]
  )

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

  const openQueueTask = useCallback((): void => {
    if (state.repos.length === 0) {
      setAddOpen(true)
      return
    }
    const target = repo ?? state.repos[0]
    if (!target) return
    if (target.id !== state.activeRepoId) workspace.selectRepo(target.id)
    commands.openTaskComposer()
  }, [commands.openTaskComposer, repo, state.activeRepoId, state.repos, workspace])

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

  const createSession = useCallback(
    async (input: Parameters<typeof workspace.createSession>[0]): Promise<boolean> => {
      const created = await workspace.createSession(input)
      if (created) commands.showSessions()
      return created
    },
    [commands.showSessions, workspace]
  )

  const addRepository = useCallback(
    async (input: Parameters<typeof workspace.addRepository>[0]): Promise<Awaited<ReturnType<typeof workspace.addRepository>>> => {
      const failure = await workspace.addRepository(input)
      if (failure === null) commands.showProjects()
      return failure
    },
    [commands.showProjects, workspace]
  )

  const initializeRepository = useCallback(
    async (
      input: Parameters<typeof workspace.initializeRepository>[0]
    ): Promise<Awaited<ReturnType<typeof workspace.initializeRepository>>> => {
      const failure = await workspace.initializeRepository(input)
      if (failure === null) commands.showProjects()
      return failure
    },
    [commands.showProjects, workspace]
  )

  const confirmRemoval = async (): Promise<void> => {
    const prompt = state.removal
    if (!prompt) return
    setRemovalBusy(true)
    await workspace.confirmRemoval()
    setRemovalBusy(false)
  }

  const paneSessions = useSessionPanes(state.sessions)

  const pages: Record<Surface, ReactNode> = {
    projects: (
      <ProjectsPage
        repos={state.repos}
        sessions={state.sessions}
        tasks={tasks.tasks}
        maxConcurrent={tasks.maxConcurrent}
        onOpenProject={commands.openProject}
        onOpenTask={commands.openTask}
        onOpenSession={commands.openDirectSession}
        onAddRepository={() => setAddOpen(true)}
        onRemoveRepository={(repoId) => void workspace.removeRepository(repoId)}
        onRetryPreparation={(repoId) => void workspace.retryPreparation(repoId)}
        notify={workspace.notify}
      />
    ),
    sessions: (
      <SessionsPage
        repo={repo}
        sessions={projectDirectSessions}
        activeSession={projectSession}
        pending={state.pending}
        branches={state.branches}
        orphans={state.orphans}
        sessionsListOpen={sessionsListOpen}
        focusActive={focusActive}
        onSelectSession={commands.openDirectSession}
        onNewSession={openNewSession}
        onRemoveBranch={(branch) => void workspace.requestRemoveBranch(branch)}
        onCollapseSessions={() => setSessionsListOpen(false)}
        onShowSessionsList={() => setSessionsListOpen(true)}
        paneSessions={paneSessions}
        refreshToken={refreshToken}
        openRequest={openRequest}
        viewRequest={viewRequest}
        drafts={drafts}
        sendToAgent={sendToAgent}
        onRestartSession={(sessionId) => void workspace.restartSession(sessionId)}
        onSleepSession={(sessionId) => void workspace.sleepSession(sessionId)}
        onWakeSession={(sessionId) => void workspace.wakeSession(sessionId)}
        onRecheckSession={(sessionId) => void workspace.recheckSession(sessionId)}
        onRemoveSession={(sessionId) => void workspace.requestRemoveSession(sessionId)}
        onRecoverWorktree={(sessionId) => void workspace.recoverWorktree(sessionId)}
        onError={workspace.reportError}
        notify={workspace.notify}
        onClearOpenRequest={commands.clearOpenRequest}
        onRequestOpenInFiles={commands.requestOpenInFiles}
        onClearViewRequest={commands.clearViewRequest}
      />
    ),
    tasks: (
      <TasksPage
        repo={repo}
        tasks={tasks.tasks}
        archivedTasks={tasks.archivedTasks}
        sessions={state.sessions}
        loading={tasks.loading}
        focusTaskId={focusTaskId}
        focusComposerNonce={focusComposerNonce}
        rememberedTaskId={repo === null ? null : taskSelectionByRepo[repo.id] ?? null}
        taskSession={taskSession}
        taskSessionTask={taskSessionTask}
        taskSessionLive={taskSessionLive}
        pending={state.pending}
        paneSessions={paneSessions}
        refreshToken={refreshToken}
        openRequest={openRequest}
        viewRequest={viewRequest}
        drafts={drafts}
        sendToAgent={sendToAgent}
        onBackToTasks={commands.backToTasks}
        onReload={() => tasks.reload()}
        onTaskSelected={commands.rememberTaskSelection}
        onOpenSession={commands.openTaskSession}
        onStopSession={(sessionId) => void workspace.stopSession(sessionId)}
        onRestartSession={(sessionId) => void workspace.restartSession(sessionId)}
        onSleepSession={(sessionId) => void workspace.sleepSession(sessionId)}
        onWakeSession={(sessionId) => void workspace.wakeSession(sessionId)}
        onRecheckSession={(sessionId) => void workspace.recheckSession(sessionId)}
        onRemoveSession={(sessionId) => void workspace.requestRemoveSession(sessionId)}
        onRecoverWorktree={(sessionId) => void workspace.recoverWorktree(sessionId)}
        onError={workspace.reportError}
        notify={workspace.notify}
        onClearOpenRequest={commands.clearOpenRequest}
        onRequestOpenInFiles={commands.requestOpenInFiles}
        onClearViewRequest={commands.clearViewRequest}
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
        onSetMaxConcurrent={tasks.setMaxConcurrent}
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

  const projectLabel =
    (displaySurface === 'sessions' || displaySurface === 'tasks') && repo !== null
      ? `${repo.displayName} · ${repo.currentBranch ?? translate('app.noBranch')}`
      : displaySurface === 'projects'
        ? translate('app.allProjectsLabel', {
            repos: translatePlural('app.repoCount', state.repos.length)
          })
        : displaySurface === 'schedules'
          ? translate('app.schedulesTitle')
          : displaySurface === 'assistant'
            ? translate('app.assistantAllProjects', { name: assistant.personaName })
            : translate('settings.title')

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
          onSchedules={commands.showSchedules}
          onOpenNotifications={() => setNotificationsOpen(true)}
          onProjects={commands.showProjects}
          themePreference={theme.preference}
          resolvedTheme={theme.resolved}
          onSetTheme={theme.setPreference}
          platform={workspace.runtime?.platform ?? null}
        />
      }
      rail={
        <AppRail
          surface={displaySurface}
          assistantName={assistant.personaName}
          assistantUnread={assistant.unread}
          assistantStatus={assistant.status}
          onProjects={commands.showProjects}
          onSchedules={commands.showSchedules}
          onAssistant={() => commands.showAssistant()}
          onSettings={commands.showSettings}
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
          onFocusSourceControl={() => commands.requestView('changes')}
        />
      }
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
            onProjects: commands.showProjects,
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
          onBack={commands.showProjects}
          onSwitch={commands.switchProject}
          onMode={commands.changeMode}
          onRetryPreparation={(repoId) => void workspace.retryPreparation(repoId)}
          assistantName={assistant.personaName}
          assistantUnread={assistant.unread}
          assistantStatus={assistant.status}
          pendingProposals={supervisorProposals}
          onOpenAssistant={() => commands.showAssistant({ repoId: repo.id })}
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
