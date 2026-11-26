import { describe, expect, it } from 'vitest'
import type { TaskRecordPayload } from '../../../shared/icode-api'
import {
  taskAttention,
  taskAttentionCounts,
  taskCanCancel,
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
    attemptMode: 'fresh',
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
    canResume: false,
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
    expect(
      taskAttention(task({ status: 'completed', reviewDecision: 'pending', archivedAt: 5 }))
    ).toBeNull()
  })

  it('counts the attention overlay', () => {
    const tasks = [
      task({ id: 'waiting', status: 'waiting' }),
      task({ id: 'failed', status: 'failed' }),
      task({ id: 'review', status: 'completed', reviewDecision: 'pending' }),
      task({ id: 'accepted', status: 'completed', reviewDecision: 'accepted' }),
      task({ id: 'queued', status: 'queued' })
    ]
    expect(taskAttentionCounts(tasks)).toEqual({
      approval: 0,
      answer: 1,
      retry: 1,
      review: 1,
      blocked: 0,
      total: 3
    })
  })

  it('treats a queued proposal as approval work, not queued work', () => {
    const proposal = task({
      id: 'proposal',
      status: 'queued',
      approval: 'pending',
      origin: 'supervisor'
    })
    expect(taskAttention(proposal)).toBe('Approval')
    expect(taskStatusLabel(proposal)).toBe('Proposed')
    expect(taskAttentionCounts([proposal])).toEqual({
      approval: 1,
      answer: 0,
      retry: 0,
      review: 0,
      blocked: 0,
      total: 1
    })
  })

  it('flags a queued task only when a blocker is a dead end', () => {
    const blocked = task({
      status: 'queued',
      dependencies: [
        {
          id: 'blocker',
          title: 'Blocker',
          status: 'cancelled',
          reviewDecision: 'pending',
          holdDependents: false,
          satisfied: false
        }
      ]
    })
    expect(taskAttention(blocked)).toBe('Blocked')
    expect(taskAttentionCounts([blocked]).blocked).toBe(1)

    const merelyWaiting = task({
      status: 'queued',
      dependencies: [
        {
          id: 'blocker',
          title: 'Blocker',
          status: 'running',
          reviewDecision: 'pending',
          holdDependents: false,
          satisfied: false
        }
      ]
    })
    expect(taskAttention(merelyWaiting)).toBeNull()
  })

  it('gives waiting and review work a human-readable label', () => {
    expect(taskStatusLabel(task({ status: 'waiting' }))).toBe('Needs input')
    expect(taskStatusLabel(task({ status: 'completed', reviewDecision: 'pending' }))).toBe('Review')
  })
})

describe('taskCanCancel', () => {
  it('offers cancel for work that is queued or running', () => {
    expect(taskCanCancel(task({ status: 'queued' }))).toBe(true)
    expect(taskCanCancel(task({ status: 'dispatching' }))).toBe(true)
    expect(taskCanCancel(task({ status: 'running' }))).toBe(true)
    expect(taskCanCancel(task({ status: 'waiting' }))).toBe(true)
  })

  it('withholds cancel from proposals and from work that already ended', () => {
    expect(taskCanCancel(task({ status: 'queued', canApprove: true }))).toBe(false)
    expect(taskCanCancel(task({ status: 'completed' }))).toBe(false)
    expect(taskCanCancel(task({ status: 'failed' }))).toBe(false)
    expect(taskCanCancel(task({ status: 'cancelled' }))).toBe(false)
  })
})
