import { afterEach, describe, expect, it } from 'vitest'
import { TaskStore } from './task-store'
import { TaskService } from './task-service'
import { TaskScheduler } from './task-scheduler'
import { makeRepositoryService, makeTempRoot, openTempDatabase } from '../persistence/persistence-test-fixtures'
import type { SessionService } from '../sessions/session-service'

/**
 * Schedules feed the ordinary queue.
 *
 * Every case here checks one of two things: that an occurrence becomes a normal
 * task (so it inherits the queue's concurrency, cancellation and retry), and
 * that a second trigger for the same instant cannot create a second task —
 * including across a restart, which is where an in-memory "last fired" flag
 * would fail.
 */

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

type Harness = {
  store: TaskStore
  scheduler: TaskScheduler
  service: TaskService
  repoId: string
  workspaceId: string
  clock: { now: number }
  reopen: () => TaskScheduler
}

async function harness(): Promise<Harness> {
  const root = makeTempRoot('ade-w84s-')
  const db = openTempDatabase(root)
  const stores = makeRepositoryService(db)
  const repoDir = `${root.dir}/repo`
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const { execFileSync } = await import('node:child_process')
  mkdirSync(repoDir, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', repoDir], { stdio: 'pipe' })
  writeFileSync(`${repoDir}/README.md`, 'base\n')
  execFileSync('git', ['-C', repoDir, 'add', '.'], { stdio: 'pipe' })
  execFileSync(
    'git',
    ['-C', repoDir, '-c', 'user.email=w84@test', '-c', 'user.name=W84', 'commit', '-qm', 'base'],
    { stdio: 'pipe' }
  )
  const added = await stores.service.addRepository(repoDir)

  const store = new TaskStore(db)
  const clock = { now: new Date(2026, 2, 10, 6, 0, 0).getTime() }
  const sessions = { create: async () => ({ id: 'ses_00000000-0000-4000-8000-000000000001' }) }
  let sequence = 0
  const service = new TaskService({
    tasks: store,
    repositories: stores.repositories,
    sessions: sessions as unknown as SessionService,
    now: () => clock.now,
    newId: () => {
      sequence += 1
      return `task_00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
    },
    isSessionLive: () => false,
    // Schedules never read changes; a queued occurrence has no worktree yet.
    listChanges: async () => ({ status: 'unavailable', reason: 'not-wired', detail: 'test' }),
    onQueueChanged: () => undefined
  })

  let occ = 0
  const makeScheduler = (): TaskScheduler =>
    new TaskScheduler({
      tasks: store,
      taskService: service,
      now: () => clock.now,
      newOccurrenceId: () => {
        occ += 1
        return `occ_${String(occ).padStart(4, '0')}`
      },
      newScheduleId: () => `sch_00000000-0000-4000-8000-00000000000${String(occ)}`,
      onChange: () => undefined
    })

  const scheduler = makeScheduler()
  cleanups.push(() => {
    db.close()
    root.cleanup()
  })

  return {
    store,
    scheduler,
    service,
    repoId: added.repository.id,
    workspaceId: stores.repositories.workspaceForRepo(added.repository.id)!.id,
    clock,
    // A second scheduler over the same database is what a restart looks like.
    reopen: makeScheduler
  }
}

function addDaily(h: Harness, hour = 4, overlap: 'queue' | 'skip' = 'queue') {
  const created = h.scheduler.create({
    repoId: h.repoId as never,
    prompt: 'Nightly cleanup',
    harness: 'claude',
    shape: { type: 'daily', hour, minute: 0 },
    overlap
  })
  if (!created.ok) throw new Error(created.error.message)
  return created.value
}

describe('schedule creation', () => {
  it('persists the next instant so a restart resumes the cadence', async () => {
    const h = await harness()
    const schedule = addDaily(h, 4)
    // 06:00 now, so the next 04:00 is tomorrow.
    expect(schedule.nextRunAt).toBe(new Date(2026, 2, 11, 4, 0, 0).getTime())
    const reloaded = h.store.findSchedule(schedule.id)!
    expect(reloaded.nextRunAt).toBe(schedule.nextRunAt)
    expect(reloaded.enabled).toBe(true)
  })

  it('accepts a one-time instant and has nothing to fire after it', async () => {
    const h = await harness()
    const when = h.clock.now + 3 * 3_600_000
    const created = h.scheduler.create({
      repoId: h.repoId as never,
      prompt: 'One shot',
      harness: 'claude',
      shape: { type: 'once', runAt: when }
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.value.nextRunAt).toBe(when)

    h.clock.now = when
    await h.scheduler.tick()
    expect(h.store.list()).toHaveLength(1)
    // Nothing more is scheduled, so a second tick creates nothing.
    await h.scheduler.tick()
    expect(h.store.list()).toHaveLength(1)
  })

  it('refuses a one-time schedule with no time', async () => {
    const h = await harness()
    const result = h.scheduler.create({
      repoId: h.repoId as never,
      prompt: 'x',
      harness: 'claude',
      shape: { type: 'once' }
    })
    expect(result.ok).toBe(false)
  })
})

describe('firing produces ordinary tasks', () => {
  it('creates a queued task linked to the schedule and its occurrence', async () => {
    const h = await harness()
    const schedule = addDaily(h, 7)
    h.clock.now = new Date(2026, 2, 11, 7, 0, 30).getTime()
    await h.scheduler.tick()

    const tasks = h.store.list()
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      status: 'queued',
      prompt: 'Nightly cleanup',
      harness: 'claude',
      repoId: h.repoId,
      scheduleId: schedule.id
    })
    expect(tasks[0]!.occurrenceAt).toBe(new Date(2026, 2, 11, 7, 0, 0).getTime())
    expect(tasks[0]!.dedupeKey).toBe(
      `schedule:${schedule.id}:${String(tasks[0]!.occurrenceAt)}`
    )

    // The occurrence receipt records what happened.
    const occurrences = h.store.listOccurrences(schedule.id)
    expect(occurrences[0]).toMatchObject({ status: 'created', taskId: tasks[0]!.id })
    // And the timer moved forward.
    expect(h.store.findSchedule(schedule.id)!.nextRunAt).toBe(
      new Date(2026, 2, 12, 7, 0, 0).getTime()
    )
  })

  it('fires once when the app was closed for three days, not three times', async () => {
    const h = await harness()
    const schedule = addDaily(h, 4)
    // Three days pass with no ticks at all.
    h.clock.now = new Date(2026, 2, 14, 6, 0, 0).getTime()
    await h.scheduler.tick()

    const tasks = h.store.list()
    expect(tasks).toHaveLength(1)
    // The newest missed occurrence was caught up.
    expect(tasks[0]!.occurrenceAt).toBe(new Date(2026, 2, 14, 4, 0, 0).getTime())
    const scheduleRow = h.store.findSchedule(schedule.id)!
    expect(scheduleRow.lastNote).toContain('Caught up')
    // The next instant is in the future, so no burst follows.
    expect(scheduleRow.nextRunAt).toBeGreaterThan(h.clock.now)
  })

  it('keeps a one-time instant across a pause, even if it passed while paused', async () => {
    const h = await harness()
    const when = h.clock.now + 60_000
    const created = h.scheduler.create({
      repoId: h.repoId as never,
      prompt: 'One shot, paused across its time',
      harness: 'claude',
      shape: { type: 'once', runAt: when }
    })
    if (!created.ok) throw new Error(created.error.message)

    // Paused before the instant, resumed after it: the run is late, not gone.
    h.scheduler.setEnabled(created.value.id, false)
    h.clock.now = when + 30_000
    h.scheduler.setEnabled(created.value.id, true)
    expect(h.store.findSchedule(created.value.id)!.nextRunAt).toBe(when)

    await h.scheduler.tick()
    const tasks = h.store.list()
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.occurrenceAt).toBe(when)
  })

  it('marks a one-time schedule finished after it runs', async () => {
    const h = await harness()
    const when = h.clock.now + 60_000
    const created = h.scheduler.create({
      repoId: h.repoId as never,
      prompt: 'Single',
      harness: 'claude',
      shape: { type: 'once', runAt: when }
    })
    if (!created.ok) throw new Error(created.error.message)

    h.clock.now = when + 5_000
    await h.scheduler.tick()
    const row = h.store.findSchedule(created.value.id)!
    // Leaving it enabled would show a schedule that can never fire again.
    expect(row.enabled).toBe(false)
    expect(row.lastNote).toContain('single scheduled run')
    expect(row.nextRunAt).toBeNull()
  })

  it('does nothing while the schedule is paused, and resumes on its cadence', async () => {
    const h = await harness()
    const schedule = addDaily(h, 4)
    h.scheduler.setEnabled(schedule.id, false)
    h.clock.now = new Date(2026, 2, 12, 6, 0, 0).getTime()
    await h.scheduler.tick()
    expect(h.store.list()).toHaveLength(0)

    h.scheduler.setEnabled(schedule.id, true)
    // Resuming recomputes from now rather than replaying the paused days.
    expect(h.store.findSchedule(schedule.id)!.nextRunAt).toBe(
      new Date(2026, 2, 13, 4, 0, 0).getTime()
    )
  })
})

describe('duplicate prevention', () => {
  it('does not create a second task for the same instant', async () => {
    const h = await harness()
    addDaily(h, 7)
    h.clock.now = new Date(2026, 2, 11, 7, 0, 10).getTime()

    await h.scheduler.tick()
    await h.scheduler.tick()
    await h.scheduler.tick()
    expect(h.store.list()).toHaveLength(1)
  })

  it('treats a re-armed timer as a duplicate, not a run', async () => {
    const h = await harness()
    const schedule = addDaily(h, 7)
    h.clock.now = new Date(2026, 2, 11, 7, 0, 10).getTime()
    await h.scheduler.tick()
    expect(h.store.list()).toHaveLength(1)

    // Rewind the stored instant, as a crash before the advance would.
    h.store.updateSchedule(schedule.id, { nextRunAt: new Date(2026, 2, 11, 7, 0, 0).getTime() }, h.clock.now)
    await h.scheduler.tick()
    expect(h.store.list()).toHaveLength(1)
    expect(h.store.findSchedule(schedule.id)!.lastNote).toContain('already ran')
  })

  it('does not re-fire the same occurrence after a restart', async () => {
    const h = await harness()
    const schedule = addDaily(h, 7)
    h.clock.now = new Date(2026, 2, 11, 7, 0, 10).getTime()
    await h.scheduler.tick()
    expect(h.store.list()).toHaveLength(1)

    // A fresh scheduler (a new process) over the same database, with the clock
    // still inside the same minute.
    const restarted = h.reopen()
    await restarted.tick()
    await restarted.tick()
    expect(h.store.list()).toHaveLength(1)
    expect(h.store.listOccurrences(schedule.id).filter((o) => o.status === 'created')).toHaveLength(1)
  })

  it('prevents a double click on "run now" from queueing two tasks', async () => {
    const h = await harness()
    const schedule = addDaily(h, 7)
    const first = h.scheduler.runNow(schedule.id)
    const second = h.scheduler.runNow(schedule.id)
    expect(first.result).toBe('created')
    expect(second.result).toBe('duplicate')
    expect(h.store.list()).toHaveLength(1)
  })
})

describe('overlap policy', () => {
  it('queues a new task when the previous run is still active (default)', async () => {
    const h = await harness()
    const schedule = addDaily(h, 7, 'queue')
    // Pretend the previous occurrence is still running.
    h.store.insert(
      {
        id: 'task_00000000-0000-4000-8000-0000000000aa',
        workspaceId: h.workspaceId as never,
        repoId: h.repoId as never,
        title: 'previous',
        prompt: 'previous',
        harness: 'claude',
        attempt: 1,
        previousTaskId: null,
        scheduleId: schedule.id,
        occurrenceAt: h.clock.now - 86_400_000,
        dedupeKey: 'previous-run'
      },
      h.clock.now
    )
    h.store.updateIfStatus(
      'task_00000000-0000-4000-8000-0000000000aa',
      ['queued'],
      { status: 'running' },
      h.clock.now
    )

    h.clock.now = new Date(2026, 2, 11, 7, 0, 10).getTime()
    await h.scheduler.tick()
    expect(h.store.list().filter((task) => task.scheduleId === schedule.id)).toHaveLength(2)
  })

  it('skips the occurrence when the policy says skip', async () => {
    const h = await harness()
    const schedule = addDaily(h, 7, 'skip')
    h.store.insert(
      {
        id: 'task_00000000-0000-4000-8000-0000000000ab',
        workspaceId: h.workspaceId as never,
        repoId: h.repoId as never,
        title: 'previous',
        prompt: 'previous',
        harness: 'claude',
        attempt: 1,
        previousTaskId: null,
        scheduleId: schedule.id,
        occurrenceAt: h.clock.now - 86_400_000,
        dedupeKey: 'previous-run'
      },
      h.clock.now
    )
    h.store.updateIfStatus(
      'task_00000000-0000-4000-8000-0000000000ab',
      ['queued'],
      { status: 'running' },
      h.clock.now
    )

    h.clock.now = new Date(2026, 2, 11, 7, 0, 10).getTime()
    await h.scheduler.tick()

    // No new task, and the skip is recorded rather than silently dropped.
    expect(h.store.list().filter((task) => task.scheduleId === schedule.id)).toHaveLength(1)
    const occurrence = h.store
      .listOccurrences(schedule.id)
      .find((entry) => entry.occurrenceAt === new Date(2026, 2, 11, 7, 0, 0).getTime())
    expect(occurrence?.status).toBe('skipped')
    expect(h.store.findSchedule(schedule.id)!.lastNote).toContain('still active')
  })
})

describe('history', () => {
  it('keeps the occurrence history for review', async () => {
    const h = await harness()
    const schedule = addDaily(h, 7)
    h.clock.now = new Date(2026, 2, 11, 7, 0, 10).getTime()
    await h.scheduler.tick()
    h.clock.now = new Date(2026, 2, 12, 7, 0, 10).getTime()
    await h.scheduler.tick()

    const occurrences = h.store.listOccurrences(schedule.id)
    expect(occurrences).toHaveLength(2)
    expect(occurrences.every((entry) => entry.status === 'created' && entry.taskId !== null)).toBe(true)
    expect(h.store.list()).toHaveLength(2)
  })
})

describe('schedule editing', () => {
  it('updates cadence and metadata without changing the schedule id or existing tasks', async () => {
    const h = await harness()
    const schedule = addDaily(h, 4)
    h.clock.now = new Date(2026, 2, 10, 5, 0, 0).getTime()
    await h.scheduler.tick()
    const beforeTasks = h.store.list().length

    const updated = h.scheduler.update(schedule.id, {
      repoId: h.repoId as never,
      title: 'Morning cleanup',
      prompt: 'Clean the workspace every morning',
      harness: 'shell',
      shape: { type: 'hours', every: 6 },
      overlap: 'skip'
    })
    expect(updated.ok).toBe(true)
    if (!updated.ok) return
    expect(updated.value.id).toBe(schedule.id)
    expect(updated.value.title).toBe('Morning cleanup')
    expect(updated.value.harness).toBe('shell')
    expect(updated.value.shape).toEqual({ type: 'hours', every: 6 })
    expect(updated.value.overlap).toBe('skip')
    expect(updated.value.nextRunAt).toBe(new Date(2026, 2, 10, 6, 0, 0).getTime())
    expect(h.store.list().length).toBe(beforeTasks)
    expect(h.store.findSchedule(schedule.id)?.prompt).toBe('Clean the workspace every morning')
  })

  it('rejects an empty instruction and a one-time schedule without a time', async () => {
    const h = await harness()
    const schedule = addDaily(h)
    const empty = h.scheduler.update(schedule.id, {
      repoId: h.repoId as never,
      prompt: '   ',
      harness: 'claude',
      shape: { type: 'daily', hour: 4, minute: 0 }
    })
    expect(empty.ok).toBe(false)

    const noTime = h.scheduler.update(schedule.id, {
      repoId: h.repoId as never,
      prompt: 'One shot',
      harness: 'claude',
      shape: { type: 'once' }
    })
    expect(noTime.ok).toBe(false)
  })
})
