import { describe, expect, it } from 'vitest'
import {
  applyActivityEvent,
  applyTerminalActivity,
  unknownActivity,
  type ActivityHookEvent,
  type AgentActivity,
  type PluginActivityEvent,
  type TerminalActivityEvent
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

function terminal(overrides: Partial<TerminalActivityEvent> = {}): TerminalActivityEvent {
  return {
    sessionId: SESSION,
    harness: 'codex',
    incarnationId: INC,
    source: 'program',
    state: 'working',
    seq: 1,
    ...overrides
  }
}

describe('terminal activity', () => {
  it('maps program working to done and idle-after-working to completed', () => {
    const working = applyTerminalActivity(unknownActivity(1), terminal(), 2)
    expect(working).toMatchObject({ state: 'working', source: 'program', outcome: null })

    const done = applyTerminalActivity(working, terminal({ state: 'done' }), 3)
    expect(done).toMatchObject({ state: 'idle', outcome: 'completed', unread: true })

    const idle = applyTerminalActivity(working, terminal({ state: 'idle' }), 3)
    expect(idle).toMatchObject({ state: 'idle', outcome: 'completed' })
  })

  it('maps a blocked program to waiting and an error to failed', () => {
    const blocked = applyTerminalActivity(
      unknownActivity(1),
      terminal({ state: 'waiting', kind: 'permission' }),
      2
    )
    expect(blocked).toMatchObject({ state: 'waiting', unread: true, outcome: null })

    const failed = applyTerminalActivity(
      unknownActivity(1),
      terminal({ state: 'error' }),
      2
    )
    expect(failed).toMatchObject({ state: 'idle', outcome: 'failed', unread: true })
  })

  it('never completes a task from a title', () => {
    const working = applyTerminalActivity(
      unknownActivity(1),
      terminal({ source: 'title', state: 'working' }),
      2
    )
    const idle = applyTerminalActivity(
      working,
      terminal({ source: 'title', state: 'idle' }),
      3
    )
    expect(idle).toMatchObject({ state: 'idle', outcome: null, source: 'title' })
  })

  it('accepts program status for a hookless harness', () => {
    const { instance, transitions } = service()
    expect(instance.ingestTerminal(terminal())).toBe('accepted')
    expect(instance.get(SESSION)).toMatchObject({ state: 'working', source: 'program' })
    expect(instance.ingestTerminal(terminal({ state: 'done', seq: 2 }))).toBe('accepted')
    expect(instance.get(SESSION)).toMatchObject({
      state: 'idle',
      outcome: 'completed',
      source: 'program'
    })
    expect(transitions.filter((t) => t.attention === 'done')).toHaveLength(1)
  })

  it('keeps a recent hook senior to terminal working and done', () => {
    const { instance } = service()
    instance.ingest(event())
    expect(instance.ingestTerminal(terminal({ state: 'done' }))).toBe('hook-senior')
    expect(instance.get(SESSION).state).toBe('working')
  })

  it('still surfaces a blocked terminal prompt while a hook is recent', () => {
    const { instance, transitions } = service()
    instance.ingest(event())
    expect(instance.ingestTerminal(terminal({ state: 'waiting' }))).toBe('accepted')
    expect(instance.get(SESSION)).toMatchObject({ state: 'waiting', source: 'program' })
    expect(transitions.filter((t) => t.attention === 'waiting')).toHaveLength(1)
  })

  it('rejects a program app that contradicts the session harness', () => {
    const { instance } = service()
    expect(
      instance.ingestTerminal(terminal({ harness: 'codex', app: 'claude-code' }))
    ).toBe('app-mismatch')
    expect(instance.get(SESSION).state).toBe('unknown')
  })

  it('rejects terminal evidence for a harness without the capability', () => {
    const { instance } = service()
    expect(instance.ingestTerminal(terminal({ harness: 'shell' }))).toBe('unsupported-harness')
  })
})

function plugin(overrides: Partial<PluginActivityEvent> = {}): PluginActivityEvent {
  return {
    sessionId: SESSION,
    harness: 'opencode',
    incarnationId: INC,
    state: 'working',
    sentAt: 1_000,
    seq: 1,
    ...overrides
  }
}

describe('managed plugin activity', () => {
  it('maps working, waiting and done snapshots with their previews', () => {
    const { instance, transitions } = service()
    expect(instance.ingestPlugin(plugin({ prompt: 'Fix the parser' }))).toBe('accepted')
    expect(instance.get(SESSION)).toMatchObject({
      state: 'working',
      source: 'plugin',
      prompt: 'Fix the parser',
      message: null,
      outcome: null
    })

    expect(
      instance.ingestPlugin(
        plugin({
          state: 'waiting',
          kind: 'permission',
          toolName: 'Bash',
          message: 'May I run the tests?',
          sentAt: 1_001,
          seq: 2
        })
      )
    ).toBe('accepted')
    expect(instance.get(SESSION)).toMatchObject({
      state: 'waiting',
      attentionKind: 'permission',
      toolName: 'Bash',
      message: 'May I run the tests?',
      unread: true
    })

    expect(
      instance.ingestPlugin(plugin({ state: 'done', sentAt: 1_002, seq: 3 }))
    ).toBe('accepted')
    expect(instance.get(SESSION)).toMatchObject({
      state: 'idle',
      outcome: 'completed',
      unread: true
    })
    expect(transitions.filter((entry) => entry.attention === 'waiting')).toHaveLength(1)
    expect(transitions.filter((entry) => entry.attention === 'done')).toHaveLength(1)
  })

  it('rolls child attention into the root and keeps a working child from finishing it', () => {
    const { instance } = service()
    instance.ingestPlugin(
      plugin({
        state: 'working',
        subagents: [{ id: 'child-1', label: 'Explore', state: 'working' }]
      })
    )
    instance.ingestPlugin(
      plugin({
        state: 'done',
        sentAt: 1_001,
        seq: 2,
        subagents: [{ id: 'child-1', label: 'Explore', state: 'working' }]
      })
    )
    expect(instance.get(SESSION)).toMatchObject({ state: 'working', outcome: null })
    expect(instance.get(SESSION).subagents).toHaveLength(1)

    instance.ingestPlugin(
      plugin({
        state: 'idle',
        sentAt: 1_002,
        seq: 3,
        subagents: [{ id: 'child-1', label: 'Explore', state: 'waiting', kind: 'question' }]
      })
    )
    expect(instance.get(SESSION)).toMatchObject({
      state: 'waiting',
      attentionKind: 'question',
      unread: true
    })

    instance.ingestPlugin(
      plugin({ state: 'idle', sentAt: 1_003, seq: 4, subagents: [] })
    )
    expect(instance.get(SESSION)).toMatchObject({ state: 'idle', outcome: null, subagents: [] })
  })

  it('dedupes a repeated snapshot and ignores unclaimed shared-server posts', () => {
    const { instance, transitions } = service()
    expect(instance.ingestPlugin(plugin())).toBe('accepted')
    expect(instance.ingestPlugin(plugin())).toBe('duplicate')
    expect(transitions).toHaveLength(1)
    expect(instance.ingestPlugin(plugin({ sharedServer: true, sentAt: 1_001 }))).toBe(
      'shared-server'
    )
    expect(instance.get(SESSION).state).toBe('working')
  })

  it('rejects stale snapshots, stale incarnations and harnesses without plugin support', () => {
    const { instance } = service()
    instance.ingestPlugin(plugin({ sentAt: 5_000 }))
    expect(instance.ingestPlugin(plugin({ sentAt: 4_000 }))).toBe('stale')
    expect(instance.ingestPlugin(plugin({ incarnationId: 'stale' }))).toBe('stale-incarnation')
    expect(instance.ingestPlugin(plugin({ harness: 'shell' }))).toBe('unsupported-harness')
  })

  it('drops plugin-derived activity when the integration is disabled', () => {
    const { instance } = service()
    instance.ingestPlugin(plugin())
    instance.invalidatePluginActivity()
    expect(instance.get(SESSION)).toMatchObject({ state: 'unknown', source: 'none' })
  })

  it('honours the runtime plugin gate without touching existing activity', () => {
    let enabled = true
    const { instance } = service({ pluginActivityEnabled: () => enabled })
    instance.ingestPlugin(plugin())
    enabled = false
    expect(instance.ingestPlugin(plugin({ state: 'done', sentAt: 1_001 }))).toBe('disabled')
    expect(instance.get(SESSION).state).toBe('working')
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

  it('drops activity when the process exits', () => {
    const { instance } = service()
    instance.ingest(event())
    expect(instance.get(SESSION).state).toBe('working')
    instance.bindIncarnation(SESSION, null)
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
      [
        'attentionKind',
        'message',
        'outcome',
        'prompt',
        'since',
        'source',
        'state',
        'subagents',
        'toolName',
        'unread'
      ].sort()
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
