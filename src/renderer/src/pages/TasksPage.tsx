import type { TaskRecordPayload } from '../../../shared/icode-api'
import type { AppError } from '../../../shared/domain/errors'
import type { RepositorySummary, SessionSummary } from '../../../shared/schemas/ipc'
import type { AgentSendResult } from '../lib/agent-send'
import type { WorkbenchDraftStore } from '../review/drafts'
import type {
  OpenFileRequest,
  TaskSessionRoute,
  ViewRequest
} from '../router/use-app-navigation'
import type { Notice, PendingAction } from '../state/workspace'
import ProjectTasksView from '../components/ProjectTasksView'
import SessionHost from '../features/sessions/SessionHost'

export type TasksPageProps = {
  repo: RepositorySummary | null
  tasks: TaskRecordPayload[]
  sessions: SessionSummary[]
  loading: boolean
  focusTaskId: string | null
  focusComposerNonce: number
  rememberedTaskId: string | null

  taskSession: TaskSessionRoute | null
  taskSessionTask: TaskRecordPayload | null
  taskSessionLive: SessionSummary | null

  pending: Record<string, PendingAction>
  paneSessions: SessionSummary[]
  refreshToken: number
  openRequest: OpenFileRequest | null
  viewRequest: ViewRequest | null
  drafts: WorkbenchDraftStore
  sendToAgent: (text: string, session: SessionSummary) => Promise<AgentSendResult>

  onBackToTasks: () => void
  onReload: () => Promise<void>
  onTaskSelected: (taskId: string) => void
  onOpenSession: (sessionId: string) => void
  onStopSession: (sessionId: string) => void
  onRestartSession: (sessionId: string) => void
  onSleepSession: (sessionId: string) => void
  onWakeSession: (sessionId: string) => void
  onRecheckSession: (sessionId: string) => void
  onRemoveSession: (sessionId: string) => void
  onRecoverWorktree: (sessionId: string) => void
  onError: (error: AppError) => void
  notify: (notice: Notice) => void

  onClearOpenRequest: () => void
  onRequestOpenInFiles: (path: string, line: number) => void
  onClearViewRequest: () => void
}

export default function TasksPage({
  repo,
  tasks,
  sessions,
  loading,
  focusTaskId,
  focusComposerNonce,
  rememberedTaskId,
  taskSession,
  taskSessionTask,
  taskSessionLive,
  pending,
  paneSessions,
  refreshToken,
  openRequest,
  viewRequest,
  drafts,
  sendToAgent,
  onBackToTasks,
  onReload,
  onTaskSelected,
  onOpenSession,
  onStopSession,
  onRestartSession,
  onSleepSession,
  onWakeSession,
  onRecheckSession,
  onRemoveSession,
  onRecoverWorktree,
  onError,
  notify,
  onClearOpenRequest,
  onRequestOpenInFiles,
  onClearViewRequest
}: TasksPageProps): React.JSX.Element {
  if (repo === null) return <></>
  if (taskSession !== null && taskSessionTask !== null && taskSessionLive !== null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="task-session-view">
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-[10px] text-muted-foreground">
          <button
            type="button"
            className="rounded px-1 py-0.5 hover:bg-muted hover:text-foreground"
            onClick={onBackToTasks}
            data-testid="task-session-back"
          >
            ← Tasks
          </button>
          <span className="min-w-0 truncate text-foreground">{taskSessionTask.title}</span>
          <span className="shrink-0">attempt {taskSessionTask.attempt}</span>
        </div>
        <SessionHost
          session={taskSessionLive}
          repo={repo}
          pending={pending[taskSessionLive.id] ?? null}
          panes={paneSessions}
          allowSleep={false}
          refreshToken={refreshToken}
          openRequest={openRequest}
          viewRequest={viewRequest}
          drafts={drafts}
          onRestart={onRestartSession}
          onSleep={onSleepSession}
          onWake={onWakeSession}
          onRecheck={onRecheckSession}
          onRemove={onRemoveSession}
          onRecoverWorktree={onRecoverWorktree}
          onError={onError}
          notify={notify}
          onSendToAgent={(text) => sendToAgent(text, taskSessionLive)}
          onClearOpenRequest={onClearOpenRequest}
          onRequestOpenInFiles={onRequestOpenInFiles}
          onClearViewRequest={onClearViewRequest}
        />
      </div>
    )
  }
  return (
    <ProjectTasksView
      repo={repo}
      tasks={tasks}
      sessions={sessions}
      loading={loading}
      focusTaskId={focusTaskId}
      focusComposerNonce={focusComposerNonce}
      rememberedTaskId={rememberedTaskId}
      notify={notify}
      refreshToken={refreshToken}
      drafts={drafts}
      openRequest={openRequest}
      onOpenRequestHandled={onClearOpenRequest}
      onReload={onReload}
      onTaskSelected={onTaskSelected}
      onOpenSession={onOpenSession}
      onStopSession={onStopSession}
      onRestartSession={onRestartSession}
      onRecheckSession={onRecheckSession}
      onError={onError}
      onSendToAgent={sendToAgent}
    />
  )
}
