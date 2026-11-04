import { describe, expect, it } from 'vitest'
import type { ActivitySummary } from '../../../shared/domain/activity'
import {
  activityDetailsHint,
  activityDetailsLabel,
  activityDotClass,
  activityLabel,
  activitySuffix,
  activityTone,
  activityTooltip,
  isKnownActivity,
  sessionStateLabel
} from './status'

function activity(overrides: Partial<ActivitySummary> = {}): ActivitySummary {
  return {
    state: 'unknown',
    toolName: null,
    unread: false,
    outcome: null,
    since: 1,
    ...overrides
  }
}

describe('activity wording', () => {
  it('names the running tool while working', () => {
    expect(activityLabel(activity({ state: 'working', toolName: 'Edit' }))).toBe('Working · Edit')
    expect(activityLabel(activity({ state: 'working' }))).toBe('Working')
  })

  it('says the agent needs the user when waiting', () => {
    expect(activityLabel(activity({ state: 'waiting', unread: true }))).toBe('Needs you')
    expect(
      activityLabel(activity({ state: 'waiting', toolName: 'AskUserQuestion', unread: true }))
    ).toBe('Needs you · AskUserQuestion')
    expect(activityLabel(activity({ state: 'waiting', toolName: 'Bash', unread: true }))).toBe(
      'Needs you'
    )
  })

  it('distinguishes a failed turn from a completed one', () => {
    expect(activityLabel(activity({ state: 'idle', outcome: 'completed' }))).toBe('Done')
    expect(activityLabel(activity({ state: 'idle', outcome: 'failed' }))).toBe('Done · failed')
  })

  it('keeps unknown neutral instead of claiming the agent is idle', () => {
    expect(activityLabel(activity())).toBe('Activity unknown')
    expect(activitySuffix(activity())).toBeNull()
    expect(activitySuffix(null)).toBeNull()
    expect(activityTooltip(null)).toContain('does not report')
    expect(isKnownActivity(activity())).toBe(false)
    expect(isKnownActivity(null)).toBe(false)
  })

  it('explains an absent activity signal without calling it unknown', () => {
    expect(activityDetailsLabel(activity(), 'claude')).toBe('No activity yet')
    expect(activityDetailsLabel(activity(), 'shell')).toBe('Not reported by this harness')
    expect(activityDetailsLabel(activity(), 'codex')).toBe('Not reported by this harness')
    expect(activityDetailsHint(activity(), 'claude')).toContain('starts a turn')
    expect(activityDetailsHint(activity(), 'shell')).toContain('Shell does not report')
    expect(
      activityDetailsLabel(activity({ state: 'working', toolName: 'Bash' }), 'claude')
    ).toBe('Working · Bash')
  })

  it('shortens the sidebar suffix without losing the failed outcome', () => {
    expect(activitySuffix(activity({ state: 'working', toolName: 'Bash' }))).toBe('Working · Bash')
    expect(activitySuffix(activity({ state: 'waiting', toolName: 'Bash', unread: true }))).toBe(
      'Needs you'
    )
    expect(activitySuffix(activity({ state: 'idle', outcome: 'completed' }))).toBe('Done')
    expect(activitySuffix(activity({ state: 'idle', outcome: 'failed' }))).toBe('Done · failed')
  })

  it('gives each state a distinct tone and dot', () => {
    const workingTone = activityTone(activity({ state: 'working' }))
    const waitingTone = activityTone(activity({ state: 'waiting' }))
    const idleTone = activityTone(activity({ state: 'idle', outcome: 'completed' }))
    expect(new Set([workingTone, waitingTone, idleTone]).size).toBe(3)
    expect(activityTone(null)).toBe('text-muted-foreground')
    expect(activityDotClass(activity({ state: 'waiting' }))).toBe('bg-signal animate-pulse')
    expect(activityDotClass(activity({ state: 'idle', outcome: 'failed' }))).toBe('bg-destructive')
    expect(activityDotClass(null)).toBe('bg-muted-foreground')
  })

  it('explains unread and waiting states in the tooltip', () => {
    expect(activityTooltip(activity({ state: 'waiting', unread: true }))).toContain(
      'waiting for you'
    )
    expect(activityTooltip(activity({ state: 'idle', unread: true }))).toContain('not viewed')
    expect(activityTooltip(activity({ state: 'idle', unread: false }))).toContain('idle')
    expect(activityTooltip(activity({ state: 'working' }))).toContain('working')
  })
})

describe('session lifecycle wording', () => {
  it('tells the user a removal is in progress without exposing the stop path', () => {
    expect(sessionStateLabel('live', 'removing')).toBe('Removing…')
  })
})
