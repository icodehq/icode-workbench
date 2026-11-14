import type { TaskRecordPayload } from '../../../shared/icode-api'
import { translate } from '../i18n/i18n-store'

export type TaskAttentionKind = 'Approval' | 'Answer' | 'Retry' | 'Review' | 'Blocked'

export type TaskAttentionCounts = {
  approval: number
  answer: number
  retry: number
  review: number
  blocked: number
  total: number
}

/**
 * Whether a queued task is waiting on at least one unsatisfied dependency.
 * This is display state; the lifecycle status stays `queued`.
 */
export function taskIsBlocked(task: TaskRecordPayload): boolean {
  return (
    task.status === 'queued' &&
    (task.dependencies ?? []).some((dependency) => !dependency.satisfied)
  )
}

/**
 * Whether one of those blockers can never satisfy the gate without a person.
 *
 * A failed or cancelled blocker has no completion to give, and a rejected
 * review will not become an acceptance on its own. Those are the dead ends that
 * need their own Needs row; a running blocker or one awaiting review is already
 * represented by its own state.
 */
export function taskBlockedByDeadEnd(task: TaskRecordPayload): boolean {
  return (task.dependencies ?? []).some((dependency) => {
    if (dependency.satisfied) return false
    if (dependency.status === 'failed' || dependency.status === 'cancelled') return true
    return dependency.status === 'completed' && dependency.reviewDecision === 'rejected'
  })
}

export function taskAttention(task: TaskRecordPayload): TaskAttentionKind | null {
  if (task.archivedAt !== null && task.archivedAt !== undefined) return null
  if (task.approval === 'pending' && task.status === 'queued') return 'Approval'
  if (task.status === 'waiting') return 'Answer'
  if (task.status === 'failed') return 'Retry'
  if (task.status === 'completed' && task.reviewDecision === 'pending') return 'Review'
  if (task.status === 'queued' && taskBlockedByDeadEnd(task)) return 'Blocked'
  return null
}

export function taskAttentionCounts(tasks: readonly TaskRecordPayload[]): TaskAttentionCounts {
  const counts = { approval: 0, answer: 0, retry: 0, review: 0, blocked: 0, total: 0 }
  for (const task of tasks) {
    const kind = taskAttention(task)
    if (kind === 'Approval') counts.approval += 1
    else if (kind === 'Answer') counts.answer += 1
    else if (kind === 'Retry') counts.retry += 1
    else if (kind === 'Review') counts.review += 1
    else if (kind === 'Blocked') counts.blocked += 1
    if (kind !== null) counts.total += 1
  }
  return counts
}

export function taskIsActive(task: TaskRecordPayload): boolean {
  return task.status === 'dispatching' || task.status === 'running' || task.status === 'waiting'
}

export type TaskLifecycleGroup = 'proposal' | 'running' | 'queued' | 'finished'

export function taskGroup(task: TaskRecordPayload): TaskLifecycleGroup {
  if (task.approval === 'pending' && task.status === 'queued') return 'proposal'
  if (taskIsActive(task)) return 'running'
  if (task.status === 'queued') return 'queued'
  return 'finished'
}

export function sortRunningTasks(tasks: readonly TaskRecordPayload[]): TaskRecordPayload[] {
  const rank = (task: TaskRecordPayload): number =>
    task.status === 'waiting' ? 0 : task.status === 'running' ? 1 : 2
  return [...tasks].sort(
    (left, right) => rank(left) - rank(right) || right.updatedAt - left.updatedAt
  )
}

export function sortQueuedTasks(tasks: readonly TaskRecordPayload[]): TaskRecordPayload[] {
  return [...tasks].sort((left, right) => left.createdAt - right.createdAt)
}

export function sortFinishedTasks(tasks: readonly TaskRecordPayload[]): TaskRecordPayload[] {
  const rank = (task: TaskRecordPayload): number => {
    if (task.status === 'completed' && task.reviewDecision === 'pending') return 0
    if (task.status === 'failed') return 1
    if (task.status === 'completed') return 2
    return 3
  }
  return [...tasks].sort(
    (left, right) => rank(left) - rank(right) || right.updatedAt - left.updatedAt
  )
}

export function taskStatusLabel(task: TaskRecordPayload): string {
  if (task.approval === 'pending' && task.status === 'queued') {
    return translate('task.status.proposed')
  }
  if (task.status === 'waiting') return translate('task.status.needsInput')
  if (task.status === 'dispatching') return translate('task.status.dispatching')
  if (task.status === 'completed') {
    return task.reviewDecision === 'pending'
      ? translate('task.status.review')
      : translate('task.status.completed')
  }
  return translate(`task.status.${task.status}`)
}

export function taskStatusTone(task: TaskRecordPayload): string {
  switch (task.status) {
    case 'queued':
      return task.approval === 'pending' ? 'text-signal' : 'text-muted-foreground'
    case 'waiting':
      return 'text-signal'
    case 'failed':
      return 'text-destructive'
    case 'completed':
      return task.reviewDecision === 'pending' ? 'text-info' : 'text-add'
    case 'running':
    case 'dispatching':
      return 'text-add'
    case 'cancelled':
      return 'text-muted-foreground'
  }
}

/** The rounded status pill used by the task workbench header. */
export function taskPillClass(task: TaskRecordPayload): string {
  switch (task.status) {
    case 'queued':
      return task.approval === 'pending'
        ? 'border-signal-line bg-signal-weak text-signal'
        : 'border-border text-muted-foreground'
    case 'waiting':
      return 'border-signal-line bg-signal-weak text-signal'
    case 'failed':
      return 'border-destructive/50 bg-destructive/10 text-destructive'
    case 'completed':
      return task.reviewDecision === 'pending'
        ? 'border-info/50 bg-info-weak text-info'
        : 'border-add/50 bg-add-weak text-add'
    case 'running':
    case 'dispatching':
      return 'border-add/50 bg-add-weak text-add'
    default:
      return 'border-border text-muted-foreground'
  }
}

export function taskIsReviewPending(task: TaskRecordPayload): boolean {
  return task.status === 'completed' && task.reviewDecision === 'pending'
}
