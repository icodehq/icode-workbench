import { describe, expect, it } from 'vitest'
import {
  applyActivityEvent,
  unknownActivity,
  type ActivityHookEvent,
  type AgentActivity
} from '../../shared/domain/activity'
import { ActivityService } from './activity-service'

const SESSION = 'ses_0123456789abcdef0123456789abcdef'
const INC = 'abcdef1234567890'

function event(overrides: Partial<ActivityHookEvent> = {}): ActivityHookEvent {
  return {
    event: 'UserPromptSubmit',
    sessionId: SESSION,
    incarnationId: INC,
    claudeSessionId: 'claude-1',
    promptId: 'prompt-1',
    toolName: null,
    sentAt: 1_000,
    ...overrides
  }
}

function service(overrides: Partial<ConstructorParameters<typeof ActivityService>[0]> = {}) {
  const transitions: Array<{ attention: 'done' | 'waiting' | null }> = []
  const rejected: string[] = []
  const instance = new ActivityService({
    isKnownSession: () => true,
    currentIncarnation: () => INC,
    now: () => 2_000,
    onTransition: (t) => transitions.push({ attention: t.attention }),
    onRejected: (reason) => rejected.push(reason),
    ...overrides
  })
  return { instance, transitions, rejected }
}

describe('activity mapping', () => {
  const cases: Array<[ActivityHookEvent['event'], string, string | null]> = [
    ['SessionStart', 'idle', null],
    ['UserPromptSubmit', 'working', null],
    ['PreToolUse', 'working', 'Bash'],
    ['PostToolUse', 'working', 'Bash'],
    ['PostToolUseFailure', 'working', 'Bash'],
    ['PermissionRequest', 'waiting', null],
    ['Stop', 'idle', null],
    ['StopFailure', 'idle', null]
  ]

  it.each(cases)('%s → %s', (name, state, toolName) => {
    const next = applyActivityEvent(
      { ...unknownActivity(1), state: 'working' } as AgentActivity,
      event({ event: name, toolName }),
      2
    )
    expect(next.state).toBe(state)
    expect(next.toolName).toBe(toolName)
  })

  it('marks a permission request as waiting and unread', () => {
    const next = applyActivityEvent(unknownActivity(1), event({ event: 'PermissionRequest' }), 2)
    expect(next).toMatchObject({ state: 'waiting', unread: true, outcome: null })
  })

  it('marks an explicit user-input tool as waiting', () => {
    for (const toolName of ['AskUserQuestion', 'ExitPlanMode']) {
      const next = applyActivityEvent(unknownActivity(1), event({ event: 'PreToolUse', toolName }), 2)
      expect(next).toMatchObject({ state: 'waiting', unread: true, toolName })
    }
  })

  it('keeps working after a tool completes', () => {
    let current = applyActivityEvent(unknownActivity(1), event(), 2)
    current = applyActivityEvent(current, event({ event: 'PreToolUse', toolName: 'Bash' }), 3)
    current = applyActivityEvent(current, event({ event: 'PostToolUse', toolName: 'Bash' }), 4)
    expect(current.state).toBe('working')
    expect(current.unread).toBe(false)
  })

  it('records a completed and a failed outcome', () => {
    const done = applyActivityEvent(unknownActivity(1), event({ event: 'Stop' }), 2)
    expect(done).toMatchObject({ state: 'idle', outcome: 'completed', unread: true })
    const failed = applyActivityEvent(unknownActivity(1), event({ event: 'StopFailure' }), 2)
    expect(failed).toMatchObject({ state: 'idle', outcome: 'failed', unread: true })
  })

  it('never invents an interrupted outcome', () => {
    const stopped = applyActivityEvent(unknownActivity(1), event({ event: 'Stop' }), 2)
    expect(stopped.outcome).toBe('completed')
  })
})

describe('ordering and identity', () => {
  it('accepts a normal turn and emits one done transition', () => {
    const { instance, transitions } = service()
    expect(instance.ingest(event())).toBe('accepted')
    expect(instance.get(SESSION).state).toBe('working')
    expect(instance.ingest(event({ event: 'PreToolUse', toolName: 'Bash', sentAt: 1_001 }))).toBe('accepted')
    expect(instance.get(SESSION).toolName).toBe('Bash')
    expect(instance.ingest(event({ event: 'Stop', sentAt: 1_002 }))).toBe('accepted')
    expect(instance.get(SESSION)).toMatchObject({ state: 'idle', outcome: 'completed', unread: true })
    expect(transitions.filter((t) => t.attention === 'done')).toHaveLength(1)
  })

  it('rejects a delayed Stop that belongs to an older turn', () => {
    const { instance, transitions } = service()
    instance.ingest(event({ promptId: 'turn-1', sentAt: 1_000 }))
    instance.ingest(event({ event: 'Stop', promptId: 'turn-1', sentAt: 1_001 }))
    // New prompt starts a new turn.
    instance.ingest(event({ promptId: 'turn-2', sentAt: 2_000 }))
    expect(instance.get(SESSION).state).toBe('working')
    // The old turn's Stop arrives late.
    expect(instance.ingest(event({ event: 'Stop', promptId: 'turn-1', sentAt: 1_002 }))).toBe('stale')
    expect(instance.get(SESSION).state).toBe('working')
    expect(transitions.filter((t) => t.attention === 'done')).toHaveLength(1)
  })

  it('rejects an event whose send time predates the newest accepted event', () => {
    const { instance } = service()
    instance.ingest(event({ sentAt: 5_000 }))
    expect(instance.ingest(event({ event: 'PreToolUse', toolName: 'Bash', sentAt: 4_000 }))).toBe('stale')
    expect(instance.get(SESSION).state).toBe('working')
  })

  it('treats a duplicate Stop as idempotent and does not notify twice', () => {
    const { instance, transitions } = service()
    instance.ingest(event({ sentAt: 1_000 }))
    instance.ingest(event({ event: 'Stop', sentAt: 1_001 }))
    const before = instance.get(SESSION)
    expect(instance.ingest(event({ event: 'Stop', sentAt: 1_001 }))).toBe('duplicate')
    expect(instance.get(SESSION)).toEqual(before)
    expect(transitions.filter((t) => t.attention === 'done')).toHaveLength(1)
  })

  it('rejects an unknown session', () => {
    const { instance, rejected } = service({ isKnownSession: () => false })
    expect(instance.ingest(event())).toBe('unknown-session')
    expect(rejected).toContain('unknown-session')
    expect(instance.get(SESSION).state).toBe('unknown')
  })

  it('rejects an event from an obsolete incarnation', () => {
    const { instance, rejected } = service()
    instance.bindIncarnation(SESSION, 'newincarnation01')
    expect(instance.ingest(event({ incidentId: 'x' } as never))).toBe('stale-incarnation')
    expect(rejected).toContain('stale-incarnation')
    expect(instance.get(SESSION).state).toBe('unknown')
  })

  it('rejects the first event of a process that is not the live one', () => {
    const { instance } = service({ currentIncarnation: () => 'differentincarnation' })
    expect(instance.ingest(event())).toBe('stale-incarnation')
  })

  it('drops all activity when the incarnation changes', () => {
    const { instance } = service()
    instance.ingest(event())
    expect(instance.get(SESSION).state).toBe('working')
    instance.bindIncarnation(SESSION, 'anotherincarnation')
    expect(instance.get(SESSION).state).toBe('unknown')
  })

  it('clears unread idempotently', () => {
    const { instance, transitions } = service()
    instance.ingest(event())
    instance.ingest(event({ event: 'Stop', sentAt: 1_001 }))
    expect(instance.get(SESSION).unread).toBe(true)
    expect(instance.clearUnread(SESSION)).toBe(true)
    expect(instance.clearUnread(SESSION)).toBe(false)
    expect(instance.get(SESSION).unread).toBe(false)
    expect(transitions.filter((t) => t.attention === null)).toHaveLength(2)
  })

  it('starts every session as unknown, never working', () => {
    const { instance } = service()
    expect(instance.get(SESSION)).toMatchObject({ state: 'unknown', unread: false })
    expect(instance.list()).toEqual([])
  })

  it('drops activity for a session that no longer exists', () => {
    const { instance } = service()
    instance.ingest(event())
    const pruned = service({ isKnownSession: () => false })
    expect(pruned.instance.get(SESSION).state).toBe('unknown')
    expect(instance.list()).toHaveLength(1)
  })
})

describe('lifecycle independence', () => {
  it('keeps activity advisory: no lifecycle vocabulary leaks into it', () => {
    const { instance } = service()
    instance.ingest(event())
    instance.ingest(event({ event: 'Stop', sentAt: 1_001 }))
    const summary = instance.get(SESSION)
    expect(Object.keys(summary).sort()).toEqual(
      ['outcome', 'since', 'state', 'toolName', 'unread'].sort()
    )
    expect(['unknown', 'idle', 'working', 'waiting']).toContain(summary.state)
  })

  it('returns unknown after the service is reset for a removed session', () => {
    const { instance } = service()
    instance.ingest(event())
    instance.reset(SESSION)
    expect(instance.get(SESSION).state).toBe('unknown')
  })

  it('never bleeds activity between sessions', () => {
    const other = 'ses_ffffffffffffffffffffffffffffffff'
    const { instance } = service({ isKnownSession: () => true })
    instance.ingest(event())
    expect(instance.get(other).state).toBe('unknown')
    expect(instance.list()).toEqual([
      expect.objectContaining({ sessionId: SESSION, activity: expect.objectContaining({ state: 'working' }) })
    ])
  })
})
