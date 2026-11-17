import { describe, expect, it } from 'vitest'
import type { TaskRecordPayload } from '../../../../shared/icode-api'
import { taskMenuEntries } from './task-menu'

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

function plan(entry: TaskRecordPayload): string[] {
  return taskMenuEntries(entry).map((item) => item.id)
}

function separators(entry: TaskRecordPayload): string[] {
  return taskMenuEntries(entry)
    .filter((item) => item.separatorBefore)
    .map((item) => item.id)
}

describe('taskMenuEntries', () => {
  it('leads a failed task with recovery and divides management from it', () => {
    const failed = task({ status: 'failed', canRetry: true, canArchive: true })
    expect(plan(failed)).toEqual(['retry', 'archive', 'pin'])
    expect(separators(failed)).toEqual(['archive'])
  })

  it('puts a resumable attempt before retry', () => {
    const resumable = task({ status: 'failed', canResume: true, canRetry: true, canArchive: true })
    expect(plan(resumable)).toEqual(['continue', 'retry', 'archive', 'pin'])
  })

  it('offers archive, then pin, on finished work', () => {
    const finished = task({ status: 'completed', canArchive: true })
    expect(plan(finished)).toEqual(['archive', 'pin'])
    expect(separators(finished)).toEqual([])
  })

  it('offers restore instead of archive in history', () => {
    const archived = task({ status: 'completed', canUnarchive: true, archivedAt: 4 })
    expect(plan(archived)).toEqual(['unarchive', 'pin'])
  })

  it('keeps cancel last and separated while work runs', () => {
    const running = task({ status: 'running' })
    expect(plan(running)).toEqual(['pin', 'cancel'])
    expect(separators(running)).toEqual(['cancel'])
  })

  it('never offers cancel for a proposal', () => {
    const proposal = task({ status: 'queued', canApprove: true })
    expect(plan(proposal)).toEqual(['pin'])
  })

  it('always leaves pin reachable', () => {
    expect(plan(task({ status: 'waiting' }))).toEqual(['pin', 'cancel'])
    expect(plan(task({ status: 'cancelled', canArchive: true }))).toEqual(['archive', 'pin'])
  })
})
