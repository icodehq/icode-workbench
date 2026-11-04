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
import { repositoryPreparationView } from '../lib/repository-preparation'
import type { AgentSendResult } from '../lib/agent-send'
import type { WorkbenchDraftStore } from '../review/drafts'
import type { Notice } from '../state/workspace'
import TaskWorkbench from './TaskWorkbench'
import {
  sortFinishedTasks,
  sortQueuedTasks,
  sortRunningTasks,
  taskAttention,
  taskAttentionCounts,
  taskGroup,
  taskIsActive,
  taskStatusLabel,
  taskStatusTone
} from './task-status'

type Props = {
  repo: RepositorySummary
  tasks: TaskRecordPayload[]
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

type Filter = 'all' | 'needs' | 'running' | 'queued' | 'finished'

function statusGlyph(task: TaskRecordPayload): React.JSX.Element {
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
  if (task.reviewDecision === 'accepted') {
    return <span className="shrink-0 rounded bg-add-weak px-1 text-[8px] text-add">accepted</span>
  }
  if (task.reviewDecision === 'rejected') {
    return <span className="shrink-0 rounded bg-destructive/15 px-1 text-[8px] text-destructive">rejected</span>
  }
  if (task.canDecideReview) {
    return <span className="shrink-0 rounded bg-muted px-1 text-[9px] text-muted-foreground">unreviewed</span>
  }
  return null
}

function ProjectTaskRow({
  task,
  busy,
  onSelect,
  onCancel,
  onRetry
}: {
  task: TaskRecordPayload
  busy: boolean
  onSelect: () => void
  onCancel: () => Promise<void>
  onRetry: () => Promise<void>
}): React.JSX.Element {
  const attention = taskAttention(task)
  return (
    <li className="rounded-md border border-transparent px-2.5 py-2 hover:border-border hover:bg-muted/50" data-testid={`task-row-${task.id}`}>
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        onClick={onSelect}
        title="Open task details"
        data-testid={`task-open-detail-${task.id}`}
      >
        <span className={`shrink-0 ${taskStatusTone(task)}`}>{statusGlyph(task)}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground" title={task.prompt}>
          {task.title}
        </span>
        {attention !== null ? (
          <span className="shrink-0 rounded bg-signal-weak px-1.5 text-[9px] text-signal">
            {attention}
          </span>
        ) : null}
        <ReviewBadge task={task} />
        <span className={`shrink-0 text-[9px] uppercase ${taskStatusTone(task)}`}>
          {taskStatusLabel(task)}
        </span>
      </button>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
        <span>{task.harness}</span>
        {task.attempt > 1 ? <span>· try {task.attempt}</span> : null}
        {task.sessionLive ? <span className="text-add">· session live</span> : null}
        {task.scheduleId ? <span>· from a schedule</span> : null}
        <span className="ml-auto flex items-center gap-1">

          {task.status === 'queued' || taskIsActive(task) ? (
            <button
              type="button"
              className="rounded border border-border px-1.5 py-0.5 text-[9px] text-muted-foreground hover:bg-muted hover:text-destructive"
              onClick={() => void onCancel()}
              disabled={busy}
              data-testid={`task-cancel-${task.id}`}
            >
              Cancel
            </button>
          ) : null}
          {task.canRetry ? (
            <button
              type="button"
              className="rounded border border-border px-1.5 py-0.5 text-[9px] hover:bg-muted"
              onClick={() => void onRetry()}
              disabled={busy}
              data-testid={`task-retry-${task.id}`}
            >
              Retry
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
  const projectTasks = useMemo(
    () => tasks.filter((task) => task.repoId === repo.id),
    [repo.id, tasks]
  )
  const preparation = repositoryPreparationView(repo)
  const [filter, setFilter] = useState<Filter>('all')
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [attempts, setAttempts] = useState<TaskRecordPayload[]>([])
  const [composerOpen, setComposerOpen] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [harness, setHarness] = useState('claude')
  const [harnesses, setHarnesses] = useState<HarnessDetection[]>([])
  const [harnessLoading, setHarnessLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const promptRef = useRef<HTMLTextAreaElement | null>(null)
  /** A focus request is applied once; a task event must not reopen a closed detail. */
  const appliedFocus = useRef<string | null>(null)
  /** Report a selection to the shell once per distinct task. */
  const reportedSelection = useRef<string | null>(null)
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
    if (projectTasks.some((task) => task.id === focusTaskId)) {
      appliedFocus.current = focusTaskId
      setSelectedTaskId(focusTaskId)
      reportSelection(focusTaskId)
    }
  }, [focusTaskId, projectTasks, reportSelection])

  useEffect(() => {
    if (focusComposerNonce === 0) return
    setComposerOpen(true)
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

  const selectedTask = projectTasks.find((task) => task.id === selectedTaskId) ?? null
  const selectedSession =
    selectedTask?.sessionId === null || selectedTask?.sessionId === undefined
      ? null
      : sessions.find((session) => session.id === selectedTask.sessionId) ?? null

  useEffect(() => {
    if (selectedTaskId !== null && !projectTasks.some((task) => task.id === selectedTaskId)) {
      setSelectedTaskId(null)
    }
  }, [projectTasks, selectedTaskId])

  // Opening a project restores the last task used there; a new project opens
  // its oldest task rather than an empty right pane.
  useEffect(() => {
    const focusPending =
      focusTaskId !== null && projectTasks.some((task) => task.id === focusTaskId)
    if (selectedTaskId !== null || focusPending) return
    const preferred =
      rememberedTaskId !== null && projectTasks.some((task) => task.id === rememberedTaskId)
        ? rememberedTaskId
        : (projectTasks[0]?.id ?? null)
    if (preferred !== null) {
      setSelectedTaskId(preferred)
      reportSelection(preferred)
    }
  }, [focusTaskId, projectTasks, rememberedTaskId, reportSelection, selectedTaskId])

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
    const running = sortRunningTasks(projectTasks.filter((task) => taskGroup(task) === 'running'))
    const queued = sortQueuedTasks(projectTasks.filter((task) => taskGroup(task) === 'queued'))
    const finished = sortFinishedTasks(projectTasks.filter((task) => taskGroup(task) === 'finished'))
    const needs = [...running, ...finished].filter((task) => taskAttention(task) !== null)
    return { running, queued, finished, needs }
  }, [projectTasks])
  const attention = taskAttentionCounts(projectTasks)

  const visible = useMemo(() => {
    if (filter === 'needs') return groups.needs
    if (filter === 'running') return groups.running
    if (filter === 'queued') return groups.queued
    if (filter === 'finished') return groups.finished
    return projectTasks
  }, [filter, groups, projectTasks])

  const showGroup = (group: 'running' | 'queued' | 'finished'): boolean => {
    if (filter === 'all' || filter === group) return true
    if (filter !== 'needs') return false
    const list = group === 'running' ? groups.running : groups.finished
    return list.some((task) => taskAttention(task) !== null)
  }

  const groupList = (group: 'running' | 'queued' | 'finished'): TaskRecordPayload[] =>
    group === 'running' ? groups.running : group === 'queued' ? groups.queued : groups.finished

  const submit = useCallback(async (): Promise<void> => {
    if (prompt.trim().length === 0) return
    setBusyId('create')
    try {
      const result = await callApi<TaskRecordPayload>(
        window.icode.tasks.create({
          repoId: repo.id,
          prompt: prompt.trim(),
          harness: harness as never
        })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      setPrompt('')
      setComposerOpen(false)
      setSelectedTaskId(result.value.id)
      reportSelection(result.value.id)
      notify({ tone: 'success', message: `Queued: ${result.value.title}` })
      await onReload()
    } finally {
      setBusyId(null)
    }
  }, [harness, notify, onReload, prompt, repo.id, reportSelection])

  const cancel = useCallback(
    async (task: TaskRecordPayload): Promise<void> => {
      setBusyId(task.id)
      try {
        const result = await callApi<TaskRecordPayload>(window.icode.tasks.cancel({ taskId: task.id }))
        if (!result.ok) notify(errorNotice(result.error))
        else notify({ tone: 'info', message: `Cancelled ${task.title}` })
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
          notify({ tone: 'success', message: `Retrying as attempt ${String(result.value.attempt)}` })
        }
        await onReload()
      } finally {
        setBusyId(null)
      }
    },
    [notify, onReload, reportSelection]
  )

  const groupMeta = [
    { key: 'running' as const, label: 'Running', note: `${String(groups.running.length)} active here` },
    { key: 'queued' as const, label: 'Queued', note: null },
    { key: 'finished' as const, label: 'Finished', note: null }
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col min-[900px]:flex-row" data-testid="project-tasks-view">
      <aside className="flex w-[326px] shrink-0 flex-col overflow-y-auto border-r border-border bg-card max-[900px]:max-h-[40vh] max-[900px]:w-full max-[900px]:border-b max-[900px]:border-r-0" data-testid="project-tasks-list">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <h1 className="text-[14px] font-semibold">Tasks</h1>
          <span className="text-[10.5px] text-muted-foreground" data-testid="tasks-summary">
            {projectTasks.length} task{projectTasks.length === 1 ? '' : 's'} in {repo.displayName}
          </span>
          <button
            type="button"
            className="ml-auto inline-flex h-7 items-center gap-1 rounded-md border border-border px-2.5 text-[10.5px] hover:bg-muted"
            onClick={() => {
              setComposerOpen((open) => !open)
              if (!composerOpen) window.requestAnimationFrame(() => promptRef.current?.focus())
            }}
            disabled={preparation !== null}
            title={
              preparation === null
                ? undefined
                : preparation.kind === 'failed'
                  ? 'Retry the first commit from Projects before creating a task.'
                  : 'Tasks unlock when the first commit finishes.'
            }
            data-testid="task-composer-toggle"
          >
            <Plus size={10} />
            Queue task
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
                aria-label="Harness"
                data-testid="task-harness"
              >
                {harnesses.length === 0 ? <option value="">No Harness detected</option> : null}
                {harnesses.map((entry) => (
                  <option key={entry.harness} value={entry.harness} disabled={entry.state !== 'available'}>
                    {entry.harness}
                    {entry.state === 'available' ? '' : ' (unavailable)'}
                  </option>
                ))}
              </select>
              <span className="text-[9px] text-muted-foreground">
                {harnessLoading ? 'Detecting Harnesses…' : 'Runs in its own worktree and session.'}
              </span>
            </div>
            <textarea
              ref={promptRef}
              className="mt-1.5 h-16 w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-[11.5px] text-foreground outline-none placeholder:text-muted-foreground"
              placeholder="What should the agent do? The task runs unattended in its own worktree."
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void submit()
              }}
              data-testid="task-prompt"
            />
            <div className="mt-1 flex items-center gap-2">
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-[10px] font-medium text-accent-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => void submit()}
                disabled={busyId !== null || prompt.trim().length === 0 || harnesses.length === 0}
                data-testid="task-create"
              >
                <Plus size={10} />
                Add to queue
              </button>
              <span className="text-[9px] text-muted-foreground">Ctrl+Enter</span>
              <button
                type="button"
                className="ml-auto text-[9px] text-muted-foreground hover:text-foreground"
                onClick={() => setComposerOpen(false)}
              >
                Close
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
                {attention.total} need you
              </span>
              <span className="mt-0.5 flex flex-wrap items-center gap-1 text-[9px] text-signal opacity-80">
                {attention.answer > 0 ? <span>Answer {attention.answer}</span> : null}
                {attention.answer > 0 && (attention.retry > 0 || attention.review > 0) ? <span>·</span> : null}
                {attention.retry > 0 ? <span>Retry {attention.retry}</span> : null}
                {attention.retry > 0 && attention.review > 0 ? <span>·</span> : null}
                {attention.review > 0 ? <span>Review {attention.review}</span> : null}
              </span>
            </span>
            <span className="shrink-0 text-[9px] text-signal">{filter === 'needs' ? 'Showing' : 'View'}</span>
          </button>
        ) : null}

        <div className="flex items-center gap-2 px-3 py-1.5 text-[9px] text-muted-foreground">
          <span>
            {filter === 'all'
              ? `${String(projectTasks.length)} task${projectTasks.length === 1 ? '' : 's'}`
              : `${String(visible.length)} of ${String(projectTasks.length)} tasks`}
          </span>
          {filter !== 'all' ? (
            <button
              type="button"
              className="text-accent hover:underline"
              onClick={() => setFilter('all')}
              data-testid="tasks-show-all"
            >
              Show all
            </button>
          ) : null}
          <span className="ml-auto flex items-center gap-2">
            <span>{groups.running.length} running</span>
            <span>·</span>
            <span>{groups.queued.length} queued</span>
            <span>·</span>
            <span>{groups.finished.length} finished</span>
          </span>
        </div>

        <div className="px-2 pb-3">
          {loading ? (
            <p className="p-3 text-[11px] text-muted-foreground">Reading the queue…</p>
          ) : projectTasks.length === 0 ? (
            <div className="p-3 text-[11px] text-muted-foreground" data-testid="tasks-empty">
              No tasks yet. Queue one for unattended work.
            </div>
          ) : visible.length === 0 ? (
            <div className="p-3 text-[11px] text-muted-foreground">
              {filter === 'needs' ? 'Nothing needs you right now.' : 'No tasks in this view.'}
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
                    title={active ? 'Show all tasks' : `Show only ${meta.label.toLowerCase()}`}
                    data-testid={`tasks-group-${meta.key}`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${
                      meta.key === 'running' ? 'bg-info' : meta.key === 'queued' ? 'bg-muted-foreground' : 'bg-add'
                    }`} />
                    <span>{meta.label}</span>
                    <span className="normal-case tracking-normal">
                      {filter === 'needs' ? `${String(list.length)} of ${String(totalInGroup.length)}` : String(list.length)}
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
                        onCancel={() => cancel(task)}
                        onRetry={() => retry(task)}
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
              Select a task to open its Overview, Terminal, Changes and Files.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
