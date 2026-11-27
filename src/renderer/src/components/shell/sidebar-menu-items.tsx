import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Copy,
  GitBranch,
  Info,
  ListPlus,
  Moon,
  Pin,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings2,
  SquarePlus,
  Sunrise,
  TerminalSquare,
  Trash2
} from 'lucide-react'
import type { RepositorySummary, SessionSummary } from '../../../../shared/schemas/ipc'
import type { Notice, PendingAction } from '../../state/workspace'
import type { useT } from '../../i18n/use-i18n'
import type { ContextMenuItem } from '../ContextMenu'
import type { SidebarPins } from './sidebar-pins'
import type { WorktreeSessionGroup } from './sidebar-model'
import {
  defaultCheckoutMenuEntries,
  newMenuEntries,
  projectMenuEntries,
  worktreeMenuEntries,
  type DefaultCheckoutMenuEntryId,
  type NewMenuEntryId,
  type ProjectMenuEntryId,
  type WorktreeMenuEntryId
} from './sidebar-menu'
import {
  sessionActionState,
  sessionMenuEntries,
  sessionMenuReasonLabel,
  type SessionMenuEntryId
} from '../sessions/session-menu'

export type SidebarMenuContext = {
  t: ReturnType<typeof useT>
  pins: SidebarPins
  hostUnreachable: boolean
  hostUnreachableReason: string
  collapsedWorktrees: ReadonlySet<string>
  collapsedDefaultCheckouts: ReadonlySet<string>
  preparationFor: (
    repo: RepositorySummary
  ) => { kind: 'preparing' | 'failed'; label: string } | null
  pendingFor: (session: SessionSummary) => PendingAction | null
  notify: (notice: Notice) => void
  onRetryPreparation: (repoId: string) => void
  onNewSessionInRepo: (repoId: string) => void
  onNewSessionInDefaultCheckout: (repoId: string) => void
  onQueueTaskInRepo: (repoId: string) => void
  onNewSessionInWorktree: (repoId: string, worktreeId: string) => void
  onRequestRemoveWorktree: (repo: RepositorySummary, group: WorktreeSessionGroup) => void
  onRecoverWorktree: (sessionId: string) => void
  onNewSession: () => void
  onQueueTask: () => void
  onAddProject: () => void
  onOpenSchedules: () => void
  onWakeSession: (sessionId: string) => void
  onResumeSession: (sessionId: string) => void
  onRestartSession: (sessionId: string) => void
  toggleProjectPin: (repoId: string) => void
  toggleSessionPin: (sessionId: string) => void
  toggleWorktreeCollapsed: (worktreeId: string) => void
  toggleDefaultCheckoutCollapsed: (repoId: string) => void
  setSettingsRepo: (repo: RepositorySummary) => void
  setMaintenanceRepo: (repo: RepositorySummary) => void
  setRemoveRepo: (repo: RepositorySummary) => void
  setDetailsSession: (session: SessionSummary) => void
  setSleepSession: (session: SessionSummary) => void
  setRemoveSession: (session: SessionSummary) => void
}

function withPlan<Id extends string>(
  entries: { id: Id; separatorBefore: boolean; disabled: boolean; reason?: string }[],
  build: Record<Id, () => ContextMenuItem>
): ContextMenuItem[] {
  return entries.map((entry) => ({
    ...build[entry.id](),
    separatorBefore: entry.separatorBefore,
    disabled: entry.disabled,
    ...(entry.reason === undefined ? {} : { reason: entry.reason })
  }))
}

/** Move-up/Move-down availability for the row a menu was opened on. */
export type SidebarRowReorder = {
  canMoveUp: boolean
  canMoveDown: boolean
  onMoveUp: () => void
  onMoveDown: () => void
}

/** Maps the pure sidebar plans to labelled menu items with stable test ids. */
export function createSidebarMenuItems(context: SidebarMenuContext) {
  const { t, pins } = context

  /**
   * Reorder is the keyboard path for drag-only ordering, so it leads the menu.
   * A separator keeps it apart from the row's lifecycle actions.
   */
  const withReorder = (
    items: ContextMenuItem[],
    reorder: SidebarRowReorder | undefined,
    testId: (direction: 'up' | 'down') => string
  ): ContextMenuItem[] => {
    if (reorder === undefined) return items
    const moves: ContextMenuItem[] = [
      {
        id: 'move-up',
        label: t('session.moveUp'),
        icon: <ArrowUp size={12} />,
        testId: testId('up'),
        disabled: !reorder.canMoveUp,
        onSelect: reorder.onMoveUp
      },
      {
        id: 'move-down',
        label: t('session.moveDown'),
        icon: <ArrowDown size={12} />,
        testId: testId('down'),
        disabled: !reorder.canMoveDown,
        onSelect: reorder.onMoveDown
      }
    ]
    return [
      ...moves,
      ...items.map((item, index) =>
        index === 0 ? { ...item, separatorBefore: true } : item
      )
    ]
  }

  /** One clipboard behavior for every row that offers Copy path. */
  const copyPathItem = (input: { path: string; testId: string }): ContextMenuItem => ({
    id: 'copy-path',
    label: t('projects.menu.copyPath'),
    icon: <Copy size={12} />,
    testId: input.testId,
    onSelect: () => {
      const clipboard = navigator.clipboard
      if (clipboard === undefined) {
        context.notify({
          tone: 'error',
          message: t('projects.notice.clipboardUnavailable')
        })
        return
      }
      void clipboard.writeText(input.path).then(
        () => context.notify({ tone: 'success', message: t('projects.notice.pathCopied') }),
        () =>
          context.notify({
            tone: 'error',
            message: t('projects.notice.clipboardUnavailable')
          })
      )
    }
  })

  const defaultCheckout = (repo: RepositorySummary): ContextMenuItem[] => {
    const collapsed = context.collapsedDefaultCheckouts.has(repo.id)
    const canStart = !context.hostUnreachable && repo.availability !== 'missing'
    const unavailableReason = context.hostUnreachable
      ? context.hostUnreachableReason
      : t('newSession.checkoutUnavailable')
    const build: Record<DefaultCheckoutMenuEntryId, () => ContextMenuItem> = {
      'new-session': () => ({
        id: 'new-session',
        label: t('sidebar.newSessionInDefaultCheckout'),
        icon: <TerminalSquare size={12} />,
        testId: `sidebar-default-checkout-${repo.id}-new-session`,
        onSelect: () => context.onNewSessionInDefaultCheckout(repo.id)
      }),
      'copy-path': () =>
        copyPathItem({
          path: repo.path,
          testId: `sidebar-default-checkout-${repo.id}-copy-path`
        }),
      toggle: () => ({
        id: 'toggle',
        label: collapsed ? t('sidebar.expandCheckout') : t('sidebar.collapseCheckout'),
        icon: <ChevronRight size={12} className={collapsed ? '' : 'rotate-90'} />,
        testId: `sidebar-default-checkout-${repo.id}-toggle`,
        onSelect: () => context.toggleDefaultCheckoutCollapsed(repo.id)
      })
    }
    return withPlan(
      defaultCheckoutMenuEntries({ canStart, unavailableReason }),
      build
    )
  }

  const worktree = (request: {
    repo: RepositorySummary
    group: WorktreeSessionGroup
    reorder?: SidebarRowReorder
  }): ContextMenuItem[] => {
    const { repo, group } = request
    const status = group.sessions[0]?.worktree?.status ?? null
    const collapsed = context.collapsedWorktrees.has(group.worktreeId)
    const build: Record<WorktreeMenuEntryId, () => ContextMenuItem> = {
      'new-session': () => ({
        id: 'new-session',
        label: t('sidebar.newSessionHere'),
        icon: <TerminalSquare size={12} />,
        testId: `sidebar-worktree-${group.worktreeId}-new-session`,
        onSelect: () => context.onNewSessionInWorktree(repo.id, group.worktreeId)
      }),
      'copy-path': () =>
        copyPathItem({
          path: group.path,
          testId: `sidebar-worktree-${group.worktreeId}-copy-path`
        }),
      toggle: () => ({
        id: 'toggle',
        label: collapsed ? t('sidebar.expandWorktree') : t('sidebar.collapseWorktree'),
        icon: <ChevronRight size={12} className={collapsed ? '' : 'rotate-90'} />,
        testId: `sidebar-worktree-${group.worktreeId}-toggle`,
        onSelect: () => context.toggleWorktreeCollapsed(group.worktreeId)
      }),
      remove: () => ({
        id: 'remove',
        label: t('sidebar.removeWorktree'),
        icon: <Trash2 size={12} />,
        danger: true,
        testId: `sidebar-worktree-${group.worktreeId}-remove`,
        onSelect: () => context.onRequestRemoveWorktree(repo, group)
      })
    }
    return withReorder(
      withPlan(
        worktreeMenuEntries({
          status,
          unavailableReason: t('newSession.worktreeUnavailable'),
          creatingReason: t('sidebar.worktreeCreating'),
          hostUnreachable: context.hostUnreachable,
          hostUnreachableReason: context.hostUnreachableReason
        }),
        build
      ),
      request.reorder,
      (direction) => `sidebar-worktree-${group.worktreeId}-move-${direction}`
    )
  }

  const project = (
    repo: RepositorySummary,
    reorder?: SidebarRowReorder
  ): ContextMenuItem[] => {
    const build: Record<ProjectMenuEntryId, () => ContextMenuItem> = {
      retry: () => ({
        id: 'retry',
        label: t('projects.menu.retry'),
        icon: <RefreshCw size={12} />,
        testId: `sidebar-project-${repo.id}-retry`,
        onSelect: () => context.onRetryPreparation(repo.id)
      }),
      'new-session': () => ({
        id: 'new-session',
        label: t('sessions.newSession'),
        icon: <SquarePlus size={12} />,
        testId: `sidebar-project-${repo.id}-new-session`,
        onSelect: () => context.onNewSessionInRepo(repo.id)
      }),
      'new-default-session': () => ({
        id: 'new-default-session',
        label: t('sidebar.newSessionInDefaultCheckout'),
        icon: <TerminalSquare size={12} />,
        testId: `sidebar-project-${repo.id}-new-default-session`,
        onSelect: () => context.onNewSessionInDefaultCheckout(repo.id)
      }),
      'queue-task': () => ({
        id: 'queue-task',
        label: t('topbar.queueTask'),
        icon: <ListPlus size={12} />,
        testId: `sidebar-project-${repo.id}-queue-task`,
        onSelect: () => context.onQueueTaskInRepo(repo.id)
      }),
      pin: () => ({
        id: 'pin',
        label: pins.projects.includes(repo.id)
          ? t('projects.row.unpin')
          : t('projects.row.pin'),
        icon: <Pin size={12} />,
        testId: `pin-project-${repo.id}`,
        onSelect: () => context.toggleProjectPin(repo.id)
      }),
      'copy-path': () =>
        copyPathItem({
          path: repo.path,
          testId: `sidebar-project-${repo.id}-copy-path`
        }),
      'repository-settings': () => ({
        id: 'repository-settings',
        label: t('projects.menu.repositorySettings'),
        icon: <Settings2 size={12} />,
        testId: `repository-settings-${repo.id}`,
        onSelect: () => context.setSettingsRepo(repo)
      }),
      maintenance: () => ({
        id: 'maintenance',
        label: t('projects.menu.maintenance'),
        icon: <GitBranch size={12} />,
        testId: 'project-maintenance-open',
        onSelect: () => context.setMaintenanceRepo(repo)
      }),
      remove: () => ({
        id: 'remove',
        label: t('projects.menu.remove'),
        icon: <Trash2 size={12} />,
        danger: true,
        testId: `repository-remove-${repo.id}`,
        onSelect: () => context.setRemoveRepo(repo)
      })
    }
    return withReorder(
      withPlan(
        projectMenuEntries({
          preparation: context.preparationFor(repo),
          hostUnreachable: context.hostUnreachable,
          hostUnreachableReason: context.hostUnreachableReason
        }),
        build
      ),
      reorder,
      (direction) => `sidebar-project-${repo.id}-move-${direction}`
    )
  }

  const newWork = (): ContextMenuItem[] => {
    const build: Record<NewMenuEntryId, () => ContextMenuItem> = {
      'new-session': () => ({
        id: 'new-session',
        label: t('sessions.newSession'),
        icon: <TerminalSquare size={12} />,
        testId: 'new-session-open',
        onSelect: context.onNewSession
      }),
      'queue-task': () => ({
        id: 'queue-task',
        label: t('topbar.queueTask'),
        testId: 'queue-task-open',
        onSelect: context.onQueueTask
      }),
      'add-project': () => ({
        id: 'add-project',
        label: t('projects.addProject'),
        icon: <Plus size={12} />,
        testId: 'add-project',
        onSelect: context.onAddProject
      }),
      schedules: () => ({
        id: 'schedules',
        label: t('rail.schedules'),
        testId: 'schedules-open',
        onSelect: context.onOpenSchedules
      })
    }
    return withPlan(
      newMenuEntries({
        hostUnreachable: context.hostUnreachable,
        hostUnreachableReason: context.hostUnreachableReason
      }),
      build
    )
  }

  const session = (
    record: SessionSummary,
    reorder?: SidebarRowReorder
  ): ContextMenuItem[] => {
    const build: Record<SessionMenuEntryId, () => ContextMenuItem> = {
      details: () => ({
        id: 'details',
        label: t('session.details'),
        icon: <Info size={12} />,
        testId: `sidebar-session-${record.id}-details`,
        onSelect: () => context.setDetailsSession(record)
      }),
      sleep: () => ({
        id: 'sleep',
        label: t('session.sleep'),
        icon: <Moon size={12} />,
        testId: `sidebar-session-${record.id}-sleep`,
        onSelect: () => context.setSleepSession(record)
      }),
      wake: () => ({
        id: 'wake',
        label: t('session.wake'),
        icon: <Sunrise size={12} />,
        testId: `sidebar-session-${record.id}-wake`,
        onSelect: () => context.onWakeSession(record.id)
      }),
      resume: () => ({
        id: 'resume',
        label: t('session.resume'),
        icon: <Play size={12} />,
        testId: `sidebar-session-${record.id}-resume`,
        onSelect: () => context.onResumeSession(record.id)
      }),
      restart: () => ({
        id: 'restart',
        label: t('session.restart'),
        icon: <RotateCcw size={12} />,
        testId: `sidebar-session-${record.id}-restart`,
        onSelect: () => context.onRestartSession(record.id)
      }),
      pin: () => ({
        id: 'pin',
        label: t(
          pins.sessions.includes(record.id) ? 'projects.row.unpin' : 'projects.row.pin'
        ),
        icon: <Pin size={12} />,
        testId: `sidebar-session-${record.id}-pin`,
        onSelect: () => context.toggleSessionPin(record.id)
      }),
      remove: () => ({
        id: 'remove',
        label: t('session.remove'),
        icon: <Trash2 size={12} />,
        danger: true,
        testId: `sidebar-session-${record.id}-remove`,
        onSelect: () => context.setRemoveSession(record)
      })
    }
    return withReorder(
      withPlan(
        sessionMenuEntries(
          sessionActionState(record, context.pendingFor(record), true)
        ).map((entry) =>
          entry.reason === undefined
            ? entry
            : { ...entry, reason: sessionMenuReasonLabel(entry.reason) }
        ),
        build
      ),
      reorder,
      (direction) => `sidebar-session-${record.id}-move-${direction}`
    )
  }

  /**
   * One entry point for both checkout row types: `group === null` is the
   * repository's shared primary checkout row.
   */
  const checkout = (request: {
    repo: RepositorySummary
    group: WorktreeSessionGroup | null
    reorder?: SidebarRowReorder
  }): ContextMenuItem[] =>
    request.group === null
      ? defaultCheckout(request.repo)
      : worktree({ repo: request.repo, group: request.group, reorder: request.reorder })

  return { checkout, project, newWork, session }
}
