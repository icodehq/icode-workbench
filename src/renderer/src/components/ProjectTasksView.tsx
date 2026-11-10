import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Loader2,
  Pause,
  Play,
  Plus,
  XCircle
} from 'lucide-react'
import type {
  TaskRecordPayload
} from '../../../shared/icode-api'
import type { HarnessDetection } from '../../../shared/domain/harness'
import type { AppError } from '../../../shared/domain/errors'
import type { RepositorySummary, SessionSummary } from '../../../shared/schemas/ipc'
import { callApi, errorNotice } from '../lib/api'
import { shortcutLabel } from '../lib/platform'
import { repositoryPreparationView } from '../lib/repository-preparation'
import type { AgentSendResult } from '../lib/agent-send'
import type { WorkbenchDraftStore } from '../review/drafts'
import type { Notice } from '../state/workspace'
import { useT, useTp } from '../i18n/use-i18n'
import TaskWorkbench from './TaskWorkbench'
import {
  sortFinishedTasks,
  sortQueuedTasks,
  sortRunningTasks,
  taskAttention,
  taskAttentionCounts,
  taskGroup,
  taskIsActive,
  taskIsBlocked,
  taskStatusLabel,
  taskStatusTone
} from './task-status'

type Props = {
  repo: RepositorySummary
  tasks: TaskRecordPayload[]
  archivedTasks: TaskRecordPayload[]
  sessions: SessionSummary[]
  loading: boolean
  focusTaskId: string | null
  focusComposerNonce: number
  /** The last task selected in this project, kept by the shell across mode switches. */
  rememberedTaskId: string | null
  notify: (notice: Notice) => void
  refreshToken: number
  drafts: WorkbenchDraftStore
  openRequest: { path: string; line: number; nonce: number } | null
  onOpenRequestHandled: () => void
  onReload: () => Promise<void>
  onTaskSelected: (taskId: string) => void
  onOpenSession: (sessionId: string) => void
  onStopSession: (sessionId: string) => void
  onRestartSession: (sessionId: string) => void
  onRecheckSession: (sessionId: string) => void
  onError: (error: AppError) => void
  onSendToAgent: (text: string, session: SessionSummary) => Promise<AgentSendResult>
}

type Filter = 'all' | 'needs' | 'proposal' | 'running' | 'queued' | 'finished' | 'history'

function statusGlyph(task: TaskRecordPayload): React.JSX.Element {
  if (task.approval === 'pending' && task.status === 'queued') {
    return <AlertTriangle size={11} />
  }
  if (task.status === 'running' || task.status === 'dispatching') {
    return <Loader2 size={11} className="animate-spin" />
  }
  if (task.status === 'waiting') return <Pause size={11} />
  if (task.status === 'queued') return <Play size={11} />
  if (task.status === 'completed') return <CheckCircle2 size={11} />
  if (task.status === 'failed') return <XCircle size={11} />
  return <Ban size={11} />
}

function ReviewBadge({ task }: { task: TaskRecordPayload }): React.JSX.Element | null {
  const t = useT()
  if (task.reviewDecision === 'accepted') {
    return (
      <span className="shrink-0 rounded bg-add-weak px-1 text-[8px] text-add">
        {t('tasks.row.accepted')}
      </span>
    )
  }
  if (task.reviewDecision === 'rejected') {
    return (
      <span className="shrink-0 rounded bg-destructive/15 px-1 text-[8px] text-destructive">
        {t('tasks.row.rejected')}
      </span>
    )
  }
  if (task.canDecideReview) {
    return (
      <span className="shrink-0 rounded bg-muted px-1 text-[9px] text-muted-foreground">
        {t('tasks.row.unreviewed')}
      </span>
    )
  }
  return null
}

function ProjectTaskRow({
  task,
  busy,
  onSelect,
  onApprove,
  onReject,
  onCancel,
  onRetry,
  onResume,
  onArchive,
  onUnarchive,
  archived
}: {
  task: TaskRecordPayload
  busy: boolean
  onSelect: () => void
  onApprove: () => Promise<void>
  onReject: () => Promise<void>
  onCancel: () => Promise<void>
  onRetry: () => Promise<void>
  onResume: () => Promise<void>
  onArchive?: () => Promise<void>
  onUnarchive?: () => Promise<void>
  archived?: boolean
}): React.JSX.Element {
  const t = useT()
  const tp = useTp()
  const attention = taskAttention(task)
  return (
    <li
      className="cursor-pointer rounded-md border border-transparent px-2.5 py-2 hover:border-border hover:bg-muted/50"
      data-testid={`task-row-${task.id}`}
      onClick={(event) => {
        // Action buttons own their click; everything else in the row selects it.
        if (!(event.target instanceof HTMLElement) || event.target.closest('button')) return
        onSelect()
      }}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        onClick={onSelect}
        title={t('tasks.row.openDetails')}
        data-testid={`task-open-detail-${task.id}`}
      >
        <span className={`shrink-0 ${taskStatusTone(task)}`}>{statusGlyph(task)}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground" title={task.prompt}>
          {task.title}
        </span>
        {attention !== null ? (
          <span className="shrink-0 rounded bg-signal-weak px-1.5 text-[9px] text-signal">
            {attention === null ? null : t(`taskAttention.${attention}`)}
          </span>
        ) : null}
        <ReviewBadge task={task} />
        {archived ? (
          <span className="shrink-0 rounded bg-muted px-1 text-[9px] text-muted-foreground">
            {t('tasks.row.archived')}
          </span>
        ) : null}
        <span className={`shrink-0 text-[9px] uppercase ${taskStatusTone(task)}`}>
          {taskStatusLabel(task)}
        </span>
      </button>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
        <span>{task.harness}</span>
        {task.dependencies !== undefined && task.dependencies.length > 0 ? (
          <span
            className={taskIsBlocked(task) ? 'text-signal' : ''}
            title={task.dependencies.map((dependency) => dependency.title).join(', ')}
            data-testid={`task-dependencies-${task.id}`}
          >
            {taskIsBlocked(task)
              ? tp('tasks.row.blockedBy', task.dependencies.filter((dependency) => !dependency.satisfied).length)
              : tp('tasks.row.after', task.dependencies.length)}
          </span>
        ) : null}
        {task.attempt > 1 ? (
          <span>{t('tasks.row.try', { count: task.attempt })}</span>
        ) : null}
        {task.attemptMode === 'resume' ? (
          <span>{`· ${t('tasks.row.continued')}`}</span>
        ) : null}
        {task.createdByActor === 'mira' ? (
          <span>{t('tasks.row.proposedByMira')}</span>
        ) : task.origin === 'supervisor' ? (
          <span>{t('tasks.row.proposedBySupervisor')}</span>
        ) : null}
        {task.sessionLive ? <span className="text-add">{t('tasks.row.sessionLive')}</span> : null}
        {task.scheduleId ? <span>{t('tasks.row.fromSchedule')}</span> : null}
        <span className="ml-auto flex items-center gap-1">
          {archived && onUnarchive ? (
            <button
              type="button"
              className="rounded border border-border px-1.5 py-0.5 text-[9px] hover:bg-muted"
              onClick={() => void onUnarchive()}
              disabled={busy}
              data-testid={`task-unarchive-${task.id}`}
            >
              {t('tasks.row.restore')}
            </button>
          ) : !archived && task.canArchive && onArchive ? (
            <button
              type="button"
              className="rounded border border-border px-1.5 py-0.5 text-[9px] text-muted-foreground hover:bg-muted"
              onClick={() => void onArchive()}
              disabled={busy}
              data-testid={`task-archive-${task.id}`}
            >
              {t('tasks.row.archive')}
            </button>
          ) : null}
          {!archived && task.canApprove ? (
            <>
              <button
                type="button"
                className="rounded border border-signal-line bg-signal-weak px-1.5 py-0.5 text-[9px] text-signal hover:bg-signal/15"
                onClick={() => void onApprove()}
                disabled={busy}
                data-testid={`task-approve-${task.id}`}
              >
                {t('tasks.row.approve')}
              </button>
              <button
                type="button"
                className="rounded border border-border px-1.5 py-0.5 text-[9px] text-muted-foreground hover:bg-muted hover:text-destructive"
                onClick={() => void onReject()}
                disabled={busy}
                data-testid={`task-reject-${task.id}`}
              >
                {t('tasks.row.reject')}
              </button>
            </>
          ) : null}
          {!task.canApprove && (task.status === 'queued' || taskIsActive(task)) ? (
            <button
              type="button"
              className="rounded border border-border px-1.5 py-0.5 text-[9px] text-muted-foreground hover:bg-muted hover:text-destructive"
              onClick={() => void onCancel()}
              disabled={busy}
              data-testid={`task-cancel-${task.id}`}
            >
              {t('tasks.row.cancel')}
            </button>
          ) : null}
          {!archived && task.canResume ? (
            <button
              type="button"
              className="rounded border border-border px-1.5 py-0.5 text-[9px] hover:bg-muted"
              onClick={() => void onResume()}
              disabled={busy}
              data-testid={`task-continue-${task.id}`}
            >
              {t('tasks.row.continue')}
            </button>
          ) : null}
          {!archived && task.canRetry ? (
            <button
              type="button"
              className="rounded border border-border px-1.5 py-0.5 text-[9px] hover:bg-muted"
              onClick={() => void onRetry()}
              disabled={busy}
              data-testid={`task-retry-${task.id}`}
            >
              {t('tasks.row.retry')}
            </button>
          ) : null}
        </span>
      </div>
      {task.error ? (
        <p className="mt-1 text-[10px] text-destructive" data-testid={`task-error-${task.id}`}>
          {task.error}
        </p>
      ) : null}
    </li>
  )
}

/**
 * The project-scoped Tasks mode.
 *
 * It receives the durable rows from the shell, filters them to this project and
 * keeps execution and judgement separate. It never shows another project's
 * task, and there is no global Tasks route to fall back into.
 */
export default function ProjectTasksView({
  repo,
  tasks,
  archivedTasks,
  sessions,
  loading,
  focusTaskId,
  focusComposerNonce,
  rememberedTaskId,
  notify,
  refreshToken,
  drafts,
  openRequest,
  onOpenRequestHandled,
  onReload,
  onTaskSelected,
  onOpenSession,
  onStopSession,
  onRestartSession,
  onRecheckSession,
  onError,
  onSendToAgent
}: Props): React.JSX.Element {
  const t = useT()
  const tp = useTp()
  const projectTasks = useMemo(
    () => tasks.filter((task) => task.repoId === repo.id),
    [repo.id, tasks]
  )
  const projectArchived = useMemo(
    () => archivedTasks.filter((task) => task.repoId === repo.id),
    [archivedTasks, repo.id]
  )
  const allProjectTasks = useMemo(
    () => [...projectTasks, ...projectArchived],
    [projectArchived, projectTasks]
  )
  const preparation = repositoryPreparationView(repo)
  const [filter, setFilter] = useState<Filter>('all')
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [attempts, setAttempts] = useState<TaskRecordPayload[]>([])
  const [composerOpen, setComposerOpen] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [harness, setHarness] = useState('claude')
  /** Blockers chosen for the next composer submission; empty means parallel. */
  const [after, setAfter] = useState<string[]>([])
  const [holdDependents, setHoldDependents] = useState(false)
  const [harnesses, setHarnesses] = useState<HarnessDetection[]>([])
  const [harnessLoading, setHarnessLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const promptRef = useRef<HTMLTextAreaElement | null>(null)
  const afterSelectRef = useRef<HTMLSelectElement | null>(null)
  /** A focus request is applied once; a task event must not reopen a closed detail. */
  const appliedFocus = useRef<string | null>(null)
  /** Report a selection to the shell once per distinct task. */
  const reportedSelection = useRef<string | null>(null)
  /**
   * IDs that have appeared in the project list at least once.
   *
   * A newly created task is selected before the reload that adds it to
   * `allProjectTasks`; without this guard the reset effect below would treat it
   * as removed and fall back to an older task.
   */
  const seenTaskIds = useRef(new Set<string>())
  const reportSelection = useCallback(
    (taskId: string): void => {
      if (reportedSelection.current === taskId) return
      reportedSelection.current = taskId
      onTaskSelected(taskId)
    },
    [onTaskSelected]
  )

  useEffect(() => {
    if (focusTaskId === null) {
      appliedFocus.current = null
      return
    }
    if (appliedFocus.current === focusTaskId) return
    if (allProjectTasks.some((task) => task.id === focusTaskId)) {
      appliedFocus.current = focusTaskId
      setSelectedTaskId(focusTaskId)
      reportSelection(focusTaskId)
    }
  }, [allProjectTasks, focusTaskId, reportSelection])

  useEffect(() => {
    if (focusComposerNonce === 0) return
    setComposerOpen(true)
    // An external "Queue task" starts a fresh draft; a follow-up sets its own
    // blocker after this effect runs.
    setAfter([])
    setHoldDependents(false)
    window.requestAnimationFrame(() => promptRef.current?.focus())
  }, [focusComposerNonce])

  useEffect(() => {
    let cancelled = false
    setHarnessLoading(true)
    void callApi<HarnessDetection[]>(window.icode.harness.list({ repoId: repo.id })).then((result) => {
      if (cancelled) return
      setHarnessLoading(false)
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      setHarnesses(result.value)
      const available = result.value.filter((entry) => entry.state === 'available')
      setHarness((current) =>
        available.some((entry) => entry.harness === current)
          ? current
          : (available[0]?.harness ?? current)
      )
    })
    return () => {
      cancelled = true
    }
  }, [notify, repo.id])

  const selectedTask = allProjectTasks.find((task) => task.id === selectedTaskId) ?? null
  const selectedSession =
    selectedTask?.sessionId === null || selectedTask?.sessionId === undefined
      ? null
      : sessions.find((session) => session.id === selectedTask.sessionId) ?? null

  /** Tasks the composer may add as blockers; archived history is not offered. */
  const afterCandidates = useMemo(
    () => projectTasks.filter((task) => !after.includes(task.id)),
    [after, projectTasks]
  )
  const afterTasks = useMemo(
    () => after.map((id) => allProjectTasks.find((task) => task.id === id)).filter((task): task is TaskRecordPayload => task !== undefined),
    [after, allProjectTasks]
  )

  const startFollowUp = useCallback((task: TaskRecordPayload): void => {
    setAfter([task.id])
    setPrompt('')
    setComposerOpen(true)
    window.requestAnimationFrame(() => promptRef.current?.focus())
  }, [])

  useEffect(() => {
    for (const task of allProjectTasks) seenTaskIds.current.add(task.id)
    if (
      selectedTaskId !== null &&
      seenTaskIds.current.has(selectedTaskId) &&
      !allProjectTasks.some((task) => task.id === selectedTaskId)
    ) {
      setSelectedTaskId(null)
    }
  }, [allProjectTasks, selectedTaskId])

  // Opening a project restores the last task used there; a new project opens
  // its oldest task rather than an empty right pane.
  useEffect(() => {
    const focusPending =
      focusTaskId !== null && allProjectTasks.some((task) => task.id === focusTaskId)
    if (selectedTaskId !== null || focusPending) return
    const preferred =
      rememberedTaskId !== null && allProjectTasks.some((task) => task.id === rememberedTaskId)
        ? rememberedTaskId
        : (allProjectTasks[0]?.id ?? null)
    if (preferred !== null) {
      setSelectedTaskId(preferred)
      reportSelection(preferred)
    }
  }, [allProjectTasks, focusTaskId, rememberedTaskId, reportSelection, selectedTaskId])

  useEffect(() => {
    const id = selectedTaskId
    if (id === null) {
      setAttempts([])
      return
    }
    let cancelled = false
    void callApi<TaskRecordPayload[]>(window.icode.tasks.history({ taskId: id })).then((result) => {
      if (!cancelled && result.ok) {
        setAttempts(result.value.filter((entry) => entry.id !== id))
      }
    })
    return () => {
      cancelled = true
    }
  }, [selectedTaskId, projectTasks])

  const groups = useMemo(() => {
    const proposal = sortQueuedTasks(
      projectTasks.filter((task) => taskGroup(task) === 'proposal')
    )
    const running = sortRunningTasks(projectTasks.filter((task) => taskGroup(task) === 'running'))
    const queued = sortQueuedTasks(projectTasks.filter((task) => taskGroup(task) === 'queued'))
    const finished = sortFinishedTasks(projectTasks.filter((task) => taskGroup(task) === 'finished'))
    const needs = [...proposal, ...running, ...finished].filter(
      (task) => taskAttention(task) !== null
    )
    // Reviewed completions and cancellations are history; a review-pending
    // completion and an un-retried failure stay in Needs.
    const historyFinished = finished.filter(
      (task) =>
        (task.status === 'completed' && task.reviewDecision !== 'pending') ||
        task.status === 'cancelled'
    )
    const history = sortFinishedTasks([...historyFinished, ...projectArchived])
    return { proposal, running, queued, finished, needs, history }
  }, [projectArchived, projectTasks])
  // History is a different working set; keep the detail pane aligned with it
  // instead of showing a Needs/review task beside a list of old work.
  useEffect(() => {
    if (filter !== 'history') return
    if (selectedTaskId !== null && groups.history.some((task) => task.id === selectedTaskId)) {
      return
    }
    const first = groups.history[0]?.id ?? null
    setSelectedTaskId(first)
    if (first !== null) reportSelection(first)
  }, [filter, groups.history, reportSelection, selectedTaskId])

  const attention = taskAttentionCounts(projectTasks)
  const archivableCount = groups.finished.filter(
    (task) =>
      (task.status === 'completed' && task.reviewDecision !== 'pending') ||
      task.status === 'cancelled'
  ).length
  const activeVisible = useMemo(
    () => [...groups.proposal, ...groups.running, ...groups.queued],
    [groups]
  )

  const visible = useMemo(() => {
    if (filter === 'needs') return groups.needs
    if (filter === 'proposal') return groups.proposal
    if (filter === 'running') return groups.running
    if (filter === 'queued') return groups.queued
    if (filter === 'finished') return groups.finished
    if (filter === 'history') return groups.history
    return activeVisible
  }, [activeVisible, filter, groups])

  const showGroup = (
    group: 'proposal' | 'running' | 'queued' | 'finished' | 'history'
  ): boolean => {
    if (filter === 'history') return group === 'history'
    if (group === 'history') return false
    // The default working list never shows finished work; History owns it.
    if (filter === 'all') return group !== 'finished'
    if (filter === group) return true
    if (filter !== 'needs') return false
    const list =
      group === 'proposal'
        ? groups.proposal
        : group === 'running'
          ? groups.running
          : group === 'finished'
            ? groups.finished
            : []
    return list.some((task) => taskAttention(task) !== null)
  }

  const groupList = (
    group: 'proposal' | 'running' | 'queued' | 'finished' | 'history'
  ): TaskRecordPayload[] =>
    group === 'proposal'
      ? groups.proposal
      : group === 'running'
        ? groups.running
        : group === 'queued'
          ? groups.queued
          : group === 'finished'
            ? groups.finished
            : groups.history

  const submit = useCallback(async (): Promise<void> => {
    if (prompt.trim().length === 0) return
    setBusyId('create')
    try {
      const result = await callApi<TaskRecordPayload>(
        window.icode.tasks.create({
          repoId: repo.id,
          prompt: prompt.trim(),
          harness: harness as never,
          ...(after.length > 0 ? { dependsOn: after } : {}),
          ...(holdDependents ? { holdDependents: true } : {})
        })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      setPrompt('')
      setAfter([])
      setHoldDependents(false)
      setComposerOpen(false)
      setSelectedTaskId(result.value.id)
      reportSelection(result.value.id)
      notify({
        tone: 'success',
        message: t('tasks.notice.queued', { title: result.value.title })
      })
      await onReload()
    } finally {
      setBusyId(null)
    }
  }, [after, harness, holdDependents, notify, onReload, prompt, repo.id, reportSelection])

  const cancel = useCallback(
    async (task: TaskRecordPayload): Promise<void> => {
      setBusyId(task.id)
      try {
        const result = await callApi<TaskRecordPayload>(window.icode.tasks.cancel({ taskId: task.id }))
        if (!result.ok) notify(errorNotice(result.error))
        else notify({ tone: 'info', message: t('tasks.notice.cancelled', { title: task.title }) })
        await onReload()
      } finally {
        setBusyId(null)
      }
    },
    [notify, onReload]
  )

  const retry = useCallback(
    async (task: TaskRecordPayload): Promise<void> => {
      setBusyId(task.id)
      try {
        const result = await callApi<TaskRecordPayload>(window.icode.tasks.retry({ taskId: task.id }))
        if (!result.ok) notify(errorNotice(result.error))
        else {
          setSelectedTaskId(result.value.id)
          reportSelection(result.value.id)
          notify({
            tone: 'success',
            message: t('tasks.notice.retrying', { count: result.value.attempt })
          })
        }
        await onReload()
      } finally {
        setBusyId(null)
      }
    },
    [notify, onReload, reportSelection]
  )

  const resume = useCallback(
    async (task: TaskRecordPayload): Promise<void> => {
      setBusyId(task.id)
      try {
        const result = await callApi<TaskRecordPayload>(window.icode.tasks.resume({ taskId: task.id }))
        if (!result.ok) notify(errorNotice(result.error))
        else {
          setSelectedTaskId(result.value.id)
          reportSelection(result.value.id)
          notify({
            tone: 'success',
            message: t('tasks.notice.continuing', { count: result.value.attempt })
          })
        }
        await onReload()
      } finally {
        setBusyId(null)
      }
    },
    [notify, onReload, reportSelection, t]
  )

  const approve = useCallback(
    async (task: TaskRecordPayload): Promise<void> => {
      setBusyId(task.id)
      try {
        const result = await callApi<TaskRecordPayload>(window.icode.tasks.approve({ taskId: task.id }))
        if (!result.ok) notify(errorNotice(result.error))
        else notify({ tone: 'success', message: t('tasks.notice.approved', { title: task.title }) })
        await onReload()
      } finally {
        setBusyId(null)
      }
    },
    [notify, onReload]
  )

  const reject = useCallback(
    async (task: TaskRecordPayload): Promise<void> => {
      setBusyId(task.id)
      try {
        const result = await callApi<TaskRecordPayload>(window.icode.tasks.reject({ taskId: task.id }))
        if (!result.ok) notify(errorNotice(result.error))
        else notify({ tone: 'info', message: t('tasks.notice.rejected', { title: task.title }) })
        await onReload()
      } finally {
        setBusyId(null)
      }
    },
    [notify, onReload]
  )

  const archive = useCallback(
    async (task: TaskRecordPayload): Promise<void> => {
      setBusyId(task.id)
      try {
        const result = await callApi<TaskRecordPayload>(
          window.icode.tasks.archive({ taskId: task.id })
        )
        if (!result.ok) notify(errorNotice(result.error))
        else notify({
          tone: 'info',
          message: t('tasks.notice.archived', { title: task.title })
        })
        await onReload()
      } finally {
        setBusyId(null)
      }
    },
    [notify, onReload]
  )

  const unarchive = useCallback(
    async (task: TaskRecordPayload): Promise<void> => {
      setBusyId(task.id)
      try {
        const result = await callApi<TaskRecordPayload>(
          window.icode.tasks.unarchive({ taskId: task.id })
        )
        if (!result.ok) notify(errorNotice(result.error))
        else notify({ tone: 'info', message: t('tasks.notice.restored', { title: task.title }) })
        await onReload()
      } finally {
        setBusyId(null)
      }
    },
    [notify, onReload]
  )

  const archiveFinished = useCallback(async (): Promise<void> => {
    setBusyId('archive-finished')
    try {
      const result = await callApi<number>(
        window.icode.tasks.archiveFinished({ repoId: repo.id })
      )
      if (!result.ok) notify(errorNotice(result.error))
      else {
        notify({
          tone: 'info',
          message:
            result.value === 0
              ? t('tasks.nothingToArchive')
              : tp('tasks.archived', result.value)
        })
      }
      await onReload()
    } finally {
      setBusyId(null)
    }
  }, [notify, onReload, repo.id])

  const groupMeta = [
    {
      key: 'proposal' as const,
      label: t('tasks.group.proposals'),
      note: t('tasks.group.needApproval', { count: groups.proposal.length })
    },
    {
      key: 'running' as const,
      label: t('tasks.group.running'),
      note: t('tasks.group.activeHere', { count: groups.running.length })
    },
    { key: 'queued' as const, label: t('tasks.group.queued'), note: null },
    { key: 'finished' as const, label: t('tasks.group.finished'), note: null },
    { key: 'history' as const, label: t('tasks.group.history'), note: null }
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col min-[900px]:flex-row" data-testid="project-tasks-view">
      <aside className="flex w-[326px] shrink-0 flex-col overflow-y-auto border-r border-border bg-card max-[900px]:max-h-[40vh] max-[900px]:w-full max-[900px]:border-b max-[900px]:border-r-0" data-testid="project-tasks-list">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <h1 className="text-[14px] font-semibold">{t('tasks.title')}</h1>
          <span className="text-[10.5px] text-muted-foreground" data-testid="tasks-summary">
            {t('tasks.summary', {
              active: activeVisible.length,
              history: groups.history.length
            })}
          </span>
          <button
            type="button"
            className={`ml-auto inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-[10.5px] ${
              filter === 'history'
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-border hover:bg-muted'
            }`}
            onClick={() => setFilter((current) => (current === 'history' ? 'all' : 'history'))}
            aria-pressed={filter === 'history'}
            data-testid="tasks-history"
          >
            {t('tasks.history')}
            <span className="text-[9px] opacity-70">{groups.history.length}</span>
          </button>
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2.5 text-[10.5px] hover:bg-muted"
            onClick={() => {
              setComposerOpen((open) => !open)
              if (!composerOpen) window.requestAnimationFrame(() => promptRef.current?.focus())
            }}
            disabled={preparation !== null}
            title={
              preparation === null
                ? undefined
                : preparation.kind === 'failed'
                  ? t('tasks.composer.retryFirstCommit')
                  : t('tasks.composer.unlock')
            }
            data-testid="task-composer-toggle"
          >
            <Plus size={10} />
            {t('tasks.queue')}
          </button>
        </div>

        {composerOpen ? (
          <div className="border-b border-border bg-card px-3 py-2.5" data-testid="task-composer">
            <div className="flex flex-wrap items-center gap-1.5">
              <select
                className="h-7 rounded border border-border bg-background px-1.5 text-[10.5px]"
                value={harness}
                onChange={(event) => setHarness(event.target.value)}
                disabled={harnessLoading}
                aria-label={t('tasks.composer.harness')}
                data-testid="task-harness"
              >
                {harnesses.length === 0 ? (
                  <option value="">{t('tasks.composer.noHarness')}</option>
                ) : null}
                {harnesses.map((entry) => (
                  <option key={entry.harness} value={entry.harness} disabled={entry.state !== 'available'}>
                    {entry.harness}
                    {entry.state === 'available' ? '' : t('tasks.composer.unavailable')}
                  </option>
                ))}
              </select>
              <span className="text-[9px] text-muted-foreground">
                {harnessLoading
                  ? t('tasks.composer.detecting')
                  : t('tasks.composer.runsOwn')}
              </span>
            </div>
            <textarea
              ref={promptRef}
              className="mt-1.5 h-16 w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-[11.5px] text-foreground outline-none placeholder:text-muted-foreground"
              placeholder={t('tasks.composer.placeholder')}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void submit()
              }}
              data-testid="task-prompt"
            />
            <div className="mt-1.5 rounded-md border border-border bg-background px-2 py-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('tasks.composer.after')}
                </span>
                {afterTasks.length === 0 ? (
                  <span className="text-[9.5px] text-muted-foreground">
                    {t('tasks.composer.afterNone')}
                  </span>
                ) : (
                  afterTasks.map((task) => (
                    <span
                      key={task.id}
                      className="inline-flex max-w-[160px] items-center gap-1 rounded border border-border bg-muted/50 px-1.5 py-0.5 text-[9.5px]"
                    >
                      <span className="truncate">{task.title}</span>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-destructive"
                        aria-label={t('tasks.composer.removeBlocker', { title: task.title })}
                        onClick={() => setAfter((current) => current.filter((id) => id !== task.id))}
                      >
                        ×
                      </button>
                    </span>
                  ))
                )}
              </div>
              {afterCandidates.length > 0 ? (
                <div className="mt-1 flex items-center gap-1.5">
                  <select
                    ref={afterSelectRef}
                    className="h-7 min-w-0 flex-1 rounded border border-border bg-card px-1.5 text-[10px]"
                    aria-label={t('tasks.composer.blocker')}
                    data-testid="task-after"
                  >
                    {afterCandidates.map((task) => (
                      <option key={task.id} value={task.id}>
                        {task.title}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="h-7 shrink-0 rounded border border-border px-1.5 text-[9.5px] hover:bg-muted"
                    onClick={() => {
                      const id = afterSelectRef.current?.value
                      if (!id) return
                      setAfter((current) => (current.includes(id) ? current : [...current, id]))
                    }}
                    data-testid="task-after-add"
                  >
                    {t('tasks.composer.addBlocker')}
                  </button>
                </div>
              ) : null}
            </div>
            <label className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <input
                type="checkbox"
                className="accent-accent"
                checked={holdDependents}
                onChange={(event) => setHoldDependents(event.target.checked)}
                data-testid="task-hold-dependents"
              />
              {t('tasks.composer.holdDependents')}
            </label>
            <div className="mt-1 flex items-center gap-2">
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-[10px] font-medium text-accent-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => void submit()}
                disabled={busyId !== null || prompt.trim().length === 0 || harnesses.length === 0}
                data-testid="task-create"
              >
                <Plus size={10} />
                {t('tasks.composer.add')}
              </button>
              <span className="text-[9px] text-muted-foreground">{shortcutLabel('Enter')}</span>
              <button
                type="button"
                className="ml-auto text-[9px] text-muted-foreground hover:text-foreground"
                onClick={() => setComposerOpen(false)}
              >
                {t('tasks.composer.close')}
              </button>
            </div>
          </div>
        ) : null}

        {attention.total > 0 ? (
          <button
            type="button"
            className={`mx-3 mt-2 flex w-[calc(100%-1.5rem)] items-center gap-2 rounded-md border px-2.5 py-1.5 text-left ${
              filter === 'needs'
                ? 'border-signal bg-signal-weak'
                : 'border-signal-line bg-signal/8 hover:bg-signal/12'
            }`}
            onClick={() => setFilter((current) => (current === 'needs' ? 'all' : 'needs'))}
            aria-pressed={filter === 'needs'}
            data-testid="tasks-attention-strip"
          >
            <AlertTriangle size={12} className="shrink-0 text-signal" />
            <span className="min-w-0 flex-1">
              <span className="block text-[10px] text-signal">
                {t('tasks.needsYou', { count: attention.total })}
              </span>
              <span className="mt-0.5 flex flex-wrap items-center gap-1 text-[9px] text-signal opacity-80">
                {[
                  attention.approval > 0
                    ? t('tasks.attention.approval', { count: attention.approval })
                    : null,
                  attention.answer > 0
                    ? t('tasks.attention.answer', { count: attention.answer })
                    : null,
                  attention.retry > 0
                    ? t('tasks.attention.retry', { count: attention.retry })
                    : null,
                  attention.blocked > 0
                    ? t('tasks.attention.blocked', { count: attention.blocked })
                    : null,
                  attention.review > 0
                    ? t('tasks.attention.review', { count: attention.review })
                    : null
                ]
                  .filter((part): part is string => part !== null)
                  .map((part, index) => (
                    <span key={part}>
                      {index > 0 ? <span className="mr-1">·</span> : null}
                      {part}
                    </span>
                  ))}
              </span>
            </span>
            <span className="shrink-0 text-[9px] text-signal">{filter === 'needs' ? t('tasks.showing') : t('tasks.view')}</span>
          </button>
        ) : null}

        <div className="flex items-center gap-2 px-3 py-1.5 text-[9px] text-muted-foreground">
          <span>
            {filter === 'history'
              ? tp('tasks.count.history', groups.history.length)
              : filter === 'all'
                ? tp('tasks.count.active', activeVisible.length)
                : t('tasks.count.inView', { count: visible.length })}
          </span>
          {filter !== 'all' ? (
            <button
              type="button"
              className="text-accent hover:underline"
              onClick={() => setFilter('all')}
              data-testid="tasks-show-all"
            >
              {t('tasks.showAll')}
            </button>
          ) : null}
        </div>

        {filter === 'history' ? (
          <div className="px-3 pb-1.5">
            <button
              type="button"
              className="w-full rounded border border-border px-2 py-1 text-[9.5px] text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => void archiveFinished()}
              disabled={busyId !== null || archivableCount === 0}
              data-testid="tasks-archive-finished"
            >
              {t('tasks.archiveAll')}
            </button>
          </div>
        ) : null}

        <div className="px-2 pb-3">
          {loading ? (
<p className="p-3 text-[11px] text-muted-foreground">{t('tasks.loading')}</p>
          ) : allProjectTasks.length === 0 ? (
            <div className="p-3 text-[11px] text-muted-foreground" data-testid="tasks-empty">
              {t('tasks.empty')}
            </div>
          ) : visible.length === 0 ? (
            <div className="p-3 text-[11px] text-muted-foreground">
              {filter === 'needs'
                ? t('tasks.emptyNeeds')
                : filter === 'history'
                  ? t('tasks.emptyHistory')
                  : t('tasks.emptyActive')}
            </div>
          ) : (
            groupMeta.map((meta) => {
              if (!showGroup(meta.key)) return null
              const totalInGroup = groupList(meta.key)
              const list =
                filter === 'needs'
                  ? totalInGroup.filter((task) => taskAttention(task) !== null)
                  : totalInGroup
              if (list.length === 0) return null
              const active = filter === meta.key
              return (
                <section key={meta.key} className="mb-2" data-testid={`tasks-${meta.key}`}>
                  <button
                    type="button"
                    className={`flex w-full items-center gap-1.5 px-1 py-1 text-left text-[9px] uppercase tracking-wide ${
                      active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
                    }`}
                    onClick={() => setFilter(active ? 'all' : meta.key)}
                    aria-pressed={active}
                    title={
                      active
                        ? t('tasks.group.showAll')
                        : t('tasks.group.showOnly', { group: meta.label })
                    }
                    data-testid={`tasks-group-${meta.key}`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${
                      meta.key === 'proposal'
                        ? 'bg-signal'
                        : meta.key === 'running'
                          ? 'bg-info'
                          : meta.key === 'queued'
                            ? 'bg-muted-foreground'
                            : 'bg-add'
                    }`} />
                    <span>{meta.label}</span>
                    <span className="normal-case tracking-normal">
                      {filter === 'needs'
                        ? t('tasks.group.countOf', {
                            shown: list.length,
                            total: totalInGroup.length
                          })
                        : list.length}
                    </span>
                    {meta.note && meta.key === 'running' ? (
                      <span className="normal-case tracking-normal text-muted-foreground">{meta.note}</span>
                    ) : null}
                  </button>
                  <ul className="space-y-1">
                    {list.map((task) => (
                      <ProjectTaskRow
                        key={task.id}
                        task={task}
                        busy={busyId === task.id}
                        onSelect={() => {
                          setSelectedTaskId(task.id)
                          reportSelection(task.id)
                        }}
                        onApprove={() => approve(task)}
                        onReject={() => reject(task)}
                        onCancel={() => cancel(task)}
                        onRetry={() => retry(task)}
                        onResume={() => resume(task)}
                        onArchive={() => archive(task)}
                        onUnarchive={() => unarchive(task)}
                        archived={task.archivedAt !== null && task.archivedAt !== undefined}
                      />
                    ))}
                  </ul>
                </section>
              )
            })
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {selectedTask ? (
          <TaskWorkbench
            key={selectedTask.id}
            task={selectedTask}
            previousAttempts={attempts}
            projectTasks={allProjectTasks}
            onSelectTask={(taskId) => {
              setSelectedTaskId(taskId)
              reportSelection(taskId)
            }}
            onQueueFollowUp={startFollowUp}
            repo={repo}
            session={selectedSession}
            notify={notify}
            refreshToken={refreshToken}
            drafts={drafts}
            openRequest={openRequest}
            onOpenRequestHandled={onOpenRequestHandled}
            onOpenSession={onOpenSession}
            onStopSession={onStopSession}
            onRestartSession={onRestartSession}
            onRecheckSession={onRecheckSession}
            onError={onError}
            onSendToAgent={onSendToAgent}
            onReload={onReload}
            onChanged={() => {
              void onReload()
              if (selectedTask.sessionId) onRecheckSession(selectedTask.sessionId)
            }}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center p-8 text-center">
            <p className="max-w-sm text-[12px] leading-relaxed text-muted-foreground">
              {t('tasks.selectTask')}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
