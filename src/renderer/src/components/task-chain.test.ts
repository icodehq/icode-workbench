import { describe, expect, it } from 'vitest'
import type { TaskRecordPayload } from '../../../shared/icode-api'
import type {
  TaskDependencySummary,
  TaskDependentSummary
} from '../../../shared/domain/task'
import { buildTaskChain, chainEdgeSatisfied } from './task-chain'

function task(id: string, overrides: Partial<TaskRecordPayload> = {}): TaskRecordPayload {
  return {
    id,
    repoId: 'repo',
    title: id,
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

function dependency(
  id: string,
  overrides: Partial<TaskDependencySummary> = {}
): TaskDependencySummary {
  return {
    id,
    title: id,
    status: 'queued',
    reviewDecision: 'pending',
    holdDependents: false,
    satisfied: false,
    ...overrides
  }
}

function dependent(
  id: string,
  overrides: Partial<TaskDependentSummary> = {}
): TaskDependentSummary {
  return {
    id,
    title: id,
    status: 'queued',
    archivedAt: null,
    ...overrides
  }
}

describe('task chain model', () => {
  it('places transitive blockers left and dependents right', () => {
    const tasks = [
      task('a'),
      task('b', { dependencies: [dependency('a')], dependents: [dependent('c')] }),
      task('c', { dependencies: [dependency('b')], dependents: [dependent('d')] }),
      task('d', { dependencies: [dependency('c')] })
    ]
    const chain = buildTaskChain(tasks, 'c')
    const depths = new Map(chain.nodes.map((node) => [node.id, node.depth]))

    expect(depths.get('a')).toBe(-2)
    expect(depths.get('b')).toBe(-1)
    expect(depths.get('c')).toBe(0)
    expect(depths.get('d')).toBe(1)
    expect(chain.edges).toEqual([
      { blockerId: 'a', dependentId: 'b' },
      { blockerId: 'b', dependentId: 'c' },
      { blockerId: 'c', dependentId: 'd' }
    ])
    expect(chain.truncated).toBe(false)
  })

  it('keeps a blocker outside the loaded list as an external node', () => {
    const tasks = [
      task('root', {
        dependencies: [dependency('outside', { title: 'Outside task' })]
      })
    ]
    const chain = buildTaskChain(tasks, 'root')
    const external = chain.nodes.find((node) => node.id === 'outside')

    expect(external?.external).toBe(true)
    expect(external?.title).toBe('Outside task')
    expect(external?.depth).toBe(-1)
  })

  it('stops at the node limit and reports truncation', () => {
    const tasks = [
      task('a'),
      task('b', { dependencies: [dependency('a')] }),
      task('c', { dependencies: [dependency('b')] })
    ]
    const chain = buildTaskChain(tasks, 'c', 2)
    expect(chain.nodes).toHaveLength(2)
    expect(chain.truncated).toBe(true)
  })

  it('terminates on cyclic data and does not duplicate nodes', () => {
    const tasks = [
      task('a', { dependencies: [dependency('b')], dependents: [dependent('b')] }),
      task('b', { dependencies: [dependency('a')], dependents: [dependent('a')] })
    ]
    const chain = buildTaskChain(tasks, 'a')
    expect(chain.nodes.map((node) => node.id).sort()).toEqual(['a', 'b'])
  })

  it('mirrors the acceptance gate when deciding whether an edge is satisfied', () => {
    expect(
      chainEdgeSatisfied({
        id: 'a',
        title: 'a',
        status: 'completed',
        reviewDecision: 'pending',
        holdDependents: false,
        external: false,
        depth: 0,
        row: 0
      })
    ).toBe(true)
    expect(
      chainEdgeSatisfied({
        id: 'a',
        title: 'a',
        status: 'completed',
        reviewDecision: 'pending',
        holdDependents: true,
        external: false,
        depth: 0,
        row: 0
      })
    ).toBe(false)
  })
})
