import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '../../../../shared/schemas/ipc'
import type { PendingAction } from '../../state/workspace'
import {
  sessionActionState,
  sessionHeaderMenuEntries,
  sessionMenuEntries,
  worktreeIsShared,
  type SessionMenuEntry
} from './session-menu'

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'session-1',
    repoId: 'repo-1',
    title: 'Session',
    harness: 'shell',
    role: 'interactive',
    state: 'live',
    authority: 'host',
    reason: 'host_live',
    incarnationId: 'inc-1',
    exitCode: null,
    error: null,
    updatedAt: 1,
    sleeping: false,
    worktree: {
      id: 'wt-1',
      path: '/tmp/wt-1',
      branch: 'icode/session-1',
      baseOid: 'abc',
      state: 'ready',
      status: 'active',
      error: null
    },
    activity: null,
    ...overrides
  }
}

function plan(
  entry: SessionSummary,
  pending: PendingAction | null = null,
  allowSleep = true
): SessionMenuEntry[] {
  return sessionMenuEntries(sessionActionState(entry, pending, allowSleep))
}

function ids(entries: SessionMenuEntry[]): string[] {
  return entries.map((entry) => entry.id)
}

function separators(entries: SessionMenuEntry[]): string[] {
  return entries.filter((entry) => entry.separatorBefore).map((entry) => entry.id)
}

function byId(entries: SessionMenuEntry[], id: SessionMenuEntry['id']): SessionMenuEntry {
  const entry = entries.find((candidate) => candidate.id === id)
  if (entry === undefined) throw new Error(`Missing ${id}`)
  return entry
}

describe('sessionHeaderMenuEntries', () => {
  it('mirrors the live lifecycle without the sidebar-only pin entry', () => {
    const entries = sessionHeaderMenuEntries(
      sessionActionState(session(), null, true),
      true
    )
    expect(ids(entries)).toEqual(['details', 'sleep', 'restart', 'remove'])
    expect(separators(entries)).toEqual(['remove'])
    expect(entries.every((entry) => entry.disabled === false)).toBe(true)
  })

  it('offers wake instead of sleep and restart on a sleeping session', () => {
    const entries = sessionHeaderMenuEntries(
      sessionActionState(session({ sleeping: true, state: 'exited' }), null, true),
      true
    )
    expect(ids(entries)).toEqual(['details', 'wake', 'remove'])
  })

  it('keeps a disabled restart for a sleeping session when sleep is not allowed', () => {
    const state = sessionActionState(session({ sleeping: true, state: 'exited' }), null, false)
    const entries = sessionHeaderMenuEntries(state, false)
    expect(ids(entries)).toEqual(['details', 'restart', 'remove'])
    expect(byId(entries, 'restart')).toMatchObject({ disabled: true })
    expect(byId(entries, 'restart').reason).toBeUndefined()
  })

  it('carries pending reasons to the header menu', () => {
    const entries = sessionHeaderMenuEntries(
      sessionActionState(session(), 'restarting', true),
      true
    )
    expect(byId(entries, 'sleep')).toMatchObject({ disabled: true, reason: 'pending' })
    expect(byId(entries, 'restart')).toMatchObject({
      disabled: true,
      reason: 'restarting'
    })
    expect(byId(entries, 'remove')).toMatchObject({ disabled: true, reason: 'pending' })
  })

  it('offers resume beside restart on an exited session with a captured conversation', () => {
    const entries = sessionHeaderMenuEntries(
      sessionActionState(session({ state: 'exited', resumable: true }), null, true),
      true
    )
    expect(ids(entries)).toEqual(['details', 'resume', 'restart', 'remove'])
    expect(byId(entries, 'resume')).toMatchObject({ disabled: false })
  })

  it('never offers resume on a live or sleeping session', () => {
    for (const entry of [
      session({ resumable: true }),
      session({ state: 'exited', resumable: true, sleeping: true })
    ]) {
      const entries = sessionHeaderMenuEntries(
        sessionActionState(entry, null, true),
        true
      )
      expect(ids(entries)).not.toContain('resume')
    }
  })
})

describe('worktreeIsShared', () => {
  it('detects another session in the same worktree, but not the session itself', () => {
    const one = session()
    const two = session({ id: 'session-2' })
    expect(worktreeIsShared(one, [one])).toBe(false)
    expect(worktreeIsShared(one, [one, two])).toBe(true)
  })

  it('does not match sessions in different worktrees or without a worktree', () => {
    const one = session()
    const other = session({
      id: 'session-2',
      worktree: {
        id: 'wt-2',
        path: '/tmp/wt-2',
        branch: 'icode/session-2',
        baseOid: 'def',
        state: 'ready',
        status: 'active',
        error: null
      }
    })
    const bare = session({ id: 'session-3', worktree: null })
    expect(worktreeIsShared(one, [one, other])).toBe(false)
    expect(worktreeIsShared(bare, [bare, one])).toBe(false)
  })
})

describe('sessionMenuEntries', () => {
  it('offers the full lifecycle on a live session', () => {
    const entries = plan(session())
    expect(ids(entries)).toEqual(['details', 'sleep', 'restart', 'pin', 'remove'])
    expect(separators(entries)).toEqual(['pin', 'remove'])
    expect(entries.every((entry) => entry.disabled === false)).toBe(true)
  })

  it('replaces sleep with wake and hides restart while sleeping', () => {
    const entries = plan(session({ sleeping: true, state: 'exited' }))
    expect(ids(entries)).toEqual(['details', 'wake', 'pin', 'remove'])
    expect(byId(entries, 'wake').disabled).toBe(false)
  })

  it('offers restart but not sleep on a finished session', () => {
    const entries = plan(session({ state: 'exited', sleeping: false }))
    expect(ids(entries)).toEqual(['details', 'restart', 'pin', 'remove'])
    expect(byId(entries, 'restart').disabled).toBe(false)
  })

  it('offers resume on a finished session with a captured conversation', () => {
    const entries = plan(session({ state: 'exited', resumable: true }))
    expect(ids(entries)).toEqual(['details', 'resume', 'restart', 'pin', 'remove'])
    expect(byId(entries, 'resume').disabled).toBe(false)
  })

  it('disables resume while a resume is in flight and carries its own reason', () => {
    const entries = plan(session({ state: 'failed', resumable: true }), 'resuming')
    expect(byId(entries, 'resume')).toMatchObject({
      disabled: true,
      reason: 'resuming'
    })
    expect(byId(entries, 'restart')).toMatchObject({
      disabled: true,
      reason: 'pending'
    })
  })

  it('explains an unreachable host or a blocked worktree on resume', () => {
    expect(
      byId(
        plan(
          session({
            state: 'failed',
            resumable: true,
            authority: 'unreachable',
            reason: 'host_unreachable'
          })
        ),
        'resume'
      )
    ).toMatchObject({ disabled: true, reason: 'host-unreachable' })

    expect(
      byId(
        plan(
          session({
            state: 'failed',
            resumable: true,
            worktree: {
              id: 'wt-1',
              path: '/tmp/wt-1',
              branch: 'icode/session-1',
              baseOid: 'abc',
              state: 'failed',
              status: 'missing',
              error: null
            }
          })
        ),
        'resume'
      )
    ).toMatchObject({ disabled: true, reason: 'worktree-blocked' })
  })

  it('disables the lifecycle while a restart is in flight', () => {
    const entries = plan(session(), 'restarting')
    expect(byId(entries, 'sleep')).toMatchObject({ disabled: true, reason: 'pending' })
    expect(byId(entries, 'restart')).toMatchObject({
      disabled: true,
      reason: 'restarting'
    })
    expect(byId(entries, 'remove')).toMatchObject({ disabled: true, reason: 'pending' })
    expect(byId(entries, 'details').disabled).toBe(false)
    expect(byId(entries, 'pin').disabled).toBe(false)
  })

  it('disables restart for any other pending action', () => {
    for (const pending of ['removing', 'sleeping', 'waking', 'stopping'] as const) {
      const entries = plan(session(), pending)
      expect(byId(entries, 'restart')).toMatchObject({
        disabled: true,
        reason: 'pending'
      })
      expect(byId(entries, 'remove')).toMatchObject({ disabled: true, reason: 'pending' })
    }
  })

  it('disables wake while a wake or sleep is in flight', () => {
    const entries = plan(session({ sleeping: true, state: 'exited' }), 'waking')
    expect(byId(entries, 'wake')).toMatchObject({ disabled: true, reason: 'pending' })
  })

  it('explains an unreachable host on restart', () => {
    const entries = plan(
      session({
        state: 'failed',
        authority: 'unreachable',
        reason: 'host_unreachable'
      })
    )
    expect(byId(entries, 'restart')).toMatchObject({
      disabled: true,
      reason: 'host-unreachable'
    })
  })

  it('blocks restart when the worktree is missing or inconsistent', () => {
    for (const status of ['missing', 'inconsistent'] as const) {
      const entries = plan(
        session({
          state: 'exited',
          worktree: {
            id: 'wt-1',
            path: '/tmp/wt-1',
            branch: 'icode/session-1',
            baseOid: 'abc',
            state: 'failed',
            status,
            error: null
          }
        })
      )
      expect(byId(entries, 'restart')).toMatchObject({
        disabled: true,
        reason: 'worktree-blocked'
      })
    }
  })

  it('leaves sleep out when the surface does not allow it', () => {
    const entries = plan(session(), null, false)
    expect(ids(entries)).toEqual(['details', 'restart', 'pin', 'remove'])
  })

  it('always keeps pin reachable and remove last', () => {
    for (const entry of [
      session(),
      session({ sleeping: true }),
      session({ state: 'failed' }),
      session({ state: 'exited' })
    ]) {
      const entries = plan(entry)
      expect(byId(entries, 'pin').disabled).toBe(false)
      expect(entries[entries.length - 1]?.id).toBe('remove')
    }
  })
})
