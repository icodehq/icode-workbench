import { describe, expect, it } from 'vitest'
import {
  notificationDestination,
  notificationTaskId,
  type NotificationTask
} from './notification-destination'

function task(sessionId: string | null): NotificationTask {
  return { id: 'task_1', sessionId }
}

describe('notificationDestination', () => {
  it('opens approvals in the task workbench', () => {
    expect(notificationDestination('approval-needed', task(null))).toEqual({
      kind: 'task',
      taskId: 'task_1'
    })
  })

  it('opens waiting and failed tasks in their session terminal', () => {
    expect(notificationDestination('task-waiting', task('ses_1'))).toEqual({
      kind: 'session',
      sessionId: 'ses_1'
    })
    expect(notificationDestination('task-failed', task('ses_1'))).toEqual({
      kind: 'session',
      sessionId: 'ses_1'
    })
  })

  it('opens review-ready tasks on Changes', () => {
    expect(notificationDestination('review-ready', task('ses_1'))).toEqual({
      kind: 'session',
      sessionId: 'ses_1',
      view: 'changes'
    })
  })

  it('falls back to the task when it has no session yet', () => {
    expect(notificationDestination('task-waiting', task(null))).toEqual({
      kind: 'task',
      taskId: 'task_1'
    })
    expect(notificationDestination('task-failed', task(null))).toEqual({
      kind: 'task',
      taskId: 'task_1'
    })
    expect(notificationDestination('review-ready', task(null))).toEqual({
      kind: 'task',
      taskId: 'task_1'
    })
  })

  it('falls back to the Mira card for missing tasks and non-task kinds', () => {
    expect(notificationDestination('task-failed', null)).toEqual({ kind: 'assistant' })
    expect(notificationDestination('custom', task('ses_1'))).toEqual({ kind: 'assistant' })
    expect(notificationDestination('task-completed', task('ses_1'))).toEqual({ kind: 'assistant' })
    expect(notificationDestination('plan-ready', task('ses_1'))).toEqual({ kind: 'assistant' })
    expect(notificationDestination(null, task('ses_1'))).toEqual({ kind: 'assistant' })
  })
})

describe('notificationTaskId', () => {
  it('reads the task id from task and notification cards', () => {
    expect(
      notificationTaskId({
        type: 'task',
        taskId: 'task_1',
        repoId: 'repo_1',
        title: 'Task',
        status: 'failed',
        approval: 'approved'
      })
    ).toBe('task_1')
    expect(
      notificationTaskId({ type: 'notification', kind: 'custom', text: 'x', taskId: 'task_2' })
    ).toBe('task_2')
  })

  it('returns null for cards without a task', () => {
    expect(notificationTaskId(null)).toBeNull()
    expect(notificationTaskId({ type: 'error', message: 'x' })).toBeNull()
    expect(notificationTaskId({ type: 'notification', kind: 'custom', text: 'x' })).toBeNull()
  })
})
