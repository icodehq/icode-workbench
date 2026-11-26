import type { TaskRecord } from '../../shared/domain/task'
import { mainT } from '../i18n/main-i18n'

export type GroupTaskMilestone = {
  /** Dedupe key stored on the room message. */
  key: string
  body: string
}

type NoticeTask = Pick<
  TaskRecord,
  'id' | 'title' | 'status' | 'approval' | 'changesRequestedAt' | 'reviewDecision'
>

/**
 * Which bot-task milestones deserve a line in the group room.
 *
 * The room is a conversation, not an event log: assignment, the start of work,
 * a review, a change request and failure are the milestones a human acts on.
 * Everything else (archive, merge bookkeeping) stays in the Work panel.
 */
export function taskGroupMilestone(
  task: NoticeTask,
  botName: string
): GroupTaskMilestone | null {
  const title = task.title
  if (task.status === 'queued' && task.approval === 'pending') {
    return {
      key: `task:${task.id}:approval`,
      body: mainT('notifications.groupTaskApproval', { name: botName, title })
    }
  }
  if (task.status === 'queued' && task.approval === 'approved') {
    return {
      key: `task:${task.id}:queued`,
      body: mainT('notifications.groupTaskQueued', { name: botName, title })
    }
  }
  if (
    task.status === 'dispatching' ||
    task.status === 'running' ||
    task.status === 'waiting'
  ) {
    return {
      key: `task:${task.id}:started`,
      body: mainT('notifications.groupTaskStarted', { name: botName, title })
    }
  }
  if (task.status === 'completed' && task.changesRequestedAt !== null) {
    return {
      key: `task:${task.id}:changes`,
      body: mainT('notifications.groupTaskChanges', { name: botName, title })
    }
  }
  if (task.status === 'completed' && task.reviewDecision === 'pending') {
    return {
      key: `task:${task.id}:review`,
      body: mainT('notifications.groupTaskReview', { name: botName, title })
    }
  }
  if (task.status === 'failed') {
    return {
      key: `task:${task.id}:failed`,
      body: mainT('notifications.groupTaskFailed', { name: botName, title })
    }
  }
  return null
}
