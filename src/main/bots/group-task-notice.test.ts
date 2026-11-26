import { describe, expect, it } from 'vitest'
import { taskGroupMilestone } from './group-task-notice'

const base = {
  id: 'task_1',
  title: 'Add rate limiting',
  approval: 'approved' as const,
  changesRequestedAt: null as number | null,
  reviewDecision: 'pending' as const
}

describe('group task milestones', () => {
  it('announces a task waiting for approval', () => {
    const milestone = taskGroupMilestone(
      { ...base, status: 'queued', approval: 'pending' },
      'Backend'
    )
    expect(milestone?.key).toBe('task:task_1:approval')
    expect(milestone?.body).toContain('waiting for your approval')
  })

  it('announces assignment, work and review exactly once each', () => {
    expect(taskGroupMilestone({ ...base, status: 'queued' }, 'Backend')?.key).toBe(
      'task:task_1:queued'
    )
    expect(taskGroupMilestone({ ...base, status: 'running' }, 'Backend')?.key).toBe(
      'task:task_1:started'
    )
    expect(taskGroupMilestone({ ...base, status: 'completed' }, 'Backend')?.key).toBe(
      'task:task_1:review'
    )
  })

  it('reports a change request instead of a plain review', () => {
    const milestone = taskGroupMilestone(
      { ...base, status: 'completed', changesRequestedAt: 1_700_000_000_000 },
      'Backend'
    )
    expect(milestone?.key).toBe('task:task_1:changes')
    expect(milestone?.body).toContain('Changes were requested')
  })

  it('reports failures', () => {
    const milestone = taskGroupMilestone({ ...base, status: 'failed' }, 'Backend')
    expect(milestone?.key).toBe('task:task_1:failed')
  })

  it('stays quiet once a review has a final decision', () => {
    expect(
      taskGroupMilestone(
        { ...base, status: 'completed', reviewDecision: 'accepted' },
        'Backend'
      )
    ).toBeNull()
    expect(
      taskGroupMilestone(
        { ...base, status: 'completed', reviewDecision: 'rejected' },
        'Backend'
      )
    ).toBeNull()
    expect(taskGroupMilestone({ ...base, status: 'cancelled' }, 'Backend')).toBeNull()
  })
})
