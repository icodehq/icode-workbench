import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Bell,
  ChevronRight,
  Folder,
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
import { isActiveSessionState } from '../../../../shared/domain/session'
import { isAgentHarness } from '../../../../shared/domain/harness'
import { openFilesStore } from '../../files/open-files'
import type { Notice, PendingAction } from '../../state/workspace'
import type { SidebarSessionActions, WorktreeRemovalOptions } from '../../state/session-actions'
import type { WorktreeRemovalOutcome } from '../../state/use-workspace'
import type { MenuAnchor } from '../ContextMenu'
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
  groupDirectSessions,
  pinnedProjectsFirst,
  repositoryRemovalImpact,
  type WorktreeSessionGroup
} from './sidebar-model'
import {
  moveRowId,
  orderByStoredIds,
  pruneSidebarOrder,
  sessionGroupKey,
  PROJECTS_GROUP_KEY,
  SIDEBAR_ROW_DRAG_TYPE,
  type SidebarDragSource,
  type SidebarDropTarget,
  type SidebarKnownRows
} from './sidebar-order'
import { emptySidebarOrder, type SidebarOrderPayload } from '../../../../shared/schemas/sidebar-order'
import WorkspaceSidebarDialogs from './WorkspaceSidebarDialogs'
import { createSidebarMenuItems } from './sidebar-menu-items'
import { sidebarBrandInset } from './window-chrome'
import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  clampSidebarWidth,
  loadSidebarWidth,
  saveSidebarWidth,
} from '../../state/sidebar-layout'
import { usePanelResize } from '../../lib/use-panel-resize'
import { toggleProjectExpanded, useExpandedProjectIds } from '../../state/sidebar-expansion'
import {
  activityDotClass,
  activitySuffix,
  activityTone,
  sessionStateDotClass,
  sessionStateLabelFor,
  subagentDotClass,
  subagentTone,
  visibleSubagents
} from '../status'
import { useT } from '../../i18n/use-i18n'

type Props = {
  repos: RepositorySummary[]
  sessions: SessionSummary[]
  tasks: TaskRecordPayload[]
  archivedTasks: TaskRecordPayload[]
  activeRepoId: string | null
  activeSessionId: string | null
  branches: OwnedBranchSummary[]
  orphans: OrphanedHostSession[]
  /** Per-session in-flight action, so the row and its menu match the header. */
  pending: Record<string, PendingAction>
  botsUnread: number
  hostUnreachable: boolean
  platform: string | null
  onOpenProject: (repoId: string, mode?: 'sessions' | 'tasks') => void
  onOpenSession: (sessionId: string) => void
  sessionActions: SidebarSessionActions
  /** Remove a worktree checkout and every session attached to it. */
  onRemoveWorktree: (
    worktreeId: string,
    options?: WorktreeRemovalOptions
  ) => Promise<WorktreeRemovalOutcome>
  /** Name-confirmed force removal for a blocked worktree. */
  onDiscardWorktree: (
    worktreeId: string,
    confirmBranch: string,
    options?: WorktreeRemovalOptions
  ) => Promise<boolean>
  onNewSession: () => void
  onNewSessionInRepo: (repoId: string) => void
  /** Start a session in the project's shared primary checkout. */
  onNewSessionInDefaultCheckout: (repoId: string) => void
  /** Start another session in an existing worktree, from its sidebar group. */
  onNewSessionInWorktree: (repoId: string, worktreeId: string) => void
  /** Re-create a missing checkout from its retained branch. */
  onQueueTask: () => void
  onQueueTaskInRepo: (repoId: string) => void
  onAddProject: () => void
  onOpenSchedules: () => void
  onOpenSettings: () => void
  onOpenSearch: () => void
  onOpenHistory: () => void
  onOpenNotifications: () => void
  onRefresh: () => void
  onRetryPreparation: (repoId: string) => void
  onRemoveRepository: (repoId: string) => void
  onRemoveBranch: (branch: string) => void
  onNotify: (notice: Notice) => void
  /** The Bots roster, embedded above Projects. */
  botsSection?: ReactNode
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

type CheckoutMenuRequest = RowMenuRequest & {
  repo: RepositorySummary
  /** null is the repository's shared primary checkout row. */
  group: WorktreeSessionGroup | null
}

type SessionMenuRequest = RowMenuRequest & { session: SessionSummary }

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
  branches,
  orphans,
  pending,
  botsUnread,
  hostUnreachable,
  platform,
  onOpenProject,
  onOpenSession,
  sessionActions,
  onRemoveWorktree,
  onDiscardWorktree,
  onNewSession,
  onNewSessionInRepo,
  onNewSessionInDefaultCheckout,
  onNewSessionInWorktree,
  onQueueTask,
  onQueueTaskInRepo,
  onAddProject,
  onOpenSchedules,
  onOpenSettings,
  onOpenSearch,
  onOpenHistory,
  onOpenNotifications,
  onRefresh,
  onRetryPreparation,
  onRemoveRepository,
  onRemoveBranch,
  onNotify,
  botsSection,
  footerStatus
}: Props): React.JSX.Element {
  const t = useT()
  const [width, setWidth] = useState<number>(() => loadSidebarWidth())
  // On macOS the traffic lights take the header's leading inset, so the
  // narrowest widths need to drop the refresh verb (the status bar still has
  // one) rather than squeeze the brand into the controls.
  const compactHeader = width < (isMacPlatform(platform) ? 290 : 250)
  const widthRef = useRef(width)
  const asideRef = useRef<HTMLElement | null>(null)
  const resizerRef = useRef<HTMLDivElement | null>(null)
  const [pins, setPins] = useState<SidebarPins>(() => readSidebarPins())
  const [projectsCollapsed, setProjectsCollapsed] = useState(false)
  // Every project starts collapsed; the store survives the focus-mode unmount.
  const expandedRepos = useExpandedProjectIds()
  const [collapsedWorktrees, setCollapsedWorktrees] = useState<Set<string>>(() => new Set())
  const [collapsedDefaultCheckouts, setCollapsedDefaultCheckouts] = useState<Set<string>>(
    () => new Set()
  )
  const [maintenanceRepo, setMaintenanceRepo] = useState<RepositorySummary | null>(null)
  const [settingsRepo, setSettingsRepo] = useState<RepositorySummary | null>(null)
  const [removeRepo, setRemoveRepo] = useState<RepositorySummary | null>(null)
  const [projectMenu, setProjectMenu] = useState<ProjectMenuRequest | null>(null)
  const [checkoutMenu, setCheckoutMenu] = useState<CheckoutMenuRequest | null>(null)
  const [sessionMenu, setSessionMenu] = useState<SessionMenuRequest | null>(null)
  const [detailsSession, setDetailsSession] = useState<SessionSummary | null>(null)
  const [sleepSession, setSleepSession] = useState<SessionSummary | null>(null)
  const [removeSession, setRemoveSession] = useState<SessionSummary | null>(null)
  const [removeWorktree, setRemoveWorktree] = useState<{
    repo: RepositorySummary
    group: WorktreeSessionGroup
  } | null>(null)
  const [newMenu, setNewMenu] = useState<{
    anchor: MenuAnchor
    returnFocus: HTMLElement | null
    opener: HTMLElement | null
  } | null>(null)

  /*
   * Sidebar order is a persisted, per-account preference. The ref is the
   * synchronous read used by drop handlers; state mirrors it for rendering.
   */
  const [rowOrder, setRowOrder] = useState<SidebarOrderPayload>(() => emptySidebarOrder())
  const rowOrderRef = useRef(rowOrder)
  const [dragSource, setDragSource] = useState<SidebarDragSource | null>(null)
  const [dropTarget, setDropTarget] = useState<SidebarDropTarget | null>(null)
  const dragSourceRef = useRef<SidebarDragSource | null>(null)

  const applyRowOrder = (next: SidebarOrderPayload): void => {
    rowOrderRef.current = next
    setRowOrder(next)
  }

  useEffect(() => {
    let cancelled = false
    void window.icode.sidebarOrder
      .get()
      .then((result) => {
        if (!cancelled && result.ok) applyRowOrder(result.value)
      })
      .catch(() => {
        // The order is a preference; a failed read falls back to natural order.
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    setPins((current) => {
      const next = pruneSidebarPins(
        current,
        repos.map((repo) => repo.id),
        sessions.map((session) => session.id),
        []
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
  }, [repos, sessions])

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
      const compact = next < (isMacPlatform(platform) ? 290 : 250)
      const compactText = compact ? 'true' : 'false'
      if (aside.dataset.compact !== compactText) aside.dataset.compact = compactText
      resizerRef.current?.setAttribute('aria-valuenow', widthText)
    },
    onCommit: persistWidth
  })

  const orderedRepos = useMemo(() => {
    const byId = new Map(repos.map((repo) => [repo.id, repo]))
    return orderByStoredIds(
      repos.map((repo) => repo.id),
      rowOrder.projects,
      (id) => id
    ).flatMap((id) => {
      const repo = byId.get(id)
      return repo === undefined ? [] : [repo]
    })
  }, [repos, rowOrder.projects])

  /*
   * Rows that currently exist, grouped exactly as the store keys them. Saving a
   * reorder prunes ids and groups that are gone instead of accumulating them.
   */
  const knownSidebarRows = useMemo<SidebarKnownRows>(() => {
    const worktrees: Record<string, Set<string>> = {}
    const sessionsByGroup: Record<string, Set<string>> = {}
    for (const repo of repos) {
      const repoSessions = sessions.filter((session) => session.repoId === repo.id)
      const groups = groupDirectSessions(repoSessions)
      sessionsByGroup[sessionGroupKey(repo.id, null)] = new Set(
        groups.defaultCheckout.map((session) => session.id)
      )
      const paths = new Set<string>()
      for (const group of groups.worktrees) {
        paths.add(group.path)
        sessionsByGroup[sessionGroupKey(repo.id, group.path)] = new Set(
          group.sessions.map((session) => session.id)
        )
      }
      if (paths.size > 0) worktrees[repo.id] = paths
    }
    return {
      projects: new Set(repos.map((repo) => repo.id)),
      worktrees,
      sessions: sessionsByGroup
    }
  }, [repos, sessions])

  const persistRowOrder = (next: SidebarOrderPayload): void => {
    const pruned = pruneSidebarOrder(next, knownSidebarRows)
    applyRowOrder(pruned)
    void window.icode.sidebarOrder
      .set(pruned)
      .then((result) => {
        if (!result.ok) onNotify({ tone: 'error', message: result.error.message })
      })
      .catch((error: unknown) => {
        onNotify({
          tone: 'error',
          message: error instanceof Error ? error.message : String(error)
        })
      })
  }

  const resetRowDrag = (): void => {
    dragSourceRef.current = null
    setDragSource(null)
    setDropTarget(null)
  }

  const startRowDrag = (event: React.DragEvent, source: SidebarDragSource): void => {
    dragSourceRef.current = source
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(SIDEBAR_ROW_DRAG_TYPE, source.id)
    setDragSource(source)
    setDropTarget(null)
  }

  const rowDragOver = (event: React.DragEvent, target: SidebarDragSource): void => {
    const source = dragSourceRef.current
    if (
      source === null ||
      source.kind !== target.kind ||
      source.groupKey !== target.groupKey ||
      source.id === target.id
    ) {
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    const after = event.clientY > rect.top + rect.height / 2
    setDropTarget((current) =>
      current !== null &&
      current.kind === target.kind &&
      current.groupKey === target.groupKey &&
      current.id === target.id &&
      current.after === after
        ? current
        : { ...target, after }
    )
  }

  const rowDragLeave = (event: React.DragEvent, target: SidebarDragSource): void => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setDropTarget((current) =>
      current !== null &&
      current.kind === target.kind &&
      current.groupKey === target.groupKey &&
      current.id === target.id
        ? null
        : current
    )
  }

  const rowDrop = (
    event: React.DragEvent,
    target: SidebarDragSource,
    apply: (sourceId: string, targetId: string, after: boolean) => void
  ): void => {
    const source = dragSourceRef.current
    if (
      source === null ||
      source.kind !== target.kind ||
      source.groupKey !== target.groupKey ||
      source.id === target.id
    ) {
      return
    }
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    apply(source.id, target.id, event.clientY > rect.top + rect.height / 2)
    resetRowDrag()
  }

  const rowDropClass = (target: SidebarDragSource): string => {
    const current = dropTarget
    if (
      current === null ||
      current.kind !== target.kind ||
      current.groupKey !== target.groupKey ||
      current.id !== target.id
    ) {
      return ''
    }
    return current.after ? 'border-b-2 border-accent' : 'border-t-2 border-accent'
  }

  const rowDraggingClass = (target: SidebarDragSource): string =>
    dragSource !== null &&
    dragSource.kind === target.kind &&
    dragSource.groupKey === target.groupKey &&
    dragSource.id === target.id
      ? 'opacity-50'
      : ''

  const applyProjectDrop = (sourceId: string, targetId: string, after: boolean): void => {
    persistRowOrder({
      ...rowOrderRef.current,
      projects: moveRowId(
        orderedRepos.map((repo) => repo.id),
        sourceId,
        targetId,
        after
      )
    })
  }

  const { pinned } = useMemo(
    () => pinnedProjectsFirst(orderedRepos, pins.projects),
    [orderedRepos, pins.projects]
  )
  const pinnedSessions = useMemo(
    () => sessions.filter((session) => pins.sessions.includes(session.id)),
    [pins.sessions, sessions]
  )
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? null,
    [activeSessionId, sessions]
  )
  const activeGroupKey =
    activeSession === null
      ? null
      : sessionGroupKey(activeSession.repoId, activeSession.worktree?.path ?? null)
  const openWorkspace = (
    repoId: string,
    groupKey: string,
    groupSessions: readonly SessionSummary[]
  ): void => {
    if (activeGroupKey === groupKey) {
      // Keep the current tab when the workspace still has a session tab. If X
      // closed the last one, selecting the workspace reopens its session
      // instead of leaving the row inert.
      const state = openFilesStore.get(groupKey)
      if (state.tabs.some((tab) => tab.kind === 'session')) return
    }
    const preferred =
      groupSessions.find((session) => session.id === activeSession?.id) ??
      groupSessions.find((session) => isActiveSessionState(session.state)) ??
      groupSessions[0]
    if (preferred !== undefined) onOpenSession(preferred.id)
    else onOpenProject(repoId, 'sessions')
  }
  const attention = attentionTaskCount(tasks) + botsUnread
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

  const toggleDefaultCheckoutCollapsed = (repoId: string): void => {
    setCollapsedDefaultCheckouts((current) => {
      const next = new Set(current)
      if (next.has(repoId)) next.delete(repoId)
      else next.add(repoId)
      return next
    })
  }

  const toggleSessionPin = (sessionId: string): void => {
    updatePins((current) => ({ ...current, sessions: togglePin(current.sessions, sessionId) }))
  }

  const menuItems = createSidebarMenuItems({
    t,
    pins,
    hostUnreachable,
    hostUnreachableReason: t('topbar.hostUnreachable'),
    collapsedWorktrees,
    collapsedDefaultCheckouts,
    preparationFor: (repo) => repositoryPreparationView(repo),
    pendingFor: (session) => pending[session.id] ?? null,
    notify: onNotify,
    onRetryPreparation,
    onNewSessionInRepo,
    onNewSessionInDefaultCheckout,
    onQueueTaskInRepo,
    onNewSessionInWorktree,
    onRequestRemoveWorktree: (repo, group) => setRemoveWorktree({ repo, group }),
    onRecoverWorktree: sessionActions.recoverWorktree,
    onNewSession,
    onQueueTask,
    onAddProject,
    onOpenSchedules,
    onWakeSession: sessionActions.wake,
    onResumeSession: sessionActions.resume,
    onRestartSession: sessionActions.restart,
    toggleProjectPin,
    toggleSessionPin,
    toggleWorktreeCollapsed,
    toggleDefaultCheckoutCollapsed,
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

  const requestCheckoutMenu = (
    repo: RepositorySummary,
    group: WorktreeSessionGroup | null,
    request: RowMenuRequest
  ): void => setCheckoutMenu({ repo, group, ...request })


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
  const sessionRow = (
    session: SessionSummary,
    groupKey: string,
    orderedGroupIds: readonly string[]
  ): React.JSX.Element => {
    const active = session.id === activeSessionId
    const suffix = activitySuffix(session.activity)
    const menuOpen = sessionMenu?.session.id === session.id
    const subagents = visibleSubagents(session.activity)
    const dragTarget: SidebarDragSource = { kind: 'session', groupKey, id: session.id }
    const applyDrop = (sourceId: string, targetId: string, after: boolean): void => {
      persistRowOrder({
        ...rowOrderRef.current,
        sessions: {
          ...rowOrderRef.current.sessions,
          [groupKey]: moveRowId(orderedGroupIds, sourceId, targetId, after)
        }
      })
    }
    return (
      <div
        key={session.id}
        className={`flex min-h-10 flex-col justify-center rounded-md ${
          menuOpen ? 'bg-hover' : ''
        } ${rowDropClass(dragTarget)} ${rowDraggingClass(dragTarget)}`}
        data-menu-open={menuOpen ? 'true' : undefined}
        onDragOver={(event) => rowDragOver(event, dragTarget)}
        onDragLeave={(event) => rowDragLeave(event, dragTarget)}
        onDrop={(event) => rowDrop(event, dragTarget, applyDrop)}
      >
        <button
          type="button"
          className={`flex min-h-10 w-full min-w-0 items-start gap-1.5 rounded-md px-1.5 py-1 text-left ${
            active
              ? 'bg-sel text-foreground shadow-[inset_2px_0_0_var(--icode-accent)]'
              : 'text-muted-foreground hover:bg-hover hover:text-foreground'
          }`}
          draggable
          onDragStart={(event) => startRowDrag(event, dragTarget)}
          onDragEnd={resetRowDrag}
          onDragOver={(event) => rowDragOver(event, dragTarget)}
          onDragLeave={(event) => rowDragLeave(event, dragTarget)}
          onDrop={(event) => rowDrop(event, dragTarget, applyDrop)}
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
            <span className="block truncate text-[13px]">{session.title}</span>
            <span className="block truncate text-[11px] text-muted-foreground">
              {sessionStateLabelFor(session, pendingFor(session))}
            </span>
            {suffix === null ? null : (
              <span
                className={`mt-0.5 flex items-center gap-1 truncate text-[11px] ${activityTone(
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
            {session.activity?.prompt ? (
              <span
                className="mt-0.5 block truncate text-[11px] text-muted-foreground/80"
                title={session.activity.prompt}
                data-testid={`session-prompt-${session.id}`}
              >
                {session.activity.prompt}
              </span>
            ) : null}
          </span>
        </button>
        {subagents.visible.length > 0 ? (
          <div className="pb-0.5 pl-6 pr-1" data-testid={`session-subagents-${session.id}`}>
            {subagents.visible.map((child) => (
              <button
                key={child.id}
                type="button"
                className="flex h-6 w-full min-w-0 items-center gap-1 rounded px-1 text-left text-[11px] hover:bg-hover"
                onClick={() => onOpenSession(session.id)}
                title={child.toolName ? `${child.label} · ${child.toolName}` : child.label}
                data-testid={`session-subagent-${session.id}-${child.id}`}
                data-subagent-state={child.state}
              >
                <span className={`h-1 w-1 shrink-0 rounded-full ${subagentDotClass(child)}`} />
                <span className="min-w-0 flex-1 truncate">{child.label}</span>
                <span className={`shrink-0 font-mono ${subagentTone(child)}`}>{child.state}</span>
              </button>
            ))}
            {subagents.hidden > 0 ? (
              <span className="block px-1 text-[11px] text-muted-foreground">
                +{subagents.hidden}
              </span>
            ) : null}
          </div>
        ) : null}
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
    const needs = attentionTaskCount(
      tasks.filter((task) => task.repoId === repo.id && task.botId === null)
    )
    const preparation = repositoryPreparationView(repo)
    const sessionCount = directSessionCount.get(repo.id) ?? 0
    const expanded = expandedRepos.has(repo.id)
    const groups = groupDirectSessions(repoSessions)
    const projectDragTarget: SidebarDragSource = {
      kind: 'project',
      groupKey: PROJECTS_GROUP_KEY,
      id: repo.id
    }
    const defaultGroupKey = sessionGroupKey(repo.id, null)
    const orderedDefaultSessions = orderByStoredIds(
      groups.defaultCheckout,
      rowOrder.sessions[defaultGroupKey] ?? [],
      (session) => session.id
    )
    const orderedDefaultIds = orderedDefaultSessions.map((session) => session.id)
    const defaultHasAgents = orderedDefaultSessions.some((session) => isAgentHarness(session.harness))
    const orderedWorktrees = orderByStoredIds(
      groups.worktrees,
      rowOrder.worktrees[repo.id] ?? [],
      (group) => group.path
    )
    const worktreeIds = orderedWorktrees.map((group) => group.path)
    const applyWorktreeDrop = (
      sourceId: string,
      targetId: string,
      after: boolean
    ): void => {
      persistRowOrder({
        ...rowOrderRef.current,
        worktrees: {
          ...rowOrderRef.current.worktrees,
          [repo.id]: moveRowId(worktreeIds, sourceId, targetId, after)
        }
      })
    }
    const defaultCollapsed = collapsedDefaultCheckouts.has(repo.id)
    const menuOpen = projectMenu?.repo.id === repo.id
    const defaultMenuOpen =
      checkoutMenu?.repo.id === repo.id && checkoutMenu.group === null
    if (compact) {
      return (
        <div
          key={`pin-${repo.id}`}
          className={`flex h-9 min-w-0 items-center rounded-md ${
            menuOpen && !isActive ? 'bg-hover' : ''
          } ${rowDropClass(projectDragTarget)} ${rowDraggingClass(projectDragTarget)}`}
          data-menu-open={menuOpen ? 'true' : undefined}
          onDragOver={(event) => rowDragOver(event, projectDragTarget)}
          onDragLeave={(event) => rowDragLeave(event, projectDragTarget)}
          onDrop={(event) => rowDrop(event, projectDragTarget, applyProjectDrop)}
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
            className={`flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left text-[13px] ${
              isActive
                ? 'bg-sel text-foreground'
                : 'text-muted-foreground hover:bg-hover hover:text-foreground'
            }`}
            draggable
            onDragStart={(event) => startRowDrag(event, projectDragTarget)}
            onDragEnd={resetRowDrag}
            onDragOver={(event) => rowDragOver(event, projectDragTarget)}
            onDragLeave={(event) => rowDragLeave(event, projectDragTarget)}
            onDrop={(event) => rowDrop(event, projectDragTarget, applyProjectDrop)}
            onClick={() => onOpenProject(repo.id, 'sessions')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title={repo.path}
            data-testid={`pinned-project-${repo.id}`}
            data-active={isActive ? 'true' : 'false'}
          >
            <FolderGit2 size={11} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
              {repo.displayName}
            </span>
            {needs > 0 ? (
              <span className="shrink-0 rounded-full bg-signal-weak px-1 font-mono text-[10px] text-signal">
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
          } ${rowDropClass(projectDragTarget)} ${rowDraggingClass(projectDragTarget)}`}
          data-testid={`sidebar-project-${repo.id}`}
          data-active={isActive ? 'true' : 'false'}
          data-menu-open={menuOpen ? 'true' : undefined}
          onDragOver={(event) => rowDragOver(event, projectDragTarget)}
          onDragLeave={(event) => rowDragLeave(event, projectDragTarget)}
          onDrop={(event) => rowDrop(event, projectDragTarget, applyProjectDrop)}
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
          <button
            type="button"
            className="ml-1 inline-flex h-6 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            onClick={() => toggleProjectExpanded(repo.id)}
            aria-expanded={expanded}
            aria-label={
              expanded
                ? t('sidebar.collapseProject', { name: repo.displayName })
                : t('sidebar.expandProject', { name: repo.displayName })
            }
            data-testid={`sidebar-project-toggle-${repo.id}`}
          >
            <ChevronRight size={9} className={expanded ? 'rotate-90' : ''} />
          </button>
          <button
            type="button"
            className="flex h-full min-w-0 flex-1 items-center gap-1 px-1 text-left"
            data-testid={`project-row-${repo.id}`}
            draggable
            onDragStart={(event) => startRowDrag(event, projectDragTarget)}
            onDragEnd={resetRowDrag}
            onDragOver={(event) => rowDragOver(event, projectDragTarget)}
            onDragLeave={(event) => rowDragLeave(event, projectDragTarget)}
            onDrop={(event) => rowDrop(event, projectDragTarget, applyProjectDrop)}
            onClick={() => {
              // The row is the group's disclosure as well as its open action:
              // clicking a project reveals or hides its sessions.
              onOpenProject(repo.id, 'sessions')
              toggleProjectExpanded(repo.id)
            }}
            aria-current={isActive ? 'page' : undefined}
            aria-expanded={expanded}
            title={repo.path}
          >
            <FolderGit2 size={12} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
              {repo.displayName}
            </span>
            {isPinned ? <Pin size={9} className="shrink-0 text-muted-foreground" /> : null}
            {needs > 0 ? (
              <span
                className="shrink-0 rounded-full bg-signal-weak px-1 font-mono text-[10px] text-signal"
                title={t('projectHeader.needsCount', { count: needs })}
              >
                {needs}
              </span>
            ) : null}
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
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
          <span className="hidden shrink-0 items-center gap-1 pr-1 font-mono text-[11px] text-muted-foreground group-hover:flex">
            <GitBranch size={9} />
            {repo.currentBranch ?? '—'}
          </span>
        </div>

        {expanded ? (
          <div
            className="mb-1 ml-5 border-l border-border pl-1"
            data-testid={`sidebar-sessions-${repo.id}`}
          >
            <div data-testid={`sidebar-default-checkout-${repo.id}`}>
              <div
                className={`group/dc flex h-7 items-center gap-1 px-1 font-mono text-[12px] text-muted-foreground ${
                  defaultMenuOpen ? 'bg-hover text-foreground' : ''
                }`}
                data-menu-open={defaultMenuOpen ? 'true' : undefined}
                onContextMenu={(event) => {
                  event.preventDefault()
                  requestCheckoutMenu(repo, null, {
                    x: event.clientX,
                    y: event.clientY,
                    // Focus returns to the row's disclosure, whichever part of
                    // the row opened the menu.
                    returnFocus:
                      event.currentTarget.querySelector<HTMLElement>(
                        `[data-testid="sidebar-default-checkout-toggle-${repo.id}"]`
                      ) ?? event.currentTarget
                  })
                }}
              >
                {defaultHasAgents ? (
                  <button
                    type="button"
                    className="inline-flex h-5 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                    aria-expanded={!defaultCollapsed}
                    aria-label={
                      defaultCollapsed
                        ? t('sidebar.expandProject', { name: t('sidebar.defaultCheckout') })
                        : t('sidebar.collapseProject', { name: t('sidebar.defaultCheckout') })
                    }
                    data-testid={`sidebar-default-checkout-toggle-${repo.id}`}
                    onClick={() => toggleDefaultCheckoutCollapsed(repo.id)}
                  >
                    <ChevronRight
                      size={8}
                      className={`shrink-0 transition-transform ${defaultCollapsed ? '' : 'rotate-90'}`}
                    />
                  </button>
                ) : (
                  <span className="h-5 w-4 shrink-0" aria-hidden="true" />
                )}
                <button
                  type="button"
                  className={`flex h-full min-w-0 flex-1 items-center gap-1 rounded text-left ${
                    activeGroupKey === defaultGroupKey
                      ? 'bg-sel text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  aria-current={activeGroupKey === defaultGroupKey ? 'page' : undefined}
                  data-testid={`sidebar-default-checkout-select-${repo.id}`}
                  data-active={activeGroupKey === defaultGroupKey ? 'true' : 'false'}
                  onClick={() => openWorkspace(repo.id, defaultGroupKey, groups.defaultCheckout)}
                  onKeyDown={(event) =>
                    openRowMenuFromKey(event, (anchor) =>
                      requestCheckoutMenu(repo, null, {
                        anchor,
                        returnFocus: event.currentTarget
                      })
                    )
                  }
                >
                  <Folder size={8} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    {t('sidebar.defaultCheckout')}
                  </span>
                  <span>{groups.defaultCheckout.length}</span>
                </button>
              </div>
              {defaultCollapsed ? null : (
                <div className="pl-1">
                  {orderedDefaultSessions
                    .filter((session) => isAgentHarness(session.harness))
                    .map((session) => sessionRow(session, defaultGroupKey, orderedDefaultIds))}
                </div>
              )}
            </div>
            {orderedWorktrees.map((group) => {
              // A header exists when it has a job: grouping several sessions,
              // or carrying the drag affordance that orders workspaces. A
              // project's only workspace needs neither.
              const shared = group.sessions.length > 1
              // Every worktree is a workspace row, even when it holds one tab.
              const showHeader = true
              const collapsed = showHeader && collapsedWorktrees.has(group.worktreeId)
              const menuOpen =
                checkoutMenu?.repo.id === repo.id &&
                checkoutMenu.group?.worktreeId === group.worktreeId
              const groupKey = sessionGroupKey(repo.id, group.path)
              const orderedGroupSessions = orderByStoredIds(
                group.sessions,
                rowOrder.sessions[groupKey] ?? [],
                (session) => session.id
              )
              const orderedGroupIds = orderedGroupSessions.map((session) => session.id)
              const hasAgents = orderedGroupSessions.some((session) => isAgentHarness(session.harness))
              const dragTarget: SidebarDragSource = {
                kind: 'worktree',
                groupKey: repo.id,
                id: group.path
              }
              return (
                <div key={group.worktreeId} data-testid={`sidebar-worktree-${group.worktreeId}`}>
                  {showHeader ? (
                    <div
                      className={`group/wt flex h-7 items-center gap-1 px-1 text-[12px] text-muted-foreground ${
                        menuOpen ? 'bg-hover text-foreground' : ''
                      } ${rowDropClass(dragTarget)} ${rowDraggingClass(dragTarget)}`}
                      data-menu-open={menuOpen ? 'true' : undefined}
                      onDragOver={(event) => rowDragOver(event, dragTarget)}
                      onDragLeave={(event) => rowDragLeave(event, dragTarget)}
                      onDrop={(event) => rowDrop(event, dragTarget, applyWorktreeDrop)}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        requestCheckoutMenu(repo, group, {
                          x: event.clientX,
                          y: event.clientY,
                          // Focus returns to the row's disclosure, whichever
                          // part of the row opened the menu.
                          returnFocus:
                            event.currentTarget.querySelector<HTMLElement>(
                              `[data-testid="sidebar-worktree-toggle-${group.worktreeId}"]`
                            ) ?? event.currentTarget
                        })
                      }}
                    >
                      {hasAgents ? (
                        <button
                          type="button"
                          className="inline-flex h-5 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                          aria-expanded={!collapsed}
                          aria-label={
                            collapsed
                              ? t('sidebar.expandProject', { name: group.path })
                              : t('sidebar.collapseProject', { name: group.path })
                          }
                          data-testid={`sidebar-worktree-toggle-${group.worktreeId}`}
                          draggable
                          onDragStart={(event) => startRowDrag(event, dragTarget)}
                          onDragEnd={resetRowDrag}
                          onDragOver={(event) => rowDragOver(event, dragTarget)}
                          onDragLeave={(event) => rowDragLeave(event, dragTarget)}
                          onDrop={(event) => rowDrop(event, dragTarget, applyWorktreeDrop)}
                          onClick={() => toggleWorktreeCollapsed(group.worktreeId)}
                        >
                          <ChevronRight
                            size={8}
                            className={`shrink-0 transition-transform ${collapsed ? '' : 'rotate-90'}`}
                          />
                        </button>
                      ) : (
                        <span className="h-5 w-4 shrink-0" aria-hidden="true" />
                      )}
                      <button
                        type="button"
                        className={`flex h-full min-w-0 flex-1 items-center gap-1 rounded text-left ${
                          activeGroupKey === groupKey
                            ? 'bg-sel text-foreground'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                        aria-label={
                          shared ? t('sidebar.sharedWorkspace') : t('sidebar.workspaceGroup')
                        }
                        aria-current={activeGroupKey === groupKey ? 'page' : undefined}
                        data-testid={`sidebar-worktree-select-${group.worktreeId}`}
                        data-active={activeGroupKey === groupKey ? 'true' : 'false'}
                        draggable
                        onDragStart={(event) => startRowDrag(event, dragTarget)}
                        onDragEnd={resetRowDrag}
                        onDragOver={(event) => rowDragOver(event, dragTarget)}
                        onDragLeave={(event) => rowDragLeave(event, dragTarget)}
                        onDrop={(event) => rowDrop(event, dragTarget, applyWorktreeDrop)}
                        onClick={() => openWorkspace(repo.id, groupKey, group.sessions)}
                        onKeyDown={(event) =>
                          openRowMenuFromKey(event, (anchor) =>
                            requestCheckoutMenu(repo, group, {
                              anchor,
                              returnFocus: event.currentTarget
                            })
                          )
                        }
                      >
                        <span className="min-w-0 flex-1 truncate" title={group.path}>
                          {group.sessions[0]?.worktree?.branch ??
                            (shared ? t('sidebar.sharedWorkspace') : t('sidebar.workspaceGroup'))}
                        </span>
                        <span>{group.sessions.length}</span>
                      </button>
                    </div>
                  ) : null}
                  {collapsed ? null : (
                    <div className="pl-1">
                      {orderedGroupSessions
                        .filter((session) => isAgentHarness(session.harness))
                        .map((session) => sessionRow(session, groupKey, orderedGroupIds))}
                    </div>
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
            <span className="block truncate text-[14px] font-semibold tracking-tight">
              <span className="text-brand">i</span>Code
            </span>
            <span className="mt-0.5 block text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
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
          onClick={onOpenHistory}
          aria-label={t('history.title')}
          title={t('history.title')}
          data-testid="sidebar-history"
        >
          <History size={13} />
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
            <span className="absolute -right-0.5 -top-0.5 min-w-3 rounded-full bg-signal px-1 text-center text-[10px] font-semibold leading-3 text-signal-ink">
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

      <div className="flex min-h-0 flex-1 flex-col px-2 py-2">
        {botsSection !== undefined ? (
          <div className="shrink-0" data-testid="sidebar-bots-slot">
            {botsSection}
          </div>
        ) : null}
        <div
          className={`min-h-[96px] flex-1 overflow-y-auto ${
            botsSection !== undefined ? 'pt-1' : ''
          }`}
          data-testid="sidebar-projects-scroll"
        >
          {pinned.length + pinnedSessions.length > 0 ? (
            <section aria-label={t('sidebar.pinned')} data-testid="sidebar-pinned">
              <div className="flex h-8 items-center gap-1 px-1 font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
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
                      className={`flex min-h-9 items-center rounded-md ${menuOpen ? 'bg-hover' : ''}`}
                      data-menu-open={menuOpen ? 'true' : undefined}
                    >
                      <button
                        type="button"
                        className={`flex min-h-9 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left ${
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
                        <span className="min-w-0 flex-1 truncate text-[13px]">{session.title}</span>
                        <span className="max-w-[110px] shrink-0 truncate text-[11px] text-muted-foreground">
                          {repo?.displayName ?? session.repoId}
                        </span>
                      </button>
                    </div>
                  )
                })}
              </div>
            </section>
          ) : null}

          <section aria-label={t('sidebar.projects')} data-testid="sidebar-projects" className="mt-1">
            <div className="flex h-8 items-center gap-1 px-1">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1 font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground hover:text-foreground"
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
                    className="w-full rounded-md px-2 py-2 text-left text-[12px] leading-relaxed text-muted-foreground hover:bg-hover hover:text-foreground"
                    onClick={onAddProject}
                    data-testid="sidebar-empty-add-project"
                  >
                    {t('projects.empty.title')}
                  </button>
                ) : (
                  orderedRepos.map((repo) => projectRow(repo, false))
                )}
              </div>
            ) : null}
          </section>
        </div>
      </div>

      {footerStatus ?? null}

      <footer className="flex shrink-0 items-center justify-end border-t border-border px-2 py-2">
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
        checkoutMenu={
          checkoutMenu === null
            ? null
            : {
                items: menuItems.checkout(checkoutMenu),
                ariaLabel:
                  checkoutMenu.group === null
                    ? t('sidebar.defaultCheckoutMenu')
                    : t('sidebar.worktreeMenu'),
                testId:
                  checkoutMenu.group === null
                    ? 'sidebar-default-checkout-menu'
                    : 'sidebar-worktree-menu',
                width: 208,
                x: checkoutMenu.x,
                y: checkoutMenu.y,
                anchor: checkoutMenu.anchor,
                align: 'start',
                returnFocus: checkoutMenu.returnFocus,
                onClose: () => setCheckoutMenu(null)
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
                onConfirm: (deleteBranch) => {
                  const sessionId = removeSession.id
                  setRemoveSession(null)
                  sessionActions.remove(sessionId, { deleteBranch })
                }
              }
        }
        removeWorktree={
          removeWorktree === null
            ? null
            : {
                repo: removeWorktree.repo,
                group: removeWorktree.group,
                onClose: () => setRemoveWorktree(null),
                onRemove: (deleteBranch) =>
                  onRemoveWorktree(removeWorktree.group.worktreeId, { deleteBranch }),
                onDiscard: (confirmBranch, deleteBranch) =>
                  onDiscardWorktree(removeWorktree.group.worktreeId, confirmBranch, {
                    deleteBranch
                  })
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
