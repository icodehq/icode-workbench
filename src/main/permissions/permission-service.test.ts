import { describe, expect, it, vi } from 'vitest'
import { PermissionService } from './permission-service'
import type { TaskRecord } from '../../shared/domain/task'

function task(overrides: Partial<TaskRecord> & Pick<TaskRecord, 'id' | 'sessionId'>): TaskRecord {
  return {
    repoId: 'repo_1' as never,
    title: 'Rewrite the README',
    prompt: 'Rewrite it',
    status: 'waiting',
    approval: 'approved',
    origin: 'human',
    createdByActor: null,
    createdBySessionId: null,
    botId: 'bot_1',
    groupId: overrides.groupId ?? 'group_1',
    groupThreadId: null,
    acceptanceCriteria: null,
    itemStatusOverride: null,
    snoozedUntil: null,
    archivedAt: null,
    attempt: 1,
    attemptMode: 'initial',
    error: null,
    resultSummary: null,
    reviewDecision: 'pending',
    reviewNote: null,
    reviewRecommendation: null,
    reviewRecommendedAt: null,
    reviewRecommendedBySessionId: null,
    changesRequestedAt: null,
    ...overrides
  } as TaskRecord
}

function fixture(tasks: TaskRecord[], holdMs?: number): {
  service: PermissionService
  changed: ReturnType<typeof vi.fn>
} {
  const changed = vi.fn()
  const service = new PermissionService({
    tasks: {
      findBySessionId: (sessionId: string) =>
        tasks.find((entry) => entry.sessionId === sessionId) ?? null
    } as never,
    now: () => 1_000,
    newId: () => 'permission_1',
    ...(holdMs === undefined ? {} : { holdMs })
  })
  service.subscribe(changed)
  return { service, changed }
}

describe('PermissionService', () => {
  it('holds a group task request and answers it', async () => {
    const { service, changed } = fixture([
      task({ id: 'task_1', sessionId: 'ses_1' as never })
    ])
    const pending = service.request({
      sessionId: 'ses_1',
      toolName: 'Bash',
      input: '{"command":"rm -rf build"}'
    })
    expect(pending).not.toBeNull()
    expect(service.list('group_1')).toEqual([
      expect.objectContaining({
        id: 'permission_1',
        taskId: 'task_1',
        groupId: 'group_1',
        toolName: 'Bash'
      })
    ])
    expect(changed).toHaveBeenCalledTimes(1)

    expect(service.respond('permission_1', { behavior: 'allow' })).toBe(true)
    await expect(pending).resolves.toEqual({ behavior: 'allow' })
    expect(service.list()).toEqual([])
    expect(changed).toHaveBeenCalledTimes(2)
    expect(service.respond('permission_1', { behavior: 'allow' })).toBe(false)
  })

  it('does not hold a task outside a group or a direct session', () => {
    const { service } = fixture([
      task({ id: 'task_2', sessionId: 'ses_2' as never, groupId: null })
    ])
    expect(
      service.request({ sessionId: 'ses_2', toolName: 'Bash', input: null })
    ).toBeNull()
    expect(
      service.request({ sessionId: 'ses_missing', toolName: 'Bash', input: null })
    ).toBeNull()
    expect(service.list()).toEqual([])
  })

  it('releases a request on timeout and session cancellation', async () => {
    const { service } = fixture(
      [
        task({ id: 'task_1', sessionId: 'ses_1' as never }),
        task({ id: 'task_2', sessionId: 'ses_2' as never })
      ],
      10
    )
    const first = service.request({ sessionId: 'ses_1', toolName: 'Bash', input: null })
    expect(first).not.toBeNull()
    await expect(first!).resolves.toBeNull()
    expect(service.list()).toEqual([])

    const second = service.request({ sessionId: 'ses_2', toolName: 'Edit', input: null })
    expect(second).not.toBeNull()
    service.cancelSession('ses_2')
    await expect(second!).resolves.toBeNull()
    expect(service.list()).toEqual([])
  })
})
