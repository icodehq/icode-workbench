import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskStore } from './task-store'
import { TaskService } from './task-service'
import { TaskDispatcher } from './task-dispatcher'
import { makeRepositoryService, makeTempRoot, openTempDatabase } from '../persistence/persistence-test-fixtures'
import type { SessionService } from '../sessions/session-service'
import type { HarnessId } from '../../shared/domain/harness'
import { AGENT_PASTE_START } from '../../shared/agent-prompt'

/**
 * The durable queue: dispatch, concurrency, cancellation, retry and restart.
 *
 * These run against a real SQLite file because the guarantees under test ARE
 * the database's: the conditional claim, the dedupe index, and the row that
 * survives a restart. A stub store would only test the stub.
 *
 * The Session service is faked — a PTY is not what this suite is about — but the
 * fake is deliberately narrow: it records what was created, written and
 * stopped, and it can be told what any session's host state is.
 */

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
  vi.useRealTimers()
})

type SessionBehaviour = {
  state: string
  exitCode: number | null
}

type FakeSessions = {
  service: SessionService
  created: Array<{ repoId: string; harness: string; title: string; id: string }>
  writes: Array<{ sessionId: string; data: string }>
  stopped: string[]
  restarted: Array<{ sessionId: string; resume: boolean }>
  behaviour: Map<string, SessionBehaviour>
  /** Force the next create to fail. */
  failCreate: Error | null
  /** Force the next write to fail. */
  failWrite: Error | null
  /** Force the next restart to fail. */
  failRestart: Error | null
  /** Runs at the start of `create`, before the fake session exists. */
  onCreate: (() => void) | null
  /** Runs at the start of `restart`, before the fake session is live again. */
  onRestart: (() => void) | null
  emit: (event: { type: string; sessionId: string }) => void
}

function fakeSessions(): FakeSessions {
  const created: FakeSessions['created'] = []
  const writes: FakeSessions['writes'] = []
  const stopped: string[] = []
  const restarted: FakeSessions['restarted'] = []
  const behaviour = new Map<string, SessionBehaviour>()
  const listeners = new Set<(event: never) => void>()
  let sequence = 0
  const fake: FakeSessions = {
    created,
    writes,
    stopped,
    restarted,
    behaviour,
    failCreate: null,
    failWrite: null,
    failRestart: null,
    onCreate: null,
    onRestart: null,
    emit: (event) => {
      for (const listener of listeners) listener(event as never)
    },
    service: null as unknown as SessionService
  }

  const service = {
    create: async (input: { repoId: string; harness: string; title?: string }) => {
      fake.onCreate?.()
      if (fake.failCreate) throw fake.failCreate
      sequence += 1
      const id = `ses_00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
      created.push({ repoId: input.repoId, harness: input.harness, title: input.title ?? '', id })
      behaviour.set(id, { state: 'live', exitCode: null })
      return { id }
    },
    get: async (sessionId: string) => ({
      id: sessionId,
      incarnationId: 'inc_w84_0001',
      state: behaviour.get(sessionId)?.state ?? 'live'
    }),
    write: async (sessionId: string, _incarnationId: string, data: string) => {
      if (fake.failWrite) throw fake.failWrite
      writes.push({ sessionId, data })
    },
    restart: async (sessionId: string, options: { resume?: boolean } = {}) => {
      fake.onRestart?.()
      if (fake.failRestart) throw fake.failRestart
      restarted.push({ sessionId, resume: options.resume === true })
      behaviour.set(sessionId, { state: 'live', exitCode: null })
      return {
        id: sessionId,
        incarnationId: 'inc_w84_0002',
        state: 'live',
        worktree: { path: '/tmp/wt' }
      }
    },
    stop: async (sessionId: string) => {
      stopped.push(sessionId)
      const previous = behaviour.get(sessionId)
      behaviour.set(sessionId, { state: 'exited', exitCode: previous?.exitCode ?? 0 })
    },
    subscribe: (listener: (event: never) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  fake.service = service as unknown as SessionService
  return fake
}

type Harness = {
  store: TaskStore
  service: TaskService
  dispatcher: TaskDispatcher
  sessions: FakeSessions
  repoId: string
  workspaceId: string
  clock: { now: number }
  advance: (ms: number) => void
}

async function harness(options: { maxConcurrent?: number } = {}): Promise<Harness> {
  const root = makeTempRoot('icode-w84-')
  const db = openTempDatabase(root)
  const stores = makeRepositoryService(db)
  // A real repository: registration proves the path is a Git working tree, and
  // a fake directory would test a code path the product never takes.
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
  if (options.maxConcurrent !== undefined) store.setMaxConcurrent(options.maxConcurrent)
  const sessions = fakeSessions()
  const clock = { now: 1_700_000_000_000 }
  const advance = (ms: number): void => {
    clock.now += ms
  }
  let sequence = 0
  const service = new TaskService({
    tasks: store,
    repositories: stores.repositories,
    sessions: sessions.service,
    now: () => clock.now,
    newId: () => {
      sequence += 1
      return `task_00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
    },
    isSessionLive: (sessionId) => sessions.behaviour.get(sessionId)?.state === 'live',
    // Change listing is exercised through the Git engine; these tests own the
    // queue, so the seam is a stub that must never be reached silently.
    listChanges: async () => ({ status: 'unavailable', reason: 'not-wired', detail: 'test' }),
    onQueueChanged: () => dispatcher.kick()
  })
  const dispatcher = new TaskDispatcher({
    tasks: store,
    sessions: sessions.service,
    now: () => clock.now,
    onChange: () => undefined,
    isSessionLive: (sessionId) => sessions.behaviour.get(sessionId)?.state === 'live',
    sessionState: (sessionId) => sessions.behaviour.get(sessionId) ?? null,
    sessionWorktree: () => '/tmp/wt',
    promptStartupDelayMs: 0,
    submitDelayMs: 0
  })
  dispatcher.start()

  cleanups.push(() => {
    dispatcher.stop()
    db.close()
    root.cleanup()
  })

  return {
    store,
    service,
    dispatcher,
    sessions,
    repoId: added.repository.id,
    workspaceId: stores.repositories.workspaceForRepo(added.repository.id)!.id,
    clock,
    advance
  }
}

function createQueued(h: Harness, prompt: string, harnessId: HarnessId = 'claude') {
  const created = h.service.create({ repoId: h.repoId as never, prompt, harness: harnessId })
  if (!created.ok) throw new Error(created.error.message)
  return created.value
}

/** Waits for the pump's async work to settle. */
async function settle(h: Harness, times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await h.dispatcher.pump()
  }
}

describe('task creation and persistence', () => {
  it('has a durable row before any session exists', async () => {
    const h = await harness({ maxConcurrent: 1 })
    let atLaunch: { status: string; sessionId: string | null; prompt: string } | null = null
    // The only honest way to assert "persisted before launched" is to look at
    // the database at the moment the launch begins.
    h.sessions.onCreate = () => {
      const row = h.store.list()[0]
      atLaunch = row
        ? { status: row.status, sessionId: row.sessionId, prompt: row.prompt }
        : null
    }
    const created = createQueued(h, 'Refactor the parser')
    await settle(h)

    expect(atLaunch).not.toBeNull()
    expect(atLaunch!.status).toBe('dispatching')
    expect(atLaunch!.sessionId).toBeNull()
    expect(atLaunch!.prompt).toBe('Refactor the parser')
    expect(h.store.findById(created.id)!.prompt).toBe('Refactor the parser')
  })

  it('derives a title from the first non-empty line', async () => {
    const h = await harness()
    const created = createQueued(h, '\n\n  Fix the flaky test in auth  \nmore detail')
    expect(created.title).toBe('Fix the flaky test in auth')
  })

  it('refuses an empty instruction', async () => {
    const h = await harness()
    const result = h.service.create({ repoId: h.repoId as never, prompt: '   ', harness: 'claude' })
    expect(result.ok).toBe(false)
  })

  it('refuses a repository that is not registered', async () => {
    const h = await harness()
    const result = h.service.create({
      repoId: 'repo_00000000-0000-4000-8000-000000000000' as never,
      prompt: 'x',
      harness: 'claude'
    })
    expect(result.ok).toBe(false)
  })

  it('survives a reopen of the database', async () => {
    const h = await harness({ maxConcurrent: 1 })
    const blocker = createQueued(h, 'holds the only slot')
    await settle(h)
    const created = createQueued(h, 'Survive this')
    await settle(h)
    expect(h.store.findById(blocker.id)!.status).toBe('running')

    // Re-reading through the store is what a restart does first.
    const reopened = h.store.findById(created.id)
    expect(reopened?.status).toBe('queued')
    expect(reopened?.prompt).toBe('Survive this')
  })
})

describe('dispatch', () => {
  it('launches the selected harness in the task repository and records the session', async () => {
    const h = await harness({ maxConcurrent: 1 })
    const created = createQueued(h, 'Write the migration', 'codex')
    await settle(h)

    expect(h.sessions.created).toHaveLength(1)
    expect(h.sessions.created[0]).toMatchObject({
      repoId: h.repoId,
      harness: 'codex',
      title: 'Write the migration'
    })
    const stored = h.store.findById(created.id)!
    expect(stored.status).toBe('running')
    expect(stored.sessionId).toBe(h.sessions.created[0]!.id)
    expect(stored.worktreePath).toBe('/tmp/wt')
    expect(stored.startedAt).not.toBeNull()
  })

  it('delivers the instruction as a bracketed paste followed by a separate Enter', async () => {
    const h = await harness({ maxConcurrent: 1 })
    createQueued(h, 'Run the tests and fix what fails')
    await settle(h)
    expect(h.sessions.writes).toHaveLength(2)
    expect(h.sessions.writes[0]!.data.startsWith(AGENT_PASTE_START)).toBe(true)
    expect(h.sessions.writes[0]!.data).toContain('Run the tests and fix what fails')
    expect(h.sessions.writes[1]!.data).toBe('\r')
  })

  it('does not mark a task completed just because the process was spawned', async () => {
    const h = await harness({ maxConcurrent: 1 })
    const created = createQueued(h, 'Long job')
    await settle(h)
    // The session is live and the prompt landed; the agent has not finished.
    expect(h.store.findById(created.id)!.status).toBe('running')
    expect(h.store.findById(created.id)!.finishedAt).toBeNull()
    expect(h.store.findById(created.id)!.resultSummary).toBeNull()
  })

  it('records a failed harness start instead of leaving the task queued forever', async () => {
    const h = await harness({ maxConcurrent: 1 })
    h.sessions.failCreate = new Error('harness exploded')
    const created = createQueued(h, 'Will not start')
    await settle(h)

    const stored = h.store.findById(created.id)!
    expect(stored.status).toBe('failed')
    expect(stored.failureReason).toBe('session-create-failed')
    expect(stored.error).toContain('could not be started')
    expect(stored.errorDetail).toContain('harness exploded')
    expect(stored.sessionId).toBeNull()
  })

  it('keeps the session link when the instruction cannot be delivered', async () => {
    const h = await harness({ maxConcurrent: 1 })
    h.sessions.failWrite = new Error('pty closed')
    const created = createQueued(h, 'Undeliverable')
    await settle(h)

    const stored = h.store.findById(created.id)!
    expect(stored.status).toBe('failed')
    expect(stored.failureReason).toBe('prompt-write-failed')
    // The session exists and may hold output: it must stay reviewable.
    expect(stored.sessionId).not.toBeNull()
    expect(stored.errorDetail).toContain('Open the session')
  })
})

describe('concurrency', () => {
  it('starts only maxConcurrent tasks at a time, oldest first', async () => {
    const h = await harness({ maxConcurrent: 1 })
    const first = createQueued(h, 'first')
    h.advance(1000)
    const second = createQueued(h, 'second')
    h.advance(1000)
    const third = createQueued(h, 'third')
    await settle(h)

    expect(h.sessions.created).toHaveLength(1)
    expect(h.store.findById(first.id)!.status).toBe('running')
    expect(h.store.findById(second.id)!.status).toBe('queued')
    expect(h.store.findById(third.id)!.status).toBe('queued')

    // Raising the limit admits the next one, not all of them.
    h.service.setMaxConcurrent(2)
    await settle(h)
    expect(h.store.findById(second.id)!.status).toBe('running')
    expect(h.store.findById(third.id)!.status).toBe('queued')
  })

  it('never dispatches the same task twice when pumps race', async () => {
    const h = await harness({ maxConcurrent: 2 })
    createQueued(h, 'only once')
    createQueued(h, 'only once too')
    // Three concurrent passes over the same queue.
    await Promise.all([h.dispatcher.pump(), h.dispatcher.pump(), h.dispatcher.pump()])
    await settle(h, 2)

    expect(h.sessions.created).toHaveLength(2)
    const ids = h.store.list().map((task) => task.sessionId)
    expect(new Set(ids.filter((id) => id !== null)).size).toBe(2)
  })

  it('bounds the configured limit to the supported range', async () => {
    const h = await harness()
    expect(h.service.setMaxConcurrent(99).ok).toBe(true)
    expect(h.service.maxConcurrent()).toBe(4)
    expect(h.service.setMaxConcurrent(0).ok).toBe(true)
    expect(h.service.maxConcurrent()).toBe(1)
  })
})

describe('observed completion and failure', () => {
  it('completes on the harness turn-end signal, not before', async () => {
    const h = await harness({ maxConcurrent: 1 })
    const created = createQueued(h, 'Do it')
    await settle(h)
    const sessionId = h.store.findById(created.id)!.sessionId!

    // The hook says the agent is working: still running.
    h.dispatcher.onActivity(sessionId, { state: 'working', outcome: null })
    expect(h.store.findById(created.id)!.status).toBe('running')

    h.dispatcher.onActivity(sessionId, { state: 'idle', outcome: 'completed' })
    const stored = h.store.findById(created.id)!
    expect(stored.status).toBe('completed')
    expect(stored.finishedAt).not.toBeNull()
    expect(stored.resultSummary).toContain('Review the worktree')
  })

  it('marks waiting when the agent asks a human, and back to running when it resumes', async () => {
    const h = await harness({ maxConcurrent: 1 })
    const created = createQueued(h, 'Needs permission')
    await settle(h)
    const sessionId = h.store.findById(created.id)!.sessionId!

    h.dispatcher.onActivity(sessionId, { state: 'waiting', outcome: null })
    expect(h.store.findById(created.id)!.status).toBe('waiting')
    expect(h.store.findById(created.id)!.resultSummary).toContain('Waiting for your input')

    // A waiting task still holds its slot: it is not finished.
    expect(h.store.countActive()).toBe(1)

    h.dispatcher.onActivity(sessionId, { state: 'working', outcome: null })
    expect(h.store.findById(created.id)!.status).toBe('running')
  })

  it('fails when the harness exits non-zero, and completes on a clean exit', async () => {
    const h = await harness({ maxConcurrent: 1 })
    const failing = createQueued(h, 'will fail')
    await settle(h)
    const failingSession = h.store.findById(failing.id)!.sessionId!
    h.sessions.behaviour.set(failingSession, { state: 'exited', exitCode: 2 })
    h.dispatcher.reconcileTask(h.store.findById(failing.id)!, { state: 'exited', exitCode: 2 })
    expect(h.store.findById(failing.id)!.status).toBe('failed')
    expect(h.store.findById(failing.id)!.exitCode).toBe(2)

    const clean = createQueued(h, 'will pass')
    await settle(h)
    const cleanSession = h.store.findById(clean.id)!.sessionId
    if (cleanSession) {
      h.dispatcher.reconcileTask(h.store.findById(clean.id)!, { state: 'exited', exitCode: 0 })
      expect(h.store.findById(clean.id)!.status).toBe('completed')
    }
  })

  it('never completes when the exit code is unknown', async () => {
    const h = await harness({ maxConcurrent: 1 })
    const created = createQueued(h, 'Murky ending')
    await settle(h)
    // Real runs hit this: a host that reports "exited" without a code. Calling
    // that success would be inventing a result nobody observed.
    h.dispatcher.reconcileTask(h.store.findById(created.id)!, { state: 'exited', exitCode: null })

    const stored = h.store.findById(created.id)!
    expect(stored.status).toBe('failed')
    expect(stored.error).toContain('exit code could not be read')
    expect(stored.status).not.toBe('completed')
  })

  it('ignores a late host event for a task the user already cancelled', async () => {
    const h = await harness({ maxConcurrent: 1 })
    const created = createQueued(h, 'Cancel me')
    await settle(h)
    await h.service.cancel(created.id)
    expect(h.store.findById(created.id)!.status).toBe('cancelled')

    h.dispatcher.onActivity(h.store.findById(created.id)!.sessionId!, {
      state: 'idle',
      outcome: 'completed'
    })
    // Cancellation is terminal; a late turn end must not rewrite it.
    expect(h.store.findById(created.id)!.status).toBe('cancelled')
  })
})

describe('cancellation', () => {
  it('cancels a queued task without ever launching it', async () => {
    const h = await harness({ maxConcurrent: 1 })
    const blocker = createQueued(h, 'holds the slot')
    await settle(h)
    const queued = createQueued(h, 'never runs')
    await settle(h)

    expect(h.store.findById(blocker.id)!.status).toBe('running')
    const cancelled = await h.service.cancel(queued.id)
    expect(cancelled.ok).toBe(true)
    expect(h.store.findById(queued.id)!.status).toBe('cancelled')
    expect(h.store.findById(queued.id)!.error).toContain('before it started')
    // Only the blocker's session was ever created.
    expect(h.sessions.created).toHaveLength(1)
  })

  it('cancels a running task and asks its session to stop', async () => {
    const h = await harness({ maxConcurrent: 1 })
    const created = createQueued(h, 'Stop this')
    await settle(h)
    const sessionId = h.store.findById(created.id)!.sessionId!

    const cancelled = await h.service.cancel(created.id)
    expect(cancelled.ok).toBe(true)
    expect(h.store.findById(created.id)!.status).toBe('cancelled')
    expect(h.sessions.stopped).toContain(sessionId)
  })

  it('refuses to cancel a task that already finished', async () => {
    const h = await harness({ maxConcurrent: 1 })
    const created = createQueued(h, 'Done')
    await settle(h)
    h.dispatcher.onActivity(h.store.findById(created.id)!.sessionId!, {
      state: 'idle',
      outcome: 'completed'
    })
    const result = await h.service.cancel(created.id)
    expect(result.ok).toBe(false)
  })
})

describe('retry', () => {
  it('creates a new attempt and keeps the failed one intact', async () => {
    const h = await harness({ maxConcurrent: 1 })
    const created = createQueued(h, 'Try me')
    await settle(h)
    h.sessions.failCreate = null
    h.dispatcher.onActivity(h.store.findById(created.id)!.sessionId!, {
      state: 'idle',
      outcome: 'failed'
    })
    const failed = h.store.findById(created.id)!
    expect(failed.status).toBe('failed')

    const retried = h.service.retry(created.id)
    expect(retried.ok).toBe(true)
    if (!retried.ok) return
    expect(retried.value.attempt).toBe(2)
    expect(retried.value.previousTaskId).toBe(created.id)
    expect(retried.value.status).toBe('queued')

    // History is preserved, not rewritten.
    const original = h.store.findById(created.id)!
    expect(original.status).toBe('failed')
    expect(original.error).toBe(failed.error)
    const history = h.service.history(retried.value.id)
    expect(history.map((task) => task.attempt)).toEqual([1, 2])
  })

  it('does not queue a second retry from a double click', async () => {
    const h = await harness({ maxConcurrent: 1 })
    const created = createQueued(h, 'Double')
    await settle(h)
    h.dispatcher.onActivity(h.store.findById(created.id)!.sessionId!, {
      state: 'idle',
      outcome: 'failed'
    })

    const first = h.service.retry(created.id)
    const second = h.service.retry(created.id)
    expect(first.ok && second.ok).toBe(true)
    if (first.ok && second.ok) expect(first.value.id).toBe(second.value.id)
    expect(h.store.list().filter((task) => task.previousTaskId === created.id)).toHaveLength(1)
  })

  it('refuses to retry a task that succeeded or is still running', async () => {
    const h = await harness({ maxConcurrent: 1 })
    const running = createQueued(h, 'Still going')
    await settle(h)
    expect(h.service.retry(running.id).ok).toBe(false)
  })
})

describe('restart recovery', () => {
  it('fails a task whose session died while iCode was closed — never completes it', async () => {
    const h = await harness({ maxConcurrent: 1 })
    const created = createQueued(h, 'Interrupted')
    await settle(h)
    const sessionId = h.store.findById(created.id)!.sessionId!

    // iCode is gone; the host has no such session any more.
    h.sessions.behaviour.delete(sessionId)
    const outcome = await h.dispatcher.recover()

    const stored = h.store.findById(created.id)!
    expect(stored.status).toBe('failed')
    expect(stored.failureReason).toBe('interrupted')
    expect(stored.status).not.toBe('completed')
    expect(outcome.interrupted).toBe(1)
  })

  it('treats an exit observed after the restart as interrupted, not completed', async () => {
    const h = await harness({ maxConcurrent: 1 })
    const created = createQueued(h, 'Clean-looking but unobserved')
    await settle(h)
    const sessionId = h.store.findById(created.id)!.sessionId!
    // The host reports a clean exit, but it happened after iCode died: nothing
    // in this process ever saw the turn finish.
    h.sessions.behaviour.set(sessionId, { state: 'exited', exitCode: 0 })

    await h.dispatcher.recover()
    const stored = h.store.findById(created.id)!
    expect(stored.status).toBe('failed')
    expect(stored.failureReason).toBe('interrupted')
    expect(stored.status).not.toBe('completed')
  })

  it('re-queues a task that was claimed but never launched', async () => {
    const h = await harness({ maxConcurrent: 4 })
    // Insert without going through the service, so the pump cannot have run:
    // this is exactly the state a crash between claim and launch leaves behind.
    const created = h.store.insert(
      {
        id: 'task_00000000-0000-4000-8000-0000000000ff',
        workspaceId: h.workspaceId as never,
        repoId: h.repoId as never,
        title: 'Claimed then crashed',
        prompt: 'Claimed then crashed',
        harness: 'claude',
        attempt: 1,
        previousTaskId: null,
        scheduleId: null,
        occurrenceAt: null,
        dedupeKey: null
      },
      h.clock.now
    )!
    // Simulate a crash between claim and session creation.
    expect(h.store.claim(created.id, h.clock.now)).toBe(true)
    expect(h.store.findById(created.id)!.status).toBe('dispatching')

    const outcome = await h.dispatcher.recover()
    expect(outcome.requeued).toBe(1)
    // Recovery re-queues and then kicks the pump, so the task is dispatchable
    // immediately — the point is that it went back through the queue rather
    // than being abandoned or failed.
    await settle(h)
    const stored = h.store.findById(created.id)!
    expect(stored.status).toBe('running')
    expect(stored.sessionId).not.toBeNull()
    expect(h.sessions.created).toHaveLength(1)
  })

  it('adopts a session that is still live instead of starting a second one', async () => {
    const h = await harness({ maxConcurrent: 1 })
    const created = createQueued(h, 'Still alive')
    await settle(h)
    const before = h.sessions.created.length

    await h.dispatcher.recover()
    expect(h.store.findById(created.id)!.status).toBe('running')
    expect(h.sessions.created).toHaveLength(before)
  })

  it('leaves genuinely queued tasks queued across a restart', async () => {
    const h = await harness({ maxConcurrent: 1 })
    const blocker = createQueued(h, 'blocker')
    await settle(h)
    const waiting = createQueued(h, 'still queued')
    await settle(h)

    await h.dispatcher.recover()
    expect(h.store.findById(blocker.id)!.status).toBe('running')
    expect(h.store.findById(waiting.id)!.status).toBe('queued')
  })
})

describe('supervisor proposals', () => {
  const SUPERVISOR = 'ses_00000000-0000-4000-8000-000000000099'

  function propose(h: Harness, prompt: string) {
    const created = h.service.create({
      repoId: h.repoId as never,
      prompt,
      harness: 'claude',
      origin: 'supervisor',
      createdBySessionId: SUPERVISOR
    })
    if (!created.ok) throw new Error(created.error.message)
    return created.value
  }

  it('never launches a proposal until a human approves it', async () => {
    const h = await harness({ maxConcurrent: 1 })
    const proposal = propose(h, 'Add a settings page')
    await settle(h)

    expect(proposal.approval).toBe('pending')
    expect(proposal.origin).toBe('supervisor')
    expect(proposal.createdBySessionId).toBe(SUPERVISOR)
    expect(proposal.approvedAt).toBeNull()
    expect(h.store.findById(proposal.id)!.status).toBe('queued')
    expect(h.sessions.created).toHaveLength(0)
  })

  it('does not let a pending proposal block an approved task behind it', async () => {
    const h = await harness({ maxConcurrent: 1 })
    const proposal = propose(h, 'Pending first')
    const approved = createQueued(h, 'Approved second')
    await settle(h)

    expect(h.store.findById(proposal.id)!.approval).toBe('pending')
    expect(h.store.findById(proposal.id)!.status).toBe('queued')
    expect(h.store.findById(approved.id)!.status).toBe('running')
    expect(h.sessions.created).toHaveLength(1)
    expect(h.sessions.created[0]!.title).toBe('Approved second')
  })

  it('launches after approval and records who approved it', async () => {
    const h = await harness({ maxConcurrent: 1 })
    const proposal = propose(h, 'Approve me')
    const result = h.service.approve(proposal.id)
    expect(result.ok).toBe(true)
    await settle(h)

    const stored = h.store.findById(proposal.id)!
    expect(stored.approval).toBe('approved')
    expect(stored.approvedBy).toBe('human')
    expect(stored.status).toBe('running')
    expect(h.sessions.created).toHaveLength(1)
  })

  it('rejects a proposal without launching it', async () => {
    const h = await harness({ maxConcurrent: 1 })
    const proposal = propose(h, 'Reject me')
    const result = h.service.reject(proposal.id, 'Not now')
    expect(result.ok).toBe(true)
    await settle(h)

    const stored = h.store.findById(proposal.id)!
    expect(stored.approval).toBe('rejected')
    expect(stored.status).toBe('cancelled')
    expect(stored.failureReason).toBe('approval-rejected')
    expect(stored.errorDetail).toBe('Not now')
    expect(h.sessions.created).toHaveLength(0)
  })

  it('caps pending proposals', async () => {
    const h = await harness({ maxConcurrent: 1 })
    for (let index = 0; index < 20; index += 1) propose(h, `Proposal ${String(index)}`)
    const overflow = h.service.create({
      repoId: h.repoId as never,
      prompt: 'One too many',
      harness: 'claude',
      origin: 'supervisor',
      createdBySessionId: SUPERVISOR
    })
    expect(overflow.ok).toBe(false)
    expect(h.store.countPending(h.repoId as never)).toBe(20)
  })
})

describe('reviewability', () => {
  it('exposes a session and a worktree for a finished task', async () => {
    const h = await harness({ maxConcurrent: 1 })
    const created = createQueued(h, 'Review me')
    await settle(h)
    h.dispatcher.onActivity(h.store.findById(created.id)!.sessionId!, {
      state: 'idle',
      outcome: 'completed'
    })
    const view = h.service.get(created.id)!
    expect(view.sessionId).not.toBeNull()
    expect(view.worktreePath).toBe('/tmp/wt')
    expect(view.canReview).toBe(true)
  })
})

describe('Mira task provenance', () => {
  it('records a non-session actor and the policy that approved the task', async () => {
    const h = await harness({ maxConcurrent: 1 })
    const created = h.service.create({
      repoId: h.repoId as never,
      title: 'Docs',
      prompt: 'Write docs.',
      harness: 'claude',
      origin: 'supervisor',
      createdByActor: 'mira',
      createdBySessionId: null,
      assistantRunId: 'run_1',
      approvalPolicy: 'mira-low-risk',
      approval: 'approved',
      approvedBy: 'mira-policy',
      dedupeKey: 'mira:test'
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const stored = h.store.findById(created.value.id)!
    expect(stored.createdByActor).toBe('mira')
    expect(stored.assistantRunId).toBe('run_1')
    expect(stored.approvalPolicy).toBe('mira-low-risk')
    expect(stored.approval).toBe('approved')
    expect(stored.approvedBy).toBe('mira-policy')
    expect(stored.createdBySessionId).toBeNull()
  })

  it('archives only terminal tasks and can restore them', async () => {
    const h = await harness({ maxConcurrent: 1 })
    const created = createQueued(h, 'Archive me later')
    expect(h.service.archive(created.id).ok).toBe(false)

    h.store.updateIfStatus(
      created.id,
      ['queued', 'dispatching', 'running'],
      { status: 'cancelled', finishedAt: h.clock.now },
      h.clock.now
    )
    const archived = h.service.archive(created.id)
    expect(archived.ok).toBe(true)
    if (archived.ok) expect(archived.value.archivedAt).toBe(h.clock.now)

    expect(h.store.list().some((task) => task.id === created.id)).toBe(false)
    expect(h.store.list({ includeArchived: true }).some((task) => task.id === created.id)).toBe(
      true
    )

    const restored = h.service.unarchive(created.id)
    expect(restored.ok).toBe(true)
    if (restored.ok) expect(restored.value.archivedAt).toBeNull()
    expect(h.store.list().some((task) => task.id === created.id)).toBe(true)
  })

  it('bulk-archives cancellations but leaves review-pending completions alone', async () => {
    const h = await harness({ maxConcurrent: 1 })
    const cancelled = createQueued(h, 'Cancel this')
    h.store.updateIfStatus(
      cancelled.id,
      ['queued', 'dispatching', 'running'],
      { status: 'cancelled', finishedAt: h.clock.now },
      h.clock.now
    )
    const completed = createQueued(h, 'Wait for review')
    h.store.updateIfStatus(
      completed.id,
      ['queued', 'dispatching', 'running'],
      { status: 'completed', finishedAt: h.clock.now },
      h.clock.now
    )

    const result = h.service.archiveFinished(h.repoId as never)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe(1)
    expect(h.store.findById(cancelled.id)!.archivedAt).not.toBeNull()
    expect(h.store.findById(completed.id)!.archivedAt).toBeNull()
  })

  it('keeps a high-risk Mira task pending until a person approves it', async () => {
    const h = await harness({ maxConcurrent: 1 })
    const created = h.service.create({
      repoId: h.repoId as never,
      title: 'Auth migration',
      prompt: 'Change auth and migrations.',
      harness: 'claude',
      origin: 'supervisor',
      createdByActor: 'mira',
      createdBySessionId: null,
      approvalPolicy: 'mira-human-approval',
      approval: 'pending',
      dedupeKey: 'mira:high-risk'
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const stored = h.store.findById(created.value.id)!
    expect(stored.approval).toBe('pending')
    expect(stored.approvedBy).toBeNull()
    expect(stored.status).toBe('queued')
  })
})

describe('continue dispatch', () => {
  async function failedDispatched(
    h: Harness,
    options: { exited?: boolean; error?: string } = {}
  ) {
    const created = createQueued(h, 'Refactor the parser')
    await settle(h)
    const task = h.store.findById(created.id)!
    expect(task.status).toBe('running')
    if (options.exited === true) {
      h.sessions.behaviour.set(task.sessionId!, { state: 'exited', exitCode: 1 })
    }
    h.store.updateIfStatus(
      task.id,
      ['running'],
      {
        status: 'failed',
        failureReason: 'harness-failed',
        finishedAt: h.clock.now,
        error: options.error ?? 'The harness exited with code 1.'
      },
      h.clock.now
    )
    return h.store.findById(task.id)!
  }

  it('reuses a live session and sends the continuation prompt', async () => {
    const h = await harness({ maxConcurrent: 1 })
    const failed = await failedDispatched(h, { error: 'Insufficient balance.' })
    const createsBefore = h.sessions.created.length

    const result = h.service.resume(failed.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    await settle(h)

    expect(h.sessions.created.length).toBe(createsBefore)
    expect(h.sessions.restarted).toHaveLength(0)
    const stored = h.store.findById(result.value.id)!
    expect(stored.status).toBe('running')
    expect(stored.sessionId).toBe(failed.sessionId)
    expect(stored.worktreePath).toBe('/tmp/wt')

    const prompt = h.sessions.writes.map((entry) => entry.data).join('')
    expect(prompt).toContain('Insufficient balance.')
    expect(prompt).toContain('Refactor the parser')
    expect(prompt).toContain('do not redo completed work')
  })

  it('restarts an exited session with its resume command', async () => {
    const h = await harness({ maxConcurrent: 1 })
    const failed = await failedDispatched(h, { exited: true })
    const createsBefore = h.sessions.created.length

    const result = h.service.resume(failed.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    await settle(h)

    expect(h.sessions.created.length).toBe(createsBefore)
    expect(h.sessions.restarted).toEqual([
      { sessionId: failed.sessionId!, resume: true }
    ])
    const stored = h.store.findById(result.value.id)!
    expect(stored.status).toBe('running')
    expect(
      h.sessions.writes.some((entry) => entry.data.includes('Refactor the parser'))
    ).toBe(true)
  })

  it('records a restart failure as resume-failed without starting over', async () => {
    const h = await harness({ maxConcurrent: 1 })
    const failed = await failedDispatched(h, { exited: true })
    h.sessions.failRestart = new Error('The host is unreachable.')

    const result = h.service.resume(failed.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    await settle(h)

    const stored = h.store.findById(result.value.id)!
    expect(stored.status).toBe('failed')
    expect(stored.failureReason).toBe('resume-failed')
    expect(stored.sessionId).toBe(failed.sessionId)
    expect(h.sessions.created).toHaveLength(1)
    // The failed continuation is itself eligible: the user may try again.
    expect(h.service.get(stored.id)!.canResume).toBe(true)
  })

  it('ignores the exit of the PTY it is deliberately replacing', async () => {
    const h = await harness({ maxConcurrent: 1 })
    const failed = await failedDispatched(h, { exited: true })
    h.sessions.onRestart = () => {
      h.sessions.behaviour.set(failed.sessionId!, { state: 'exited', exitCode: 1 })
      h.sessions.emit({ type: 'exit', sessionId: failed.sessionId! })
    }

    const result = h.service.resume(failed.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    await settle(h)

    expect(h.store.findById(result.value.id)!.status).toBe('running')
  })

  it('records a prompt delivery failure without creating a new session', async () => {
    const h = await harness({ maxConcurrent: 1 })
    const failed = await failedDispatched(h)
    h.sessions.failWrite = new Error('The terminal did not accept input.')

    const result = h.service.resume(failed.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    await settle(h)

    const stored = h.store.findById(result.value.id)!
    expect(stored.status).toBe('failed')
    expect(stored.failureReason).toBe('prompt-write-failed')
    expect(h.sessions.created).toHaveLength(1)
  })
})
