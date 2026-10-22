import { describe, expect, it, vi } from 'vitest'
import { ActivityBroadcaster } from './activity-broadcaster'
import type { ActivityTransition } from './activity-service'
import type { ActivitySummary } from '../../shared/domain/activity'
import type { ActivityEvent } from '../../shared/schemas/activity'

const SESSION = 'ses_0123456789abcdef0123456789abcdef'

function summary(overrides: Partial<ActivitySummary> = {}): ActivitySummary {
  return {
    state: 'idle',
    toolName: null,
    unread: true,
    outcome: 'completed',
    since: 1_000,
    ...overrides
  }
}

function transition(overrides: Partial<ActivityTransition> = {}): ActivityTransition {
  return {
    sessionId: SESSION,
    previous: summary({ state: 'working', unread: false, outcome: null }),
    next: summary(),
    attention: 'done',
    ...overrides
  }
}

function setup(options: { focused?: boolean } = {}) {
  const notify = vi.fn()
  const logs: string[] = []
  const broadcaster = new ActivityBroadcaster({
    notify,
    // BrowserWindow is unavailable in a Node test; the seams keep this pure.
    isAnyWindowFocused: () => options.focused ?? false,
    send: () => undefined,
    log: (message) => logs.push(message)
  })
  return { broadcaster, notify, logs }
}

describe('attention notifications', () => {
  it('notifies when unfocused and suppresses while focused', () => {
    const unfocused = setup({ focused: false })
    unfocused.broadcaster.handle(transition(), 'Claude session')
    expect(unfocused.notify).toHaveBeenCalledTimes(1)
    expect(unfocused.notify).toHaveBeenCalledWith(
      'Claude session',
      'The agent finished.',
      SESSION
    )

    const focused = setup({ focused: true })
    focused.broadcaster.handle(transition(), 'Claude session')
    expect(focused.notify).not.toHaveBeenCalled()
  })

  it('notifies once per logical transition even if delivery repeats', () => {
    const { broadcaster, notify } = setup()
    const event = transition()
    broadcaster.handle(event, 'Session')
    broadcaster.handle(event, 'Session')
    broadcaster.handle(event, 'Session')
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('notifies again for a genuinely new completion', () => {
    const { broadcaster, notify } = setup()
    broadcaster.handle(transition(), 'Session')
    broadcaster.handle(transition({ next: summary({ since: 2_000 }) }), 'Session')
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('describes a waiting transition with the tool name and a failure with its outcome', () => {
    const { broadcaster, notify } = setup()
    broadcaster.handle(
      transition({
        attention: 'waiting',
        next: summary({ state: 'waiting', toolName: 'Bash', outcome: null })
      }),
      'Session'
    )
    expect(notify).toHaveBeenLastCalledWith('Session', 'Waiting for you · Bash', SESSION)

    broadcaster.handle(
      transition({
        attention: 'done',
        next: summary({ since: 3_000, outcome: 'failed' })
      }),
      'Session'
    )
    expect(notify).toHaveBeenLastCalledWith('Session', 'The agent stopped with an error.', SESSION)
  })

  it('never notifies for a non-attention transition', () => {
    const { broadcaster, notify } = setup()
    broadcaster.handle(
      transition({ attention: null, next: summary({ state: 'working', unread: false, outcome: null }) }),
      'Session'
    )
    expect(notify).not.toHaveBeenCalled()
  })

  it('re-notifies after the session was viewed and completes again', () => {
    const { broadcaster, notify } = setup()
    broadcaster.handle(transition(), 'Session')
    broadcaster.forget(SESSION)
    broadcaster.handle(transition(), 'Session')
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('swallows notification failures without throwing', () => {
    const logs: string[] = []
    const broadcaster = new ActivityBroadcaster({
      notify: () => {
        throw new Error('notification service unavailable')
      },
      isAnyWindowFocused: () => false,
      send: () => undefined,
      log: (message) => logs.push(message)
    })
    expect(() => broadcaster.handle(transition(), 'Session')).not.toThrow()
    expect(logs.join('\n')).toContain('notification failed')
  })
})

describe('renderer broadcast', () => {
  it('pushes every transition, including ones that need no attention', () => {
    const sent: ActivityEvent[] = []
    const broadcaster = new ActivityBroadcaster({
      notify: () => undefined,
      isAnyWindowFocused: () => true,
      send: (event) => sent.push(event)
    })
    const working = transition({
      attention: null,
      next: summary({ state: 'working', toolName: 'Edit', unread: false, outcome: null })
    })
    broadcaster.handle(working, 'Session')
    expect(sent).toEqual([
      { type: 'activity', sessionId: SESSION, activity: working.next }
    ])
  })
})
