import { useCallback, useEffect, useState } from 'react'
import { Check, GitBranch, Loader2, Terminal, X } from 'lucide-react'
import { callApi, errorNotice } from '../lib/api'
import type { TaskChangesPayload, TaskRecordPayload } from '../../../shared/ade-api'
import type { Notice } from '../state/workspace'

export type TaskDetailProps = {
  task: TaskRecordPayload
  previousAttempts: TaskRecordPayload[]
  notify: (notice: Notice) => void
  onClose: () => void
  /** Opens the session that *this task* owns. */
  onOpenSession: (sessionId: string) => void
  /** Opens Diff Review for the session that *this task* owns. */
  onReviewChanges: (sessionId: string) => void
  onChanged: () => void
}

const ACTIVE = new Set(['queued', 'dispatching', 'running', 'waiting'])

/**
 * Everything known about one task's outcome, and the decision about it.
 *
 * Two rules shape this panel:
 *
 *  1. **Execution and judgement are shown separately.** `status` says what the
 *     process did; the review decision says whether a human wants the result.
 *     A completed task is not "done" until someone accepts or rejects it, and
 *     the labels never blur the two.
 *
 *  2. **Accepting is recorded, not performed.** The action writes a decision. It
 *     does not commit, merge, push, delete a worktree or discard an edit, and the
 *     copy says exactly that so "Accept" cannot be read as "merge".
 */
export default function TaskDetail({
  task,
  previousAttempts,
  notify,
  onClose,
  onOpenSession,
  onReviewChanges,
  onChanged
}: TaskDetailProps): React.JSX.Element {
  const [changes, setChanges] = useState<TaskChangesPayload | null>(null)
  const [loadingChanges, setLoadingChanges] = useState(true)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState(task.reviewNote ?? '')
  /** Set when changing an existing decision, so a mis-click cannot overwrite it. */
  const [confirming, setConfirming] = useState<'accepted' | 'rejected' | null>(null)

  const active = ACTIVE.has(task.status)

  const loadChanges = useCallback(async (): Promise<void> => {
    setLoadingChanges(true)
    const result = await callApi<TaskChangesPayload>(window.ade.tasks.changes({ taskId: task.id }))
    if (!result.ok) {
      setChanges({ taskId: task.id, sessionId: task.sessionId, status: 'unavailable', detail: result.error.message })
    } else {
      setChanges(result.value)
    }
    setLoadingChanges(false)
  }, [task.id, task.sessionId])

  useEffect(() => {
    void loadChanges()
    // `updatedAt` is the task row's own change stamp: re-reading on it keeps the
    // panel honest when the worktree changes underneath an open panel (a task
    // finishing, a worktree removed, new files written by a live session).
  }, [loadChanges, task.updatedAt])

  const decide = async (decision: 'accepted' | 'rejected'): Promise<void> => {
    if (busy) return
    if (task.reviewDecision !== 'pending' && task.reviewDecision !== decision && !confirming) {
      // First click asks; the second one really writes.
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
            ? 'Recorded as accepted. The code is still only in this task\'s worktree.'
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

  return (
    <aside
      className="flex w-[420px] shrink-0 flex-col overflow-y-auto border-l border-border bg-card/40"
      data-testid="task-detail"
    >
      <div className="flex items-start gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] font-medium" data-testid="task-detail-title">
            {task.title}
          </p>
          <p className="mt-0.5 truncate text-[9px] text-muted-foreground">
            {task.harness} · attempt {task.attempt}
            {task.scheduleId ? ' · from a schedule' : ''}
          </p>
        </div>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onClose}
          title="Close"
          data-testid="task-detail-close"
        >
          <X size={12} />
        </button>
      </div>

      <Section title="Execution">
        <Row label="Status">
          <span data-testid="task-detail-status">{task.status}</span>
        </Row>
        {task.failureReason ? (
          <Row label="Reason">
            <span data-testid="task-detail-reason">{task.failureReason}</span>
          </Row>
        ) : null}
        {task.exitCode !== null ? (
          <Row label="Exit code">
            <span data-testid="task-detail-exit">{task.exitCode}</span>
          </Row>
        ) : null}
        <Row label="Started">{task.startedAt === null ? '—' : formatTime(task.startedAt)}</Row>
        <Row label="Finished">{task.finishedAt === null ? '—' : formatTime(task.finishedAt)}</Row>
        <Row label="Duration">{duration ?? '—'}</Row>
        <Row label="Session">
          {task.sessionId ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 text-foreground hover:underline"
              onClick={() => onOpenSession(task.sessionId!)}
              data-testid="task-detail-open-session"
            >
              <Terminal size={9} />
              {task.sessionLive ? 'Open (live)' : 'Open'}
            </button>
          ) : (
            <span data-testid="task-detail-no-session">Not started — no session</span>
          )}
        </Row>
        <Row label="Worktree">
          <span className="break-all font-mono text-[9px]" data-testid="task-detail-worktree">
            {task.worktreePath ?? '—'}
          </span>
        </Row>
        {task.resultSummary ? (
          <p className="mt-1 text-[10px] text-muted-foreground" data-testid="task-detail-result">
            {task.resultSummary}
          </p>
        ) : null}
        {task.error ? (
          <p className="mt-1 text-[10px] text-destructive" data-testid="task-detail-error">
            {task.error}
            {task.errorDetail ? <span className="text-muted-foreground"> {task.errorDetail}</span> : null}
          </p>
        ) : null}
        {active && task.sessionLive ? (
          /*
           * The honest explanation for the most common "stuck" task: the harness
           * is alive and waiting for a permission prompt. Workspace trust is
           * prepared by iCode; the agent's own permissions are not.
           */
          <p className="mt-1 text-[10px] text-signal" data-testid="task-detail-attention">
            The session is live and has not finished. If the harness is waiting for a permission
            prompt, open the Session and answer it there. iCode trusts the project&apos;s harness
            configuration, but never answers agent permission prompts for you.
          </p>
        ) : null}
      </Section>

      <Section
        title="Changes"
        action={
          <button
            type="button"
            className="text-[9px] text-muted-foreground hover:text-foreground"
            onClick={() => void loadChanges()}
            data-testid="task-changes-refresh"
          >
            Refresh
          </button>
        }
      >
        {loadingChanges ? (
          <p className="flex items-center gap-1 text-[10px] text-muted-foreground" data-testid="task-changes-loading">
            <Loader2 size={10} className="animate-spin" />
            Reading this task's worktree…
          </p>
        ) : changes === null ? null : changes.status === 'unavailable' ? (
          <p className="text-[10px] text-muted-foreground" data-testid="task-changes-unavailable">
            {changes.detail ?? 'This task has no worktree to review.'}
          </p>
        ) : (changes.files ?? []).length === 0 ? (
          <p className="text-[10px] text-muted-foreground" data-testid="task-changes-empty">
            This task's worktree has no changes against its baseline.
          </p>
        ) : (
          <>
            <ul className="space-y-0.5" data-testid="task-changes-list">
              {(changes.files ?? []).map((file) => (
                <li key={file.path} className="flex items-center gap-1 font-mono text-[10px]">
                  <span className="w-4 shrink-0 text-muted-foreground">{file.status.slice(0, 1)}</span>
                  <span className="min-w-0 flex-1 truncate" title={file.path}>
                    {file.path}
                  </span>
                  <span className="shrink-0 text-add">
                    {file.additions === null ? '' : `+${String(file.additions)}`}
                  </span>
                  <span className="shrink-0 text-destructive">
                    {file.deletions === null ? '' : `−${String(file.deletions)}`}
                  </span>
                </li>
              ))}
            </ul>
            {changes.listTruncated ? (
              <p className="mt-1 text-[9px] text-signal">Showing the first 1,000 changed files.</p>
            ) : null}
            <button
              type="button"
              className="mt-1.5 inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[9px] hover:bg-muted"
              onClick={() => task.sessionId && onReviewChanges(task.sessionId)}
              data-testid="task-changes-open-review"
            >
              <GitBranch size={9} />
              Open diff review
            </button>
            <p className="mt-1 text-[9px] text-muted-foreground">
              Compared against the commit this task's worktree was created from
              {changes.baselineOid ? ` (${changes.baselineOid.slice(0, 7)})` : ''}.
            </p>
          </>
        )}
      </Section>

      <Section title="Review decision">
        <p className="text-[10px] text-muted-foreground" data-testid="task-detail-review-state">
          {task.reviewDecision === 'pending'
            ? active
              ? 'Pending — the task is still running, so there is nothing to judge yet.'
              : 'Pending review. Execution status and this decision are separate.'
            : `${task.reviewDecision === 'accepted' ? 'Accepted' : 'Rejected'}${task.reviewedAt ? ` on ${formatTime(task.reviewedAt)}` : ''}`}
        </p>
        {task.reviewNote ? (
          <p className="mt-1 whitespace-pre-wrap text-[10px] text-foreground" data-testid="task-detail-review-note">
            {task.reviewNote}
          </p>
        ) : null}
        {task.canDecideReview ? (
          <>
            <textarea
              className="mt-1.5 h-12 w-full resize-none rounded border border-border bg-transparent px-2 py-1 text-[10px] outline-none placeholder:text-muted-foreground"
              placeholder="Optional note about the decision"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              data-testid="task-review-note"
            />
            {confirming ? (
              <p className="mt-1 text-[10px] text-signal" data-testid="task-review-confirm">
                This task was already {task.reviewDecision}. Click {confirming} again to replace that
                decision.
              </p>
            ) : null}
            <div className="mt-1.5 flex items-center gap-1">
              <button
                type="button"
                className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] disabled:opacity-40 ${
                  task.reviewDecision === 'accepted'
                    ? 'border-add/60 bg-add-weak text-add'
                    : 'border-border hover:bg-muted'
                }`}
                onClick={() => void decide('accepted')}
                disabled={busy}
                data-testid="task-review-accept"
              >
                <Check size={10} />
                {confirming === 'accepted' ? 'Confirm accept' : 'Accept'}
              </button>
              <button
                type="button"
                className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] disabled:opacity-40 ${
                  task.reviewDecision === 'rejected'
                    ? 'border-destructive/60 bg-destructive/15 text-destructive'
                    : 'border-border hover:bg-muted'
                }`}
                onClick={() => void decide('rejected')}
                disabled={busy}
                data-testid="task-review-reject"
              >
                <X size={10} />
                {confirming === 'rejected' ? 'Confirm reject' : 'Reject'}
              </button>
            </div>
            <p className="mt-1 text-[9px] text-muted-foreground" data-testid="task-review-safety">
              Accept records that you want this result. It does not merge, commit, push, or delete
              anything; the changes stay in this task's worktree.
            </p>
          </>
        ) : (
          <p className="mt-1 text-[9px] text-muted-foreground">
            A decision becomes available when the task stops.
          </p>
        )}
      </Section>

      {previousAttempts.length > 0 ? (
        <Section title="Previous attempts">
          <ul className="space-y-1" data-testid="task-detail-attempts">
            {previousAttempts.map((attempt) => (
              <li key={attempt.id} className="rounded border border-border px-2 py-1 text-[10px]">
                <span className="text-foreground">attempt {attempt.attempt}</span>{' '}
                <span className="text-muted-foreground">
                  · {attempt.status}
                  {attempt.failureReason ? ` (${attempt.failureReason})` : ''} · review{' '}
                  {attempt.reviewDecision}
                </span>
                {attempt.error ? (
                  <p className="mt-0.5 text-[9px] text-muted-foreground">{attempt.error}</p>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[9px] text-muted-foreground">
            Each attempt keeps its own result and its own decision.
          </p>
        </Section>
      ) : null}
    </aside>
  )
}

function Section({
  title,
  action,
  children
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="border-b border-border px-3 py-2">
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
        <div className="ml-auto">{action}</div>
      </div>
      {children}
    </section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-baseline gap-2 py-0.5 text-[10px]">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 text-foreground">{children}</span>
    </div>
  )
}

function formatTime(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)} ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${String(seconds)} s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${String(minutes)}m ${String(rest)}s`
}
