import { describe, expect, it } from 'vitest'
import type { TaskRecordPayload } from '../../../shared/icode-api'
import {
  sortFinishedTasks,
  sortQueuedTasks,
  taskAttention,
  taskAttentionCounts,
  taskGroup,
  taskStatusLabel
} from './task-status'

function task(overrides: Partial<TaskRecordPayload>): TaskRecordPayload {
  return {
    id: 'task-1',
    repoId: 'repo',
    title: 'Task',
    prompt: 'Do the work',
    harness: 'shell',
    status: 'queued',
    sessionId: null,
    worktreePath: null,
    attempt: 1,
    previousTaskId: null,
    scheduleId: null,
    occurrenceAt: null,
    createdAt: 1,
    updatedAt: 1,
    startedAt: null,
    finishedAt: null,
    resultSummary: null,
    error: null,
    errorDetail: null,
    failureReason: null,
    lastObservedState: null,
    exitCode: null,
    reviewDecision: 'pending',
    reviewedAt: null,
    reviewNote: null,
    sessionLive: false,
    canRetry: false,
    canReview: false,
    canDecideReview: false,
    reviewDecisionFinal: false,
    ...overrides
  }
}

describe('task attention and lifecycle', () => {
  it('maps each attention kind without duplicating lifecycle', () => {
    expect(taskAttention(task({ status: 'waiting' }))).toBe('Answer')
    expect(taskAttention(task({ status: 'failed' }))).toBe('Retry')
    expect(taskAttention(task({ status: 'completed', reviewDecision: 'pending' }))).toBe('Review')
    expect(taskAttention(task({ status: 'completed', reviewDecision: 'accepted' }))).toBeNull()
    expect(taskAttention(task({ status: 'running' }))).toBeNull()
    expect(taskAttention(task({ status: 'cancelled' }))).toBeNull()
  })

  it('counts the overlay and keeps lifecycle groups disjoint', () => {
    const tasks = [
      task({ id: 'waiting', status: 'waiting' }),
      task({ id: 'failed', status: 'failed' }),
      task({ id: 'review', status: 'completed', reviewDecision: 'pending' }),
      task({ id: 'accepted', status: 'completed', reviewDecision: 'accepted' }),
      task({ id: 'queued', status: 'queued' })
    ]
    expect(taskAttentionCounts(tasks)).toEqual({ answer: 1, retry: 1, review: 1, total: 3 })
    expect(tasks.map((entry) => taskGroup(entry))).toEqual(['running', 'finished', 'finished', 'finished', 'queued'])
  })

  it('orders finished work review-first, then failed, then decided work', () => {
    const review = task({ id: 'review', status: 'completed', updatedAt: 3 })
    const failed = task({ id: 'failed', status: 'failed', updatedAt: 2 })
    const accepted = task({ id: 'accepted', status: 'completed', reviewDecision: 'accepted', updatedAt: 1 })
    const cancelled = task({ id: 'cancelled', status: 'cancelled', updatedAt: 0 })
    expect(sortFinishedTasks([cancelled, accepted, failed, review]).map((entry) => entry.id)).toEqual([
      'review',
      'failed',
      'accepted',
      'cancelled'
    ])
  })

  it('keeps queued work oldest first and gives waiting a human-readable label', () => {
    expect(
      sortQueuedTasks([
        task({ id: 'new', createdAt: 20 }),
        task({ id: 'old', createdAt: 10 })
      ]).map((entry) => entry.id)
    ).toEqual(['old', 'new'])
    expect(taskStatusLabel(task({ status: 'waiting' }))).toBe('Needs input')
    expect(taskStatusLabel(task({ status: 'completed', reviewDecision: 'pending' }))).toBe('Review')
  })
})
