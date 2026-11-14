import { useEffect, useMemo, useState } from 'react'
import {
  Bell,
  ChevronRight,
  Copy,
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
import type { Notice } from '../../state/workspace'
import ContextMenu, { type ContextMenuItem, type MenuAnchor } from '../ContextMenu'
import ProjectMaintenanceDialog from '../sessions/ProjectMaintenanceDialog'
import AssistantAvatar from '../AssistantAvatar'
import { repositoryPreparationView } from '../../lib/repository-preparation'
import { shortcutLabel } from '../../lib/platform'
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
  pinnedProjectsFirst
} from './sidebar-model'
import { sidebarBrandInset } from './window-chrome'
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
  assistantName: string
  assistantUnread: number
  assistantStatus: 'working' | 'idle' | 'offline' | 'error'
  hostUnreachable: boolean
  platform: string | null
  onOpenProject: (repoId: string, mode?: 'sessions' | 'tasks') => void
  onOpenSession: (sessionId: string) => void
  onOpenTask: (task: TaskRecordPayload) => void
  onNewSession: () => void
  onNewSessionInRepo: (repoId: string) => void
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
  assistantName,
  assistantUnread,
  assistantStatus,
  hostUnreachable,
  platform,
  onOpenProject,
  onOpenSession,
  onOpenTask,
  onNewSession,
  onNewSessionInRepo,
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
  const [pins, setPins] = useState<SidebarPins>(() => readSidebarPins())
  const [projectsCollapsed, setProjectsCollapsed] = useState(false)
  const [tasksCollapsed, setTasksCollapsed] = useState(false)
  const [tasksNeedsOnly, setTasksNeedsOnly] = useState(false)
  const [tasksHistory, setTasksHistory] = useState(false)
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(() => new Set())
  const [maintenanceRepo, setMaintenanceRepo] = useState<RepositorySummary | null>(null)
  const [projectMenu, setProjectMenu] = useState<ProjectMenuRequest | null>(null)
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
  const toggleSessionPin = (sessionId: string): void => {
    updatePins((current) => ({ ...current, sessions: togglePin(current.sessions, sessionId) }))
  }
  const toggleTaskPin = (taskId: string): void => {
    updatePins((current) => ({ ...current, tasks: togglePin(current.tasks, taskId) }))
  }

  const projectMenuItems = (repo: RepositorySummary): ContextMenuItem[] => {
    const preparation = repositoryPreparationView(repo)
    return [
      {
        id: 'open-sessions',
        label: t('projectHeader.sessions'),
        icon: <TerminalSquare size={12} />,
        testId: `sidebar-project-${repo.id}-sessions`,
        onSelect: () => onOpenProject(repo.id, 'sessions')
      },
      {
        id: 'open-tasks',
        label: t('projectHeader.tasks'),
        icon: <FolderGit2 size={12} />,
        testId: `sidebar-project-${repo.id}-tasks`,
        onSelect: () => onOpenProject(repo.id, 'tasks')
      },
      {
        id: 'new-session',
        label: t('sessions.newSession'),
        icon: <TerminalSquare size={12} />,
        onSelect: () => onNewSessionInRepo(repo.id)
      },
      {
        id: 'queue-task',
        label: t('topbar.queueTask'),
        separatorBefore: true,
        onSelect: () => onQueueTaskInRepo(repo.id)
      },
      {
        id: 'pin',
        label: pins.projects.includes(repo.id)
          ? t('projects.row.unpin')
          : t('projects.row.pin'),
        icon: <Pin size={12} />,
        testId: `pin-project-${repo.id}`,
        onSelect: () => toggleProjectPin(repo.id)
      },
      {
        id: 'copy-path',
        label: t('projects.menu.copyPath'),
        icon: <Copy size={12} />,
        onSelect: () => {
          const write = navigator.clipboard?.writeText(repo.path)
          if (write === undefined) return
          void write.then(
            () => onNotify({ tone: 'success', message: t('projects.menu.copyPath') }),
            () => undefined
          )
        }
      },
      ...(preparation?.kind === 'failed'
        ? [
            {
              id: 'retry',
              label: t('projects.menu.retry'),
              icon: <RefreshCw size={12} />,
              onSelect: () => onRetryPreparation(repo.id)
            } satisfies ContextMenuItem
          ]
        : []),
      {
        id: 'maintenance',
        label: t('sidebar.maintenance'),
        icon: <GitBranch size={12} />,
        separatorBefore: true,
        testId: 'project-maintenance-open',
        onSelect: () => setMaintenanceRepo(repo)
      },
      {
        id: 'remove',
        label: t('projects.menu.remove'),
        danger: true,
        separatorBefore: true,
        testId: `repository-remove-${repo.id}`,
        onSelect: () => onRemoveRepository(repo.id)
      }
    ]
  }

  const requestProjectMenu = (
    repo: RepositorySummary,
    request: Omit<ProjectMenuRequest, 'repo'>
  ): void => setProjectMenu({ repo, ...request })

  const newMenuItems: ContextMenuItem[] = [
    {
      id: 'new-session',
      label: t('sessions.newSession'),
      icon: <TerminalSquare size={12} />,
      testId: 'new-session-open',
      disabled: hostUnreachable,
      reason: hostUnreachable ? t('topbar.hostUnreachable') : undefined,
      onSelect: onNewSession
    },
    {
      id: 'queue-task',
      label: t('topbar.queueTask'),
      testId: 'queue-task-open',
      onSelect: onQueueTask
    },
    {
      id: 'add-project',
      label: t('projects.addProject'),
      icon: <Plus size={12} />,
      separatorBefore: true,
      testId: 'add-project',
      onSelect: onAddProject
    },
    {
      id: 'schedules',
      label: t('rail.schedules'),
      testId: 'schedules-open',
      onSelect: onOpenSchedules
    }
  ]

  const sessionRow = (session: SessionSummary): React.JSX.Element => {
    const active = session.id === activeSessionId
    const pinned = pins.sessions.includes(session.id)
    const suffix = activitySuffix(session.activity)
    return (
      <div key={session.id} className="group/session flex min-h-7 items-center rounded-md">
        <button
          type="button"
          className={`flex min-h-7 min-w-0 flex-1 items-start gap-1.5 rounded-md px-1.5 py-1 text-left ${
            active
              ? 'bg-sel text-foreground shadow-[inset_2px_0_0_var(--icode-accent)]'
              : 'text-muted-foreground hover:bg-hover hover:text-foreground'
          }`}
          onClick={() => onOpenSession(session.id)}
          aria-current={active ? 'true' : undefined}
          title={session.title}
          data-testid={`session-item-${session.id}`}
          data-session-id={session.id}
          data-session-state={session.state}
          data-session-role={session.role}
          data-session-sleeping={String(session.sleeping === true)}
          data-session-incarnation={session.incarnationId ?? ''}
          data-session-activity={session.activity?.state ?? 'unknown'}
          data-session-activity-unread={String(session.activity?.unread ?? false)}
          data-active={active ? 'true' : 'false'}
        >
          <span
            className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${sessionStateDotClass(session, null)}`}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[10px]">{session.title}</span>
            <span className="block truncate font-mono text-[7.5px] text-muted-foreground">
              {sessionStateLabelFor(session, null)}
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
        <button
          type="button"
          className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground ${
            pinned ? 'text-accent opacity-100' : 'opacity-0 focus-visible:opacity-100 group-hover/session:opacity-100'
          }`}
          onClick={() => toggleSessionPin(session.id)}
          aria-label={t(pinned ? 'projects.row.unpinAria' : 'projects.row.pinAria', {
            name: session.title
          })}
          title={t(pinned ? 'projects.row.unpin' : 'projects.row.pin')}
          data-testid={`session-pin-${session.id}`}
        >
          <Pin size={9} />
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
    if (compact) {
      return (
        <div key={`pin-${repo.id}`} className="flex h-7 min-w-0 items-center rounded-md">
          <button
            type="button"
            className={`flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left text-[10px] ${
              isActive
                ? 'bg-sel text-foreground'
                : 'text-muted-foreground hover:bg-hover hover:text-foreground'
            }`}
            onClick={() => onOpenProject(repo.id, 'sessions')}
            onContextMenu={(event) => {
              event.preventDefault()
              requestProjectMenu(repo, {
                x: event.clientX,
                y: event.clientY,
                returnFocus: event.currentTarget
              })
            }}
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
            <Pin size={9} className="shrink-0 text-accent" />
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
              : 'text-muted-foreground hover:bg-hover hover:text-foreground'
          }`}
          data-testid={`sidebar-project-${repo.id}`}
          data-active={isActive ? 'true' : 'false'}
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
            onContextMenu={(event) => {
              event.preventDefault()
              requestProjectMenu(repo, {
                x: event.clientX,
                y: event.clientY,
                returnFocus: event.currentTarget
              })
            }}
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
            aria-label={t('sidebar.projectMenu')}
            title={t('sidebar.projectMenu')}
            data-testid={`sidebar-project-menu-${repo.id}`}
            onClick={(event) => {
              event.stopPropagation()
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
            {groups.worktrees.map((group) => (
              <div key={group.branch}>
                <div className="flex h-5 items-center gap-1 px-1 font-mono text-[7.5px] text-muted-foreground">
                  <GitBranch size={8} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{group.branch}</span>
                  <span>{group.sessions.length}</span>
                </div>
                <div className="pl-1">{group.sessions.map(sessionRow)}</div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <aside
      className="flex h-full w-[300px] shrink-0 flex-col border-r border-border bg-card"
      aria-label={t('sidebar.workspace')}
      data-testid="workspace-sidebar"
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
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
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
                return (
                  <div key={`pin-session-${session.id}`} className="group/pin flex min-h-7 items-center rounded-md">
                    <button
                      type="button"
                      className={`flex min-h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left ${
                        active ? 'bg-sel text-foreground' : 'text-muted-foreground hover:bg-hover hover:text-foreground'
                      }`}
                      onClick={() => onOpenSession(session.id)}
                      title={session.title}
                      data-testid={`pinned-session-${session.id}`}
                    >
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${sessionStateDotClass(session, null)}`}
                      />
                      <span className="min-w-0 flex-1 truncate text-[10px]">{session.title}</span>
                      <span className="max-w-[110px] shrink-0 truncate font-mono text-[7.5px] text-muted-foreground">
                        {repo?.displayName ?? session.repoId}
                        {session.worktree ? ` / ${session.worktree.branch.split('/').pop()}` : ''}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-accent hover:bg-muted"
                      onClick={() => toggleSessionPin(session.id)}
                      aria-label={t('projects.row.unpinAria', { name: session.title })}
                      title={t('projects.row.unpin')}
                    >
                      <Pin size={9} />
                    </button>
                  </div>
                )
              })}
              {pinnedTasks.map((task) => {
                const repo = repos.find((entry) => entry.id === task.repoId)
                const active = task.id === activeTaskId
                return (
                  <div key={`pin-task-${task.id}`} className="group/pin flex min-h-7 items-center rounded-md">
                    <button
                      type="button"
                      className={`flex min-h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left ${
                        active ? 'bg-sel text-foreground' : 'text-muted-foreground hover:bg-hover hover:text-foreground'
                      }`}
                      onClick={() => onOpenTask(task)}
                      title={task.title}
                      data-testid={`pinned-task-${task.id}`}
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${taskDotClass(task)}`} />
                      <span className="min-w-0 flex-1 truncate text-[10px]">{task.title}</span>
                      <span className="max-w-[110px] shrink-0 truncate font-mono text-[7.5px] text-muted-foreground">
                        {repo?.displayName ?? task.repoId}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-accent hover:bg-muted"
                      onClick={() => toggleTaskPin(task.id)}
                      aria-label={t('projects.row.unpinAria', { name: task.title })}
                      title={t('projects.row.unpin')}
                    >
                      <Pin size={9} />
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
                    const pinned = pins.tasks.includes(task.id)
                    return (
                      <div key={task.id} className="group/task flex min-h-7 items-center rounded-md">
                        <button
                          type="button"
                          className={`flex min-h-7 min-w-0 flex-1 items-start gap-1.5 rounded-md px-1.5 py-1 text-left ${
                            active ? 'bg-sel text-foreground shadow-[inset_2px_0_0_var(--icode-accent)]' : 'text-muted-foreground hover:bg-hover hover:text-foreground'
                          }`}
                          onClick={() => onOpenTask(task)}
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
                        <button
                          type="button"
                          className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground ${
                            pinned ? 'text-accent opacity-100' : 'opacity-0 focus-visible:opacity-100 group-hover/task:opacity-100'
                          }`}
                          onClick={() => toggleTaskPin(task.id)}
                          aria-label={t(pinned ? 'projects.row.unpinAria' : 'projects.row.pinAria', {
                            name: task.title
                          })}
                          title={t(pinned ? 'projects.row.unpin' : 'projects.row.pin')}
                          data-testid={`task-pin-${task.id}`}
                        >
                          <Pin size={9} />
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

      {projectMenu !== null ? (
        <ContextMenu
          items={projectMenuItems(projectMenu.repo)}
          ariaLabel={t('sidebar.projectMenu')}
          testId="sidebar-project-menu"
          width={228}
          x={projectMenu.x}
          y={projectMenu.y}
          anchor={projectMenu.anchor}
          align="start"
          returnFocus={projectMenu.returnFocus}
          opener={projectMenu.opener}
          onClose={() => setProjectMenu(null)}
        />
      ) : null}
      {newMenu !== null ? (
        <ContextMenu
          items={newMenuItems}
          ariaLabel={t('sidebar.newWork')}
          testId="sidebar-new-work-menu"
          width={208}
          anchor={newMenu.anchor}
          returnFocus={newMenu.returnFocus}
          opener={newMenu.opener}
          onClose={() => setNewMenu(null)}
        />
      ) : null}
      {maintenanceRepo !== null ? (
        <ProjectMaintenanceDialog
          repo={maintenanceRepo}
          branches={branches}
          orphans={orphans}
          onRemoveBranch={onRemoveBranch}
          onClose={() => setMaintenanceRepo(null)}
        />
      ) : null}
    </aside>
  )
}
