/**
 * When a Task should be created again.
 *
 * Follows Ceza's schedule model (`packages/contract/src/automation-schedule.ts`):
 * a few bounded wall-clock shapes instead of a cron string, because a cron
 * string is a parser, an evaluator and a timezone bug waiting to happen — and
 * the shapes are all the product needs. A cron string is derived for *display*
 * only and never evaluated.
 *
 * The math is pure and lives here so the scheduler, the preview text and the UI
 * all agree: what the editor shows is what the timer fires.
 *
 * All arithmetic is in the machine's local zone. A schedule that says 04:00
 * means 04:00 where the user is, which is also where the repository lives.
 */

import { DEFAULT_LOCALE, t, type Locale } from '../i18n'
import { formatDateTime } from '../i18n/format'
import type { HarnessId } from './harness'
import type { RepoId } from './ids'

export const SCHEDULE_TYPES = ['once', 'daily', 'weekdays', 'weekly', 'hours'] as const
export type ScheduleType = (typeof SCHEDULE_TYPES)[number]

/** `hours` choices that divide a day evenly, so midnight stays an occurrence. */
export const SCHEDULE_HOURS_OPTIONS = [1, 2, 3, 4, 6, 8, 12] as const
export type ScheduleEvery = (typeof SCHEDULE_HOURS_OPTIONS)[number]

export type TaskScheduleShape = {
  type: ScheduleType
  /** Absolute instant for `once`; ignored by the other shapes. */
  runAt?: number
  /** 0–23. Default 4 — overnight, when a workstation is otherwise idle. */
  hour?: number
  /** 0–59. Default 0. */
  minute?: number
  /** ISO weekday, Monday = 1 … Sunday = 7. Default 1. */
  day?: number
  /** Hours between runs from midnight. Default 6. */
  every?: ScheduleEvery
}

export type NormalizedShape = {
  type: ScheduleType
  runAt: number | null
  hour: number
  minute: number
  day: number
  every: ScheduleEvery
}

export function normalizeShape(shape: TaskScheduleShape): NormalizedShape {
  return {
    type: shape.type,
    runAt: shape.runAt ?? null,
    hour: shape.hour ?? 4,
    minute: shape.minute ?? 0,
    day: shape.day ?? 1,
    every: shape.every ?? 6
  }
}

const pad = (value: number): string => String(value).padStart(2, '0')
const hm = (hour: number, minute: number): string => `${pad(hour)}:${pad(minute)}`

/** The one-line description shown in the schedule list. */
export function scheduleLabel(
  shape: TaskScheduleShape,
  locale: Locale = DEFAULT_LOCALE
): string {
  const s = normalizeShape(shape)
  switch (s.type) {
    case 'once':
      return s.runAt === null
        ? t(locale, 'schedule.label.onceNotScheduled')
        : t(locale, 'schedule.label.onceAt', { time: formatInstant(s.runAt, locale) })
    case 'daily':
      return t(locale, 'schedule.label.daily', { time: hm(s.hour, s.minute) })
    case 'weekdays':
      return t(locale, 'schedule.label.weekdays', { time: hm(s.hour, s.minute) })
    case 'weekly':
      return t(locale, 'schedule.label.weekly', {
        weekday: new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(
          weeklyReference(s.day)
        ),
        time: hm(s.hour, s.minute)
      })
    case 'hours':
      return s.every === 1
        ? t(locale, 'schedule.label.everyHour')
        : t(locale, 'schedule.label.everyHours', { count: s.every })
  }
}

/** 2024-01-01 was a Monday; formatting only needs the weekday. */
function weeklyReference(day: number): Date {
  return new Date(2024, 0, day)
}

/** Display-only cron text; never parsed back. */
export function cronOf(shape: TaskScheduleShape): string {
  const s = normalizeShape(shape)
  switch (s.type) {
    case 'once':
      return '—'
    case 'daily':
      return `${String(s.minute)} ${String(s.hour)} * * *`
    case 'weekdays':
      return `${String(s.minute)} ${String(s.hour)} * * 1-5`
    case 'weekly':
      // cron numbers Sunday 0, our shapes number Monday 1.
      return `${String(s.minute)} ${String(s.hour)} * * ${String(s.day % 7)}`
    case 'hours':
      return `${String(s.minute)} */${String(s.every)} * * *`
  }
}

function formatInstant(instant: number, locale: Locale): string {
  return formatDateTime(locale, instant, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** Local wall-clock instant for a given calendar day. */
function wallClock(
  year: number,
  monthIndex: number,
  dayOfMonth: number,
  hour: number,
  minute: number
): number {
  return new Date(year, monthIndex, dayOfMonth, hour, minute, 0, 0).getTime()
}

function isoWeekday(date: Date): number {
  // getDay: 0 = Sunday. Our numbering: Monday = 1 … Sunday = 7.
  return date.getDay() === 0 ? 7 : date.getDay()
}

/**
 * The first occurrence strictly after `afterMs`, or `null` when the shape has no
 * future occurrence (a `once` in the past, or an unusable absolute instant).
 */
export function nextOccurrence(shape: TaskScheduleShape, afterMs: number): number | null {
  const s = normalizeShape(shape)
  if (s.type === 'once') return s.runAt !== null && s.runAt > afterMs ? s.runAt : null

  if (s.type === 'hours') {
    const start = new Date(afterMs)
    const midnight = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate(),
      0,
      0,
      0,
      0
    ).getTime()
    const step = s.every * 3_600_000
    // Occurrences are anchored to midnight, so a restart cannot drift them and
    // two processes computing independently agree on the same instants.
    const slot = Math.floor((afterMs - midnight) / step) + 1
    const sameDay = midnight + slot * step
    if (new Date(sameDay).getDate() === start.getDate()) return sameDay
    const nextMidnight = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate() + 1,
      0,
      0,
      0,
      0
    ).getTime()
    return nextMidnight
  }

  const anchor = new Date(afterMs)
  for (let offset = 0; offset <= 8; offset += 1) {
    const candidateDate = new Date(
      anchor.getFullYear(),
      anchor.getMonth(),
      anchor.getDate() + offset,
      0,
      0,
      0,
      0
    )
    if (s.type === 'weekdays' && isoWeekday(candidateDate) > 5) continue
    if (s.type === 'weekly' && isoWeekday(candidateDate) !== s.day) continue
    const candidate = wallClock(
      candidateDate.getFullYear(),
      candidateDate.getMonth(),
      candidateDate.getDate(),
      s.hour,
      s.minute
    )
    if (candidate > afterMs) return candidate
  }
  return null
}

/**
 * Every occurrence in `[fromMs, toMs]`.
 *
 * The start is inclusive because callers ask "which occurrences did I miss
 * starting at this due instant" — excluding the instant itself would report a
 * daily schedule as having missed nothing while it was a day late.
 *
 * Bounded on purpose: a schedule that slept through a year must not build a
 * million-element array to decide one catch-up. Callers use the tail.
 */
export function occurrencesBetween(
  shape: TaskScheduleShape,
  fromMs: number,
  toMs: number,
  limit = 500
): number[] {
  const found: number[] = []
  let cursor = fromMs - 1
  while (found.length < limit) {
    const next = nextOccurrence(shape, cursor)
    if (next === null || next > toMs) break
    found.push(next)
    cursor = next
  }
  return found
}

/**
 * How late a due occurrence may be and still be considered "on time".
 * Ceza uses the same 10 minutes (`SCHEDULE_GRACE_MS`); a desktop that slept for
 * a few minutes should not turn a scheduled run into a catch-up.
 */
export const SCHEDULE_GRACE_MS = 10 * 60_000

/** Past this, a missed occurrence is retired rather than fired. */
export const SCHEDULE_CATCH_UP_MS = 24 * 60 * 60_000

/** Consecutive launch failures after which a schedule pauses itself. */
export const SCHEDULE_AUTO_PAUSE_AFTER = 3

export type ScheduleTrigger = 'schedule' | 'catch-up' | 'manual'

/**
 * What a due schedule should do, decided without touching any state.
 *
 * Separating the decision from the launch is what makes the age rule testable
 * and identical for a timer tick, a boot recovery and a manual run.
 */
export type ScheduleDecision =
  | { kind: 'fire'; at: number; trigger: ScheduleTrigger; missed: number }
  | { kind: 'skip'; missed: number; reason: string }

export function decideOccurrence(
  shape: TaskScheduleShape,
  dueMs: number,
  nowMs: number
): ScheduleDecision {
  if (dueMs > nowMs) return { kind: 'skip', missed: 0, reason: 'not due yet' }
  const age = nowMs - dueMs
  if (age <= SCHEDULE_GRACE_MS) {
    return { kind: 'fire', at: dueMs, trigger: 'schedule', missed: 0 }
  }
  const missed = occurrencesBetween(shape, dueMs, nowMs)
  const latest = missed.at(-1) ?? dueMs
  const skipped = Math.max(0, missed.length - 1)
  if (nowMs - latest <= SCHEDULE_CATCH_UP_MS) {
    return { kind: 'fire', at: latest, trigger: 'catch-up', missed: skipped }
  }
  return {
    kind: 'skip',
    missed: missed.length,
    reason: `Missed ${String(missed.length)} occurrence(s); the newest is over a day old, so nothing was launched.`
  }
}

/**
 * What to do when the previous occurrence's task is still running.
 *
 * Ceza implicitly queues every occurrence and lets the concurrency cap serialize
 * them. iCode makes the choice explicit because the two answers are both
 * defensible and a user should not have to discover which one they got:
 *  - `queue` — every occurrence is its own task, bounded by the concurrency cap.
 *  - `skip`  — a missed tick is skipped instead of stacked behind a long run.
 */
export const SCHEDULE_OVERLAP_POLICIES = ['queue', 'skip'] as const
export type ScheduleOverlapPolicy = (typeof SCHEDULE_OVERLAP_POLICIES)[number]

export type TaskSchedule = {
  id: string
  repoId: RepoId
  title: string
  prompt: string
  harness: HarnessId
  shape: TaskScheduleShape
  overlap: ScheduleOverlapPolicy
  enabled: boolean
  createdAt: number
  updatedAt: number
  /** The next instant this process intends to fire; persisted, so it survives restart. */
  nextRunAt: number | null
  lastRunAt: number | null
  consecutiveFailures: number
  /** A one-line note about the last decision, shown in the UI. */
  lastNote: string | null
}

export type ScheduleOccurrenceRecord = {
  id: string
  scheduleId: string
  occurrenceAt: number
  taskId: string | null
  status: 'reserved' | 'created' | 'skipped' | 'error'
  note: string | null
  createdAt: number
  updatedAt: number
}
