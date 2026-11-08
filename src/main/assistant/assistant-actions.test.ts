import { describe, expect, it, vi } from 'vitest'
import { AssistantActions } from './assistant-actions'
import { DEFAULT_ASSISTANT_SETTINGS } from '../../shared/domain/assistant'
import { newRepoId } from '../../shared/domain/ids'
import type { TaskRecord } from '../../shared/domain/task'

describe('AssistantActions', () => {
  it('creates a Mira task with low-risk provenance and an auto-policy approval', async () => {
    const repoId = newRepoId()
    const created = {
      id: 'task_1',
      repoId,
      title: 'Docs',
      prompt: 'Write docs.',
      status: 'queued',
      approval: 'approved',
      origin: 'supervisor',
      createdByActor: 'mira',
      createdBySessionId: null,
      assistantRunId: 'run_1',
      approvalPolicy: 'mira-low-risk',
      attempt: 1,
      finishedAt: null,
      updatedAt: 1,
      createdAt: 1,
      reviewDecision: 'pending',
      error: null
    } as unknown as TaskRecord
    const create = vi.fn(() => ({ ok: true as const, value: created }))
    const get = vi.fn(() => created)
    const recordAction = vi.fn()
    const actions = new AssistantActions({
      store: {
        getSettings: () => DEFAULT_ASSISTANT_SETTINGS,
        recordAction
      } as never,
      tasks: { create, get, maxConcurrent: () => 1 } as never,
      taskStore: { list: () => [], countAutoDispatchedSince: () => 0 } as never,
      sessions: { list: async () => ({ sessions: [], orphans: [] }) } as never,
      supervisors: {} as never,
      repositories: {
        list: () => [],
        findById: () => ({
          id: repoId,
          displayName: 'Repo',
          executionTarget: { kind: 'local' },
          currentBranch: 'main',
          availability: 'present',
          preparation: null
        })
      } as never,
      gitWorkspace: {} as never,
      policy: {
        classify: () => ({ autoApprove: true, reasons: [], risk: 'low' as const })
      } as never,
      listHarnesses: async () => [
        { state: 'available', harness: 'claude', command: { command: 'claude', args: [] } }
      ] as never,
      threadId: 'thread_1',
      runId: 'run_1',
      now: () => 1
    })

    const result = await actions.execute({
      op: 'tasks.create',
      repoId,
      title: 'Docs',
      prompt: 'Write docs.'
    })

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId,
        origin: 'supervisor',
        createdByActor: 'mira',
        createdBySessionId: null,
        assistantRunId: 'run_1',
        approval: 'approved',
        approvedBy: 'mira-policy',
        approvalPolicy: 'mira-low-risk'
      })
    )
    expect(result).toMatchObject({
      ok: true,
      card: { type: 'task', taskId: 'task_1', autoApproved: true }
    })
    expect(recordAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'mira',
        op: 'tasks.create',
        outcome: 'auto-dispatched'
      })
    )
  })
})
