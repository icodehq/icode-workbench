import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionService, SessionServiceError } from './session-service'
import { FakeHostGateway } from './fake-host-gateway'
import { makeRepositoryService, makeTempRoot, openTempDatabase } from '../persistence/persistence-test-fixtures'
import { resolveRepositoryRoot } from '../repositories/repository-path'
import { buildWslTerminalArgs } from '../wsl/terminal/path-a'
import { makeAppError } from '../../shared/domain/errors'
import { WorktreeStore } from '../persistence/worktree-store'
import { GitWorktreeService } from '../worktrees/git-worktree-service'
import { samePathResolved } from '../worktrees/worktree-status'
import { rmSync as rmTree, writeFileSync } from 'node:fs'
import { newSessionId } from '../../shared/domain/ids'
import type { TempRoot } from '../persistence/persistence-test-fixtures'
import type { Database } from '../persistence/database'
import type { HarnessDetectionResult } from '../harness/harness-detector'
import { newRepoId } from '../../shared/domain/ids'
import { toPtyIncarnationId } from '../../shared/domain/ids'
import type { RendererSessionEvent } from '../../shared/schemas/ipc'
import type { WorkspaceTrustService } from '../harness/trust/workspace-trust'

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
  detection: { current: HarnessDetectionResult; targets: unknown[] }
  pathA: { requested: string[]; fail: null | { code: 'NOT_A_DIRECTORY'; message: string } }
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

function setup(options: {
  harness?: HarnessDetectionResult
  workspaceTrust?: WorkspaceTrustService
} = {}): Fixture {
  const root = makeTempRoot('icode-session-')
  const db = openTempDatabase(root)
  const stores = makeRepositoryService(db, {
    // A WSL target needs a guest resolver. These tests assert routing, so the
    // stub answers with the local canonical path; guest path semantics are
    // covered by the W6 suites and the real-guest runs.
    resolveRoot: async (path) => resolveRepositoryRoot(path)
  })
  const host = new FakeHostGateway()
  const detection = {
    current: options.harness ?? available('/usr/bin/claude'),
    /** Every target discovery was asked for, in order. */
    targets: [] as unknown[]
  }
  const worktrees = new WorktreeStore(db)
  const gitWorktrees = new GitWorktreeService({ worktreeRoot: join(root.dir, 'worktrees') })
  const pathA = {
    /** Every guest cwd Path A was asked to enter. */
    requested: [] as string[],
    fail: null as null | { code: 'NOT_A_DIRECTORY'; message: string }
  }
  const service = new SessionService({
    database: db,
    repositories: stores.repositories,
    sessions: stores.sessions,
    worktrees,
    gitWorktrees,
    host,
    ...(options.workspaceTrust === undefined ? {} : { workspaceTrust: options.workspaceTrust }),
    detectHarness: async (_harness, target) => {
      detection.targets.push(target)
      return detection.current
    },
    launchArgs: (harness, target) => {
      if (harness !== 'claude') return []
      return target.kind === 'wsl'
        ? ['--settings', '/mnt/d/profile/agent-hooks/settings.json']
        : ['--settings', 'D:\\profile\\agent-hooks\\settings.json']
    },
    resolveWslTerminal: async (_target, guestCwd) => {
      pathA.requested.push(guestCwd)
      if (pathA.fail) {
        return {
          status: 'failed' as const,
          failure: { code: pathA.fail.code, error: makeAppError(pathA.fail.code, pathA.fail.message) }
        }
      }
      return {
        status: 'ready' as const,
        launch: {
          command: '/mnt/c/Windows/System32/wsl.exe',
          args: buildWslTerminalArgs('Ubuntu-26.04', guestCwd),
          ptyCwd: join(root.dir, 'pty'),
          guestCwd,
          distro: 'Ubuntu-26.04'
        }
      }
    },
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
    ['-C', repoPath, '-c', 'user.email=icode@test', '-c', 'user.name=iCode', 'commit', '-qm', 'init'],
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
    detection,
    pathA
  }
}

async function withRepo(options: {
  workspaceTrust?: WorkspaceTrustService
} = {}): Promise<Fixture> {
  const fixture = setup(options)
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
    expect(f.host.calls.kill).toEqual([{ sessionId: a.id, host: 'local' }])
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
    expect(f.host.calls.kill).toEqual([{ sessionId: created.id, host: 'local' }])
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
    // Rewrite the durable observation to model a prior iCode run.
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
    // Orphans are not adopted into iCode metadata.
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
    expect(samePathResolved(f.host.sessions.get(first.id)!.info.cwd, first.worktree!.path)).toBe(true)
    expect(samePathResolved(f.host.sessions.get(second.id)!.info.cwd, second.worktree!.path)).toBe(true)

    const registered = await f.gitWorktrees.listWorktrees(f.repoPath)
    const paths = registered.map((entry) => entry.path)
    expect(paths.some((candidate) => samePathResolved(candidate, first.worktree!.path))).toBe(true)
    expect(paths.some((candidate) => samePathResolved(candidate, second.worktree!.path))).toBe(true)
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

    expect(samePathResolved(restarted.worktree!.path, created.worktree!.path)).toBe(true)
    expect(restarted.worktree!.branch).toBe(created.worktree!.branch)
    expect(restarted.incarnationId).not.toBe(created.incarnationId)
    expect(samePathResolved(f.host.sessions.get(created.id)!.info.cwd, created.worktree!.path)).toBe(true)
  })

  it('sleeps durably and wakes with the harness resume command', async () => {
    const f = await withRepo()
    const created = await f.service.create(createInput(f))
    f.stores.sessions.setResumeToken(created.id as never, 'claude-conversation-1')

    const slept = await f.service.sleep(created.id)
    expect(slept.sleeping).toBe(true)
    expect(slept.state).toBe('exited')
    expect(f.stores.sessions.findById(created.id as never)!.sleepingAt).not.toBeNull()

    const woken = await f.service.wake(created.id)
    expect(woken.sleeping).toBe(false)
    expect(woken.state).toBe('live')
    expect(woken.incarnationId).not.toBe(created.incarnationId)
    expect(f.stores.sessions.findById(created.id as never)!.sleepingAt).toBeNull()

    const args = f.host.calls.createOrAttach.at(-1)!.args
    expect(args).toContain('--resume')
    expect(args).toContain('claude-conversation-1')
    expect(args).toContain('--settings')
  })

  it.each([
    ['codex', ['resume', '--last']],
    ['opencode', ['--continue']],
    ['shell', []]
  ] as const)('wakes %s with its harness-native resume strategy', async (harness, resumeArgs) => {
    const f = await withRepo()
    const created = await f.service.create(createInput(f, { harness }))
    await f.service.sleep(created.id)
    const woken = await f.service.wake(created.id)
    expect(woken.state).toBe('live')
    const args = f.host.calls.createOrAttach.at(-1)!.args
    const argv = Array.isArray(args) ? args : [args]
    if (resumeArgs.length === 0) {
      expect(argv.some((arg) => arg === '--continue' || arg === 'resume')).toBe(false)
    } else {
      expect(argv.slice(-resumeArgs.length)).toEqual([...resumeArgs])
    }
  })

  it('does not sleep a session that is not live', async () => {
    const f = await withRepo()
    const created = await f.service.create(createInput(f))
    f.host.finish(created.id, 0, true)

    await expect(f.service.sleep(created.id)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof SessionServiceError && error.appError.code === 'INVALID_ARGUMENT'
    )
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
    expect(samePathResolved(f.host.sessions.get(legacyId)!.info.cwd, f.repoPath)).toBe(true)
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

/**
 * W7: the persisted repository target decides where a session is discovered and
 * launched. A WSL session must never be served by the local host, and a WSL
 * failure must not fall back to it.
 */
describe('execution-target routing', () => {
  it('asks discovery for the local target on a local repository', async () => {
    const f = await withRepo()
    await f.service.create({ repoId: f.repoId, harness: 'claude', cols: 80, rows: 24 })
    expect(f.detection.targets).toEqual([{ kind: 'local' }])
  })

  it('passes the WSL target to discovery and to the host, never local', async () => {
    const f = await withRepo()
    const target = {
      kind: 'wsl' as const,
      distro: 'Ubuntu-26.04',
      distroId: 'a5489bf0-2b9e-49bf-940e-0c19a6caef73'
    }
    // Register a second repository row for the same path on the WSL target.
    const added = await f.stores.service.addRepository(f.repoPath, target)
    await f.service.create({ repoId: added.repository.id, harness: 'claude', cols: 100, rows: 30 })

    expect(f.detection.targets).toContainEqual(target)
    // The host call carried the same target: one PTY, on the distro's Host.
    expect(f.host.calls.createOrAttach).toHaveLength(1)
  })

  it('reports a WSL host failure instead of retrying locally', async () => {
    const f = await withRepo()
    const target = {
      kind: 'wsl' as const,
      distro: 'Ubuntu-26.04',
      distroId: 'a5489bf0-2b9e-49bf-940e-0c19a6caef73'
    }
    const added = await f.stores.service.addRepository(f.repoPath, target)
    f.host.reachable = false
    const error = await f.service
      .create({ repoId: added.repository.id, harness: 'claude', cols: 80, rows: 24 })
      .catch((value: unknown) => value)
    // The failure is classified, and it is the host's: no local retry happened.
    expect((error as { appError?: { code: string } }).appError?.code).toBe('HOST_UNREACHABLE')
    expect(f.host.calls.createOrAttach).toHaveLength(0)
    expect(f.host.reachable).toBe(false)
  })

  it('surfaces a missing guest harness as unavailable, without a command', async () => {
    const f = await withRepo()
    f.detection.current = unusable('unavailable')
    const error = await f.service
      .create({ repoId: f.repoId, harness: 'claude', cols: 80, rows: 24 })
      .catch((value: unknown) => value)
    expect((error as { appError?: { code: string } }).appError?.code).toBe('HARNESS_UNAVAILABLE')
    expect(f.host.calls.createOrAttach).toHaveLength(0)
  })
})

/**
 * A host that is down must only blank the sessions it owns. Before W7 there was
 * one host, so all-or-nothing was right; with a distro in the mix it is not.
 */
describe('per-host reconciliation', () => {
  it('keeps a WSL session live when only the local host is down', async () => {
    const f = await withRepo()
    const target = {
      kind: 'wsl' as const,
      distro: 'Ubuntu-26.04',
      distroId: 'a5489bf0-2b9e-49bf-940e-0c19a6caef73'
    }
    const added = await f.stores.service.addRepository(f.repoPath, target)
    const created = await f.service.create({
      repoId: added.repository.id,
      harness: 'claude',
      cols: 80,
      rows: 24
    })
    // Only the local host goes down: the WSL row must keep its own verdict.
    f.host.failForTarget = 'local'
    const view = await f.service.reconcile()
    const summary = view.sessions.find((session) => session.id === created.id)
    expect(summary?.state).toBe('live')
  })

  it('marks a session unknown when its own host is the one that failed', async () => {
    const f = await withRepo()
    const target = {
      kind: 'wsl' as const,
      distro: 'Ubuntu-26.04',
      distroId: 'a5489bf0-2b9e-49bf-940e-0c19a6caef73'
    }
    const added = await f.stores.service.addRepository(f.repoPath, target)
    const created = await f.service.create({
      repoId: added.repository.id,
      harness: 'claude',
      cols: 80,
      rows: 24
    })
    f.host.failForTarget = 'wsl'
    const view = await f.service.reconcile()
    const summary = view.sessions.find((session) => session.id === created.id)
    expect(summary?.state).toBe('unavailable')
  })
})

/**
 * W8: three routes must stay distinct.
 *
 *   local repo + shell      → the local terminal, unchanged
 *   WSL repo + shell        → **Path A**: desktop Host spawns `wsl.exe`
 *   WSL repo + agent        → **Path B**: managed Guest Host via the W7 route
 */
describe('Path A terminal routing', () => {
  const WSL_TARGET = {
    kind: 'wsl' as const,
    distro: 'Ubuntu-26.04',
    distroId: 'a5489bf0-2b9e-49bf-940e-0c19a6caef73'
  }

  async function wslRepo(f: Fixture) {
    const added = await f.stores.service.addRepository(f.repoPath, WSL_TARGET)
    return added.repository.id
  }

  it('launches a WSL shell on the desktop host with wsl.exe', async () => {
    const f = await withRepo()
    const repoId = await wslRepo(f)
    const created = await f.service.create({ repoId, harness: 'shell', cols: 100, rows: 30 })

    const call = f.host.calls.createOrAttach.at(-1)!
    // The desktop Host, not the distro's managed Host.
    expect(call.host).toBe('local')
    expect(call.command).toContain('wsl.exe')
    expect(call.args.slice(0, 4)).toEqual(['-d', 'Ubuntu-26.04', '--exec', 'sh'])
    // The guest worktree is the directory the shell enters.
    expect(call.args.at(-1)).toBe(created.worktree?.path)
    // A ConPTY cannot start in a Linux path.
    expect(call.cwd).toBe(join(f.root.dir, 'pty'))
  })

  it('does not report a newly created WSL worktree as missing', async () => {
    /*
     * Regression: create() returned a summary without an existence probe, so
     * describeWorktree stat'ed the guest path on Windows and the New Session
     * overlay said the worktree was missing while the session was live.
     */
    const f = await withRepo()
    const added = await f.stores.service.addRepository(f.repoPath, WSL_TARGET)
    const guestPath = '/home/u/.icode/worktrees/scope/repo/ses'
    vi.spyOn(f.gitWorktrees, 'worktreeRootFor').mockResolvedValue('/home/u/.icode/worktrees/scope')
    vi.spyOn(f.gitWorktrees, 'worktreePathFor').mockReturnValue(guestPath)
    vi.spyOn(f.gitWorktrees, 'create').mockResolvedValue(undefined)

    const created = await f.service.create({
      repoId: added.repository.id,
      harness: 'shell',
      cols: 80,
      rows: 24
    })

    expect(created.worktree).toMatchObject({ path: guestPath, status: 'active' })
  })

  it('prepares harness trust for the worktree before spawning', async () => {
    const prepare = vi.fn(async () => ({ status: 'trusted' as const }))
    const f = await withRepo({
      workspaceTrust: { prepare, remove: vi.fn(async () => undefined) }
    })
    const added = await f.stores.service.addRepository(f.repoPath, WSL_TARGET)
    const created = await f.service.create({
      repoId: added.repository.id,
      harness: 'claude',
      cols: 80,
      rows: 24
    })

    expect(prepare).toHaveBeenCalledWith({
      harness: 'claude',
      target: WSL_TARGET,
      worktreePath: created.worktree?.path
    })
  })

  it('never probes a harness for a Path A terminal', async () => {
    const f = await withRepo()
    const repoId = await wslRepo(f)
    await f.service.create({ repoId, harness: 'shell', cols: 80, rows: 24 })
    // The distro's login shell is the terminal's shell, so discovery is skipped.
    expect(f.detection.targets).toEqual([])
  })

  it('keeps a WSL coding Agent on the managed host (Path B)', async () => {
    const f = await withRepo()
    const repoId = await wslRepo(f)
    await f.service.create({ repoId, harness: 'claude', cols: 80, rows: 24 })
    const call = f.host.calls.createOrAttach.at(-1)!
    expect(call.host).toContain('wsl:Ubuntu-26.04')
    expect(call.command).not.toContain('wsl.exe')
    // Path B detected inside the distro, as W7 wired it.
    expect(f.detection.targets).toEqual([WSL_TARGET])
  })

  it('keeps a local shell session exactly as before', async () => {
    const f = await withRepo()
    const created = await f.service.create({ repoId: f.repoId, harness: 'shell', cols: 80, rows: 24 })
    const call = f.host.calls.createOrAttach.at(-1)!
    expect(call.host).toBe('local')
    expect(call.command).not.toContain('wsl.exe')
    // The local terminal still starts in the checkout itself.
    expect(call.cwd).toBe(created.worktree?.path)
  })

  it('presents the machine-local cwd when attaching to a Path A terminal', async () => {
    const f = await withRepo()
    const repoId = await wslRepo(f)
    const created = await f.service.create({ repoId, harness: 'shell', cols: 80, rows: 24 })
    const attached = await f.service.attach(created.id)
    expect(attached.incarnationId).toBeTruthy()
    const call = f.host.calls.createOrAttach.at(-1)!
    expect(call.attachOnly).toBe(true)
    expect(call.cwd).toBe(join(f.root.dir, 'pty'))
    expect(call.host).toBe('local')
  })

  it('refuses a Path A terminal when the guest directory is invalid', async () => {
    const f = await withRepo()
    const repoId = await wslRepo(f)
    f.pathA.fail = { code: 'NOT_A_DIRECTORY', message: 'That folder is not available.' }
    const error = await f.service
      .create({ repoId, harness: 'shell', cols: 80, rows: 24 })
      .catch((value: unknown) => value)
    expect((error as { appError?: { code: string } }).appError?.code).toBe('NOT_A_DIRECTORY')
    // No PTY was started, and nothing fell back to a local shell.
    expect(f.host.calls.createOrAttach).toHaveLength(0)
  })

  it('does not leave a worktree behind when Path A validation fails first', async () => {
    const f = await withRepo()
    const repoId = await wslRepo(f)
    f.pathA.fail = { code: 'NOT_A_DIRECTORY', message: 'That folder is not available.' }
    await f.service.create({ repoId, harness: 'shell', cols: 80, rows: 24 }).catch(() => {})
    // The pre-flight happens before any Git work, so no checkout exists.
    expect(f.worktrees.listAll()).toHaveLength(0)
  })
})

describe('Path A lifecycle is judged by the desktop host', () => {
  const WSL_TARGET = {
    kind: 'wsl' as const,
    distro: 'Ubuntu-26.04',
    distroId: 'a5489bf0-2b9e-49bf-940e-0c19a6caef73'
  }

  it('keeps a Path A terminal live after reconcile, not "unavailable"', async () => {
    const f = await withRepo()
    const added = await f.stores.service.addRepository(f.repoPath, WSL_TARGET)
    const created = await f.service.create({
      repoId: added.repository.id,
      harness: 'shell',
      cols: 80,
      rows: 24
    })
    // The terminal lives on the desktop host; the distro's host never saw it.
    const view = await f.service.list()
    const summary = view.sessions.find((session) => session.id === created.id)
    expect(summary?.state).toBe('live')
  })

  it('stops and resizes a Path A terminal on the desktop host', async () => {
    const f = await withRepo()
    const added = await f.stores.service.addRepository(f.repoPath, WSL_TARGET)
    const created = await f.service.create({
      repoId: added.repository.id,
      harness: 'shell',
      cols: 80,
      rows: 24
    })
    await f.service.resize(created.id, created.incarnationId!, 120, 40)
    await f.service.stop(created.id)
    // Both calls reached the desktop host, proven by the fake recording them.
    expect(f.host.calls.resize.at(-1)?.host).toBe('local')
    expect(f.host.calls.kill.at(-1)?.host).toBe('local')
  })
})

describe('Path A restart', () => {
  it('restarts the shell on the desktop host with the WSL argv', async () => {
    const f = await withRepo()
    const added = await f.stores.service.addRepository(f.repoPath, {
      kind: 'wsl',
      distro: 'Ubuntu-26.04',
      distroId: 'a5489bf0-2b9e-49bf-940e-0c19a6caef73'
    })
    const created = await f.service.create({
      repoId: added.repository.id,
      harness: 'shell',
      cols: 80,
      rows: 24
    })
    await f.service.restart(created.id)
    const call = f.host.calls.createOrAttach.at(-1)!
    expect(call.host).toBe('local')
    expect(call.command).toContain('wsl.exe')
    expect(call.cwd).toBe(join(f.root.dir, 'pty'))
    // The guest worktree, not a Windows path.
    expect(call.args.at(-1)).toBe(created.worktree?.path)
  })
})

/**
 * Work 71: a guest Agent is launched through a login shell, so extra arguments
 * must go inside its exec script. Measured before the fix: the shell consumed
 * `--settings <path>` as `$0`/`$1` and Claude Code received neither.
 */
describe('launch argument delivery', () => {
  const WSL_TARGET = {
    kind: 'wsl' as const,
    distro: 'Ubuntu-26.04',
    distroId: 'a5489bf0-2b9e-49bf-940e-0c19a6caef73'
  }
  const SHELL_COMMAND = {
    harness: 'claude' as const,
    state: 'available' as const,
    version: '2.1.310',
    resolvedPath: '/home/u/.nvm/versions/node/v24.15.0/bin/claude',
    command: {
      command: '/bin/bash',
      args: ['-ilc', "exec '/home/u/.nvm/versions/node/v24.15.0/bin/claude'"],
      shellWrapper: { scriptIndex: 1 }
    },
    diagnostics: {
      resolvedPath: '/home/u/.nvm/versions/node/v24.15.0/bin/claude',
      outcome: 'exited' as const,
      exitCode: 0,
      signal: null,
      stdoutTail: '',
      stderrTail: '',
      durationMs: 1,
      observedAt: 1,
      attempts: 1
    }
  }

  it('gives the guest Claude its settings as real arguments inside the script', async () => {
    const f = await withRepo()
    f.detection.current = SHELL_COMMAND
    const added = await f.stores.service.addRepository(f.repoPath, WSL_TARGET)
    await f.service.create({ repoId: added.repository.id, harness: 'claude', cols: 80, rows: 24 })

    const call = f.host.calls.createOrAttach.at(-1)!
    expect(call.command).toBe('/bin/bash')
    // Still a shell invocation: options plus one script, nothing after it.
    expect(call.args).toHaveLength(2)
    expect(call.args[0]).toBe('-ilc')
    // `exec` carries the harness and its settings, so the shell cannot eat them.
    expect(call.args[1]).toBe(
      "exec '/home/u/.nvm/versions/node/v24.15.0/bin/claude' '--settings' '/mnt/d/profile/agent-hooks/settings.json'"
    )
    expect(call.args).not.toContain('--settings')
  })

  it('keeps a local Claude launch appending to argv', async () => {
    const f = await withRepo()
    f.detection.current = {
      ...SHELL_COMMAND,
      command: { command: '/usr/local/bin/claude', args: [] }
    }
    await f.service.create({ repoId: f.repoId, harness: 'claude', cols: 80, rows: 24 })
    const call = f.host.calls.createOrAttach.at(-1)!
    expect(call.command).toBe('/usr/local/bin/claude')
    expect(call.args).toEqual(['--settings', 'D:\\profile\\agent-hooks\\settings.json'])
  })

  it('leaves a WSL shell terminal (Path A) with no Claude arguments at all', async () => {
    const f = await withRepo()
    const added = await f.stores.service.addRepository(f.repoPath, WSL_TARGET)
    const created = await f.service.create({
      repoId: added.repository.id,
      harness: 'shell',
      cols: 80,
      rows: 24
    })
    const call = f.host.calls.createOrAttach.at(-1)!
    expect(call.host).toBe('local')
    expect(call.args).not.toContain('--settings')
    expect(call.args.at(-1)).toBe(created.worktree?.path)
  })
})
