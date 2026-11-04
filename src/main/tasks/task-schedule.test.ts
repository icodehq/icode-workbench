import { describe, expect, it } from 'vitest'
import {
  decideOccurrence,
  nextOccurrence,
  occurrencesBetween,
  scheduleLabel
} from '../../shared/domain/task-schedule'

/**
 * Occurrence math.
 *
 * These are pure wall-clock decisions, which is exactly why they are tested
 * here rather than through a scheduler: "did the laptop sleep through three
 * runs" must have one answer that a timer, a boot and a manual run all share.
 *
 * Every expectation is built with the local `Date` constructor, so the tests
 * assert wall-clock behaviour in whatever zone the machine runs.
 */

function at(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

describe('nextOccurrence', () => {
  it('returns the next daily instant, not the current one', () => {
    const shape = { type: 'daily' as const, hour: 4, minute: 0 }
    expect(nextOccurrence(shape, at(2026, 3, 10, 3, 59))).toBe(at(2026, 3, 10, 4, 0))
    // Exactly on the instant counts as "already passed": the next one is tomorrow.
    expect(nextOccurrence(shape, at(2026, 3, 10, 4, 0))).toBe(at(2026, 3, 11, 4, 0))
  })

  it('skips the weekend for weekdays', () => {
    // 2026-03-13 is a Friday; the next weekday occurrence is Monday the 16th.
    const shape = { type: 'weekdays' as const, hour: 7, minute: 30 }
    expect(nextOccurrence(shape, at(2026, 3, 13, 8, 0))).toBe(at(2026, 3, 16, 7, 30))
  })

  it('finds the requested weekday only', () => {
    // 2026-03-10 is a Tuesday. `day: 1` = Monday.
    const shape = { type: 'weekly' as const, day: 1, hour: 2, minute: 0 }
    expect(nextOccurrence(shape, at(2026, 3, 10, 12, 0))).toBe(at(2026, 3, 16, 2, 0))
  })

  it('anchors hourly occurrences to midnight', () => {
    const shape = { type: 'hours' as const, every: 6 as const }
    expect(nextOccurrence(shape, at(2026, 3, 10, 0, 0))).toBe(at(2026, 3, 10, 6, 0))
    expect(nextOccurrence(shape, at(2026, 3, 10, 7, 0))).toBe(at(2026, 3, 10, 12, 0))
    // Crossing midnight lands on 00:00 of the next day, not 24:00.
    expect(nextOccurrence(shape, at(2026, 3, 10, 23, 0))).toBe(at(2026, 3, 11, 0, 0))
  })

  it('has no future occurrence for a one-time instant in the past', () => {
    const shape = { type: 'once' as const, runAt: at(2026, 1, 1, 9) }
    expect(nextOccurrence(shape, at(2026, 3, 10, 9))).toBeNull()
    expect(nextOccurrence(shape, at(2025, 1, 1, 9))).toBe(at(2026, 1, 1, 9))
  })
})

describe('occurrencesBetween', () => {
  it('lists every missed daily instant', () => {
    const shape = { type: 'daily' as const, hour: 4, minute: 0 }
    const missed = occurrencesBetween(shape, at(2026, 3, 10, 4), at(2026, 3, 13, 5))
    expect(missed).toEqual([
      at(2026, 3, 10, 4),
      at(2026, 3, 11, 4),
      at(2026, 3, 12, 4),
      at(2026, 3, 13, 4)
    ])
  })

  it('is bounded, so a year of sleep cannot build a huge array', () => {
    const shape = { type: 'hours' as const, every: 1 as const }
    const missed = occurrencesBetween(shape, 0, Date.now(), 10)
    expect(missed.length).toBe(10)
  })
})

describe('decideOccurrence (the age rule)', () => {
  const shape = { type: 'daily' as const, hour: 4, minute: 0 }

  it('fires on time inside the grace window', () => {
    const due = at(2026, 3, 10, 4)
    const decision = decideOccurrence(shape, due, due + 5 * 60_000)
    expect(decision).toEqual({ kind: 'fire', at: due, trigger: 'schedule', missed: 0 })
  })

  it('fires the newest missed occurrence once, and says how many were skipped', () => {
    const due = at(2026, 3, 10, 4)
    // Eight hours later: the 10th and 11th are both in the past; the latest is 11th.
    const decision = decideOccurrence(shape, due, at(2026, 3, 11, 5))
    expect(decision.kind).toBe('fire')
    if (decision.kind === 'fire') {
      expect(decision.at).toBe(at(2026, 3, 11, 4))
      expect(decision.trigger).toBe('catch-up')
      expect(decision.missed).toBe(1)
    }
  })

  it('retires an occurrence older than a day instead of firing it', () => {
    // A weekly cadence is where this rule bites: the newest missed instant can
    // legitimately be six days old, and reviving it would surprise the user.
    const weekly = { type: 'weekly' as const, day: 1, hour: 4 }
    // Monday 2026-03-02 04:00 was missed; it is now Monday 2026-03-09 12:00, but
    // the *latest* missed occurrence is 2026-03-09 04:00 — only 8 hours old, so
    // that one does catch up. A two-week gap retires instead.
    const decision = decideOccurrence(weekly, at(2026, 3, 2, 4), at(2026, 3, 9, 12))
    expect(decision.kind).toBe('fire')
    if (decision.kind === 'fire') expect(decision.at).toBe(at(2026, 3, 9, 4))

    // Older than a day from the newest missed instant: nothing fires.
    const stale = decideOccurrence(weekly, at(2026, 3, 2, 4), at(2026, 3, 5, 12))
    expect(stale.kind).toBe('skip')
    if (stale.kind === 'skip') expect(stale.reason).toMatch(/over a day old/)
  })
})

describe('scheduleLabel', () => {
  it('describes each shape without a cron string', () => {
    expect(scheduleLabel({ type: 'daily', hour: 4 })).toBe('every day at 04:00')
    expect(scheduleLabel({ type: 'weekdays', hour: 7, minute: 30 })).toBe('weekdays at 07:30')
    expect(scheduleLabel({ type: 'weekly', day: 2, hour: 2 })).toBe('Tue at 02:00')
    expect(scheduleLabel({ type: 'hours', every: 6 })).toBe('every 6 hours')
    expect(scheduleLabel({ type: 'hours', every: 1 })).toBe('every hour')
  })
})
