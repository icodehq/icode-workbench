import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Ban,
  CheckCircle2,
  Clock,
  GitBranch,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Terminal,
  XCircle
} from 'lucide-react'
import { callApi, errorNotice } from '../lib/api'
import type { TaskRecordPayload, TaskSchedulePayload } from '../../../shared/ade-api'
import type { RepositorySummary } from '../../../shared/schemas/ipc'
import type { HarnessDetection } from '../../../shared/domain/harness'
import type { Notice } from '../state/workspace'
import TaskDetail from './TaskDetail'

export type TasksViewProps = {
  repos: RepositorySummary[]
  activeRepoId: string | null
  notify: (notice: Notice) => void
  /** Opens the session a task is bound to. */
  onOpenSession: (sessionId: string) => void
  /** Opens the review panel for a task's session. */
  onReviewChanges: (sessionId: string) => void
}

type FormState = {
  repoId: string
  prompt: string
  harness: string
}

/**
 * The task queue.
 *
 * Its job is to answer three questions without the user opening a terminal:
 * what is waiting, what is running, and what did it leave behind. Everything
 * shown here comes from a durable row — the view holds no state a restart would
 * lose, so closing ADE cannot make the queue disagree with itself.
 */
export default function TasksView({
  repos,
  activeRepoId,
  notify,
  onOpenSession,
  onReviewChanges
}: TasksViewProps): React.JSX.Element {
  const [tasks, setTasks] = useState<TaskRecordPayload[]>([])
  const [schedules, setSchedules] = useState<TaskSchedulePayload[]>([])
  const [maxConcurrent, setMaxConcurrent] = useState(1)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>({
    repoId: activeRepoId ?? repos[0]?.id ?? '',
    prompt: '',
    harness: 'claude'
  })
  /**
   * Detection results, stamped with the repository they belong to.
   *
   * Without the stamp, switching repository shows the previous repo's list for
   * a moment and the defaulting effect rewrites the user's harness pick from
   * that stale list — a choice that then looks like it "did not take".
   */
  const [harnesses, setHarnesses] = useState<{
    repoId: string
    list: HarnessDetection[]
  } | null>(null)
  const [tab, setTab] = useState<'queue' | 'schedules'>('queue')
  /** The task whose detail is open. Held by id so it re-reads after a change. */
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [attempts, setAttempts] = useState<TaskRecordPayload[]>([])
  const [scheduleForm, setScheduleForm] = useState({
    prompt: '',
    title: '',
    shape: 'daily',
    hour: 4,
    minute: 0,
    every: 6 as 1 | 2 | 3 | 4 | 6 | 8 | 12,
    day: 1,
    runAtLocal: '',
    overlap: 'queue' as 'queue' | 'skip'
  })
  const mounted = useRef(true)
  /**
   * Actions already in flight, keyed by target.
   *
   * A `disabled` attribute only takes effect after a re-render, so two clicks in
   * the same tick both pass it — which queued two runs of one schedule during
   * verification. This ref is synchronous and closes that gap; the database's
   * occurrence receipt remains the guarantee for scheduled instants.
   */
  const inFlight = useRef(new Set<string>())

  const guarded = useCallback(async (key: string, work: () => Promise<void>): Promise<void> => {
    if (inFlight.current.has(key)) return
    inFlight.current.add(key)
    try {
      await work()
    } finally {
      inFlight.current.delete(key)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (activeRepoId && form.repoId === '') setForm((current) => ({ ...current, repoId: activeRepoId }))
  }, [activeRepoId, form.repoId])

  const load = useCallback(async (): Promise<void> => {
    const [tasksResult, schedulesResult, settingsResult] = await Promise.all([
      callApi<TaskRecordPayload[]>(window.ade.tasks.list({ limit: 200 })),
      callApi<TaskSchedulePayload[]>(window.ade.schedules.list({})),
      callApi<{ maxConcurrent: number }>(window.ade.tasks.settings())
    ])
    if (!mounted.current) return
    if (tasksResult.ok) setTasks(tasksResult.value)
    if (schedulesResult.ok) setSchedules(schedulesResult.value)
    if (settingsResult.ok) setMaxConcurrent(settingsResult.value.maxConcurrent)
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Main says when the queue changed; polling would either lag or burn cycles.
  useEffect(() => window.ade.onTaskEvent(() => void load()), [load])

  const repoId = form.repoId || activeRepoId || repos[0]?.id || ''

  useEffect(() => {
    if (!repoId) return
    let cancelled = false
    void callApi<HarnessDetection[]>(window.ade.harness.list({ repoId })).then((result) => {
      if (cancelled || !result.ok) return
      setHarnesses({ repoId, list: result.value })
      const available = result.value.filter((entry) => entry.state === 'available')
      setForm((current) => {
        // Keep an explicit pick when it can run in THIS repository; only fall
        // back when the chosen harness is genuinely unavailable here.
        const keep = available.some((entry) => entry.harness === current.harness)
        return keep ? current : { ...current, harness: available[0]?.harness ?? current.harness }
      })
    })
    return () => {
      cancelled = true
    }
  }, [repoId])

  const groups = useMemo(() => {
    const byStatus = (status: TaskRecordPayload['status']): TaskRecordPayload[] =>
      tasks.filter((task) => task.status === status)
    return {
      active: tasks.filter((task) => ['dispatching', 'running', 'waiting'].includes(task.status)),
      queued: byStatus('queued'),
      completed: byStatus('completed'),
      failed: byStatus('failed'),
      cancelled: byStatus('cancelled')
    }
  }, [tasks])

  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null

  /**
   * Loads the retry chain for the open task.
   *
   * Attempts are fetched rather than filtered from the list: the list is
   * windowed to 200 rows and a chain can outlive that window.
   */
  useEffect(() => {
    const id = selectedTaskId
    if (!id) {
      setAttempts([])
      return
    }
    let cancelled = false
    void callApi<TaskRecordPayload[]>(window.ade.tasks.history({ taskId: id })).then((result) => {
      if (cancelled || !result.ok) return
      setAttempts(result.value.filter((entry) => entry.id !== id))
    })
    return () => {
      cancelled = true
    }
  }, [selectedTaskId, tasks])

  const repoName = (id: string): string =>
    repos.find((repo) => repo.id === id)?.displayName ?? 'unknown repository'

  const submit = (): Promise<void> =>
    guarded('create', async () => {
      await submitUnguarded()
    })

  const submitUnguarded = async (): Promise<void> => {
    if (repoId === '' || form.prompt.trim().length === 0) {
      notify({ tone: 'error', message: 'Choose a repository and describe the task.' })
      return
    }
    setBusyId('create')
    try {
      const result = await callApi<TaskRecordPayload>(
        window.ade.tasks.create({
          repoId,
          prompt: form.prompt,
          harness: form.harness as never
        })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      setForm((current) => ({ ...current, prompt: '' }))
      notify({ tone: 'success', message: `Queued: ${result.value.title}` })
      await load()
    } finally {
      setBusyId(null)
    }
  }

  const cancel = (task: TaskRecordPayload): Promise<void> =>
    guarded(`cancel:${task.id}`, async () => {
      await cancelUnguarded(task)
    })

  const cancelUnguarded = async (task: TaskRecordPayload): Promise<void> => {
    setBusyId(task.id)
    try {
      const result = await callApi<TaskRecordPayload>(window.ade.tasks.cancel({ taskId: task.id }))
      if (!result.ok) notify(errorNotice(result.error))
      else notify({ tone: 'info', message: `Cancelled ${task.title}` })
      await load()
    } finally {
      setBusyId(null)
    }
  }

  const retry = (task: TaskRecordPayload): Promise<void> =>
    guarded(`retry:${task.id}`, async () => {
      await retryUnguarded(task)
    })

  const retryUnguarded = async (task: TaskRecordPayload): Promise<void> => {
    setBusyId(task.id)
    try {
      const result = await callApi<TaskRecordPayload>(window.ade.tasks.retry({ taskId: task.id }))
      if (!result.ok) notify(errorNotice(result.error))
      else notify({ tone: 'success', message: `Retrying as attempt ${String(result.value.attempt)}` })
      await load()
    } finally {
      setBusyId(null)
    }
  }

  const changeConcurrency = async (value: number): Promise<void> => {
    const result = await callApi<number>(window.ade.tasks.setSettings({ maxConcurrent: value }))
    if (!result.ok) notify(errorNotice(result.error))
    else setMaxConcurrent(result.value)
    await load()
  }

  const createSchedule = (): Promise<void> =>
    guarded('schedule-create', async () => {
      await createScheduleUnguarded()
    })

  const createScheduleUnguarded = async (): Promise<void> => {
    if (scheduleForm.prompt.trim().length === 0) {
      notify({ tone: 'error', message: 'A schedule needs an instruction.' })
      return
    }
    setBusyId('schedule')
    try {
      const result = await callApi<TaskSchedulePayload>(
        window.ade.schedules.create({
          repoId,
          prompt: scheduleForm.prompt,
          ...(scheduleForm.title.trim() ? { title: scheduleForm.title.trim() } : {}),
          harness: form.harness as never,
          overlap: scheduleForm.overlap,
          shape:
            scheduleForm.shape === 'once'
              ? {
                  type: 'once',
                  // `datetime-local` has no zone; the machine's zone is the point.
                  runAt: scheduleForm.runAtLocal
                    ? new Date(scheduleForm.runAtLocal).getTime()
                    : undefined
                }
              : scheduleForm.shape === 'hours'
                ? { type: 'hours', every: scheduleForm.every }
                : scheduleForm.shape === 'weekly'
                  ? { type: 'weekly', day: scheduleForm.day, hour: scheduleForm.hour, minute: scheduleForm.minute }
                  : {
                      type: scheduleForm.shape as 'daily' | 'weekdays',
                      hour: scheduleForm.hour,
                      minute: scheduleForm.minute
                    }
        })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      setScheduleForm((current) => ({ ...current, prompt: '', title: '' }))
      notify({ tone: 'success', message: `Scheduled: ${result.value.title}` })
      await load()
    } finally {
      setBusyId(null)
    }
  }

  const toggleSchedule = (schedule: TaskSchedulePayload): Promise<void> =>
    guarded(`toggle:${schedule.id}`, async () => {
      await toggleScheduleUnguarded(schedule)
    })

  const toggleScheduleUnguarded = async (schedule: TaskSchedulePayload): Promise<void> => {
    setBusyId(schedule.id)
    try {
      const result = await callApi<TaskSchedulePayload>(
        window.ade.schedules.setEnabled({ scheduleId: schedule.id, enabled: !schedule.enabled })
      )
      if (!result.ok) notify(errorNotice(result.error))
      await load()
    } finally {
      setBusyId(null)
    }
  }

  const runScheduleNow = (schedule: TaskSchedulePayload): Promise<void> =>
    guarded(`run:${schedule.id}`, async () => {
      await runScheduleNowUnguarded(schedule)
    })

  const runScheduleNowUnguarded = async (schedule: TaskSchedulePayload): Promise<void> => {
    setBusyId(schedule.id)
    try {
      const result = await callApi<{ result: string; taskId?: string }>(
        window.ade.schedules.runNow({ scheduleId: schedule.id })
      )
      if (!result.ok) notify(errorNotice(result.error))
      else if (result.value.result === 'created') {
        notify({ tone: 'success', message: `Queued a run of ${schedule.title}` })
      } else {
        notify({ tone: 'info', message: `Nothing was queued (${result.value.result}).` })
      }
      await load()
    } finally {
      setBusyId(null)
    }
  }

  const removeSchedule = async (schedule: TaskSchedulePayload): Promise<void> => {
    setBusyId(schedule.id)
    try {
      const result = await callApi<null>(window.ade.schedules.remove({ scheduleId: schedule.id }))
      if (!result.ok) notify(errorNotice(result.error))
      await load()
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-1" data-testid="tasks-view">
      <div className="min-w-0 flex-1 overflow-y-auto" data-testid="tasks-list-column">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <h1 className="text-[13px] font-semibold">Tasks</h1>
          <span className="text-[10px] text-muted-foreground" data-testid="tasks-summary">
            {String(groups.active.length)} active · {String(groups.queued.length)} queued ·{' '}
            {String(groups.completed.length)} completed · {String(groups.failed.length)} failed
          </span>
          <div className="ml-auto flex items-center gap-1">
            <label className="text-[9px] text-muted-foreground" htmlFor="task-concurrency">
              Run at once
            </label>
            <select
              id="task-concurrency"
              className="h-6 rounded border border-border bg-transparent px-1 text-[10px]"
              data-testid="tasks-concurrency"
              value={maxConcurrent}
              onChange={(event) => void changeConcurrency(Number(event.target.value))}
            >
              {[1, 2, 3, 4].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => void load()}
              title="Refresh"
              data-testid="tasks-refresh"
            >
              <RefreshCw size={11} />
            </button>
          </div>
        </div>

        <div className="flex gap-1 border-b border-border px-3 py-1.5">
          {(['queue', 'schedules'] as const).map((name) => (
            <button
              key={name}
              type="button"
              className={`rounded px-2 py-0.5 text-[10px] ${
                tab === name ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setTab(name)}
              data-testid={`tasks-tab-${name}`}
            >
              {name === 'queue' ? `Queue (${String(tasks.length)})` : `Schedules (${String(schedules.length)})`}
            </button>
          ))}
        </div>

        {tab === 'queue' ? (
          <>
            <div className="border-b border-border px-3 py-2" data-testid="task-composer">
              <div className="flex items-center gap-1">
                <select
                  className="h-6 max-w-[220px] rounded border border-border bg-transparent px-1 text-[10px]"
                  data-testid="task-repo"
                  value={repoId}
                  onChange={(event) => setForm((current) => ({ ...current, repoId: event.target.value }))}
                >
                  {repos.map((repo) => (
                    <option key={repo.id} value={repo.id}>
                      {repo.displayName}
                    </option>
                  ))}
                </select>
                <select
                  className="h-6 rounded border border-border bg-transparent px-1 text-[10px]"
                  data-testid="task-harness"
                  value={form.harness}
                  onChange={(event) => setForm((current) => ({ ...current, harness: event.target.value }))}
                >
                  {(harnesses?.repoId === repoId ? harnesses.list : []).map((entry) => (
                    <option key={entry.harness} value={entry.harness} disabled={entry.state !== 'available'}>
                      {entry.harness}
                      {entry.state === 'available' ? '' : ' (unavailable)'}
                    </option>
                  ))}
                </select>
                <span className="text-[9px] text-muted-foreground">queued, then started automatically</span>
              </div>
              <textarea
                className="mt-1.5 h-16 w-full resize-none rounded border border-border bg-transparent px-2 py-1 text-[11px] text-foreground outline-none placeholder:text-muted-foreground"
                placeholder="What should the agent do? The task runs in its own session and worktree."
                data-testid="task-prompt"
                value={form.prompt}
                onChange={(event) => setForm((current) => ({ ...current, prompt: event.target.value }))}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void submit()
                }}
              />
              <div className="mt-1 flex items-center gap-2">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-foreground hover:bg-muted disabled:opacity-40"
                  onClick={() => void submit()}
                  disabled={busyId !== null || repoId === '' || form.prompt.trim().length === 0}
                  data-testid="task-create"
                >
                  <Plus size={11} />
                  Queue task
                </button>
                <span className="text-[9px] text-muted-foreground">Ctrl+Enter</span>
              </div>
            </div>

            {loading ? (
              <p className="p-3 text-[11px] text-muted-foreground">Reading the queue…</p>
            ) : tasks.length === 0 ? (
              <p className="p-3 text-[11px] text-muted-foreground" data-testid="tasks-empty">
                No tasks yet. A task runs on its own, so you do not have to keep its terminal open.
              </p>
            ) : (
              <div className="px-2 py-2">
                {groups.active.length > 0 ? (
                  <Section title="Active" testId="tasks-active">
                    {groups.active.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        repoName={repoName(task.repoId)}
                        busy={busyId === task.id}
                        onCancel={cancel}
                        onRetry={retry}
                        onOpenSession={onOpenSession}
                        onReview={onReviewChanges}
                        onSelect={() => setSelectedTaskId(task.id)}
                        selected={selectedTaskId === task.id}
                      />
                    ))}
                  </Section>
                ) : null}
                {groups.queued.length > 0 ? (
                  <Section title="Queued" testId="tasks-queued">
                    {groups.queued.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        repoName={repoName(task.repoId)}
                        busy={busyId === task.id}
                        onCancel={cancel}
                        onRetry={retry}
                        onOpenSession={onOpenSession}
                        onReview={onReviewChanges}
                        onSelect={() => setSelectedTaskId(task.id)}
                        selected={selectedTaskId === task.id}
                      />
                    ))}
                  </Section>
                ) : null}
                {groups.failed.length > 0 ? (
                  <Section title="Failed" testId="tasks-failed">
                    {groups.failed.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        repoName={repoName(task.repoId)}
                        busy={busyId === task.id}
                        onCancel={cancel}
                        onRetry={retry}
                        onOpenSession={onOpenSession}
                        onReview={onReviewChanges}
                        onSelect={() => setSelectedTaskId(task.id)}
                        selected={selectedTaskId === task.id}
                      />
                    ))}
                  </Section>
                ) : null}
                {groups.completed.length > 0 ? (
                  <Section title="Completed" testId="tasks-completed">
                    {groups.completed.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        repoName={repoName(task.repoId)}
                        busy={busyId === task.id}
                        onCancel={cancel}
                        onRetry={retry}
                        onOpenSession={onOpenSession}
                        onReview={onReviewChanges}
                        onSelect={() => setSelectedTaskId(task.id)}
                        selected={selectedTaskId === task.id}
                      />
                    ))}
                  </Section>
                ) : null}
                {groups.cancelled.length > 0 ? (
                  <Section title="Cancelled" testId="tasks-cancelled">
                    {groups.cancelled.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        repoName={repoName(task.repoId)}
                        busy={busyId === task.id}
                        onCancel={cancel}
                        onRetry={retry}
                        onOpenSession={onOpenSession}
                        onReview={onReviewChanges}
                        onSelect={() => setSelectedTaskId(task.id)}
                        selected={selectedTaskId === task.id}
                      />
                    ))}
                  </Section>
                ) : null}
              </div>
            )}
          </>
        ) : (
          <div className="px-3 py-2" data-testid="schedules-panel">
            <div className="rounded border border-border p-2" data-testid="schedule-composer">
              <div className="flex flex-wrap items-center gap-1">
                <input
                  className="h-6 min-w-[160px] flex-1 rounded border border-border bg-transparent px-1 text-[10px]"
                  placeholder="Optional name"
                  data-testid="schedule-title"
                  value={scheduleForm.title}
                  onChange={(event) =>
                    setScheduleForm((current) => ({ ...current, title: event.target.value }))
                  }
                />
                <select
                  className="h-6 rounded border border-border bg-transparent px-1 text-[10px]"
                  data-testid="schedule-shape"
                  value={scheduleForm.shape}
                  onChange={(event) =>
                    setScheduleForm((current) => ({ ...current, shape: event.target.value }))
                  }
                >
                  <option value="once">once</option>
                  <option value="daily">daily</option>
                  <option value="weekdays">weekdays</option>
                  <option value="weekly">weekly</option>
                  <option value="hours">every N hours</option>
                </select>
                {scheduleForm.shape === 'once' ? (
                  <input
                    type="datetime-local"
                    className="h-6 rounded border border-border bg-transparent px-1 text-[10px]"
                    data-testid="schedule-run-at"
                    value={scheduleForm.runAtLocal}
                    onChange={(event) =>
                      setScheduleForm((current) => ({ ...current, runAtLocal: event.target.value }))
                    }
                  />
                ) : scheduleForm.shape === 'hours' ? (
                  <select
                    className="h-6 rounded border border-border bg-transparent px-1 text-[10px]"
                    data-testid="schedule-every"
                    value={scheduleForm.every}
                    onChange={(event) =>
                      setScheduleForm((current) => ({ ...current, every: Number(event.target.value) as 1 }))
                    }
                  >
                    {[1, 2, 3, 4, 6, 8, 12].map((value) => (
                      <option key={value} value={value}>
                        {value}h
                      </option>
                    ))}
                  </select>
                ) : (
                  <>
                    <input
                      type="number"
                      min={0}
                      max={23}
                      className="h-6 w-14 rounded border border-border bg-transparent px-1 text-[10px]"
                      data-testid="schedule-hour"
                      value={scheduleForm.hour}
                      onChange={(event) =>
                        setScheduleForm((current) => ({ ...current, hour: Number(event.target.value) }))
                      }
                    />
                    <span className="text-[10px] text-muted-foreground">:</span>
                    <input
                      type="number"
                      min={0}
                      max={59}
                      className="h-6 w-14 rounded border border-border bg-transparent px-1 text-[10px]"
                      data-testid="schedule-minute"
                      value={scheduleForm.minute}
                      onChange={(event) =>
                        setScheduleForm((current) => ({ ...current, minute: Number(event.target.value) }))
                      }
                    />
                    {scheduleForm.shape === 'weekly' ? (
                      <select
                        className="h-6 rounded border border-border bg-transparent px-1 text-[10px]"
                        data-testid="schedule-day"
                        value={scheduleForm.day}
                        onChange={(event) =>
                          setScheduleForm((current) => ({ ...current, day: Number(event.target.value) }))
                        }
                      >
                        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((name, index) => (
                          <option key={name} value={index + 1}>
                            {name}
                          </option>
                        ))}
                      </select>
                    ) : null}
                  </>
                )}
                <select
                  className="h-6 rounded border border-border bg-transparent px-1 text-[10px]"
                  data-testid="schedule-overlap"
                  value={scheduleForm.overlap}
                  onChange={(event) =>
                    setScheduleForm((current) => ({
                      ...current,
                      overlap: event.target.value as 'queue' | 'skip'
                    }))
                  }
                >
                  <option value="queue">if busy: queue anyway</option>
                  <option value="skip">if busy: skip this run</option>
                </select>
              </div>
              <textarea
                className="mt-1.5 h-12 w-full resize-none rounded border border-border bg-transparent px-2 py-1 text-[11px] outline-none placeholder:text-muted-foreground"
                placeholder="Instruction for each run"
                data-testid="schedule-prompt"
                value={scheduleForm.prompt}
                onChange={(event) =>
                  setScheduleForm((current) => ({ ...current, prompt: event.target.value }))
                }
              />
              <button
                type="button"
                className="mt-1 inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] hover:bg-muted disabled:opacity-40"
                onClick={() => void createSchedule()}
                disabled={busyId !== null || scheduleForm.prompt.trim().length === 0}
                data-testid="schedule-create"
              >
                <Clock size={11} />
                Add schedule
              </button>
            </div>

            {schedules.length === 0 ? (
              <p className="mt-3 text-[11px] text-muted-foreground" data-testid="schedules-empty">
                No schedules. Each occurrence becomes an ordinary task in the queue.
              </p>
            ) : (
              <ul className="mt-2 space-y-1">
                {schedules.map((schedule) => (
                  <li
                    key={schedule.id}
                    className="rounded border border-border px-2 py-1.5"
                    data-testid={`schedule-row-${schedule.id}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">
                        {schedule.title}
                      </span>
                      <span
                        className={`rounded px-1 text-[9px] ${
                          schedule.enabled ? 'bg-add-weak text-add' : 'bg-muted text-muted-foreground'
                        }`}
                        data-testid={`schedule-state-${schedule.id}`}
                      >
                        {schedule.enabled ? 'enabled' : 'paused'}
                      </span>
                      <span className="shrink-0 text-[9px] text-muted-foreground">{schedule.label}</span>
                      <button
                        type="button"
                        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                        title={schedule.enabled ? 'Pause' : 'Resume'}
                        data-testid={`schedule-toggle-${schedule.id}`}
                        disabled={busyId === schedule.id}
                        onClick={() => void toggleSchedule(schedule)}
                      >
                        {schedule.enabled ? <Pause size={10} /> : <Play size={10} />}
                      </button>
                      <button
                        type="button"
                        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                        title="Run now"
                        data-testid={`schedule-run-${schedule.id}`}
                        disabled={busyId === schedule.id}
                        onClick={() => void runScheduleNow(schedule)}
                      >
                        <RotateCcw size={10} />
                      </button>
                      <button
                        type="button"
                        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                        title="Delete schedule"
                        data-testid={`schedule-remove-${schedule.id}`}
                        disabled={busyId === schedule.id}
                        onClick={() => void removeSchedule(schedule)}
                      >
                        <XCircle size={10} />
                      </button>
                    </div>
                    <p className="mt-0.5 text-[9px] text-muted-foreground">
                      next {schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString() : '—'} ·
                      overlap {schedule.overlap === 'queue' ? 'queues' : 'skips'}
                      {schedule.lastNote ? ` · ${schedule.lastNote}` : ''}
                    </p>
                    {schedule.occurrences.length > 0 ? (
                      <ul className="mt-0.5 space-y-0.5">
                        {schedule.occurrences.slice(0, 3).map((occurrence) => (
                          <li
                            key={occurrence.id}
                            className="truncate text-[9px] text-muted-foreground"
                            data-testid={`schedule-occurrence-${occurrence.id}`}
                          >
                            {new Date(occurrence.occurrenceAt).toLocaleString()} · {occurrence.status}
                            {occurrence.note ? ` · ${occurrence.note}` : ''}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      {selectedTask ? (
        <TaskDetail
          key={selectedTask.id}
          task={selectedTask}
          previousAttempts={attempts}
          notify={notify}
          onClose={() => setSelectedTaskId(null)}
          onOpenSession={onOpenSession}
          onReviewChanges={onReviewChanges}
          onChanged={() => void load()}
        />
      ) : null}
    </div>
  )
}

function Section({
  title,
  testId,
  children
}: {
  title: string
  testId: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="mb-2" data-testid={testId}>
      <h2 className="mb-1 px-1 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <ul className="space-y-1">{children}</ul>
    </section>
  )
}

/**
 * The review verdict, as a distinct chip from the execution status.
 *
 * A finished task shows `unreviewed` rather than nothing: silence would read as
 * "fine", and acceptance is a decision nobody has made yet.
 */
function reviewBadge(task: TaskRecordPayload): React.JSX.Element | null {
  if (task.reviewDecision === 'accepted') {
    return (
      <span
        className="shrink-0 rounded bg-add-weak px-1 text-[9px] text-add"
        data-testid={`task-review-badge-${task.id}`}
      >
        accepted
      </span>
    )
  }
  if (task.reviewDecision === 'rejected') {
    return (
      <span
        className="shrink-0 rounded bg-destructive/15 px-1 text-[9px] text-destructive"
        data-testid={`task-review-badge-${task.id}`}
      >
        rejected
      </span>
    )
  }
  if (task.canDecideReview) {
    return (
      <span
        className="shrink-0 rounded bg-muted px-1 text-[9px] text-muted-foreground"
        data-testid={`task-review-badge-${task.id}`}
      >
        unreviewed
      </span>
    )
  }
  return null
}

function statusGlyph(status: TaskRecordPayload['status']): React.JSX.Element {
  if (status === 'running' || status === 'dispatching') return <Loader2 size={11} className="animate-spin" />
  if (status === 'waiting') return <Pause size={11} />
  if (status === 'queued') return <Clock size={11} />
  if (status === 'completed') return <CheckCircle2 size={11} />
  if (status === 'failed') return <XCircle size={11} />
  return <Ban size={11} />
}

const statusTone: Record<TaskRecordPayload['status'], string> = {
  queued: 'text-muted-foreground',
  dispatching: 'text-info',
  running: 'text-info',
  waiting: 'text-signal',
  completed: 'text-add',
  failed: 'text-destructive',
  cancelled: 'text-muted-foreground'
}

function TaskRow({
  task,
  repoName,
  busy,
  onCancel,
  onRetry,
  onOpenSession,
  onReview,
  onSelect,
  selected
}: {
  task: TaskRecordPayload
  repoName: string
  busy: boolean
  onCancel: (task: TaskRecordPayload) => Promise<void>
  onRetry: (task: TaskRecordPayload) => Promise<void>
  onOpenSession: (sessionId: string) => void
  onReview: (sessionId: string) => void
  onSelect: () => void
  selected: boolean
}): React.JSX.Element {
  const active = ['queued', 'dispatching', 'running', 'waiting'].includes(task.status)
  return (
    <li
      className={`rounded border px-2 py-1.5 ${
        selected ? 'border-accent/70 bg-accent/5' : 'border-border'
      }`}
      data-testid={`task-row-${task.id}`}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        onClick={onSelect}
        title="Open task details"
        data-testid={`task-open-detail-${task.id}`}
      >
        <span className={`shrink-0 ${statusTone[task.status]}`} data-testid={`task-status-${task.id}`}>
          {statusGlyph(task.status)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-foreground" title={task.prompt}>
          {task.title}
        </span>
        {reviewBadge(task)}
        <span className="shrink-0 text-[9px] uppercase text-muted-foreground">
          {task.status}
          {task.attempt > 1 ? ` · try ${String(task.attempt)}` : ''}
        </span>
      </button>
      <p className="mt-0.5 flex items-center gap-2 text-[9px] text-muted-foreground">
        <span>{repoName}</span>
        <span>· {task.harness}</span>
        {task.scheduleId ? <span>· from a schedule</span> : null}
        {task.sessionLive ? <span className="text-add">· session live</span> : null}
      </p>
      {task.error ? (
        <p className="mt-0.5 text-[10px] text-destructive" data-testid={`task-error-${task.id}`}>
          {task.error}
          {task.errorDetail ? <span className="text-muted-foreground"> {task.errorDetail}</span> : null}
        </p>
      ) : null}
      {task.resultSummary ? (
        <p className="mt-0.5 text-[10px] text-muted-foreground" data-testid={`task-result-${task.id}`}>
          {task.resultSummary}
        </p>
      ) : null}
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {task.sessionId ? (
          <>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[9px] hover:bg-muted"
              onClick={() => onOpenSession(task.sessionId!)}
              data-testid={`task-open-session-${task.id}`}
            >
              <Terminal size={9} />
              Session
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[9px] hover:bg-muted"
              onClick={() => onReview(task.sessionId!)}
              data-testid={`task-review-${task.id}`}
            >
              <GitBranch size={9} />
              Changes
            </button>
          </>
        ) : null}
        {active ? (
          <button
            type="button"
            className="rounded border border-destructive/50 px-1.5 py-0.5 text-[9px] text-destructive hover:bg-destructive/10 disabled:opacity-40"
            onClick={() => void onCancel(task)}
            disabled={busy}
            data-testid={`task-cancel-${task.id}`}
          >
            Cancel
          </button>
        ) : null}
        {task.canRetry ? (
          <button
            type="button"
            className="rounded border border-border px-1.5 py-0.5 text-[9px] hover:bg-muted disabled:opacity-40"
            onClick={() => void onRetry(task)}
            disabled={busy}
            data-testid={`task-retry-${task.id}`}
          >
            Retry
          </button>
        ) : null}
      </div>
    </li>
  )
}
