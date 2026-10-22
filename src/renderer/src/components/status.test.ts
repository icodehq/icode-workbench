import { describe, expect, it } from 'vitest'
import type { ActivitySummary } from '../../../shared/domain/activity'
import {
  activityDotClass,
  activityLabel,
  activitySuffix,
  activityTone,
  activityTooltip,
  isKnownActivity
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
    expect(activityDotClass(activity({ state: 'waiting' }))).toContain('amber')
    expect(activityDotClass(activity({ state: 'idle', outcome: 'failed' }))).toContain('red')
    expect(activityDotClass(null)).toBe('bg-neutral-500')
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
