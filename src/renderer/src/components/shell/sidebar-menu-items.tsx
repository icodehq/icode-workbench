import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  CircleX,
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
import type { TaskRecordPayload } from '../../../../shared/icode-api'
import type { Notice, PendingAction } from '../../state/workspace'
import type { useT } from '../../i18n/use-i18n'
import type { ContextMenuItem } from '../ContextMenu'
import type { TaskAction } from '../TaskWorkbench'
import type { SidebarPins } from './sidebar-pins'
import type { WorktreeSessionGroup } from './sidebar-model'
import {
  newMenuEntries,
  projectMenuEntries,
  worktreeMenuEntries,
  type NewMenuEntryId,
  type ProjectMenuEntryId,
  type WorktreeMenuEntryId
} from './sidebar-menu'
import { taskMenuEntries, type TaskMenuEntryId } from './task-menu'
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
  preparationFor: (
    repo: RepositorySummary
  ) => { kind: 'preparing' | 'failed'; label: string } | null
  pendingFor: (session: SessionSummary) => PendingAction | null
  notify: (notice: Notice) => void
  onRetryPreparation: (repoId: string) => void
  onNewSessionInRepo: (repoId: string) => void
  onQueueTaskInRepo: (repoId: string) => void
  onNewSessionInWorktree: (repoId: string, worktreeId: string) => void
  onRecoverWorktree: (sessionId: string) => void
  onNewSession: () => void
  onQueueTask: () => void
  onAddProject: () => void
  onOpenSchedules: () => void
  onTaskAction: (task: TaskRecordPayload, action: TaskAction) => void
  onWakeSession: (sessionId: string) => void
  onResumeSession: (sessionId: string) => void
  onRestartSession: (sessionId: string) => void
  toggleProjectPin: (repoId: string) => void
  toggleTaskPin: (taskId: string) => void
  toggleSessionPin: (sessionId: string) => void
  toggleWorktreeCollapsed: (worktreeId: string) => void
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

/** Maps the pure sidebar plans to labelled menu items with stable test ids. */
export function createSidebarMenuItems(context: SidebarMenuContext) {
  const { t, pins } = context

  const worktree = (request: {
    repo: RepositorySummary
    group: WorktreeSessionGroup
  }): ContextMenuItem[] => {
    const { repo, group } = request
    const status = group.sessions[0]?.worktree?.status ?? null
    const collapsed = context.collapsedWorktrees.has(group.worktreeId)
    const firstSession = group.sessions[0]
    const build: Record<WorktreeMenuEntryId, () => ContextMenuItem> = {
      'new-session': () => ({
        id: 'new-session',
        label: t('sessions.newSession'),
        icon: <TerminalSquare size={12} />,
        testId: `sidebar-worktree-${group.worktreeId}-new-session`,
        onSelect: () => context.onNewSessionInWorktree(repo.id, group.worktreeId)
      }),
      'copy-path': () => ({
        id: 'copy-path',
        label: t('projects.menu.copyPath'),
        icon: <Copy size={12} />,
        testId: `sidebar-worktree-${group.worktreeId}-copy-path`,
        onSelect: () => {
          const write = navigator.clipboard?.writeText(group.path)
          if (write === undefined) return
          void write.then(
            () => context.notify({ tone: 'success', message: t('projects.menu.copyPath') }),
            () => undefined
          )
        }
      }),
      toggle: () => ({
        id: 'toggle',
        label: collapsed ? t('sidebar.expandWorktree') : t('sidebar.collapseWorktree'),
        icon: <ChevronRight size={12} className={collapsed ? '' : 'rotate-90'} />,
        testId: `sidebar-worktree-${group.worktreeId}-toggle`,
        onSelect: () => context.toggleWorktreeCollapsed(group.worktreeId)
      }),
      recover: () => ({
        id: 'recover',
        label: t('sidebar.recoverWorktree'),
        icon: <RefreshCw size={12} />,
        testId: `sidebar-worktree-${group.worktreeId}-recover`,
        onSelect: () => {
          if (firstSession !== undefined) context.onRecoverWorktree(firstSession.id)
        }
      })
    }
    return withPlan(
      worktreeMenuEntries({
        status,
        hasSession: firstSession !== undefined,
        unavailableReason: t('newSession.worktreeUnavailable')
      }),
      build
    )
  }

  const project = (repo: RepositorySummary): ContextMenuItem[] => {
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
      'copy-path': () => ({
        id: 'copy-path',
        label: t('projects.menu.copyPath'),
        icon: <Copy size={12} />,
        testId: `sidebar-project-${repo.id}-copy-path`,
        onSelect: () => {
          const clipboard = navigator.clipboard
          if (clipboard === undefined) {
            context.notify({
              tone: 'error',
              message: t('projects.notice.clipboardUnavailable')
            })
            return
          }
          void clipboard.writeText(repo.path).then(
            () =>
              context.notify({ tone: 'success', message: t('projects.notice.pathCopied') }),
            () =>
              context.notify({
                tone: 'error',
                message: t('projects.notice.clipboardUnavailable')
              })
          )
        }
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
    return withPlan(
      projectMenuEntries({
        preparation: context.preparationFor(repo),
        hostUnreachable: context.hostUnreachable,
        hostUnreachableReason: context.hostUnreachableReason
      }),
      build
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

  const task = (record: TaskRecordPayload): ContextMenuItem[] => {
    const build: Record<TaskMenuEntryId, () => ContextMenuItem> = {
      continue: () => ({
        id: 'continue',
        label: t('tasks.row.continue'),
        icon: <Play size={12} />,
        onSelect: () => context.onTaskAction(record, 'resume')
      }),
      retry: () => ({
        id: 'retry',
        label: t('tasks.row.retry'),
        icon: <RefreshCw size={12} />,
        onSelect: () => context.onTaskAction(record, 'retry')
      }),
      archive: () => ({
        id: 'archive',
        label: t('tasks.row.archive'),
        icon: <Archive size={12} />,
        onSelect: () => context.onTaskAction(record, 'archive')
      }),
      unarchive: () => ({
        id: 'unarchive',
        label: t('tasks.row.restore'),
        icon: <ArchiveRestore size={12} />,
        onSelect: () => context.onTaskAction(record, 'unarchive')
      }),
      pin: () => ({
        id: 'pin',
        label: t(pins.tasks.includes(record.id) ? 'projects.row.unpin' : 'projects.row.pin'),
        icon: <Pin size={12} />,
        onSelect: () => context.toggleTaskPin(record.id)
      }),
      cancel: () => ({
        id: 'cancel',
        label: t('tasks.row.cancel'),
        icon: <CircleX size={12} />,
        danger: true,
        onSelect: () => context.onTaskAction(record, 'cancel')
      })
    }
    return taskMenuEntries(record).map((entry) => ({
      ...build[entry.id](),
      separatorBefore: entry.separatorBefore,
      testId: `sidebar-task-${record.id}-${entry.id}`
    }))
  }

  const session = (record: SessionSummary): ContextMenuItem[] => {
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
    return withPlan(
      sessionMenuEntries(
        sessionActionState(record, context.pendingFor(record), true)
      ).map((entry) =>
        entry.reason === undefined
          ? entry
          : { ...entry, reason: sessionMenuReasonLabel(entry.reason) }
      ),
      build
    )
  }

  return { worktree, project, newWork, task, session }
}
