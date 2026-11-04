import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, GitBranch, Loader2, Terminal, X } from 'lucide-react'
import { callApi, errorNotice } from '../lib/api'
import type { TaskChangesPayload, TaskRecordPayload } from '../../../shared/ade-api'
import type { SessionSummary } from '../../../shared/schemas/ipc'
import type { Notice } from '../state/workspace'
import { sessionStateLabel, stateDotClass } from './status'
import {
  taskPillClass,
  taskStatusLabel
} from './task-status'

export type TaskOverviewProps = {
  task: TaskRecordPayload
  previousAttempts: TaskRecordPayload[]
  notify: (notice: Notice) => void
  session: SessionSummary | null
  onOpenTerminal: () => void
  onOpenFullSession: () => void
  onOpenChanges: () => void
  onChanged: () => void
}

const ACTIVE = new Set(['queued', 'dispatching', 'running', 'waiting'])

function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`
  const hours = Math.floor(minutes / 60)
  return `${String(hours)}h ${String(minutes % 60)}m`
}

function Card({
  title,
  action,
  children
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="overflow-hidden rounded-lg border border-line bg-card">
      <div className="flex min-h-9 items-center gap-2 border-b border-border px-3">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {title}
        </h3>
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
      <div className="p-3">{children}</div>
    </section>
  )
}

function Row({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-2 py-0.5 text-[11px] leading-relaxed">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-foreground">{children}</span>
    </div>
  )
}

/**
 * The task Overview, not a drawer.
 *
 * Execution and judgement stay separate: a completed task is not accepted until
 * someone records a decision, and accepting never commits, merges, pushes or
 * deletes anything.
 */
export default function TaskOverview({
  task,
  previousAttempts,
  notify,
  session,
  onOpenTerminal,
  onOpenFullSession,
  onOpenChanges,
  onChanged
}: TaskOverviewProps): React.JSX.Element {
  const [changes, setChanges] = useState<TaskChangesPayload | null>(null)
  const [loadingChanges, setLoadingChanges] = useState(true)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState(task.reviewNote ?? '')
  const [confirming, setConfirming] = useState<'accepted' | 'rejected' | null>(null)

  const active = ACTIVE.has(task.status)

  const loadChanges = useCallback(async (): Promise<void> => {
    setLoadingChanges(true)
    const result = await callApi<TaskChangesPayload>(window.ade.tasks.changes({ taskId: task.id }))
    if (!result.ok) {
      setChanges({
        taskId: task.id,
        sessionId: task.sessionId,
        status: 'unavailable',
        detail: result.error.message
      })
    } else {
      setChanges(result.value)
    }
    setLoadingChanges(false)
  }, [task.id, task.sessionId])

  useEffect(() => {
    void loadChanges()
  }, [loadChanges, task.updatedAt])

  const decide = async (decision: 'accepted' | 'rejected'): Promise<void> => {
    if (busy) return
    if (task.reviewDecision !== 'pending' && task.reviewDecision !== decision && !confirming) {
      setConfirming(decision)
      return
    }
    setBusy(true)
    try {
      const result = await callApi<TaskRecordPayload>(
        window.ade.tasks.decideReview({
          taskId: task.id,
          decision,
          note: note.trim() ? note.trim() : null,
          replace: task.reviewDecision !== 'pending' && task.reviewDecision !== decision
        })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      setConfirming(null)
      notify({
        tone: 'success',
        message:
          decision === 'accepted'
            ? "Recorded as accepted. The code is still only in this task's worktree."
            : 'Recorded as rejected. Nothing was deleted or reverted.'
      })
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  const duration =
    task.startedAt !== null && task.finishedAt !== null
      ? formatDuration(task.finishedAt - task.startedAt)
      : null
  const changedFiles = changes?.status === 'available' ? changes.files ?? [] : []
  const additions = changedFiles.reduce((total, file) => total + (file.additions ?? 0), 0)
  const deletions = changedFiles.reduce((total, file) => total + (file.deletions ?? 0), 0)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-background p-4" data-testid="task-detail">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card
            title="Instruction"
            action={
              <button
                type="button"
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                title="Copy instruction"
                aria-label="Copy instruction"
                onClick={() => {
                  void navigator.clipboard.writeText(task.prompt)
                  notify({ tone: 'success', message: 'Instruction copied.' })
                }}
              >
                <Copy size={12} />
              </button>
            }
          >
            <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-foreground">
              {task.prompt}
            </p>
          </Card>

          <Card title="Activity">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex h-[21px] items-center gap-1.5 rounded-full border px-2 text-[10.5px] font-medium ${taskPillClass(task)}`}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-current" />
                {taskStatusLabel(task)}
              </span>
              <span className="text-[11px] text-muted-foreground">
                attempt {task.attempt}
                {duration ? ` · ${duration}` : ''}
                {task.updatedAt ? ` · updated ${formatTime(task.updatedAt)}` : ''}
              </span>
            </div>
            {task.resultSummary ? (
              <p className="mt-2 whitespace-pre-wrap text-[11.5px] leading-relaxed text-foreground" data-testid="task-detail-result">
                {task.resultSummary}
              </p>
            ) : null}
            {task.error ? (
              <p className="mt-2 whitespace-pre-wrap text-[11.5px] leading-relaxed text-destructive" data-testid="task-detail-error">
                {task.error}
                {task.errorDetail ? <span className="text-muted-foreground"> {task.errorDetail}</span> : null}
              </p>
            ) : null}
            {task.failureReason ? (
              <p className="mt-2 text-[11px] text-signal" data-testid="task-detail-reason">
                Reason: {task.failureReason}
              </p>
            ) : null}
            {active && task.sessionLive ? (
              <p className="mt-2 rounded-md border border-signal-line bg-signal-weak px-2.5 py-2 text-[10.5px] leading-relaxed text-signal" data-testid="task-detail-attention">
                The session is live and has not finished. If the harness is waiting for a permission
                prompt, open the terminal and answer it there. iCode trusts the project&apos;s harness
                configuration, but it never answers agent permission prompts for you.
              </p>
            ) : null}
          </Card>

          <Card
            title="Changes"
            action={
              <button
                type="button"
                className="text-[10px] text-muted-foreground hover:text-foreground"
                onClick={() => void loadChanges()}
                data-testid="task-changes-refresh"
              >
                Refresh
              </button>
            }
          >
            {loadingChanges ? (
              <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground" data-testid="task-changes-loading">
                <Loader2 size={11} className="animate-spin" />
                Reading this task's worktree…
              </p>
            ) : changes === null ? null : changes.status === 'unavailable' ? (
              <p className="text-[11px] text-muted-foreground" data-testid="task-changes-unavailable">
                {changes.detail ?? 'This task has no worktree to review.'}
              </p>
            ) : (changes.files ?? []).length === 0 ? (
              <p className="text-[11px] text-muted-foreground" data-testid="task-changes-empty">
                This task's worktree has no changes against its baseline.
              </p>
            ) : (
              <>
                <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span>{changedFiles.length} files</span>
                  <span className="text-add">+{additions}</span>
                  <span className="text-destructive">−{deletions}</span>
                  <button
                    type="button"
                    className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-[10.5px] text-foreground hover:bg-muted"
                    onClick={onOpenChanges}
                    data-testid="task-changes-open-review"
                  >
                    <GitBranch size={11} />
                    Open diff
                  </button>
                </div>
                <ul className="space-y-1" data-testid="task-changes-list">
                  {changedFiles.slice(0, 4).map((file) => (
                    <li key={file.path} className="flex items-center gap-2 font-mono text-[11px]">
                      <span className="w-4 shrink-0 text-muted-foreground">{file.status.slice(0, 1).toUpperCase()}</span>
                      <span className="min-w-0 flex-1 truncate text-foreground" title={file.path}>{file.path}</span>
                      <span className="shrink-0 text-add">{file.additions === null ? '' : `+${String(file.additions)}`}</span>
                      <span className="shrink-0 text-destructive">{file.deletions === null ? '' : `−${String(file.deletions)}`}</span>
                    </li>
                  ))}
                </ul>
                {changedFiles.length > 4 ? (
                  <p className="mt-1 text-[10px] text-muted-foreground">and {changedFiles.length - 4} more…</p>
                ) : null}
                {changes.listTruncated ? (
                  <p className="mt-1 text-[10px] text-signal">Showing the first 1,000 changed files.</p>
                ) : null}
                <p className="mt-2 text-[10px] text-muted-foreground">
                  Compared against the commit this task's worktree was created from
                  {changes.baselineOid ? ` (${changes.baselineOid.slice(0, 7)})` : ''}.
                </p>
              </>
            )}
          </Card>

          <Card title="Review decision">
            <p className="text-[11.5px] text-muted-foreground" data-testid="task-detail-review-state">
              {task.reviewDecision === 'pending'
                ? active
                  ? 'Pending — the task is still running, so there is nothing to judge yet.'
                  : 'Pending review. Execution status and this decision are separate.'
                : `${task.reviewDecision === 'accepted' ? 'Accepted' : 'Rejected'}${task.reviewedAt ? ` on ${formatTime(task.reviewedAt)}` : ''}`}
            </p>
            {task.reviewNote ? (
              <p className="mt-1 whitespace-pre-wrap text-[11px] text-foreground" data-testid="task-detail-review-note">
                {task.reviewNote}
              </p>
            ) : null}
            {task.canDecideReview ? (
              <>
                <textarea
                  className="mt-2 h-14 w-full resize-none rounded-md border border-border bg-muted/40 px-2 py-1.5 text-[11px] text-foreground outline-none placeholder:text-muted-foreground"
                  placeholder="Optional note about the decision"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  data-testid="task-review-note"
                />
                {confirming ? (
                  <p className="mt-1 text-[10.5px] text-signal" data-testid="task-review-confirm">
                    This task was already {task.reviewDecision}. Click {confirming} again to replace that
                    decision.
                  </p>
                ) : null}
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    className={`inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-[10.5px] disabled:opacity-40 ${
                      task.reviewDecision === 'accepted'
                        ? 'border-add/60 bg-add-weak text-add'
                        : 'border-border text-foreground hover:bg-muted'
                    }`}
                    onClick={() => void decide('accepted')}
                    disabled={busy}
                    data-testid="task-review-accept"
                  >
                    <Check size={11} />
                    {confirming === 'accepted' ? 'Confirm accept' : 'Accept'}
                  </button>
                  <button
                    type="button"
                    className={`inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-[10.5px] disabled:opacity-40 ${
                      task.reviewDecision === 'rejected'
                        ? 'border-destructive/60 bg-destructive/15 text-destructive'
                        : 'border-border text-foreground hover:bg-muted'
                    }`}
                    onClick={() => void decide('rejected')}
                    disabled={busy}
                    data-testid="task-review-reject"
                  >
                    <X size={11} />
                    {confirming === 'rejected' ? 'Confirm reject' : 'Reject'}
                  </button>
                </div>
                <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground" data-testid="task-review-safety">
                  Accept records that you want this result. It does not merge, commit, push, or delete
                  anything; the changes stay in this task's worktree.
                </p>
              </>
            ) : (
              <p className="mt-1 text-[10px] text-muted-foreground">
                A decision becomes available when the task stops.
              </p>
            )}
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Card title="Details">
            <Row label="Harness">{task.harness}</Row>
            <Row label="Attempt">{task.attempt}</Row>
            <Row label="Started">{task.startedAt === null ? '—' : formatTime(task.startedAt)}</Row>
            <Row label="Finished">{task.finishedAt === null ? '—' : formatTime(task.finishedAt)}</Row>
            <Row label="Duration">{duration ?? '—'}</Row>
            {task.exitCode !== null ? (
              <Row label="Exit code">
                <span data-testid="task-detail-exit">{task.exitCode}</span>
              </Row>
            ) : null}
            {session?.worktree ? (
              <>
                <Row label="Branch">
                  <span className="font-mono">{session.worktree.branch}</span>
                </Row>
                <Row label="Base">
                  <span className="font-mono">{session.worktree.baseOid.slice(0, 7)}</span>
                </Row>
              </>
            ) : null}
            <Row label="Worktree">
              <span className="break-all font-mono text-[10px]" data-testid="task-detail-worktree">
                {task.worktreePath ?? session?.worktree?.path ?? '—'}
              </span>
            </Row>
            {task.scheduleId ? <Row label="Schedule">from a schedule</Row> : null}
          </Card>

          <Card title="Session">
            {session === null ? (
              <p className="text-[11px] text-muted-foreground" data-testid="task-detail-no-session">
                Not started — no session
              </p>
            ) : (
              <>
                <div className="flex items-center gap-1.5 text-[11.5px] text-foreground">
                  <span className={`h-1.5 w-1.5 rounded-full ${stateDotClass(session.state, null)}`} />
                  {sessionStateLabel(session.state, null)}
                  {session.state === 'live' ? ' · attachable' : ''}
                </div>
                <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                  {session.id}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-[10.5px] text-foreground hover:bg-muted"
                    onClick={onOpenTerminal}
                    data-testid="task-detail-open-session"
                  >
                    <Terminal size={11} />
                    Open terminal
                  </button>
                  <button
                    type="button"
                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-[10.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={onOpenFullSession}
                    data-testid="task-full-session"
                  >
                    Full session
                  </button>
                </div>
              </>
            )}
          </Card>

          {previousAttempts.length > 0 ? (
            <Card title="Previous attempts">
              <ul className="space-y-1.5" data-testid="task-detail-attempts">
                {previousAttempts.map((attempt) => (
                  <li key={attempt.id} className="rounded-md border border-border bg-muted/30 px-2 py-1.5 text-[10.5px]">
                    <span className="text-foreground">attempt {attempt.attempt}</span>{' '}
                    <span className="text-muted-foreground">
                      · {attempt.status}
                      {attempt.failureReason ? ` (${attempt.failureReason})` : ''} · review{' '}
                      {attempt.reviewDecision}
                    </span>
                    {attempt.error ? (
                      <p className="mt-0.5 text-[10px] text-muted-foreground">{attempt.error}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  )
}
