import { describe, expect, it } from 'vitest'
import { toPtyIncarnationId } from './ids'
import {
  MAX_SESSION_TITLE_LENGTH,
  assertNewPtyIncarnation,
  canAcceptTerminalInput,
  isActiveSessionState,
  isTerminalSessionState,
  normalizeSessionTitle,
  reconcileSessionState
} from './session'
import type { HostObservation, PersistedSessionObservation, ReconciledSessionState } from './session'

const incarnation = toPtyIncarnationId('abcdef1234567890')
const nextIncarnation = toPtyIncarnationId('1234567890abcdef')

function persisted(
  overrides: Partial<PersistedSessionObservation> = {}
): PersistedSessionObservation {
  return {
    lastObservedState: 'exited',
    lastObservedExitCode: 0,
    lastObservedError: null,
    lastObservedIncarnationId: incarnation,
    lastObservedAt: 1,
    ...overrides
  }
}

function liveHost(): HostObservation {
  return {
    reachable: true,
    session: { status: 'live', incarnationId: incarnation, ptyPid: 4242, exitCode: null }
  }
}

describe('lifecycle classification', () => {
  it('treats starting and live as active; exited and failed as terminal', () => {
    expect(isActiveSessionState('starting')).toBe(true)
    expect(isActiveSessionState('live')).toBe(true)
    expect(isActiveSessionState('unavailable')).toBe(false)
    expect(isTerminalSessionState('exited')).toBe(true)
    expect(isTerminalSessionState('failed')).toBe(true)
    expect(isTerminalSessionState('live')).toBe(false)
  })
})

describe('reconcileSessionState', () => {
  it('takes liveness and incarnation from a reachable host', () => {
    const result = reconcileSessionState(persisted({ lastObservedState: 'live' }), liveHost())
    expect(result).toMatchObject({
      state: 'live',
      authority: 'host',
      reason: 'host_live',
      incarnationId: incarnation,
      exitCode: null
    })
    expect(canAcceptTerminalInput(result)).toBe(true)
  })

  it('reports a starting host session as starting', () => {
    const result = reconcileSessionState(persisted({ lastObservedState: 'live' }), {
      reachable: true,
      session: { status: 'starting', incarnationId: incarnation, ptyPid: 4242, exitCode: null }
    })
    expect(result.state).toBe('starting')
    expect(result.reason).toBe('host_starting')
    expect(canAcceptTerminalInput(result)).toBe(false)
  })

  it('maps a clean host exit to exited', () => {
    const result = reconcileSessionState(persisted({ lastObservedState: 'live' }), {
      reachable: true,
      session: { status: 'exited', incarnationId: incarnation, ptyPid: 4242, exitCode: 0 }
    })
    expect(result).toMatchObject({ state: 'exited', authority: 'host', reason: 'host_exited' })
    expect(canAcceptTerminalInput(result)).toBe(false)
  })

  it('maps a nonzero host exit to failed', () => {
    const result = reconcileSessionState(persisted({ lastObservedState: 'live' }), {
      reachable: true,
      session: { status: 'exited', incarnationId: incarnation, ptyPid: 4242, exitCode: 2 }
    })
    expect(result).toMatchObject({ state: 'failed', authority: 'host', reason: 'host_failed', exitCode: 2 })
  })

  it('honors an explicit host failed status', () => {
    const result = reconcileSessionState(persisted({ lastObservedState: 'starting' }), {
      reachable: true,
      session: { status: 'failed', incarnationId: incarnation, ptyPid: -1, exitCode: null }
    })
    expect(result.state).toBe('failed')
    expect(result.reason).toBe('host_failed')
  })

  it('marks a persisted active session unavailable when the host does not know it', () => {
    const result = reconcileSessionState(persisted({ lastObservedState: 'live' }), {
      reachable: true,
      session: null
    })
    expect(result).toMatchObject({
      state: 'unavailable',
      authority: 'host',
      reason: 'session_not_known',
      incarnationId: null
    })
    expect(canAcceptTerminalInput(result)).toBe(false)
  })

  it('keeps historical exited state when a reachable host has forgotten the session', () => {
    const result = reconcileSessionState(persisted({ lastObservedState: 'exited' }), {
      reachable: true,
      session: null
    })
    expect(result).toMatchObject({
      state: 'exited',
      authority: 'persisted',
      reason: 'history_only',
      incarnationId: null
    })
  })

  it('never reports host loss as exited or live', () => {
    const active = reconcileSessionState(persisted({ lastObservedState: 'live' }), {
      reachable: false
    })
    expect(active).toMatchObject({
      state: 'unavailable',
      authority: 'unreachable',
      reason: 'host_unreachable',
      incarnationId: null
    })
    expect(active.state).not.toBe('exited')
    expect(canAcceptTerminalInput(active)).toBe(false)

    const starting = reconcileSessionState(persisted({ lastObservedState: 'starting' }), {
      reachable: false
    })
    expect(starting.state).toBe('unavailable')
  })

  it('keeps historical terminal state during host loss', () => {
    const failed = reconcileSessionState(
      persisted({
        lastObservedState: 'failed',
        lastObservedExitCode: 9,
        lastObservedError: { code: 'SPAWN_FAILED', message: 'boom', retryable: false }
      }),
      { reachable: false }
    )
    expect(failed).toMatchObject({
      state: 'failed',
      authority: 'persisted',
      reason: 'host_unreachable_history',
      exitCode: 9
    })
    expect(failed.error?.code).toBe('SPAWN_FAILED')
  })
})

describe('canAcceptTerminalInput', () => {
  it('requires host authority and an incarnation', () => {
    const base: ReconciledSessionState = {
      state: 'live',
      authority: 'host',
      reason: 'host_live',
      incarnationId: incarnation,
      exitCode: null,
      error: null
    }
    expect(canAcceptTerminalInput(base)).toBe(true)
    expect(canAcceptTerminalInput({ ...base, incarnationId: null })).toBe(false)
    expect(canAcceptTerminalInput({ ...base, authority: 'persisted' })).toBe(false)
    expect(canAcceptTerminalInput({ ...base, state: 'unavailable' })).toBe(false)
  })
})

describe('incarnation rotation', () => {
  it('rejects reusing the previous incarnation on restart', () => {
    expect(() => assertNewPtyIncarnation(incarnation, nextIncarnation)).not.toThrow()
    expect(() => assertNewPtyIncarnation(null, nextIncarnation)).not.toThrow()
    expect(() => assertNewPtyIncarnation(incarnation, incarnation)).toThrow(
      'must use a new incarnation ID'
    )
  })
})

describe('normalizeSessionTitle', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeSessionTitle('  Fix   the\ncheckout  ')).toBe('Fix the checkout')
  })

  it('replaces control characters', () => {
    expect(normalizeSessionTitle('a\u0000b\u001fc')).toBe('a b c')
  })

  it('clamps to the documented length', () => {
    expect(normalizeSessionTitle('x'.repeat(400))).toHaveLength(MAX_SESSION_TITLE_LENGTH)
  })

  it('falls back when empty', () => {
    expect(normalizeSessionTitle('   ', 'Claude · atlas')).toBe('Claude · atlas')
    expect(normalizeSessionTitle('', '')).toBe('Untitled session')
  })
})
