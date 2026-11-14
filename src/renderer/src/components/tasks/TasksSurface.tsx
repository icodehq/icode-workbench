import { useEffect, useMemo, useState } from 'react'
import { ListTodo, Loader2, Plus } from 'lucide-react'
import type { TaskRecordPayload } from '../../../../shared/icode-api'
import type { AppError } from '../../../../shared/domain/errors'
import type { RepositorySummary, SessionSummary } from '../../../../shared/schemas/ipc'
import type { AgentSendResult } from '../../lib/agent-send'
import type { WorkbenchDraftStore } from '../../review/drafts'
import type { Notice } from '../../state/workspace'
import { callApi } from '../../lib/api'
import TaskWorkbench, { type TaskAction } from '../TaskWorkbench'
import { useT } from '../../i18n/use-i18n'

type Props = {
  repo: RepositorySummary | null
  tasks: TaskRecordPayload[]
  archivedTasks: TaskRecordPayload[]
  sessions: SessionSummary[]
  selectedTaskId: string | null
  loading: boolean
  focusActive: boolean
  refreshToken: number
  openRequest: { path: string; line: number; nonce: number } | null
  taskViewRequest: { tab: 'terminal' | 'changes' | 'files'; nonce: number } | null
  drafts: WorkbenchDraftStore
  notify: (notice: Notice) => void
  onOpenRequestHandled: () => void
  onTaskViewRequestHandled: () => void
  onQueueTask: () => void
  onQueueFollowUp: (task: TaskRecordPayload) => void
  onSelectTask: (task: TaskRecordPayload) => void
  onOpenSession: (sessionId: string) => void
  onStopSession: (sessionId: string) => void
  onRestartSession: (sessionId: string) => void
  onRecheckSession: (sessionId: string) => void
  onError: (error: AppError) => void
  onSendToAgent: (text: string, session: SessionSummary) => Promise<AgentSendResult>
  onReload: () => Promise<void>
  onChanged: () => void
  onTaskAction: (task: TaskRecordPayload, action: TaskAction) => void
}

/** Full-width task surface. The task list lives in the sidebar. */
export default function TasksSurface({
  repo,
  tasks,
  archivedTasks,
  sessions,
  selectedTaskId,
  loading,
  focusActive,
  refreshToken,
  openRequest,
  taskViewRequest,
  drafts,
  notify,
  onOpenRequestHandled,
  onTaskViewRequestHandled,
  onQueueTask,
  onQueueFollowUp,
  onSelectTask,
  onOpenSession,
  onStopSession,
  onRestartSession,
  onRecheckSession,
  onError,
  onSendToAgent,
  onReload,
  onChanged,
  onTaskAction
}: Props): React.JSX.Element {
  const t = useT()
  const [attempts, setAttempts] = useState<TaskRecordPayload[]>([])

  const allTasks = useMemo(
    () => [...tasks, ...archivedTasks].filter((task) => task.repoId === repo?.id),
    [archivedTasks, repo?.id, tasks]
  )
  const projectTasks = useMemo(
    () => tasks.filter((task) => task.repoId === repo?.id),
    [repo?.id, tasks]
  )
  const task = allTasks.find((entry) => entry.id === selectedTaskId) ?? null
  const session =
    task?.sessionId === null || task?.sessionId === undefined
      ? null
      : (sessions.find((entry) => entry.id === task.sessionId) ?? null)

  useEffect(() => {
    if (task === null) {
      setAttempts([])
      return
    }
    let cancelled = false
    void callApi<TaskRecordPayload[]>(window.icode.tasks.history({ taskId: task.id })).then(
      (result) => {
        if (!cancelled && result.ok) {
          setAttempts(result.value.filter((entry) => entry.id !== task.id))
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [task?.id, tasks])

  if (repo === null) return <></>

  if (task === null) {
    return (
      <div
        className="flex min-h-0 flex-1 items-center justify-center p-8"
        data-testid="tasks-surface"
      >
        <div
          className="w-full max-w-md rounded-lg border border-border bg-card p-6"
          data-testid="tasks-empty"
        >
          <div className="flex items-center gap-2">
            {loading ? (
              <Loader2 size={14} className="animate-spin text-muted-foreground" />
            ) : (
              <ListTodo size={14} className="text-muted-foreground" />
            )}
            <h1 className="text-[14px] font-semibold">{t('tasks.title')}</h1>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            {loading ? t('tasks.loading') : t('tasks.empty')}
          </p>
          <button
            type="button"
            className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[11px] font-medium text-accent-ink hover:opacity-90"
            onClick={onQueueTask}
            data-testid="empty-queue-task"
          >
            <Plus size={12} />
            {t('topbar.queueTask')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="tasks-surface">
      <TaskWorkbench
        key={task.id}
        task={task}
        previousAttempts={attempts}
        projectTasks={projectTasks}
        onSelectTask={(taskId) => {
          const next = allTasks.find((entry) => entry.id === taskId)
          if (next) onSelectTask(next)
        }}
        onQueueFollowUp={onQueueFollowUp}
        repo={repo}
        session={session}
        notify={notify}
        refreshToken={refreshToken}
        openRequest={openRequest}
        onOpenRequestHandled={onOpenRequestHandled}
        onOpenSession={onOpenSession}
        onStopSession={onStopSession}
        onRestartSession={onRestartSession}
        onRecheckSession={onRecheckSession}
        onError={onError}
        onSendToAgent={onSendToAgent}
        drafts={drafts}
        onReload={onReload}
        onChanged={onChanged}
        viewRequest={taskViewRequest}
        onViewRequestHandled={onTaskViewRequestHandled}
        onTaskAction={(action) => onTaskAction(task, action)}
        focusActive={focusActive}
      />
    </div>
  )
}
