import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '../../../../shared/schemas/ipc'
import { nextPaneKeys, paneKey } from './session-panes'

function session(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    repoId: 'repo_a',
    title: id,
    harness: 'shell',
    state: 'live',
    authority: 'host',
    reason: 'host_live',
    incarnationId: 'inc_1',
    exitCode: null,
    error: null,
    updatedAt: 1,
    worktree: null,
    activity: null,
    ...overrides
  }
}

describe('pane keys', () => {
  it('uses the incarnation, or pending before one exists', () => {
    expect(paneKey('ses_a', 'inc_1')).toBe('ses_a:inc_1')
    expect(paneKey('ses_a', null)).toBe('ses_a:pending')
  })

  it('adds panes for starting and live sessions', () => {
    const next = nextPaneKeys(new Set(), [
      session('ses_live', { state: 'live', incarnationId: 'inc_live' }),
      session('ses_starting', { state: 'starting', incarnationId: 'inc_starting' })
    ])

    expect([...next].sort()).toEqual(['ses_live:inc_live', 'ses_starting:inc_starting'])
  })

  it('does not add panes for sessions that were never mounted', () => {
    const next = nextPaneKeys(new Set(), [
      session('ses_exited', { state: 'exited', incarnationId: 'inc_1' }),
      session('ses_failed', { state: 'failed', incarnationId: 'inc_2' }),
      session('ses_unavailable', { state: 'unavailable', incarnationId: null })
    ])

    expect(next.size).toBe(0)
  })
})

describe('pane reconciliation', () => {
  it('retains a terminal pane and removes a disappeared session', () => {
    const previous = new Set(['ses_exited:inc_1', 'ses_gone:inc_1'])
    const next = nextPaneKeys(previous, [
      session('ses_exited', { state: 'exited', incarnationId: 'inc_1' })
    ])

    expect(next.has('ses_exited:inc_1')).toBe(true)
    expect(next.has('ses_gone:inc_1')).toBe(false)
  })

  it('replaces an old incarnation when a restarted session is active', () => {
    const previous = new Set(['ses_a:inc_old'])
    const next = nextPaneKeys(previous, [
      session('ses_a', { state: 'starting', incarnationId: 'inc_new' })
    ])

    expect([...next]).toEqual(['ses_a:inc_new'])
  })

  it('keeps the old pane when the replacement session is terminal', () => {
    const previous = new Set(['ses_a:inc_old'])
    const next = nextPaneKeys(previous, [
      session('ses_a', { state: 'exited', incarnationId: 'inc_new' })
    ])

    expect(next).toBe(previous)
    expect(next.has('ses_a:inc_old')).toBe(true)
    expect(next.has('ses_a:inc_new')).toBe(false)
  })

  it('keeps an unavailable pane while the session is still listed', () => {
    const previous = new Set(['ses_a:inc_1'])
    const next = nextPaneKeys(previous, [
      session('ses_a', { state: 'unavailable', incarnationId: 'inc_1' })
    ])

    expect(next).toBe(previous)
  })

  it('preserves Set identity when no lifecycle change occurs', () => {
    const previous = new Set(['ses_a:inc_1'])
    const next = nextPaneKeys(previous, [
      session('ses_a', { state: 'live', incarnationId: 'inc_1' })
    ])

    expect(next).toBe(previous)
  })

  it('tracks a live session that has no incarnation yet', () => {
    const next = nextPaneKeys(new Set(), [
      session('ses_a', { state: 'live', incarnationId: null })
    ])

    expect([...next]).toEqual(['ses_a:pending'])
  })
})
