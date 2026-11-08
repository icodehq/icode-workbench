import { AlertCircle, CheckCircle2, ListTodo } from 'lucide-react'
import type { AssistantCardPayload } from '../../../shared/schemas/assistant'

const STATUS_TONE: Record<string, string> = {
  queued: 'text-muted-foreground',
  dispatching: 'text-info',
  running: 'text-info',
  waiting: 'text-signal',
  completed: 'text-add',
  failed: 'text-destructive',
  cancelled: 'text-muted-foreground'
}

export type AssistantTaskAction = 'approve' | 'reject' | 'retry' | 'cancel'

export default function AssistantCardView({
  card,
  repoName,
  onOpenTask,
  onTaskAction
}: {
  card: AssistantCardPayload
  repoName?: string
  onOpenTask?: (taskId: string) => void
  onTaskAction?: (action: AssistantTaskAction, taskId: string) => void
}): React.JSX.Element {
  if (card.type === 'task') {
    return (
      <div
        className="rounded-md border border-border bg-card px-3 py-2.5"
        data-testid={`assistant-card-task-${card.taskId}`}
      >
        <div className="flex items-center gap-2">
          <ListTodo size={12} className="shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-foreground">
            {card.title}
          </span>
          {card.approval === 'pending' ? (
            <span className="shrink-0 rounded bg-signal-weak px-1.5 py-0.5 text-[9px] font-medium text-signal">
              needs approval
            </span>
          ) : card.autoApproved ? (
            <span className="shrink-0 rounded bg-add-weak px-1.5 py-0.5 text-[9px] font-medium text-add">
              auto-dispatched
            </span>
          ) : null}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
          {repoName ? <span>{repoName}</span> : null}
          <span className={STATUS_TONE[card.status] ?? 'text-muted-foreground'}>{card.status}</span>
          {card.reasons && card.reasons.length > 0 ? (
            <span className="text-signal">{card.reasons.join(' · ')}</span>
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {onOpenTask ? (
            <button
              type="button"
              className="inline-flex h-6 items-center rounded border border-border px-2 text-[10px] text-foreground hover:bg-muted"
              onClick={() => onOpenTask(card.taskId)}
              data-testid={`assistant-open-task-${card.taskId}`}
            >
              Open task
            </button>
          ) : null}
          {onTaskAction && card.approval === 'pending' ? (
            <>
              <button
                type="button"
                className="inline-flex h-6 items-center rounded bg-accent px-2 text-[10px] text-accent-ink hover:opacity-90"
                onClick={() => onTaskAction('approve', card.taskId)}
                data-testid={`assistant-approve-task-${card.taskId}`}
              >
                Approve
              </button>
              <button
                type="button"
                className="inline-flex h-6 items-center rounded border border-destructive/40 px-2 text-[10px] text-destructive hover:bg-destructive/5"
                onClick={() => onTaskAction('reject', card.taskId)}
                data-testid={`assistant-reject-task-${card.taskId}`}
              >
                Reject
              </button>
            </>
          ) : null}
          {onTaskAction && card.status === 'failed' ? (
            <button
              type="button"
              className="inline-flex h-6 items-center rounded border border-border px-2 text-[10px] text-foreground hover:bg-muted"
              onClick={() => onTaskAction('retry', card.taskId)}
              data-testid={`assistant-retry-task-${card.taskId}`}
            >
              Retry
            </button>
          ) : null}
          {onTaskAction &&
          (card.status === 'queued' ||
            card.status === 'dispatching' ||
            card.status === 'running' ||
            card.status === 'waiting') ? (
            <button
              type="button"
              className="inline-flex h-6 items-center rounded border border-border px-2 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => onTaskAction('cancel', card.taskId)}
              data-testid={`assistant-cancel-task-${card.taskId}`}
            >
              Cancel
            </button>
          ) : null}
        </div>
      </div>
    )
  }

  if (card.type === 'action') {
    return (
      <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px]">
        {card.ok ? (
          <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-add" />
        ) : (
          <AlertCircle size={12} className="mt-0.5 shrink-0 text-destructive" />
        )}
        <span className="min-w-0 text-muted-foreground">{card.message}</span>
      </div>
    )
  }

  if (card.type === 'notification') {
    return (
      <div className="rounded-md border border-signal-line bg-signal-weak px-3 py-2 text-[11px] text-signal">
        {card.text}
      </div>
    )
  }

  return (
    <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
      <AlertCircle size={12} className="mt-0.5 shrink-0" />
      <span className="min-w-0">{card.message}</span>
    </div>
  )
}
