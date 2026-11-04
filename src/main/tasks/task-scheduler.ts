import type { HarnessId } from '../../shared/domain/harness'
import type { RepoId } from '../../shared/domain/ids'
import {
  decideOccurrence,
  normalizeShape,
  occurrencesBetween,
  SCHEDULE_AUTO_PAUSE_AFTER,
  scheduleLabel,
  nextOccurrence,
  type ScheduleOverlapPolicy,
  type TaskSchedule,
  type TaskScheduleShape
} from '../../shared/domain/task-schedule'
import type { AppError } from '../../shared/domain/errors'
import { makeAppError } from '../../shared/domain/errors'
import type { TaskStore } from './task-store'
import type { TaskService } from './task-service'

/**
 * Turns due schedule instants into ordinary queued tasks.
 *
 * There is no second execution path here: `fire` calls the same
 * `TaskService.create` a button does, and the dispatcher is what starts it. A
 * schedule therefore inherits concurrency limits, cancellation, retry and
 * restart recovery without reimplementing any of them.
 *
 * Two rules are borrowed from Ceza's `ScheduleRunner` because they are the ones
 * that make timers survivable:
 *
 *  - the **age rule**: on time (within the grace window) fires the due instant;
 *    late but under a day fires the newest missed instant once; older is retired
 *    with a note. A laptop that slept for three days gets one catch-up, not
 *    three runs.
 *  - `nextRunAt` advances from `max(occurrence, now)`, so an overdue schedule
 *    cannot fire a burst to "catch up" on its own bookkeeping.
 *
 * and one the database enforces: `(schedule_id, occurrence_at)` is unique, so a
 * duplicate trigger — a re-armed timer, a second window, a restart mid-fire —
 * meets the receipt and becomes a logged no-op.
 */

export type SchedulerDeps = {
  tasks: TaskStore
  taskService: TaskService
  now: () => number
  newOccurrenceId: () => string
  newScheduleId: () => string
  onChange: () => void
  /** How often to check. Bounded so an idle app does almost nothing. */
  tickMs?: number
}

const DEFAULT_TICK_MS = 30_000

export type FireResult =
  | { result: 'created'; taskId: string; occurrenceAt: number; trigger: string }
  | { result: 'duplicate' | 'skipped' | 'paused' | 'not-due'; occurrenceAt?: number; note?: string }

export type CreateScheduleInput = {
  repoId: RepoId
  title?: string
  prompt: string
  harness: HarnessId
  shape: TaskScheduleShape
  overlap?: ScheduleOverlapPolicy
  enabled?: boolean
}

export type UpdateScheduleInput = {
  repoId: RepoId
  title?: string
  prompt: string
  harness: HarnessId
  shape: TaskScheduleShape
  overlap?: ScheduleOverlapPolicy
}

export class TaskScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(private readonly deps: SchedulerDeps) {}

  start(): void {
    if (this.timer) return
    // One timer for the whole app, not one per schedule: the tick is a single
    // SELECT over enabled rows and costs nothing when there are none.
    this.timer = setInterval(() => {
      void this.tick()
    }, this.deps.tickMs ?? DEFAULT_TICK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  list(repoId?: RepoId): Array<TaskSchedule & { label: string; occurrences: ReturnType<TaskStore['listOccurrences']> }> {
    return this.deps.tasks.listSchedules(repoId).map((schedule) => ({
      ...schedule,
      label: scheduleLabel(schedule.shape),
      occurrences: this.deps.tasks.listOccurrences(schedule.id, 10)
    }))
  }

  create(input: CreateScheduleInput): { ok: true; value: TaskSchedule } | { ok: false; error: AppError } {
    const prompt = input.prompt.trim()
    if (prompt.length === 0) {
      return {
        ok: false,
        error: makeAppError('INVALID_ARGUMENT', 'A schedule needs an instruction.')
      }
    }
    const shape = input.shape
    if (shape.type === 'once' && (shape.runAt === undefined || !Number.isFinite(shape.runAt))) {
      return { ok: false, error: makeAppError('INVALID_ARGUMENT', 'A one-time schedule needs a time.') }
    }
    const now = this.deps.now()
    const normalized = normalizeShape(shape)
    const title = (input.title?.trim() || prompt.split('\n')[0] || 'Scheduled task').slice(0, 200)
    const schedule: TaskSchedule = {
      id: this.deps.newScheduleId(),
      repoId: input.repoId,
      title,
      prompt,
      harness: input.harness,
      shape,
      overlap: input.overlap ?? 'queue',
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
      // Persisted at creation so a restart resumes this cadence instead of
      // recomputing from boot time.
      nextRunAt:
        normalized.type === 'once'
          ? (normalized.runAt ?? null)
          : nextOccurrence(shape, now),
      lastRunAt: null,
      consecutiveFailures: 0,
      lastNote: null
    }
    this.deps.tasks.insertSchedule(schedule)
    this.deps.onChange()
    return { ok: true, value: schedule }
  }

  /**
   * Edits a schedule in place.
   *
   * Occurrences already recorded stay attached to the schedule id, and tasks
   * those occurrences created are untouched. The next instant is recomputed from
   * now for an enabled schedule, so editing a cadence does not replay missed
   * runs under the old shape.
   */
  update(
    scheduleId: string,
    input: UpdateScheduleInput
  ): { ok: true; value: TaskSchedule } | { ok: false; error: AppError } {
    const existing = this.deps.tasks.findSchedule(scheduleId)
    if (!existing) {
      return { ok: false, error: makeAppError('INVALID_ARGUMENT', 'That schedule no longer exists.') }
    }
    const prompt = input.prompt.trim()
    if (prompt.length === 0) {
      return { ok: false, error: makeAppError('INVALID_ARGUMENT', 'A schedule needs an instruction.') }
    }
    if (input.shape.type === 'once' && (input.shape.runAt === undefined || !Number.isFinite(input.shape.runAt))) {
      return { ok: false, error: makeAppError('INVALID_ARGUMENT', 'A one-time schedule needs a time.') }
    }
    const now = this.deps.now()
    const normalized = normalizeShape(input.shape)
    const title = (input.title?.trim() || prompt.split('\n')[0] || 'Scheduled task').slice(0, 200)
    const nextRunAt = existing.enabled
      ? normalized.type === 'once'
        ? (normalized.runAt ?? null)
        : nextOccurrence(input.shape, now)
      : existing.nextRunAt
    this.deps.tasks.updateSchedule(
      scheduleId,
      {
        repoId: input.repoId,
        title,
        prompt,
        harness: input.harness,
        shape: input.shape,
        overlap: input.overlap ?? existing.overlap,
        nextRunAt,
        consecutiveFailures: 0,
        lastNote: 'Edited.'
      },
      now
    )
    this.deps.onChange()
    return { ok: true, value: this.deps.tasks.findSchedule(scheduleId)! }
  }

  /**
   * Enables or pauses a schedule.
   *
   * Resuming recomputes the next instant from now: a schedule paused for a week
   * should continue on its cadence rather than immediately replaying the outages.
   */
  setEnabled(scheduleId: string, enabled: boolean): { ok: true; value: TaskSchedule } | { ok: false; error: AppError } {
    const schedule = this.deps.tasks.findSchedule(scheduleId)
    if (!schedule) {
      return { ok: false, error: makeAppError('INVALID_ARGUMENT', 'That schedule no longer exists.') }
    }
    const now = this.deps.now()
    const normalized = normalizeShape(schedule.shape)
    /*
     * A resumed one-time schedule keeps its own instant even if that instant has
     * already passed.
     *
     * `nextOccurrence` answers "what comes after now", which for `once` is
     * nothing — so using it here silently retired a schedule whose run was
     * merely missed while it was paused. Handing the past instant back to the
     * age rule lets it fire (within the grace window) or retire with a note,
     * which is the same rule a tick uses.
     */
    const resumedNext =
      normalized.type === 'once'
        ? (normalized.runAt ?? null)
        : nextOccurrence(schedule.shape, now)
    this.deps.tasks.updateSchedule(
      scheduleId,
      {
        enabled,
        nextRunAt: enabled ? resumedNext : schedule.nextRunAt,
        lastNote: enabled ? 'Enabled.' : 'Paused.',
        ...(enabled ? { consecutiveFailures: 0 } : {})
      },
      now
    )
    this.deps.onChange()
    return { ok: true, value: this.deps.tasks.findSchedule(scheduleId)! }
  }

  remove(scheduleId: string): void {
    this.deps.tasks.deleteSchedule(scheduleId)
    this.deps.onChange()
  }

  /**
   * Fires one schedule now, by hand.
   *
   * Uses a distinct occurrence key so a manual run can never be mistaken for the
   * scheduled instant, and therefore can never consume it.
   */
  runNow(scheduleId: string): FireResult {
    const schedule = this.deps.tasks.findSchedule(scheduleId)
    if (!schedule) return { result: 'skipped', note: 'That schedule no longer exists.' }
    const now = this.deps.now()
    return this.fire(schedule, now, 'manual', now)
  }

  /** One pass over every enabled schedule. Public so tests and boot can call it. */
  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const now = this.deps.now()
      for (const schedule of this.deps.tasks.listSchedules()) {
        if (!schedule.enabled) continue
        const due = schedule.nextRunAt ?? nextOccurrence(schedule.shape, now)
        if (due === null) continue
        if (due > now) continue
        const decision = decideOccurrence(schedule.shape, due, now)
        if (decision.kind === 'skip') {
          // Nothing fires, but the timer still moves so the next tick is not
          // re-evaluating the same stale instant forever.
          this.advance(schedule, now, now, decision.reason)
          continue
        }
        this.fire(schedule, decision.at, decision.trigger, now)
      }
    } finally {
      this.running = false
    }
  }

  /**
   * Creates a task for one occurrence, or explains why it did not.
   *
   * The occurrence is reserved in the database *before* the task is created, so
   * a crash between the two leaves a receipt that stops a retry from launching
   * work twice — the same reason Ceza reserves a receipt before it launches.
   */
  private fire(
    schedule: TaskSchedule,
    occurrenceAt: number,
    trigger: 'schedule' | 'catch-up' | 'manual',
    now: number
  ): FireResult {
    const isManual = trigger === 'manual'
    const reserved = isManual
      ? this.deps.tasks.reserveOccurrence(
          {
            id: this.deps.newOccurrenceId(),
            scheduleId: schedule.id,
            // A manual run at `now` gets its own instant; the millisecond
            // detail is what keeps two clicks from colliding.
            occurrenceAt: now,
            note: 'Started by hand.'
          },
          now
        )
      : this.deps.tasks.reserveOccurrence(
          {
            id: this.deps.newOccurrenceId(),
            scheduleId: schedule.id,
            occurrenceAt,
            note: trigger === 'catch-up' ? 'Caught up the missed occurrence.' : 'Scheduled run.'
          },
          now
        )
    if (!reserved) {
      this.deps.tasks.updateSchedule(
        schedule.id,
        { lastNote: 'That occurrence already ran.', ...(!isManual ? { nextRunAt: this.nextAfter(schedule, occurrenceAt, now) } : {}) },
        now
      )
      this.deps.onChange()
      return { result: 'duplicate', occurrenceAt }
    }

    // Overlap policy: the explicit answer to "the last one is still running".
    if (schedule.overlap === 'skip' && this.deps.tasks.hasActiveTaskForSchedule(schedule.id)) {
      this.deps.tasks.resolveOccurrence(
        schedule.id,
        occurrenceAt,
        { status: 'skipped', note: 'The previous run was still active.' },
        now
      )
      this.deps.tasks.updateSchedule(
        schedule.id,
        {
          lastNote: 'Skipped: the previous run was still active.',
          nextRunAt: this.nextAfter(schedule, occurrenceAt, now)
        },
        now
      )
      this.deps.onChange()
      return { result: 'skipped', occurrenceAt }
    }

    const created = this.deps.taskService.create({
      repoId: schedule.repoId,
      title: schedule.title,
      prompt: schedule.prompt,
      harness: schedule.harness,
      scheduleId: schedule.id,
      occurrenceAt,
      dedupeKey: `schedule:${schedule.id}:${String(occurrenceAt)}`
    })

    if (!created.ok) {
      this.deps.tasks.resolveOccurrence(
        schedule.id,
        occurrenceAt,
        { status: 'error', note: created.error.message },
        now
      )
      this.recordFailure(schedule, now, created.error.message)
      return { result: 'skipped', occurrenceAt, note: created.error.message }
    }

    this.deps.tasks.resolveOccurrence(
      schedule.id,
      occurrenceAt,
      { status: 'created', taskId: created.value.id },
      now
    )
    const oneShot = normalizeShape(schedule.shape).type === 'once'
    this.deps.tasks.updateSchedule(
      schedule.id,
      {
        lastRunAt: occurrenceAt,
        consecutiveFailures: 0,
        // A one-time schedule that has run is not "enabled and waiting": it is
        // finished. Leaving it enabled would show a live schedule that can
        // never fire again.
        ...(oneShot && !isManual ? { enabled: false } : {}),
        lastNote:
          trigger === 'manual'
            ? 'Started by hand.'
            : trigger === 'catch-up'
              ? 'Caught up a missed occurrence.'
              : oneShot
                ? 'Ran its single scheduled run.'
                : 'Ran on schedule.',
        // A one-time schedule has no next instant; leaving `nextRunAt` null is
        // how the row stops being considered instead of needing a second flag.
        nextRunAt: isManual ? schedule.nextRunAt : this.nextAfter(schedule, occurrenceAt, now)
      },
      now
    )
    this.deps.onChange()
    return { result: 'created', taskId: created.value.id, occurrenceAt, trigger }
  }

  /**
   * Three consecutive launch failures pause the schedule.
   *
   * A schedule that cannot launch is a standing source of failed tasks; pausing
   * it after the third is the difference between a warning and a loop.
   */
  private recordFailure(schedule: TaskSchedule, now: number, message: string): void {
    const failures = schedule.consecutiveFailures + 1
    if (failures >= SCHEDULE_AUTO_PAUSE_AFTER) {
      this.deps.tasks.updateSchedule(
        schedule.id,
        {
          enabled: false,
          consecutiveFailures: failures,
          lastNote: `Paused after ${String(SCHEDULE_AUTO_PAUSE_AFTER)} launch failures: ${message}`
        },
        now
      )
      this.deps.onChange()
      return
    }
    this.deps.tasks.updateSchedule(
      schedule.id,
      { consecutiveFailures: failures, lastNote: message },
      now
    )
    this.deps.onChange()
  }

  private nextAfter(schedule: TaskSchedule, occurrenceAt: number, now: number): number | null {
    // Ceza's rule: advance from `max(occurrence, now)` so an overdue schedule
    // does not fire a burst of back-dated occurrences.
    return nextOccurrence(schedule.shape, Math.max(occurrenceAt, now))
  }

  private advance(schedule: TaskSchedule, from: number, now: number, note: string): void {
    this.deps.tasks.updateSchedule(
      schedule.id,
      { nextRunAt: this.nextAfter(schedule, from, now), lastNote: note },
      now
    )
    this.deps.onChange()
  }

  /** Occurrences a schedule would fire in a window — used by the UI preview. */
  preview(scheduleId: string, count = 5): number[] {
    const schedule = this.deps.tasks.findSchedule(scheduleId)
    if (!schedule) return []
    const from = this.deps.now()
    return occurrencesBetween(schedule.shape, from, from + 32 * 24 * 3_600_000, count)
  }
}
