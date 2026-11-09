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

  it('continues a Mira-owned task in place and audits the intent', async () => {
    const repoId = newRepoId()
    const failed = {
      id: 'task_1',
      repoId,
      title: 'Docs',
      status: 'failed',
      approval: 'approved',
      origin: 'supervisor',
      createdByActor: 'mira',
      createdBySessionId: null,
      sessionId: 'ses_1',
      attempt: 1,
      attemptMode: 'fresh',
      canResume: true,
      error: 'Insufficient balance.',
      reviewDecision: 'pending',
      updatedAt: 1
    } as unknown as TaskRecord
    const continued = {
      ...failed,
      id: 'task_2',
      status: 'queued',
      attempt: 2,
      attemptMode: 'resume',
      canResume: false,
      error: null
    } as unknown as TaskRecord
    const get = vi.fn((id: string) => (id === 'task_1' ? failed : continued))
    const resume = vi.fn(() => ({ ok: true as const, value: continued }))
    const recordAction = vi.fn()
    const actions = new AssistantActions({
      store: { getSettings: () => DEFAULT_ASSISTANT_SETTINGS, recordAction } as never,
      tasks: { get, resume } as never,
      taskStore: {} as never,
      sessions: {} as never,
      supervisors: {} as never,
      repositories: {} as never,
      gitWorkspace: {} as never,
      policy: {} as never,
      listHarnesses: async () => [] as never,
      threadId: 'thread_1',
      runId: 'run_1',
      now: () => 1
    })

    const result = await actions.execute({ op: 'tasks.resume', taskId: 'task_1' })

    expect(resume).toHaveBeenCalledWith('task_1', { assistantRunId: 'run_1' })
    expect(result).toMatchObject({
      op: 'tasks.resume',
      ok: true,
      card: { type: 'task', taskId: 'task_2', canResume: false }
    })
    expect(recordAction).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'tasks.resume', outcome: 'ok' })
    )
  })

  it('refuses to continue a task a person created', async () => {
    const repoId = newRepoId()
    const humanTask = {
      id: 'task_1',
      repoId,
      title: 'Docs',
      status: 'failed',
      approval: 'approved',
      origin: 'human',
      createdByActor: null,
      createdBySessionId: null,
      sessionId: 'ses_1',
      attempt: 1,
      attemptMode: 'fresh',
      canResume: true,
      error: null,
      reviewDecision: 'pending',
      updatedAt: 1
    } as unknown as TaskRecord
    const resume = vi.fn()
    const recordAction = vi.fn()
    const actions = new AssistantActions({
      store: { getSettings: () => DEFAULT_ASSISTANT_SETTINGS, recordAction } as never,
      tasks: { get: () => humanTask, resume } as never,
      taskStore: {} as never,
      sessions: {} as never,
      supervisors: {} as never,
      repositories: {} as never,
      gitWorkspace: {} as never,
      policy: {} as never,
      listHarnesses: async () => [] as never,
      threadId: 'thread_1',
      runId: 'run_1',
      now: () => 1
    })

    const result = await actions.execute({ op: 'tasks.resume', taskId: 'task_1' })

    expect(resume).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
  })
})
