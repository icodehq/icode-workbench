import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bell,
  ChevronRight,
  Filter,
  FolderGit2,
  GitBranch,
  History,
  MoreHorizontal,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Settings,
  TerminalSquare
} from 'lucide-react'
import type { TaskRecordPayload } from '../../../../shared/icode-api'
import type {
  OrphanedHostSession,
  OwnedBranchSummary,
  RepositorySummary,
  SessionSummary
} from '../../../../shared/schemas/ipc'
import type { Notice, PendingAction } from '../../state/workspace'
import type { SidebarSessionActions } from '../../state/session-actions'
import type { MenuAnchor } from '../ContextMenu'
import type { TaskAction } from '../TaskWorkbench'
import AssistantAvatar from '../AssistantAvatar'
import { repositoryPreparationView } from '../../lib/repository-preparation'
import { isMacPlatform, shortcutLabel } from '../../lib/platform'
import {
  pruneSidebarPins,
  readSidebarPins,
  togglePin,
  writeSidebarPins,
  type SidebarPins
} from './sidebar-pins'
import {
  attentionTaskCount,
  buildSidebarTaskGroups,
  groupDirectSessions,
  pinnedProjectsFirst,
  repositoryRemovalImpact,
  type WorktreeSessionGroup
} from './sidebar-model'
import WorkspaceSidebarDialogs from './WorkspaceSidebarDialogs'
import { createSidebarMenuItems } from './sidebar-menu-items'
import { sidebarBrandInset } from './window-chrome'
import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  clampSidebarWidth,
  loadSidebarWidth,
  saveSidebarWidth
} from '../../state/sidebar-layout'
import { usePanelResize } from '../../lib/use-panel-resize'
import { taskAttention, taskStatusLabel } from '../task-status'
import {
  activityDotClass,
  activitySuffix,
  activityTone,
  sessionStateDotClass,
  sessionStateLabelFor
} from '../status'
import { useT } from '../../i18n/use-i18n'

type Props = {
  repos: RepositorySummary[]
  sessions: SessionSummary[]
  tasks: TaskRecordPayload[]
  archivedTasks: TaskRecordPayload[]
  activeRepoId: string | null
  activeSessionId: string | null
  activeTaskId: string | null
  branches: OwnedBranchSummary[]
  orphans: OrphanedHostSession[]
  /** Per-session in-flight action, so the row and its menu match the header. */
  pending: Record<string, PendingAction>
  assistantName: string
  assistantUnread: number
  assistantStatus: 'working' | 'idle' | 'offline' | 'error'
  hostUnreachable: boolean
  platform: string | null
  onOpenProject: (repoId: string, mode?: 'sessions' | 'tasks') => void
  onOpenSession: (sessionId: string) => void
  onOpenTask: (task: TaskRecordPayload) => void
  onTaskAction: (task: TaskRecordPayload, action: TaskAction) => void
  sessionActions: SidebarSessionActions
  onNewSession: () => void
  onNewSessionInRepo: (repoId: string) => void
  /** Start another session in an existing worktree, from its sidebar group. */
  onNewSessionInWorktree: (repoId: string, worktreeId: string) => void
  /** Re-create a missing checkout from its retained branch. */
  onQueueTask: () => void
  onQueueTaskInRepo: (repoId: string) => void
  onAddProject: () => void
  onOpenSchedules: () => void
  onOpenAssistant: () => void
  onOpenSettings: () => void
  onOpenSearch: () => void
  onOpenNotifications: () => void
  onRefresh: () => void
  onRetryPreparation: (repoId: string) => void
  onRemoveRepository: (repoId: string) => void
  onRemoveBranch: (branch: string) => void
  onNotify: (notice: Notice) => void
  footerStatus?: React.ReactNode
}

type ProjectMenuRequest = {
  repo: RepositorySummary
  anchor?: MenuAnchor
  x?: number
  y?: number
  returnFocus: HTMLElement | null
  opener?: HTMLElement | null
}

type WorktreeMenuRequest = {
  repo: RepositorySummary
  group: WorktreeSessionGroup
  x: number
  y: number
  returnFocus: HTMLElement | null
}

/**
 * A menu requested from a row. Pointer opens carry cursor coordinates; the
 * keyboard opens against the row's rectangle so the menu has a stable anchor.
 */
type RowMenuRequest = {
  anchor?: MenuAnchor
  x?: number
  y?: number
  returnFocus: HTMLElement | null
}

type TaskMenuRequest = RowMenuRequest & { task: TaskRecordPayload }

type SessionMenuRequest = RowMenuRequest & { session: SessionSummary }

function taskDotClass(task: TaskRecordPayload): string {
  const attention = taskAttention(task)
  if (attention === 'Review') return 'bg-info'
  if (attention === 'Retry') return 'bg-destructive'
  if (attention !== null) return 'bg-signal'
  if (task.status === 'running' || task.status === 'dispatching') return 'bg-add'
  if (task.status === 'completed') return task.reviewDecision === 'pending' ? 'bg-info' : 'bg-add'
  if (task.status === 'failed') return 'bg-destructive'
  return 'bg-muted-foreground'
}

function menuAnchor(element: Element): MenuAnchor {
  const rect = element.getBoundingClientRect()
  return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
}

export default function WorkspaceSidebar({
  repos,
  sessions,
  tasks,
  archivedTasks,
  activeRepoId,
  activeSessionId,
  activeTaskId,
  branches,
  orphans,
  pending,
  assistantName,
  assistantUnread,
  assistantStatus,
  hostUnreachable,
  platform,
  onOpenProject,
  onOpenSession,
  onOpenTask,
  onTaskAction,
  sessionActions,
  onNewSession,
  onNewSessionInRepo,
  onNewSessionInWorktree,
  onQueueTask,
  onQueueTaskInRepo,
  onAddProject,
  onOpenSchedules,
  onOpenAssistant,
  onOpenSettings,
  onOpenSearch,
  onOpenNotifications,
  onRefresh,
  onRetryPreparation,
  onRemoveRepository,
  onRemoveBranch,
  onNotify,
  footerStatus
}: Props): React.JSX.Element {
  const t = useT()
  const [width, setWidth] = useState<number>(() => loadSidebarWidth())
  // On macOS the traffic lights take the header's leading inset, so the
  // narrowest widths need to drop the refresh verb (the status bar still has
  // one) rather than squeeze the brand into the controls.
  const compactHeader = width < (isMacPlatform(platform) ? 280 : 240)
  const widthRef = useRef(width)
  const asideRef = useRef<HTMLElement | null>(null)
  const resizerRef = useRef<HTMLDivElement | null>(null)
  const [pins, setPins] = useState<SidebarPins>(() => readSidebarPins())
  const [projectsCollapsed, setProjectsCollapsed] = useState(false)
  const [tasksCollapsed, setTasksCollapsed] = useState(false)
  const [tasksNeedsOnly, setTasksNeedsOnly] = useState(false)
  const [tasksHistory, setTasksHistory] = useState(false)
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(() => new Set())
  const [collapsedWorktrees, setCollapsedWorktrees] = useState<Set<string>>(() => new Set())
  const [maintenanceRepo, setMaintenanceRepo] = useState<RepositorySummary | null>(null)
  const [settingsRepo, setSettingsRepo] = useState<RepositorySummary | null>(null)
  const [removeRepo, setRemoveRepo] = useState<RepositorySummary | null>(null)
  const [projectMenu, setProjectMenu] = useState<ProjectMenuRequest | null>(null)
  const [worktreeMenu, setWorktreeMenu] = useState<WorktreeMenuRequest | null>(null)
  const [taskMenu, setTaskMenu] = useState<TaskMenuRequest | null>(null)
  const [sessionMenu, setSessionMenu] = useState<SessionMenuRequest | null>(null)
  const [detailsSession, setDetailsSession] = useState<SessionSummary | null>(null)
  const [sleepSession, setSleepSession] = useState<SessionSummary | null>(null)
  const [removeSession, setRemoveSession] = useState<SessionSummary | null>(null)
  const [newMenu, setNewMenu] = useState<{
    anchor: MenuAnchor
    returnFocus: HTMLElement | null
    opener: HTMLElement | null
  } | null>(null)

  useEffect(() => {
    setPins((current) => {
      const next = pruneSidebarPins(
        current,
        repos.map((repo) => repo.id),
        sessions.map((session) => session.id),
        [...tasks, ...archivedTasks].map((task) => task.id)
      )
      if (
        next.projects.length === current.projects.length &&
        next.sessions.length === current.sessions.length &&
        next.tasks.length === current.tasks.length
      ) {
        return current
      }
      writeSidebarPins(next)
      return next
    })
  }, [archivedTasks, repos, sessions, tasks])

  useEffect(() => {
    widthRef.current = width
  }, [width])

  const persistWidth = (next: number): void => {
    const clamped = clampSidebarWidth(next)
    setWidth(clamped)
    widthRef.current = clamped
    saveSidebarWidth(clamped)
  }

  const { handleProps } = usePanelResize({
    kind: 'sidebar',
    panelRef: asideRef,
    getStartValue: () => widthRef.current,
    clamp: clampSidebarWidth,
    direction: 1,
    axis: 'x',
    cursor: 'col-resize',
    onLive: (next) => {
      const aside = asideRef.current
      if (aside === null) return
      const widthText = String(Math.round(next))
      if (aside.dataset.width !== widthText) aside.dataset.width = widthText
      const compact = next < (isMacPlatform(platform) ? 280 : 240)
      const compactText = compact ? 'true' : 'false'
      if (aside.dataset.compact !== compactText) aside.dataset.compact = compactText
      resizerRef.current?.setAttribute('aria-valuenow', widthText)
    },
    onCommit: persistWidth
  })

  const { pinned } = useMemo(
    () => pinnedProjectsFirst(repos, pins.projects),
    [pins.projects, repos]
  )
  const pinnedSessions = useMemo(
    () => sessions.filter((session) => pins.sessions.includes(session.id)),
    [pins.sessions, sessions]
  )
  const pinnedTasks = useMemo(
    () => [...tasks, ...archivedTasks].filter((task) => pins.tasks.includes(task.id)),
    [archivedTasks, pins.tasks, tasks]
  )
  const taskGroups = useMemo(
    () =>
      buildSidebarTaskGroups(
        tasksHistory ? archivedTasks : tasks,
        repos,
        tasksHistory ? false : tasksNeedsOnly,
        tasksHistory
      ),
    [archivedTasks, repos, tasks, tasksHistory, tasksNeedsOnly]
  )
  const attention = attentionTaskCount(tasks)
  const directSessionCount = useMemo(() => {
    const count = new Map<string, number>()
    for (const session of sessions) count.set(session.repoId, (count.get(session.repoId) ?? 0) + 1)
    return count
  }, [sessions])

  const updatePins = (updater: (current: SidebarPins) => SidebarPins): void => {
    setPins((current) => {
      const next = updater(current)
      writeSidebarPins(next)
      return next
    })
  }

  const toggleProjectPin = (repoId: string): void => {
    updatePins((current) => ({ ...current, projects: togglePin(current.projects, repoId) }))
  }

  const toggleWorktreeCollapsed = (worktreeId: string): void => {
    setCollapsedWorktrees((current) => {
      const next = new Set(current)
      if (next.has(worktreeId)) next.delete(worktreeId)
      else next.add(worktreeId)
      return next
    })
  }

  const toggleSessionPin = (sessionId: string): void => {
    updatePins((current) => ({ ...current, sessions: togglePin(current.sessions, sessionId) }))
  }
  const toggleTaskPin = (taskId: string): void => {
    updatePins((current) => ({ ...current, tasks: togglePin(current.tasks, taskId) }))
  }

  const menuItems = createSidebarMenuItems({
    t,
    pins,
    hostUnreachable,
    hostUnreachableReason: t('topbar.hostUnreachable'),
    collapsedWorktrees,
    preparationFor: (repo) => repositoryPreparationView(repo),
    pendingFor: (session) => pending[session.id] ?? null,
    notify: onNotify,
    onRetryPreparation,
    onNewSessionInRepo,
    onQueueTaskInRepo,
    onNewSessionInWorktree,
    onRecoverWorktree: sessionActions.recoverWorktree,
    onNewSession,
    onQueueTask,
    onAddProject,
    onOpenSchedules,
    onTaskAction,
    onWakeSession: sessionActions.wake,
    onRestartSession: sessionActions.restart,
    toggleProjectPin,
    toggleTaskPin,
    toggleSessionPin,
    toggleWorktreeCollapsed,
    setSettingsRepo,
    setMaintenanceRepo,
    setRemoveRepo,
    setDetailsSession,
    setSleepSession,
    setRemoveSession
  })

  const requestProjectMenu = (
    repo: RepositorySummary,
    request: Omit<ProjectMenuRequest, 'repo'>
  ): void => setProjectMenu({ repo, ...request })

  const requestTaskMenu = (task: TaskRecordPayload, request: RowMenuRequest): void =>
    setTaskMenu({ task, ...request })

  const requestSessionMenu = (session: SessionSummary, request: RowMenuRequest): void =>
    setSessionMenu({ session, ...request })

  const pendingFor = (session: SessionSummary): PendingAction | null =>
    pending[session.id] ?? null

  /** The menu key opens the same menu a right-click does, anchored to the row. */
  const openRowMenuFromKey = (
    event: React.KeyboardEvent<HTMLElement>,
    open: (anchor: MenuAnchor) => void
  ): void => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
    event.preventDefault()
    open(menuAnchor(event.currentTarget))
  }

  const removalImpact = (repoId: string): { sessions: number; worktrees: number } =>
    repositoryRemovalImpact(repoId, sessions, [...tasks, ...archivedTasks])

  /**
   * Actions for one task row. The row click opens the task, so the menu holds
   * only lifecycle actions it cannot perform. The plan lives in `task-menu` so
   * the ordering and availability rules are unit-tested.
   */
  /**
   * Session lifecycle is a row-level action: the row menu is the fast path for
   * any session, including one that is not open. The header menu stays the
   * descriptive surface; both read the plan in `sessions/session-menu`.
   */
  const sessionRow = (session: SessionSummary): React.JSX.Element => {
    const active = session.id === activeSessionId
    const suffix = activitySuffix(session.activity)
    const menuOpen = sessionMenu?.session.id === session.id
    return (
      <div
        key={session.id}
        className={`flex min-h-7 items-center rounded-md ${menuOpen ? 'bg-hover' : ''}`}
        data-menu-open={menuOpen ? 'true' : undefined}
      >
        <button
          type="button"
          className={`flex min-h-7 min-w-0 flex-1 items-start gap-1.5 rounded-md px-1.5 py-1 text-left ${
            active
              ? 'bg-sel text-foreground shadow-[inset_2px_0_0_var(--icode-accent)]'
              : 'text-muted-foreground hover:bg-hover hover:text-foreground'
          }`}
          onClick={() => onOpenSession(session.id)}
          onContextMenu={(event) => {
            event.preventDefault()
            requestSessionMenu(session, {
              x: event.clientX,
              y: event.clientY,
              returnFocus: event.currentTarget
            })
          }}
          onKeyDown={(event) =>
            openRowMenuFromKey(event, (anchor) =>
              requestSessionMenu(session, { anchor, returnFocus: event.currentTarget })
            )
          }
          aria-current={active ? 'true' : undefined}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={session.title}
          data-testid={`session-item-${session.id}`}
          data-session-id={session.id}
          data-session-state={session.state}
          data-session-role={session.role}
          data-session-sleeping={String(session.sleeping === true)}
          data-session-pending={pendingFor(session) ?? ''}
          data-session-incarnation={session.incarnationId ?? ''}
          data-session-activity={session.activity?.state ?? 'unknown'}
          data-session-activity-unread={String(session.activity?.unread ?? false)}
          data-active={active ? 'true' : 'false'}
        >
          <span
            className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${sessionStateDotClass(session, pendingFor(session))}`}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[10px]">{session.title}</span>
            <span className="block truncate font-mono text-[7.5px] text-muted-foreground">
              {sessionStateLabelFor(session, pendingFor(session))}
              {session.worktree
                ? ` · ${
                    session.worktree.branch.length > 22
                      ? `${session.worktree.branch.slice(0, 21)}…`
                      : session.worktree.branch
                  }`
                : ''}
            </span>
            {suffix === null ? null : (
              <span
                className={`mt-0.5 flex items-center gap-1 truncate text-[7.5px] ${activityTone(
                  session.activity
                )}${session.activity?.unread ? ' font-semibold' : ''}`}
                data-testid={`session-activity-${session.id}`}
                data-activity={session.activity?.state ?? 'unknown'}
                data-activity-unread={String(session.activity?.unread ?? false)}
              >
                <span
                  className={`h-1 w-1 shrink-0 rounded-full ${activityDotClass(session.activity)}`}
                />
                <span className="truncate">{suffix}</span>
              </span>
            )}
          </span>
        </button>
      </div>
    )
  }

  const projectRow = (
    repo: RepositorySummary,
    isPinned: boolean,
    compact = false
  ): React.JSX.Element => {
    const repoSessions = sessions.filter((session) => session.repoId === repo.id)
    const hasActiveSession = repoSessions.some((session) => session.id === activeSessionId)
    const isActive = repo.id === activeRepoId && !hasActiveSession
    const needs = attentionTaskCount(tasks.filter((task) => task.repoId === repo.id))
    const preparation = repositoryPreparationView(repo)
    const sessionCount = directSessionCount.get(repo.id) ?? 0
    const expanded = !collapsedRepos.has(repo.id)
    const groups = groupDirectSessions(repoSessions)
    const menuOpen = projectMenu?.repo.id === repo.id
    if (compact) {
      return (
        <div
          key={`pin-${repo.id}`}
          className={`flex h-7 min-w-0 items-center rounded-md ${
            menuOpen && !isActive ? 'bg-hover' : ''
          }`}
          data-menu-open={menuOpen ? 'true' : undefined}
          onContextMenu={(event) => {
            event.preventDefault()
            requestProjectMenu(repo, {
              x: event.clientX,
              y: event.clientY,
              returnFocus: event.currentTarget.querySelector<HTMLElement>(
                `[data-testid="pinned-project-${repo.id}"]`
              )
            })
          }}
        >
          <button
            type="button"
            className={`flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left text-[10px] ${
              isActive
                ? 'bg-sel text-foreground'
                : 'text-muted-foreground hover:bg-hover hover:text-foreground'
            }`}
            onClick={() => onOpenProject(repo.id, 'sessions')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title={repo.path}
            data-testid={`pinned-project-${repo.id}`}
            data-active={isActive ? 'true' : 'false'}
          >
            <FolderGit2 size={11} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate text-[10px] font-medium">
              {repo.displayName}
            </span>
            {needs > 0 ? (
              <span className="shrink-0 rounded-full bg-signal-weak px-1 font-mono text-[8px] text-signal">
                {needs}
              </span>
            ) : null}
          </button>
        </div>
      )
    }
    return (
      <div key={repo.id} data-testid={`sidebar-project-group-${repo.id}`}>
        <div
          className={`group flex h-8 min-w-0 items-center rounded-md pr-1 ${
            isActive
              ? 'bg-sel text-foreground shadow-[inset_2px_0_0_var(--icode-accent)]'
              : menuOpen
                ? 'bg-hover text-foreground'
                : 'text-muted-foreground hover:bg-hover hover:text-foreground'
          }`}
          data-testid={`sidebar-project-${repo.id}`}
          data-active={isActive ? 'true' : 'false'}
          data-menu-open={menuOpen ? 'true' : undefined}
          onContextMenu={(event) => {
            event.preventDefault()
            requestProjectMenu(repo, {
              x: event.clientX,
              y: event.clientY,
              returnFocus: event.currentTarget.querySelector<HTMLElement>(
                `[data-testid="project-row-${repo.id}"]`
              )
            })
          }}
        >
          {repoSessions.length > 0 ? (
            <button
              type="button"
              className="ml-1 inline-flex h-6 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
              onClick={() => {
                setCollapsedRepos((current) => {
                  const next = new Set(current)
                  if (next.has(repo.id)) next.delete(repo.id)
                  else next.add(repo.id)
                  return next
                })
              }}
              aria-expanded={expanded}
              aria-label={repo.displayName}
              data-testid={`sidebar-project-toggle-${repo.id}`}
            >
              <ChevronRight size={9} className={expanded ? 'rotate-90' : ''} />
            </button>
          ) : (
            <span className="ml-1 w-4 shrink-0" />
          )}
          <button
            type="button"
            className="flex h-full min-w-0 flex-1 items-center gap-1 px-1 text-left"
            data-testid={`project-row-${repo.id}`}
            onClick={() => onOpenProject(repo.id, 'sessions')}
            aria-current={isActive ? 'page' : undefined}
            aria-haspopup="menu"
            title={repo.path}
          >
            <FolderGit2 size={12} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate text-[11px] font-medium">
              {repo.displayName}
            </span>
            {isPinned ? <Pin size={9} className="shrink-0 text-muted-foreground" /> : null}
            {needs > 0 ? (
              <span
                className="shrink-0 rounded-full bg-signal-weak px-1 font-mono text-[8px] text-signal"
                title={t('projectHeader.needsCount', { count: needs })}
              >
                {needs}
              </span>
            ) : null}
            <span className="shrink-0 font-mono text-[8px] text-muted-foreground">
              {sessionCount}
            </span>
            {preparation?.kind === 'failed' ? (
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-signal"
                title={preparation.label}
              />
            ) : null}
          </button>
          <button
            type="button"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
            aria-label={t('projects.row.actionsAria', { name: repo.displayName })}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title={t('projects.row.actions')}
            data-testid={`sidebar-project-menu-${repo.id}`}
            onClick={(event) => {
              event.stopPropagation()
              if (projectMenu?.repo.id === repo.id) {
                setProjectMenu(null)
                return
              }
              requestProjectMenu(repo, {
                anchor: menuAnchor(event.currentTarget),
                returnFocus: event.currentTarget,
                opener: event.currentTarget
              })
            }}
          >
            <MoreHorizontal size={12} />
          </button>
          <span className="hidden shrink-0 items-center gap-1 pr-1 font-mono text-[8px] text-muted-foreground group-hover:flex">
            <GitBranch size={9} />
            {repo.currentBranch ?? '—'}
          </span>
        </div>

        {expanded && repoSessions.length > 0 ? (
          <div
            className="mb-1 ml-5 border-l border-border pl-1"
            data-testid={`sidebar-sessions-${repo.id}`}
          >
            {groups.root.map(sessionRow)}
            {groups.worktrees.map((group) => {
              const status = group.sessions[0]?.worktree?.status
              // A checkout Git cannot hand to a PTY must not offer a session.
              const canAdd = status === 'ready-to-start' || status === 'active'
              const collapsed = collapsedWorktrees.has(group.worktreeId)
              return (
                <div key={group.worktreeId} data-testid={`sidebar-worktree-${group.worktreeId}`}>
                  <div className="group/wt flex h-5 items-center gap-1 px-1 font-mono text-[7.5px] text-muted-foreground">
                    <button
                      type="button"
                      className="flex h-full min-w-0 flex-1 items-center gap-1 text-left hover:text-foreground focus-visible:text-foreground"
                      aria-expanded={!collapsed}
                      aria-label={group.branch}
                      data-testid={`sidebar-worktree-toggle-${group.worktreeId}`}
                      onClick={() => toggleWorktreeCollapsed(group.worktreeId)}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        setWorktreeMenu({
                          repo,
                          group,
                          x: event.clientX,
                          y: event.clientY,
                          returnFocus: event.currentTarget
                        })
                      }}
                    >
                      <ChevronRight
                        size={8}
                        className={`shrink-0 transition-transform ${collapsed ? '' : 'rotate-90'}`}
                      />
                      <GitBranch size={8} className="shrink-0" />
                      <span className="min-w-0 flex-1 truncate" title={group.path}>
                        {group.branch}
                      </span>
                      <span>{group.sessions.length}</span>
                    </button>
                    <button
                      type="button"
                      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-0 hover:bg-muted hover:text-foreground focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-30 group-hover/wt:opacity-100 group-hover/wt:disabled:opacity-30"
                      aria-label={t('sidebar.newSessionHere')}
                      title={
                        canAdd
                          ? t('sidebar.newSessionHere')
                          : t('newSession.worktreeUnavailable')
                      }
                      disabled={!canAdd}
                      data-testid={`sidebar-worktree-new-session-${group.worktreeId}`}
                      onClick={() => onNewSessionInWorktree(repo.id, group.worktreeId)}
                    >
                      <Plus size={9} />
                    </button>
                  </div>
                  {collapsed ? null : (
                    <div className="pl-1">{group.sessions.map(sessionRow)}</div>
                  )}
                </div>
              )
            })}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <>
    <aside
      ref={asideRef}
      className="workspace-sidebar flex h-full shrink-0 flex-col border-r border-border bg-card"
      style={{ width: `${String(width)}px`, maxWidth: '85vw' }}
      aria-label={t('sidebar.workspace')}
      data-testid="workspace-sidebar"
      data-width={width}
      data-compact={compactHeader ? 'true' : 'false'}
    >
      <div
        className="icode-titlebar flex h-12 shrink-0 items-center gap-1 border-b border-border px-2"
        style={{ paddingLeft: sidebarBrandInset(platform) + 8 }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 px-1 py-1" data-testid="sidebar-brand">
          <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-brand/15 text-brand">
            <TerminalSquare size={13} />
          </span>
          <span className="min-w-0 leading-none">
            <span className="block truncate text-[12px] font-semibold tracking-tight">
              <span className="text-brand">i</span>Code
            </span>
            <span className="mt-0.5 block text-[8px] uppercase tracking-[0.14em] text-muted-foreground">
              Workbench
            </span>
          </span>
        </div>
        <button
          type="button"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onOpenSearch}
          aria-label={t('topbar.searchTitle', { shortcut: shortcutLabel('K', platform) })}
          title={t('topbar.searchTitle', { shortcut: shortcutLabel('K', platform) })}
          data-testid="global-search"
        >
          <Search size={13} />
        </button>
        <button
          type="button"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={(event) =>
            setNewMenu({
              anchor: menuAnchor(event.currentTarget),
              returnFocus: event.currentTarget,
              opener: event.currentTarget
            })
          }
          aria-label={t('sidebar.newWork')}
          title={t('sidebar.newWork')}
          data-testid="sidebar-new-menu"
        >
          <Plus size={14} />
        </button>
        <button
          type="button"
          className="relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onOpenNotifications}
          aria-label={t('topbar.notificationsActivity')}
          title={t('topbar.notificationsActivity')}
          data-testid="needs-you-bell"
          data-count={attention}
        >
          <Bell size={13} />
          {attention > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 min-w-3 rounded-full bg-signal px-1 text-center text-[8px] font-semibold leading-3 text-signal-ink">
              {attention > 9 ? '9+' : attention}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          className="workspace-sidebar-refresh inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onRefresh}
          aria-label={t('status.refreshTitle')}
          title={t('status.refreshTitle')}
          data-testid="sidebar-refresh"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {pinned.length + pinnedSessions.length + pinnedTasks.length > 0 ? (
          <section aria-label={t('sidebar.pinned')} data-testid="sidebar-pinned">
            <div className="flex h-7 items-center gap-1 px-1 font-mono text-[8px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              <Pin size={9} />
              {t('sidebar.pinned')}
            </div>
            <div className="space-y-0.5">
              {pinned.map((repo) => projectRow(repo, true, true))}
              {pinnedSessions.map((session) => {
                const repo = repos.find((entry) => entry.id === session.repoId)
                const active = session.id === activeSessionId
                const menuOpen = sessionMenu?.session.id === session.id
                return (
                  <div
                    key={`pin-session-${session.id}`}
                    className={`flex min-h-7 items-center rounded-md ${menuOpen ? 'bg-hover' : ''}`}
                    data-menu-open={menuOpen ? 'true' : undefined}
                  >
                    <button
                      type="button"
                      className={`flex min-h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left ${
                        active ? 'bg-sel text-foreground' : 'text-muted-foreground hover:bg-hover hover:text-foreground'
                      }`}
                      onClick={() => onOpenSession(session.id)}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        requestSessionMenu(session, {
                          x: event.clientX,
                          y: event.clientY,
                          returnFocus: event.currentTarget
                        })
                      }}
                      onKeyDown={(event) =>
                        openRowMenuFromKey(event, (anchor) =>
                          requestSessionMenu(session, { anchor, returnFocus: event.currentTarget })
                        )
                      }
                      aria-haspopup="menu"
                      aria-expanded={menuOpen}
                      title={session.title}
                      data-testid={`pinned-session-${session.id}`}
                      data-session-pending={pendingFor(session) ?? ''}
                    >
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${sessionStateDotClass(session, pendingFor(session))}`}
                      />
                      <span className="min-w-0 flex-1 truncate text-[10px]">{session.title}</span>
                      <span className="max-w-[110px] shrink-0 truncate font-mono text-[7.5px] text-muted-foreground">
                        {repo?.displayName ?? session.repoId}
                        {session.worktree ? ` / ${session.worktree.branch.split('/').pop()}` : ''}
                      </span>
                    </button>
                  </div>
                )
              })}
              {pinnedTasks.map((task) => {
                const repo = repos.find((entry) => entry.id === task.repoId)
                const active = task.id === activeTaskId
                const menuOpen = taskMenu?.task.id === task.id
                return (
                  <div
                    key={`pin-task-${task.id}`}
                    className={`flex min-h-7 items-center rounded-md ${menuOpen ? 'bg-hover' : ''}`}
                    data-menu-open={menuOpen ? 'true' : undefined}
                  >
                    <button
                      type="button"
                      className={`flex min-h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left ${
                        active ? 'bg-sel text-foreground' : 'text-muted-foreground hover:bg-hover hover:text-foreground'
                      }`}
                      onClick={() => onOpenTask(task)}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        requestTaskMenu(task, {
                          x: event.clientX,
                          y: event.clientY,
                          returnFocus: event.currentTarget
                        })
                      }}
                      onKeyDown={(event) =>
                        openRowMenuFromKey(event, (anchor) =>
                          requestTaskMenu(task, { anchor, returnFocus: event.currentTarget })
                        )
                      }
                      aria-haspopup="menu"
                      aria-expanded={menuOpen}
                      title={task.title}
                      data-testid={`pinned-task-${task.id}`}
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${taskDotClass(task)}`} />
                      <span className="min-w-0 flex-1 truncate text-[10px]">{task.title}</span>
                      <span className="max-w-[110px] shrink-0 truncate font-mono text-[7.5px] text-muted-foreground">
                        {repo?.displayName ?? task.repoId}
                      </span>
                    </button>
                  </div>
                )
              })}
            </div>
          </section>
        ) : null}

        <section aria-label={t('sidebar.projects')} data-testid="sidebar-projects" className="mt-1">
          <div className="flex h-7 items-center gap-1 px-1">
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1 font-mono text-[8px] font-semibold uppercase tracking-[0.1em] text-muted-foreground hover:text-foreground"
              onClick={() => setProjectsCollapsed((current) => !current)}
              aria-expanded={!projectsCollapsed}
              data-testid="sidebar-projects-toggle"
            >
              <ChevronRight
                size={9}
                className={projectsCollapsed ? '' : 'rotate-90'}
              />
              {t('sidebar.projects')}
              <span className="text-muted-foreground/70">{repos.length}</span>
            </button>
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={onAddProject}
              aria-label={t('projects.addProject')}
              title={t('projects.addProject')}
              data-testid="sidebar-add-project"
            >
              <Plus size={11} />
            </button>
          </div>
          {!projectsCollapsed ? (
            <div className="space-y-0.5" data-testid="sidebar-project-rows">
              {repos.length === 0 ? (
                <button
                  type="button"
                  className="w-full rounded-md px-2 py-2 text-left text-[10px] leading-relaxed text-muted-foreground hover:bg-hover hover:text-foreground"
                  onClick={onAddProject}
                  data-testid="sidebar-empty-add-project"
                >
                  {t('projects.empty.title')}
                </button>
              ) : (
                repos.map((repo) => projectRow(repo, false))
              )}
            </div>
          ) : null}
        </section>
      </div>

      <section
        className="flex max-h-[38%] min-h-0 shrink-0 flex-col border-t border-border px-2 pb-2 pt-1"
        aria-label={t('sidebar.tasks')}
        data-testid="sidebar-tasks"
      >
        <div className="flex h-7 shrink-0 items-center gap-1 px-1">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1 font-mono text-[8px] font-semibold uppercase tracking-[0.1em] text-muted-foreground hover:text-foreground"
            onClick={() => setTasksCollapsed((current) => !current)}
            aria-expanded={!tasksCollapsed}
            data-testid="sidebar-tasks-toggle"
          >
            <ChevronRight size={9} className={tasksCollapsed ? '' : 'rotate-90'} />
            {t('sidebar.tasks')}
            <span className="text-muted-foreground/70">
              {tasksHistory ? archivedTasks.length : tasks.length}
            </span>
            {attention > 0 ? (
              <span className="inline-flex items-center gap-1 text-signal" data-testid="sidebar-tasks-needs">
                <span className="h-1 w-1 rounded-full bg-signal" />
                {attention}
              </span>
            ) : null}
          </button>
          <button
            type="button"
            className={`inline-flex h-6 w-6 items-center justify-center rounded hover:bg-muted ${
              tasksHistory ? 'text-accent' : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setTasksHistory((current) => !current)}
            aria-pressed={tasksHistory}
            aria-label={t('tasks.history')}
            title={t('tasks.history')}
            data-testid="sidebar-tasks-history"
          >
            <History size={10} />
          </button>
          <button
            type="button"
            className={`inline-flex h-6 w-6 items-center justify-center rounded hover:bg-muted ${
              tasksNeedsOnly ? 'text-signal' : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => {
              if (!tasksHistory) setTasksNeedsOnly((current) => !current)
            }}
            disabled={tasksHistory}
            aria-pressed={tasksNeedsOnly}
            aria-label={t('sidebar.tasksFilter')}
            title={t('sidebar.tasksFilter')}
            data-testid="sidebar-tasks-filter"
          >
            <Filter size={10} />
          </button>
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onQueueTask}
            aria-label={t('topbar.queueTask')}
            title={t('topbar.queueTask')}
            data-testid="sidebar-queue-task"
          >
            <Plus size={11} />
          </button>
        </div>

        {!tasksCollapsed ? (
          <div className="min-h-0 flex-1 overflow-y-auto" data-testid="sidebar-task-rows">
            {taskGroups.length === 0 ? (
              <p className="px-2 py-2 text-[10px] leading-relaxed text-muted-foreground">
                {tasksHistory
                  ? t('tasks.emptyHistory')
                  : tasksNeedsOnly
                    ? t('tasks.emptyNeeds')
                    : t('tasks.empty')}
              </p>
            ) : (
              taskGroups.map((group) => (
                <div key={group.repo.id} className="mb-1" data-testid={`sidebar-task-group-${group.repo.id}`}>
                  <div className="flex h-5 items-center gap-1 px-1 font-mono text-[7.5px] uppercase tracking-[0.08em] text-muted-foreground">
                    <span className="min-w-0 flex-1 truncate">{group.repo.displayName}</span>
                    <span>{group.tasks.length}</span>
                  </div>
                  {group.tasks.map((task) => {
                    const active = task.id === activeTaskId
                    const menuOpen = taskMenu?.task.id === task.id
                    return (
                      <div
                        key={task.id}
                        className={`flex min-h-7 items-center rounded-md ${menuOpen ? 'bg-hover' : ''}`}
                        data-menu-open={menuOpen ? 'true' : undefined}
                      >
                        <button
                          type="button"
                          className={`flex min-h-7 min-w-0 flex-1 items-start gap-1.5 rounded-md px-1.5 py-1 text-left ${
                            active ? 'bg-sel text-foreground shadow-[inset_2px_0_0_var(--icode-accent)]' : 'text-muted-foreground hover:bg-hover hover:text-foreground'
                          }`}
                          onClick={() => onOpenTask(task)}
                          onContextMenu={(event) => {
                            event.preventDefault()
                            requestTaskMenu(task, {
                              x: event.clientX,
                              y: event.clientY,
                              returnFocus: event.currentTarget
                            })
                          }}
                          onKeyDown={(event) =>
                            openRowMenuFromKey(event, (anchor) =>
                              requestTaskMenu(task, {
                                anchor,
                                returnFocus: event.currentTarget
                              })
                            )
                          }
                          aria-haspopup="menu"
                          aria-expanded={menuOpen}
                          title={task.title}
                          data-testid={`sidebar-task-${task.id}`}
                          aria-current={active ? 'true' : undefined}
                        >
                          <span
                            className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${taskDotClass(task)}`}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[10px]">{task.title}</span>
                            <span className="block truncate font-mono text-[7.5px] text-muted-foreground">
                              {taskStatusLabel(task)}
                              {task.attempt ? ` · ${t('task.attempt', { count: task.attempt })}` : ''}
                            </span>
                          </span>
                        </button>
                      </div>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        ) : null}
      </section>

      {footerStatus ?? null}

      <footer className="flex shrink-0 items-center gap-1 border-t border-border px-2 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onOpenAssistant}
          data-testid="sidebar-mira"
        >
          <AssistantAvatar name={assistantName} status={assistantStatus} size="sm" />
          <span className="min-w-0 flex-1 truncate text-[10.5px]">{assistantName}</span>
          {assistantUnread > 0 ? (
            <span className="rounded-full bg-signal-weak px-1 text-[8px] font-medium text-signal">
              {assistantUnread > 9 ? '9+' : assistantUnread}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onOpenSettings}
          aria-label={t('settings.title')}
          title={t('settings.title')}
          data-testid="sidebar-settings"
        >
          <Settings size={13} />
        </button>
      </footer>

      <WorkspaceSidebarDialogs
        projectMenu={
          projectMenu === null
            ? null
            : {
                items: menuItems.project(projectMenu.repo),
                ariaLabel: t('projects.row.actionsAria', {
                  name: projectMenu.repo.displayName
                }),
                testId: 'sidebar-project-menu',
                width: 228,
                x: projectMenu.x,
                y: projectMenu.y,
                anchor: projectMenu.anchor,
                align: 'start',
                returnFocus: projectMenu.returnFocus,
                opener: projectMenu.opener,
                onClose: () => setProjectMenu(null)
              }
        }
        worktreeMenu={
          worktreeMenu === null
            ? null
            : {
                items: menuItems.worktree(worktreeMenu),
                ariaLabel: t('sidebar.worktreeMenu'),
                testId: 'sidebar-worktree-menu',
                width: 208,
                x: worktreeMenu.x,
                y: worktreeMenu.y,
                returnFocus: worktreeMenu.returnFocus,
                onClose: () => setWorktreeMenu(null)
              }
        }
        taskMenu={
          taskMenu === null
            ? null
            : {
                items: menuItems.task(taskMenu.task),
                ariaLabel: t('task.actions'),
                testId: 'sidebar-task-menu',
                width: 208,
                x: taskMenu.x,
                y: taskMenu.y,
                anchor: taskMenu.anchor,
                align: 'start',
                returnFocus: taskMenu.returnFocus,
                onClose: () => setTaskMenu(null)
              }
        }
        sessionMenu={
          sessionMenu === null
            ? null
            : {
                items: menuItems.session(sessionMenu.session),
                ariaLabel: t('session.actions'),
                testId: 'sidebar-session-menu',
                width: 208,
                x: sessionMenu.x,
                y: sessionMenu.y,
                anchor: sessionMenu.anchor,
                align: 'start',
                returnFocus: sessionMenu.returnFocus,
                onClose: () => setSessionMenu(null)
              }
        }
        newMenu={
          newMenu === null
            ? null
            : {
                items: menuItems.newWork(),
                ariaLabel: t('sidebar.newWork'),
                testId: 'sidebar-new-work-menu',
                width: 208,
                anchor: newMenu.anchor,
                returnFocus: newMenu.returnFocus,
                opener: newMenu.opener,
                onClose: () => setNewMenu(null)
              }
        }
        maintenance={
          maintenanceRepo === null
            ? null
            : {
                repo: maintenanceRepo,
                branches,
                orphans,
                onRemoveBranch,
                onClose: () => setMaintenanceRepo(null)
              }
        }
        repositorySettings={
          settingsRepo === null
            ? null
            : {
                repoId: settingsRepo.id,
                repoName: settingsRepo.displayName,
                onClose: () => setSettingsRepo(null)
              }
        }
        removeRepository={
          removeRepo === null
            ? null
            : {
                repo: removeRepo,
                sessionCount: removalImpact(removeRepo.id).sessions,
                worktreeCount: removalImpact(removeRepo.id).worktrees,
                onClose: () => setRemoveRepo(null),
                onConfirm: () => {
                  const repoId = removeRepo.id
                  setRemoveRepo(null)
                  onRemoveRepository(repoId)
                }
              }
        }
        details={
          detailsSession === null
            ? null
            : {
                session: detailsSession,
                repo: repos.find((repo) => repo.id === detailsSession.repoId) ?? null,
                notify: onNotify,
                onClose: () => setDetailsSession(null)
              }
        }
        sleep={
          sleepSession === null
            ? null
            : {
                session: sleepSession,
                onClose: () => setSleepSession(null),
                onConfirm: () => {
                  const sessionId = sleepSession.id
                  setSleepSession(null)
                  sessionActions.sleep(sessionId)
                }
              }
        }
        removeSession={
          removeSession === null
            ? null
            : {
                session: removeSession,
                sessions,
                onClose: () => setRemoveSession(null),
                onConfirm: () => {
                  const sessionId = removeSession.id
                  setRemoveSession(null)
                  sessionActions.remove(sessionId)
                }
              }
        }
      />
    </aside>
    <div
      ref={resizerRef}
      role="separator"
      aria-orientation="vertical"
      aria-label={t('sidebar.resize')}
      aria-valuemin={SIDEBAR_WIDTH_MIN}
      aria-valuemax={SIDEBAR_WIDTH_MAX}
      aria-valuenow={width}
      title={t('sidebar.resize')}
      tabIndex={0}
      className="w-1.5 shrink-0 cursor-col-resize bg-transparent hover:bg-accent/40 focus-visible:bg-signal focus-visible:outline-none max-[900px]:hidden"
      data-testid="sidebar-resizer"
      {...handleProps}
      onDoubleClick={() => persistWidth(SIDEBAR_WIDTH_DEFAULT)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          persistWidth(widthRef.current - 16)
        } else if (event.key === 'ArrowRight') {
          event.preventDefault()
          persistWidth(widthRef.current + 16)
        }
      }}
    />
    </>
  )
}
