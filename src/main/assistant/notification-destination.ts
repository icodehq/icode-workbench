import type { AssistantCard, AssistantNotificationKind } from '../../shared/domain/assistant'

/** The parts of a task a notification destination needs. */
export type NotificationTask = {
  id: string
  sessionId: string | null
}

/** Where an OS notification click should take the user. */
export type NotificationFocusDestination =
  | { kind: 'assistant' }
  | { kind: 'session'; sessionId: string; view?: 'terminal' | 'changes' | 'files' }
  | { kind: 'task'; taskId: string }

/**
 * Maps a Mira notification to the place where the user can act on it.
 *
 * Only kinds that describe a concrete task or session leave Mira; everything
 * else (including a task that disappeared) falls back to the notification card.
 */
export function notificationDestination(
  kind: AssistantNotificationKind | null,
  task: NotificationTask | null
): NotificationFocusDestination {
  if (task === null) return { kind: 'assistant' }
  switch (kind) {
    case 'approval-needed':
      return { kind: 'task', taskId: task.id }
    case 'task-waiting':
    case 'task-failed':
      return task.sessionId === null
        ? { kind: 'task', taskId: task.id }
        : { kind: 'session', sessionId: task.sessionId }
    case 'review-ready':
      return task.sessionId === null
        ? { kind: 'task', taskId: task.id }
        : { kind: 'session', sessionId: task.sessionId, view: 'changes' }
    default:
      return { kind: 'assistant' }
  }
}

/** The task a notification card points at, when it has one. */
export function notificationTaskId(card: AssistantCard | null): string | null {
  if (card === null) return null
  switch (card.type) {
    case 'task':
      return card.taskId
    case 'action':
    case 'notification':
      return card.taskId ?? null
    case 'error':
      return null
  }
}
