import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionService, SessionServiceError } from './session-service'
import { FakeHostGateway } from './fake-host-gateway'
import { makeRepositoryService, makeTempRoot, openTempDatabase } from '../persistence/persistence-test-fixtures'
import { WorktreeStore } from '../persistence/worktree-store'
import { GitWorktreeService } from '../worktrees/git-worktree-service'
import { rmSync as rmTree, writeFileSync } from 'node:fs'
import { newSessionId } from '../../shared/domain/ids'
import type { TempRoot } from '../persistence/persistence-test-fixtures'
import type { Database } from '../persistence/database'
import type { HarnessDetectionResult } from '../harness/harness-detector'
import { newRepoId } from '../../shared/domain/ids'
import { toPtyIncarnationId } from '../../shared/domain/ids'
import type { RendererSessionEvent } from '../../shared/schemas/ipc'

type Fixture = {
  root: TempRoot
  db: Database
  stores: ReturnType<typeof makeRepositoryService>
  host: FakeHostGateway
  service: SessionService
  worktrees: WorktreeStore
  gitWorktrees: GitWorktreeService
  repoId: string
  repoPath: string
  events: RendererSessionEvent[]
  detection: { current: HarnessDetectionResult }
}

const fixtures: Array<() => void> = []

function available(command: string): HarnessDetectionResult {
  return {
    state: 'available',
    harness: 'claude',
    version: '2.1.304',
    resolvedPath: command,
    diagnostics: {
      resolvedPath: command,
      outcome: 'exited',
      exitCode: 0,
      signal: null,
      stdoutTail: '2.1.304',
      stderrTail: '',
      durationMs: 10,
      observedAt: 1,
      attempts: 1
    },
    command: { command, args: [] }
  }
}

function unusable(
  state: 'unavailable' | 'detection_failed',
  harness: 'claude' | 'codex' | 'opencode' | 'shell' = 'claude'
): HarnessDetectionResult {
  const diagnostics = {
    resolvedPath: null,
    outcome: 'spawn_error' as const,
    exitCode: null,
    signal: null,
    stdoutTail: '',
    stderrTail: 'Missing optional dependency @openai/codex-linux-x64',
    durationMs: 12,
    observedAt: 1,
    attempts: 1
  }
  return state === 'unavailable'
    ? {
        state,
        harness,
        reason: 'not_found',
        incompatibility: null,
        message: 'Executable not found on PATH',
        diagnostics,
        command: null
      }
    : {
        state,
        harness,
        reason: 'timeout',
        message: 'Version probe timed out after 5000 ms',
        diagnostics,
        command: null
      }
}

function setup(options: { harness?: HarnessDetectionResult } = {}): Fixture {
  const root = makeTempRoot('ade-session-')
  const db = openTempDatabase(root)
  const stores = makeRepositoryService(db)
  const host = new FakeHostGateway()
  const detection = { current: options.harness ?? available('/usr/bin/claude') }
  const worktrees = new WorktreeStore(db)
  const gitWorktrees = new GitWorktreeService({ worktreeRoot: join(root.dir, 'worktrees') })
  const service = new SessionService({
    database: db,
    repositories: stores.repositories,
    sessions: stores.sessions,
    worktrees,
    gitWorktrees,
    host,
    detectHarness: async () => detection.current,
    now: () => 1_700_000_000_000
  })
  service.start()
  const events: RendererSessionEvent[] = []
  service.subscribe((event) => events.push(event))

  const repoPath = join(root.dir, 'atlas')
  mkdirSync(repoPath, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', repoPath], { stdio: 'pipe' })
  // Worktree isolation requires a baseline commit.
  writeFileSync(join(repoPath, 'README.md'), '# fixture\n')
  execFileSync('git', ['-C', repoPath, 'add', 'README.md'], { stdio: 'pipe' })
  execFileSync(
    'git',
    ['-C', repoPath, '-c', 'user.email=ade@test', '-c', 'user.name=ADE', 'commit', '-qm', 'init'],
    { stdio: 'pipe' }
  )

  fixtures.push(() => {
    service.dispose()
    db.close()
    root.cleanup()
  })

  return {
    root,
    db,
    stores,
    host,
    service,
    worktrees,
    gitWorktrees,
    repoId: '',
    repoPath,
    events,
    detection
  }
}

async function withRepo(): Promise<Fixture> {
  const fixture = setup()
  const added = await fixture.stores.service.addRepository(fixture.repoPath)
  fixture.repoId = added.repository.id
  return fixture
}

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()!()
})

function createInput(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    repoId: fixture.repoId,
    harness: 'claude' as const,
    cols: 120,
    rows: 32,
    ...overrides
  } as Parameters<SessionService['create']>[0]
}

describe('session creation', () => {
  it('persists durable metadata and starts the resolved harness command', async () => {
    const f = await withRepo()
    const summary = await f.service.create(createInput(f))
    expect(summary).toMatchObject({
      repoId: f.repoId,
      harness: 'claude',
      state: 'live',
      authority: 'host',
      reason: 'host_live',
      exitCode: null
    })
    expect(summary.title).toContain('Claude Code')
    expect(f.host.calls.createOrAttach).toHaveLength(1)
    expect(f.host.calls.createOrAttach[0]).toMatchObject({
      sessionId: summary.id,
      attachOnly: false,
      command: '/usr/bin/claude'
    })
    const stored = f.stores.sessions.findById(summary.id as never)
    expect(stored?.observation.lastObservedState).toBe('live')
    expect(stored?.observation.lastObservedIncarnationId).toBe(summary.incarnationId)
    expect(f.events.some((event) => event.type === 'state')).toBe(true)
  })

  it('uses an optional title', async () => {
    const f = await withRepo()
    const summary = await f.service.create(createInput(f, { title: 'Fix   checkout' }))
    expect(summary.title).toBe('Fix checkout')
  })

  it('rejects an unknown repository without spawning', async () => {
    const f = await withRepo()
    await expect(
      f.service.create(createInput(f, { repoId: newRepoId() }))
    ).rejects.toMatchObject({ appError: { code: 'INVALID_ARGUMENT' } })
    expect(f.host.calls.createOrAttach).toHaveLength(0)
  })

  it('rejects an unavailable harness with diagnostics', async () => {
    const f = setup({ harness: unusable('unavailable', 'codex') })
    const added = await f.stores.service.addRepository(f.repoPath)
    f.repoId = added.repository.id
    await expect(f.service.create(createInput(f, { harness: 'codex' }))).rejects.toMatchObject({
      appError: {
        code: 'HARNESS_UNAVAILABLE',
        context: expect.objectContaining({ reason: 'not_found', stderr: expect.stringContaining('codex-linux-x64') })
      }
    })
    expect(f.host.calls.createOrAttach).toHaveLength(0)
    expect(f.stores.sessions.listAll()).toHaveLength(0)
  })

  it('keeps detection failure distinct from unavailable', async () => {
    const f = setup({ harness: unusable('detection_failed', 'codex') })
    const added = await f.stores.service.addRepository(f.repoPath)
    f.repoId = added.repository.id
    await expect(f.service.create(createInput(f, { harness: 'codex' }))).rejects.toMatchObject({
      appError: { code: 'HARNESS_DETECTION_FAILED', retryable: true }
    })
  })

  it('records a failed spawn and never marks it live', async () => {
    const f = await withRepo()
    f.host.failNextSpawn = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })
    await expect(f.service.create(createInput(f))).rejects.toMatchObject({
      appError: { code: 'SPAWN_FAILED' }
    })
    const rows = f.stores.sessions.listAll()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.observation.lastObservedState).toBe('failed')
    expect(rows[0]!.observation.lastObservedIncarnationId).toBeNull()
  })

  it('records host unavailability on create and keeps it distinguishable', async () => {
    const f = await withRepo()
    f.host.reachable = false
    await expect(f.service.create(createInput(f))).rejects.toMatchObject({
      appError: { code: 'HOST_UNREACHABLE', retryable: true }
    })
    const rows = f.stores.sessions.listAll()
    expect(rows[0]!.observation.lastObservedState).toBe('failed')
    expect(rows[0]!.observation.lastObservedError?.code).toBe('HOST_UNREACHABLE')
  })

  it('rejects a missing working directory before spawning', async () => {
    const f = await withRepo()
    rmSync(f.repoPath, { recursive: true, force: true })
    await expect(f.service.create(createInput(f))).rejects.toMatchObject({
      appError: { code: 'CWD_MISSING' }
    })
    expect(f.host.calls.createOrAttach).toHaveLength(0)
  })
})

describe('attach', () => {
  it('attaches to the existing PTY without spawning another', async () => {
    const f = await withRepo()
    const created = await f.service.create(createInput(f))
    const payload = await f.service.attach(created.id)
    expect(payload).toMatchObject({
      sessionId: created.id,
      incarnationId: created.incarnationId,
      cols: 120,
      rows: 32,
      seq: 0,
      alternateScreen: false,
      truncated: false
    })
    expect(f.host.sessions.size).toBe(1)
    expect(f.host.calls.createOrAttach).toHaveLength(2)
    expect(f.host.calls.createOrAttach[1]!.attachOnly).toBe(true)
  })

  it('returns the current snapshot after output', async () => {
    const f = await withRepo()
    const created = await f.service.create(createInput(f))
    f.host.emitData(created.id, 'hello\r\n')
    const payload = await f.service.attach(created.id)
    expect(payload.seq).toBe(1)
    expect(payload.snapshot).toContain('hello')
  })

  it('marks the session unavailable when the host lost it', async () => {
    const f = await withRepo()
    const created = await f.service.create(createInput(f))
    f.host.remove(created.id)
    await expect(f.service.attach(created.id)).rejects.toMatchObject({
      appError: { code: 'SESSION_NOT_FOUND' }
    })
    const stored = f.stores.sessions.findById(created.id as never)
    expect(stored?.observation.lastObservedState).toBe('unavailable')
  })

  it('rejects an unknown session', async () => {
    const f = await withRepo()
    await expect(
      f.service.attach('ses_00000000-0000-4000-8000-000000000000')
    ).rejects.toMatchObject({ appError: { code: 'SESSION_NOT_FOUND' } })
  })
})

describe('input, resize, stop', () => {
  it('writes only with the current incarnation', async () => {
    const f = await withRepo()
    const created = await f.service.create(createInput(f))
    await f.service.write(created.id, created.incarnationId!, 'ls\r')
    expect(f.host.calls.write).toEqual([
      { sessionId: created.id, incarnationId: created.incarnationId, data: 'ls\r' }
    ])
  })

  it('rejects a stale incarnation before touching the host', async () => {
    const f = await withRepo()
    const created = await f.service.create(createInput(f))
    const stale = 'deadbeefdeadbeef'
    await expect(f.service.write(created.id, stale, 'boom')).rejects.toMatchObject({
      appError: { code: 'SESSION_NOT_FOUND', detail: expect.stringContaining('current incarnation') }
    })
    await expect(f.service.resize(created.id, stale, 80, 24)).rejects.toMatchObject({
      appError: { code: 'SESSION_NOT_FOUND' }
    })
    expect(f.host.calls.write).toHaveLength(0)
    expect(f.host.calls.resize).toHaveLength(0)
  })

  it('resizes the addressed session only', async () => {
    const f = await withRepo()
    const a = await f.service.create(createInput(f))
    const b = await f.service.create(createInput(f))
    await f.service.resize(a.id, a.incarnationId!, 140, 44)
    expect(f.host.sessions.get(a.id)?.info).toMatchObject({ cols: 140, rows: 44 })
    expect(f.host.sessions.get(b.id)?.info).toMatchObject({ cols: 120, rows: 32 })
  })

  it('treats a requested stop as an exit even with a SIGHUP exit code', async () => {
    const f = await withRepo()
    const a = await f.service.create(createInput(f))
    const b = await f.service.create(createInput(f))
    await f.service.stop(a.id)
    expect(f.host.calls.kill).toEqual([a.id])
    expect(f.host.sessions.get(b.id)?.info.status).toBe('live')
    const stored = f.stores.sessions.findById(a.id as never)
    expect(stored?.observation.lastObservedState).toBe('exited')
    expect(stored?.observation.lastObservedExitCode).toBe(129)
    expect(f.events.some((event) => event.type === 'exit')).toBe(true)
    const summary = await f.service.get(a.id)
    expect(summary).toMatchObject({ state: 'exited', reason: 'host_exited', exitCode: 129 })
  })

  it('treats stopping an already-gone session as idempotent', async () => {
    const f = await withRepo()
    const created = await f.service.create(createInput(f))
    f.host.remove(created.id)
    await expect(f.service.stop(created.id)).resolves.toBeUndefined()
    expect(f.stores.sessions.findById(created.id as never)?.observation.lastObservedState).toBe(
      'unavailable'
    )
  })
})

describe('restart and incarnation safety', () => {
  it('restarts with a new incarnation and ignores late old events', async () => {
    const f = await withRepo()
    const created = await f.service.create(createInput(f))
    const oldIncarnation = created.incarnationId!
    f.host.finish(created.id, 0)

    const restarted = await f.service.restart(created.id)
    expect(restarted.state).toBe('live')
    expect(restarted.incarnationId).not.toBe(oldIncarnation)

    const eventsBefore = f.events.length
    f.host.emitData(created.id, 'ghost', oldIncarnation)
    expect(f.events.length).toBe(eventsBefore)

    await expect(
      f.service.write(created.id, oldIncarnation, 'stale')
    ).rejects.toMatchObject({ appError: { code: 'SESSION_NOT_FOUND' } })
    await f.service.write(created.id, restarted.incarnationId!, 'new')
    expect(f.host.calls.write.at(-1)?.incarnationId).toBe(restarted.incarnationId)
  })

  it('stops a live session before restarting it', async () => {
    const f = await withRepo()
    const created = await f.service.create(createInput(f))
    const restarted = await f.service.restart(created.id)
    expect(f.host.calls.kill).toEqual([created.id])
    expect(restarted.incarnationId).not.toBe(created.incarnationId)
  })

  it('refuses restart when the harness is no longer available', async () => {
    const f = await withRepo()
    const created = await f.service.create(createInput(f))
    f.detection.current = unusable('unavailable')
    await expect(f.service.restart(created.id)).rejects.toMatchObject({
      appError: { code: 'HARNESS_UNAVAILABLE' }
    })
  })
})

describe('startup reconciliation', () => {
  async function seedPersisted(
    f: Fixture,
    options: { state: 'live' | 'starting' | 'exited' | 'failed'; incarnation?: string }
  ): Promise<string> {
    const created = await f.service.create(createInput(f))
    const workspace = f.stores.repositories.workspaceForRepo(created.repoId as never)
    if (!workspace) throw new Error('missing workspace')
    // Rewrite the durable observation to model a prior ADE run.
    f.stores.sessions.recordObservation(created.id as never, {
      lastObservedState: options.state,
      lastObservedExitCode: options.state === 'exited' ? 0 : null,
      lastObservedError: null,
      lastObservedIncarnationId: toPtyIncarnationId(
        options.incarnation ?? created.incarnationId!
      ),
      lastObservedAt: 1
    })
    return created.id
  }

  it('confirms a live PTY from the host, not from the database', async () => {
    const f = await withRepo()
    const id = await seedPersisted(f, { state: 'live' })
    const view = await f.service.reconcile()
    const summary = view.sessions.find((session) => session.id === id)!
    expect(summary).toMatchObject({ state: 'live', authority: 'host', reason: 'host_live' })
    expect(summary.incarnationId).toBe(f.host.sessions.get(id)?.info.incarnationId)
  })

  it('reports a host exit truthfully', async () => {
    const f = await withRepo()
    const id = await seedPersisted(f, { state: 'live' })
    f.host.sessions.get(id)!.info.status = 'exited'
    f.host.sessions.get(id)!.info.exitCode = 0
    const view = await f.service.reconcile()
    expect(view.sessions.find((session) => session.id === id)).toMatchObject({
      state: 'exited',
      authority: 'host',
      exitCode: 0,
      reason: 'host_exited'
    })
  })

  it('marks an active session missing from the host unavailable', async () => {
    const f = await withRepo()
    const id = await seedPersisted(f, { state: 'live' })
    f.host.remove(id)
    const view = await f.service.reconcile()
    const summary = view.sessions.find((session) => session.id === id)!
    expect(summary).toMatchObject({
      state: 'unavailable',
      authority: 'host',
      reason: 'session_not_known',
      incarnationId: null
    })
    expect(summary.error?.code).toBe('SESSION_NOT_FOUND')
    expect(f.stores.sessions.findById(id as never)?.observation.lastObservedState).toBe(
      'unavailable'
    )
  })

  it('does not convert a host query failure into a process exit', async () => {
    const f = await withRepo()
    const id = await seedPersisted(f, { state: 'live' })
    f.host.reachable = false
    const view = await f.service.reconcile()
    const summary = view.sessions.find((session) => session.id === id)!
    expect(summary).toMatchObject({
      state: 'unavailable',
      authority: 'unreachable',
      reason: 'host_unreachable'
    })
    expect(summary.state).not.toBe('exited')
    expect(summary.exitCode).not.toBe(0)
    expect(summary.error?.code).toBe('HOST_UNREACHABLE')
    expect(f.service.getLastHostError()?.code).toBe('HOST_UNREACHABLE')
  })

  it('reports a requested stop as exited, not failed, when reconciling', async () => {
    const f = await withRepo()
    const created = await f.service.create(createInput(f))
    await f.service.stop(created.id)
    const view = await f.service.reconcile()
    expect(view.sessions.find((session) => session.id === created.id)).toMatchObject({
      state: 'exited',
      reason: 'host_exited',
      exitCode: 129
    })
  })

  it('still reports an unrequested nonzero exit as failed', async () => {
    const f = await withRepo()
    const created = await f.service.create(createInput(f))
    f.host.finish(created.id, 2)
    const view = await f.service.reconcile()
    expect(view.sessions.find((session) => session.id === created.id)).toMatchObject({
      state: 'failed',
      reason: 'host_failed',
      exitCode: 2
    })
  })

  it('keeps historical terminal state during host loss', async () => {
    const f = await withRepo()
    const id = await seedPersisted(f, { state: 'exited' })
    f.host.reachable = false
    const view = await f.service.reconcile()
    expect(view.sessions.find((session) => session.id === id)).toMatchObject({
      state: 'exited',
      authority: 'persisted',
      reason: 'host_unreachable_history'
    })
  })

  it('surfaces a live host PTY with no durable row as an orphan', async () => {
    const f = await withRepo()
    f.host.seedSession('ses_orphaned-by-hand', { status: 'live' })
    const view = await f.service.reconcile()
    expect(view.orphans).toEqual([
      expect.objectContaining({
        sessionId: 'ses_orphaned-by-hand',
        status: 'live'
      })
    ])
    // Orphans are not adopted into ADE metadata.
    expect(f.stores.sessions.listAll()).toHaveLength(0)
  })

  it('filters by repository and returns a stable view', async () => {
    const f = await withRepo()
    const created = await f.service.create(createInput(f))
    const view = await f.service.list(f.repoId)
    expect(view.sessions.map((session) => session.id)).toEqual([created.id])
    expect(view.orphans).toEqual([])
    await expect(f.service.list(newRepoId())).resolves.toEqual({ sessions: [], orphans: [] })
  })
})

describe('session service errors', () => {
  it('wraps invalid session IDs', async () => {
    const f = await withRepo()
    const error = await f.service.get('not-an-id').catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(SessionServiceError)
    expect((error as SessionServiceError).appError.code).toBe('INVALID_ARGUMENT')
  })
})


describe('worktree isolation', () => {
  it('gives every session its own checkout and starts the PTY there', async () => {
    const f = await withRepo()
    const first = await f.service.create(createInput(f))
    const second = await f.service.create(createInput(f, { title: 'second' }))

    expect(first.worktree).not.toBeNull()
    expect(second.worktree).not.toBeNull()
    expect(first.worktree!.path).not.toBe(second.worktree!.path)
    expect(first.worktree!.branch).not.toBe(second.worktree!.branch)
    expect(first.worktree!.status).toBe('active')
    expect(f.host.sessions.get(first.id)!.info.cwd).toBe(first.worktree!.path)
    expect(f.host.sessions.get(second.id)!.info.cwd).toBe(second.worktree!.path)

    const registered = await f.gitWorktrees.listWorktrees(f.repoPath)
    const paths = registered.map((entry) => entry.path)
    expect(paths).toEqual(
      expect.arrayContaining([first.worktree!.path, second.worktree!.path])
    )
  })

  it('refuses a repository without a baseline commit', async () => {
    const f = await withRepo()
    const emptyPath = join(f.root.dir, 'empty')
    mkdirSync(emptyPath, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main', emptyPath], { stdio: 'pipe' })
    const added = await f.stores.service.addRepository(emptyPath)

    await expect(
      f.service.create({ ...createInput(f), repoId: added.repository.id })
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof SessionServiceError && error.appError.code === 'UNBORN_REPOSITORY'
    )
    expect(f.stores.sessions.listForRepo(added.repository.id)).toHaveLength(0)
  })

  it('restarts in the same worktree with a new incarnation', async () => {
    const f = await withRepo()
    const created = await f.service.create(createInput(f))
    const restarted = await f.service.restart(created.id)

    expect(restarted.worktree!.path).toBe(created.worktree!.path)
    expect(restarted.worktree!.branch).toBe(created.worktree!.branch)
    expect(restarted.incarnationId).not.toBe(created.incarnationId)
    expect(f.host.sessions.get(created.id)!.info.cwd).toBe(created.worktree!.path)
  })

  it('keeps a legacy session in the primary checkout, including restart', async () => {
    const f = await withRepo()
    const workspace = f.stores.repositories.workspaceForRepo(f.repoId as never)!
    const legacyId = newSessionId()
    f.stores.sessions.insert({
      id: legacyId,
      workspaceId: workspace.id,
      harness: 'shell',
      title: 'legacy session',
      createdAt: 1_600_000_000_000,
      lastActiveAt: 1_600_000_000_000,
      observation: {
        lastObservedState: 'exited',
        lastObservedExitCode: 0,
        lastObservedError: null,
        lastObservedIncarnationId: null,
        lastObservedAt: 1_600_000_000_000
      }
    })

    const summary = await f.service.get(legacyId)
    expect(summary.worktree).toBeNull()

    const restarted = await f.service.restart(legacyId)
    expect(restarted.worktree).toBeNull()
    expect(f.host.sessions.get(legacyId)!.info.cwd).toBe(f.repoPath)
    expect(f.worktrees.findBySession(legacyId)).toBeNull()
  })

  it('reports a missing worktree and never falls back to the primary checkout', async () => {
    const f = await withRepo()
    const created = await f.service.create(createInput(f))
    rmTree(created.worktree!.path, { recursive: true, force: true })

    await expect(f.service.attach(created.id)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof SessionServiceError && error.appError.code === 'WORKTREE_MISSING'
    )
    expect(f.host.calls.createOrAttach).toHaveLength(1)

    const listed = await f.service.list(f.repoId)
    expect(listed.sessions[0]!.worktree!.status).toBe('missing')

    await expect(f.service.restart(created.id)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof SessionServiceError && error.appError.code === 'WORKTREE_MISSING'
    )
    expect(f.host.sessions.get(created.id)!.info.status).toBe('live')
  })
})
