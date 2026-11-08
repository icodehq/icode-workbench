import { describe, expect, it, vi } from 'vitest'
import { AssistantNotifier, type AssistantNotifierDeps } from './assistant-notifier'
import { DEFAULT_ASSISTANT_SETTINGS } from '../../shared/domain/assistant'

function task(id: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    repoId: 'repo_a',
    title: `Task ${id}`,
    status,
    approval: 'approved',
    createdByActor: null,
    origin: 'human',
    attempt: 1,
    finishedAt: 100,
    updatedAt: 100,
    createdAt: 100,
    reviewDecision: 'pending',
    ...extra
  }
}

function fixture(initial: ReturnType<typeof task>[]) {
  let tasks = initial
  const postNotification = vi.fn((_input: unknown) => ({ id: 'msg_notification' }))
  const markNotificationDelivered = vi.fn()
  const onOsNotify = vi.fn()
  let focused = true
  const deps: AssistantNotifierDeps = {
    service: { postNotification, markNotificationDelivered } as never,
    taskStore: { list: () => tasks } as never,
    repositories: { list: () => [] } as never,
    settings: () => DEFAULT_ASSISTANT_SETTINGS,
    now: () => new Date('2026-11-08T12:00:00').getTime(),
    isWindowFocused: () => focused,
    onOsNotify
  }
  const notifier = new AssistantNotifier(deps)
  return {
    notifier,
    postNotification,
    onOsNotify,
    markNotificationDelivered,
    setTasks: (next: ReturnType<typeof task>[]) => {
      tasks = next
    },
    setFocused: (value: boolean) => {
      focused = value
    }
  }
}

describe('AssistantNotifier', () => {
  it('primes existing needs and only posts new fingerprints', async () => {
    const f = fixture([task('old', 'failed')])
    await f.notifier.start()
    expect(f.postNotification).not.toHaveBeenCalled()

    f.setTasks([task('old', 'failed'), task('new', 'failed')])
    await f.notifier.sweepNow()
    expect(f.postNotification).toHaveBeenCalledTimes(1)
    expect(f.postNotification.mock.calls[0]?.[0]).toMatchObject({
      notificationKind: 'task-failed',
      priority: 'high'
    })

    await f.notifier.sweepNow()
    expect(f.postNotification).toHaveBeenCalledTimes(1)
  })

  it('delivers an OS notification only when unfocused and outside quiet mode', async () => {
    const f = fixture([])
    await f.notifier.start()

    f.setTasks([task('a', 'failed')])
    await f.notifier.sweepNow()
    expect(f.onOsNotify).not.toHaveBeenCalled()

    f.setFocused(false)
    f.setTasks([task('a', 'failed'), task('b', 'waiting')])
    await f.notifier.sweepNow()
    expect(f.onOsNotify).toHaveBeenCalledTimes(1)
    expect(f.markNotificationDelivered).toHaveBeenCalledWith('msg_notification')
  })

  it('does not notify for a Mira-created approval waiting on the user', async () => {
    const f = fixture([])
    await f.notifier.start()
    f.setTasks([
      task('mira', 'queued', {
        approval: 'pending',
        createdByActor: 'mira'
      })
    ])
    await f.notifier.sweepNow()
    expect(f.postNotification).not.toHaveBeenCalled()
  })
})
