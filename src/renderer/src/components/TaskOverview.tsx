import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, GitBranch, Loader2, Terminal, X } from 'lucide-react'
import { callApi, errorNotice } from '../lib/api'
import type { TaskChangesPayload, TaskRecordPayload } from '../../../shared/icode-api'
import type { SessionSummary } from '../../../shared/schemas/ipc'
import type { Notice } from '../state/workspace'
import { sessionStateLabel, stateDotClass } from './status'
import { formatDateTime } from '../../../shared/i18n'
import { getLocale, translate } from '../i18n/i18n-store'
import { useT } from '../i18n/use-i18n'
import {
  taskPillClass,
  taskStatusLabel
} from './task-status'

export type TaskOverviewProps = {
  task: TaskRecordPayload
  previousAttempts: TaskRecordPayload[]
  /** The project's tasks, used to resolve dependency titles for pickers. */
  projectTasks: TaskRecordPayload[]
  notify: (notice: Notice) => void
  session: SessionSummary | null
  onOpenTerminal: () => void
  onOpenFullSession: () => void
  onOpenChanges: () => void
  onSelectTask: (taskId: string) => void
  onQueueFollowUp: (task: TaskRecordPayload) => void
  onChanged: () => void
  /** Opens the Source Control merge picker (used by Accept & merge). */
  onMerge?: () => void
}

const ACTIVE = new Set(['queued', 'dispatching', 'running', 'waiting'])

function formatTime(value: number): string {
  return formatDateTime(getLocale(), value, { hour: '2-digit', minute: '2-digit' })
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  if (seconds < 60) return translate('duration.seconds', { seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return translate('duration.minutesSeconds', {
      minutes,
      seconds: seconds % 60
    })
  }
  const hours = Math.floor(minutes / 60)
  return translate('duration.hoursMinutes', { hours, minutes: minutes % 60 })
}

/** Whether `startId` already waits on `targetId`; adding the reverse edge cycles. */
function canReach(
  startId: string,
  targetId: string,
  tasksById: Map<string, TaskRecordPayload>
): boolean {
  const stack = [startId]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const id = stack.pop()!
    if (id === targetId) return true
    if (seen.has(id)) continue
    seen.add(id)
    for (const dependency of tasksById.get(id)?.dependencies ?? []) stack.push(dependency.id)
  }
  return false
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
  projectTasks,
  notify,
  session,
  onOpenTerminal,
  onOpenFullSession,
  onOpenChanges,
  onSelectTask,
  onQueueFollowUp,
  onChanged,
  onMerge
}: TaskOverviewProps): React.JSX.Element {
  const t = useT()
  const [changes, setChanges] = useState<TaskChangesPayload | null>(null)
  const [loadingChanges, setLoadingChanges] = useState(true)
  const [busy, setBusy] = useState(false)
  const [dependencyBusy, setDependencyBusy] = useState(false)
  const [note, setNote] = useState(task.reviewNote ?? '')
  const [confirming, setConfirming] = useState<'accepted' | 'rejected' | null>(null)
  const blockerSelectRef = useRef<HTMLSelectElement | null>(null)

  const active = ACTIVE.has(task.status)

  const loadChanges = useCallback(async (): Promise<void> => {
    setLoadingChanges(true)
    const result = await callApi<TaskChangesPayload>(window.icode.tasks.changes({ taskId: task.id }))
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

  const decide = async (decision: 'accepted' | 'rejected'): Promise<boolean> => {
    if (busy) return false
    if (task.reviewDecision !== 'pending' && task.reviewDecision !== decision && !confirming) {
      setConfirming(decision)
      return false
    }
    setBusy(true)
    try {
      const result = await callApi<TaskRecordPayload>(
        window.icode.tasks.decideReview({
          taskId: task.id,
          decision,
          note: note.trim() ? note.trim() : null,
          replace: task.reviewDecision !== 'pending' && task.reviewDecision !== decision
        })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return false
      }
      setConfirming(null)
      notify({
        tone: 'success',
        message:
          decision === 'accepted'
            ? t('taskOverview.acceptedNotice')
            : t('taskOverview.rejectedNotice')
      })
      onChanged()
      return true
    } finally {
      setBusy(false)
    }
  }

  const acceptAndMerge = async (): Promise<void> => {
    if (onMerge === undefined) return
    if (await decide('accepted')) onMerge()
  }

  const setArchived = async (archived: boolean): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const result = await callApi<TaskRecordPayload>(
        archived
          ? window.icode.tasks.archive({ taskId: task.id })
          : window.icode.tasks.unarchive({ taskId: task.id })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      notify({
        tone: 'info',
        message: archived
          ? t('taskOverview.archivedNotice')
          : t('taskOverview.restoredNotice')
      })
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  const settleProposal = async (decision: 'approve' | 'reject'): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const result = await callApi<TaskRecordPayload>(
        decision === 'approve'
          ? window.icode.tasks.approve({ taskId: task.id })
          : window.icode.tasks.reject({ taskId: task.id })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      notify({
        tone: decision === 'approve' ? 'success' : 'info',
        message:
          decision === 'approve'
            ? t('taskOverview.approvedNotice')
            : t('taskOverview.rejectedNotice')
      })
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  const addDependency = async (blockerId: string): Promise<void> => {
    if (!blockerId || dependencyBusy) return
    setDependencyBusy(true)
    try {
      const result = await callApi<TaskRecordPayload>(
        window.icode.tasks.addDependency({ taskId: task.id, blockerId })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      notify({ tone: 'info', message: t('taskOverview.dependencies.added') })
      onChanged()
    } finally {
      setDependencyBusy(false)
    }
  }

  const removeDependency = async (blockerId: string): Promise<void> => {
    if (dependencyBusy) return
    setDependencyBusy(true)
    try {
      const result = await callApi<TaskRecordPayload>(
        window.icode.tasks.removeDependency({ taskId: task.id, blockerId })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      notify({ tone: 'info', message: t('taskOverview.dependencies.removed') })
      onChanged()
    } finally {
      setDependencyBusy(false)
    }
  }

  const setHoldDependents = async (hold: boolean): Promise<void> => {
    if (dependencyBusy) return
    setDependencyBusy(true)
    try {
      const result = await callApi<TaskRecordPayload>(
        window.icode.tasks.setHoldDependents({ taskId: task.id, hold })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      onChanged()
    } finally {
      setDependencyBusy(false)
    }
  }

  const duration =
    task.startedAt !== null && task.finishedAt !== null
      ? formatDuration(task.finishedAt - task.startedAt)
      : null
  const dependencies = task.dependencies ?? []
  const dependents = task.dependents ?? []
  const blockerIds = new Set(dependencies.map((dependency) => dependency.id))
  const tasksById = new Map(projectTasks.map((candidate) => [candidate.id, candidate]))
  const availableBlockers = projectTasks.filter(
    (candidate) =>
      candidate.id !== task.id &&
      !blockerIds.has(candidate.id) &&
      !canReach(candidate.id, task.id, tasksById)
  )
  const holdEditable = task.reviewDecision === 'pending' && task.archivedAt == null
  const queued = task.status === 'queued'
  const changedFiles = changes?.status === 'available' ? changes.files ?? [] : []
  const additions = changedFiles.reduce((total, file) => total + (file.additions ?? 0), 0)
  const deletions = changedFiles.reduce((total, file) => total + (file.deletions ?? 0), 0)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-background p-4" data-testid="task-detail">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card
            title={t('taskOverview.instruction')}
            action={
              <button
                type="button"
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                title={t('taskOverview.copyInstruction')}
                aria-label={t('taskOverview.copyInstruction')}
                onClick={() => {
                  void navigator.clipboard.writeText(task.prompt)
                  notify({ tone: 'success', message: t('taskOverview.copied') })
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

          <Card
            title={t('taskOverview.activity')}
            action={
              task.canArchive || task.canUnarchive ? (
                <button
                  type="button"
                  className="rounded border border-border px-1.5 py-0.5 text-[9px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                  onClick={() => void setArchived(task.canArchive === true)}
                  disabled={busy}
                  data-testid="task-detail-archive"
                >
                  {task.canUnarchive ? t('taskOverview.restore') : t('taskOverview.archive')}
                </button>
              ) : undefined
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex h-[21px] items-center gap-1.5 rounded-full border px-2 text-[10.5px] font-medium ${taskPillClass(task)}`}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-current" />
                {taskStatusLabel(task)}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {t('taskOverview.attempt', { count: task.attempt })}
                {duration ? ` · ${duration}` : ''}
                {task.updatedAt
                  ? t('taskOverview.updated', { time: formatTime(task.updatedAt) })
                  : ''}
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
                {t('taskOverview.reason', { reason: task.failureReason })}
              </p>
            ) : null}
            {active && task.sessionLive ? (
              <p className="mt-2 rounded-md border border-signal-line bg-signal-weak px-2.5 py-2 text-[10.5px] leading-relaxed text-signal" data-testid="task-detail-attention">
                {t('taskOverview.liveNote')}
              </p>
            ) : null}
          </Card>

          {task.canApprove ? (
            <Card title={t('taskOverview.proposal')}>
              <p className="text-[11.5px] leading-relaxed text-muted-foreground" data-testid="task-proposal-state">
                {task.createdByActor === 'mira'
                  ? t('taskOverview.proposedByMira')
                  : t('taskOverview.proposedBySupervisor')}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-signal-line bg-signal-weak px-2.5 text-[10.5px] text-signal hover:bg-signal/15 disabled:opacity-40"
                  onClick={() => void settleProposal('approve')}
                  disabled={busy}
                  data-testid="task-proposal-approve"
                >
                  <Check size={11} />
                  {t('taskOverview.approve')}
                </button>
                <button
                  type="button"
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2.5 text-[10.5px] text-foreground hover:bg-muted disabled:opacity-40"
                  onClick={() => void settleProposal('reject')}
                  disabled={busy}
                  data-testid="task-proposal-reject"
                >
                  <X size={11} />
                  {t('taskOverview.reject')}
                </button>
              </div>
            </Card>
          ) : null}

          <Card
            title={t('taskOverview.changes')}
            action={
              <button
                type="button"
                className="text-[10px] text-muted-foreground hover:text-foreground"
                onClick={() => void loadChanges()}
                data-testid="task-changes-refresh"
              >
                {t('taskOverview.changesRefresh')}
              </button>
            }
          >
            {loadingChanges ? (
              <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground" data-testid="task-changes-loading">
                <Loader2 size={11} className="animate-spin" />
                {t('taskOverview.readingWorktree')}
              </p>
            ) : changes === null ? null : changes.status === 'unavailable' ? (
              <p className="text-[11px] text-muted-foreground" data-testid="task-changes-unavailable">
                {changes.detail ?? t('taskOverview.noWorktree')}
              </p>
            ) : (changes.files ?? []).length === 0 ? (
              <p className="text-[11px] text-muted-foreground" data-testid="task-changes-empty">
                {t('taskOverview.noChanges')}
              </p>
            ) : (
              <>
                <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span>{t('taskOverview.filesCount', { count: changedFiles.length })}</span>
                  <span className="text-add">+{additions}</span>
                  <span className="text-destructive">−{deletions}</span>
                  <button
                    type="button"
                    className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-[10.5px] text-foreground hover:bg-muted"
                    onClick={onOpenChanges}
                    data-testid="task-changes-open-review"
                  >
                    <GitBranch size={11} />
                    {t('taskOverview.openDiff')}
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
                  <p className="mt-1 text-[10px] text-muted-foreground">
                  {t('taskOverview.moreFiles', { count: changedFiles.length - 4 })}
                </p>
                ) : null}
                {changes.listTruncated ? (
                  <p className="mt-1 text-[10px] text-signal">{t('taskOverview.truncated')}</p>
                ) : null}
                <p className="mt-2 text-[10px] text-muted-foreground">
                  {t('taskOverview.compared', {
                    baseline: changes.baselineOid
                      ? ` (${changes.baselineOid.slice(0, 7)})`
                      : ''
                  })}
                </p>
              </>
            )}
          </Card>

          <Card title={t('taskOverview.reviewDecision')}>
            <p className="text-[11.5px] text-muted-foreground" data-testid="task-detail-review-state">
              {task.reviewDecision === 'pending'
                ? active
                  ? t('taskOverview.reviewPendingActive')
                  : t('taskOverview.reviewPending')
                : task.reviewDecision === 'accepted'
                  ? task.reviewedAt
                    ? t('taskOverview.reviewAcceptedOn', { time: formatTime(task.reviewedAt) })
                    : t('taskOverview.accepted')
                  : task.reviewedAt
                    ? t('taskOverview.reviewRejectedOn', { time: formatTime(task.reviewedAt) })
                    : t('taskOverview.rejected')}
            </p>
            {task.reviewRecommendation ? (
              <div
                className="mt-2 rounded-md border border-info/40 bg-info-weak px-2.5 py-2 text-[10.5px] text-info"
                data-testid="task-review-recommendation"
              >
                <p className="font-medium">
                  {task.reviewRecommendation === 'accept'
                    ? t('taskOverview.recommendsAccept')
                    : t('taskOverview.recommendsReject')}
                  {task.reviewRecommendedAt
                    ? t('taskOverview.recommendationAt', {
                        time: formatTime(task.reviewRecommendedAt)
                      })
                    : ''}
                </p>
                {task.reviewRecommendationNote ? (
                  <p className="mt-1 whitespace-pre-wrap text-foreground/80">
                    {task.reviewRecommendationNote}
                  </p>
                ) : null}
                <p className="mt-1 text-[9.5px] opacity-80">
                  {t('taskOverview.recommendationNote')}
                </p>
              </div>
            ) : null}
            {task.reviewNote ? (
              <p className="mt-1 whitespace-pre-wrap text-[11px] text-foreground" data-testid="task-detail-review-note">
                {task.reviewNote}
              </p>
            ) : null}
            {task.canDecideReview ? (
              <>
                <textarea
                  className="mt-2 h-14 w-full resize-none rounded-md border border-border bg-muted/40 px-2 py-1.5 text-[11px] text-foreground outline-none placeholder:text-muted-foreground"
                  placeholder={t('taskOverview.reviewNotePlaceholder')}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  data-testid="task-review-note"
                />
                {confirming ? (
                  <p className="mt-1 text-[10.5px] text-signal" data-testid="task-review-confirm">
                    {t('taskOverview.confirmReplace', {
                      decision:
                        task.reviewDecision === 'accepted'
                          ? t('taskOverview.accepted')
                          : t('taskOverview.rejected'),
                      action:
                        confirming === 'accepted'
                          ? t('taskOverview.accept')
                          : t('taskOverview.reject')
                    })}
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
                    {confirming === 'accepted'
                      ? t('taskOverview.confirmAccept')
                      : t('taskOverview.accept')}
                  </button>
                  <button
                    type="button"
                    className="inline-flex h-7 items-center gap-1 rounded-md bg-accent px-2.5 text-[10.5px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
                    onClick={() => void acceptAndMerge()}
                    disabled={busy || onMerge === undefined}
                    data-testid="task-review-accept-merge"
                  >
                    <Check size={11} />
                    {t('taskOverview.acceptAndMerge')}
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
                    {confirming === 'rejected'
                      ? t('taskOverview.confirmReject')
                      : t('taskOverview.reject')}
                  </button>
                </div>
                <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground" data-testid="task-review-safety">
                  {t('taskOverview.reviewSafety')}
                </p>
              </>
            ) : (
              <p className="mt-1 text-[10px] text-muted-foreground">
                {t('taskOverview.decisionAvailable')}
              </p>
            )}
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Card title={t('taskOverview.details')}>
            <Row label={t('taskOverview.row.harness')}>{task.harness}</Row>
            <Row label={t('taskOverview.row.attempt')}>{task.attempt}</Row>
            <Row label={t('taskOverview.row.started')}>
              {task.startedAt === null ? '—' : formatTime(task.startedAt)}
            </Row>
            <Row label={t('taskOverview.row.finished')}>
              {task.finishedAt === null ? '—' : formatTime(task.finishedAt)}
            </Row>
            <Row label={t('taskOverview.row.duration')}>{duration ?? '—'}</Row>
            {task.exitCode !== null ? (
              <Row label={t('taskOverview.row.exitCode')}>
                <span data-testid="task-detail-exit">{task.exitCode}</span>
              </Row>
            ) : null}
            {session?.worktree ? (
              <>
                <Row label={t('taskOverview.row.branch')}>
                  <span className="font-mono">{session.worktree.branch}</span>
                </Row>
                <Row label={t('taskOverview.row.base')}>
                  <span className="font-mono">{session.worktree.baseOid.slice(0, 7)}</span>
                </Row>
              </>
            ) : null}
            <Row label={t('taskOverview.row.worktree')}>
              <span className="break-all font-mono text-[10px]" data-testid="task-detail-worktree">
                {task.worktreePath ?? session?.worktree?.path ?? '—'}
              </span>
            </Row>
            {task.scheduleId ? <Row label={t('taskOverview.row.schedule')}>{t('taskOverview.fromSchedule')}</Row> : null}
          </Card>

          <Card
            title={t('taskOverview.dependencies.title')}
            action={
              <button
                type="button"
                className="rounded border border-border px-1.5 py-0.5 text-[9px] text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => onQueueFollowUp(task)}
                data-testid="task-queue-follow-up"
              >
                {t('taskOverview.dependencies.followUp')}
              </button>
            }
          >
            {dependencies.length === 0 ? (
              <p className="text-[11px] text-muted-foreground" data-testid="task-dependencies-empty">
                {t('taskOverview.dependencies.none')}
              </p>
            ) : (
              <ul className="space-y-1.5" data-testid="task-dependencies-list">
                {dependencies.map((dependency) => (
                  <li
                    key={dependency.id}
                    className="rounded-md border border-border bg-muted/30 px-2 py-1.5 text-[10.5px]"
                  >
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left text-foreground hover:underline disabled:cursor-default disabled:hover:no-underline"
                        onClick={() => {
                          if (tasksById.has(dependency.id)) onSelectTask(dependency.id)
                        }}
                        disabled={!tasksById.has(dependency.id)}
                        title={dependency.title}
                        data-testid={`task-dependency-open-${dependency.id}`}
                      >
                        {dependency.title}
                      </button>
                      {queued ? (
                        <button
                          type="button"
                          className="shrink-0 text-muted-foreground hover:text-destructive disabled:opacity-40"
                          onClick={() => void removeDependency(dependency.id)}
                          disabled={dependencyBusy}
                          aria-label={t('taskOverview.dependencies.remove')}
                          data-testid={`task-dependency-remove-${dependency.id}`}
                        >
                          ×
                        </button>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-[9.5px] text-muted-foreground">
                      {dependency.holdDependents
                        ? t('taskOverview.dependencies.waitsForAcceptance')
                        : t('taskOverview.dependencies.startsWhenFinished')}
                      {' · '}
                      {dependency.satisfied
                        ? t('taskOverview.dependencies.satisfied')
                        : dependency.mergeState === 'conflicted'
                          ? t('taskOverview.dependencies.mergeConflicted')
                          : dependency.status === 'completed' &&
                              dependency.mergedIntoChain === false
                            ? t('taskOverview.dependencies.waitingForMerge')
                            : dependency.status === 'failed' ||
                                dependency.status === 'cancelled' ||
                                (dependency.status === 'completed' &&
                                  dependency.reviewDecision === 'rejected')
                              ? t('taskOverview.dependencies.blockerStopped')
                              : t('taskOverview.dependencies.waiting')}
                    </p>
                  </li>
                ))}
              </ul>
            )}

            {queued && availableBlockers.length > 0 ? (
              <div className="mt-2 flex items-center gap-1.5">
                <select
                  ref={blockerSelectRef}
                  className="h-7 min-w-0 flex-1 rounded border border-border bg-background px-1.5 text-[10px]"
                  aria-label={t('taskOverview.dependencies.blocker')}
                  data-testid="task-dependency-select"
                >
                  {availableBlockers.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.title}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="h-7 shrink-0 rounded border border-border px-1.5 text-[9.5px] hover:bg-muted disabled:opacity-40"
                  onClick={() => void addDependency(blockerSelectRef.current?.value ?? '')}
                  disabled={dependencyBusy}
                  data-testid="task-dependency-add"
                >
                  {t('taskOverview.dependencies.add')}
                </button>
              </div>
            ) : null}

            <label className="mt-2 flex items-start gap-1.5 text-[10px] text-muted-foreground">
              <input
                type="checkbox"
                className="mt-0.5 accent-accent"
                checked={task.holdDependents === true}
                disabled={!holdEditable || dependencyBusy}
                onChange={(event) => void setHoldDependents(event.target.checked)}
                data-testid="task-hold-dependents-toggle"
              />
              <span>{t('taskOverview.dependencies.hold')}</span>
            </label>

            {dependents.length > 0 ? (
              <div className="mt-2 border-t border-line pt-2">
                <p className="text-[9px] uppercase tracking-wide text-muted-foreground">
                  {t('taskOverview.dependencies.dependents')}
                </p>
                <ul className="mt-1 space-y-0.5">
                  {dependents.map((dependent) => (
                    <li key={dependent.id}>
                      <button
                        type="button"
                        className="max-w-full truncate text-left text-[10.5px] text-foreground hover:underline disabled:cursor-default disabled:hover:no-underline"
                        onClick={() => {
                          if (tasksById.has(dependent.id)) onSelectTask(dependent.id)
                        }}
                        disabled={!tasksById.has(dependent.id)}
                        title={dependent.title}
                      >
                        {dependent.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Card>

          <Card title={t('taskOverview.session')}>
            {session === null ? (
              <p className="text-[11px] text-muted-foreground" data-testid="task-detail-no-session">
                {t('taskOverview.notStarted')}
              </p>
            ) : (
              <>
                <div className="flex items-center gap-1.5 text-[11.5px] text-foreground">
                  <span className={`h-1.5 w-1.5 rounded-full ${stateDotClass(session.state, null)}`} />
                  {sessionStateLabel(session.state, null)}
                  {session.state === 'live' ? t('taskOverview.attachable') : ''}
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
                    {t('taskOverview.openTerminal')}
                  </button>
                  <button
                    type="button"
                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-[10.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={onOpenFullSession}
                    data-testid="task-full-session"
                  >
                    {t('taskOverview.fullSession')}
                  </button>
                </div>
              </>
            )}
          </Card>

          {previousAttempts.length > 0 ? (
            <Card title={t('taskOverview.previousAttempts')}>
              <ul className="space-y-1.5" data-testid="task-detail-attempts">
                {previousAttempts.map((attempt) => (
                  <li key={attempt.id} className="rounded-md border border-border bg-muted/30 px-2 py-1.5 text-[10.5px]">
                    <span className="text-foreground">
                      {t('taskOverview.attemptLabel', { count: attempt.attempt })}
                      {attempt.attemptMode === 'resume'
                        ? ` · ${t('tasks.row.continued')}`
                        : ''}
                    </span>{' '}
                    <span className="text-muted-foreground">
                      {t('taskOverview.attemptMeta', {
                        status: taskStatusLabel(attempt),
                        reason: attempt.failureReason
                          ? t('taskOverview.attemptReason', { reason: attempt.failureReason })
                          : '',
                        decision:
                          attempt.reviewDecision === 'accepted'
                            ? t('taskOverview.accepted')
                            : attempt.reviewDecision === 'rejected'
                              ? t('taskOverview.rejected')
                              : t('tasks.row.unreviewed')
                      })}
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
