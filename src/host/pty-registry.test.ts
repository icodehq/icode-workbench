import { afterEach, describe, expect, it } from 'vitest'
import { PtyRegistry, RegistryError, type PtySpawnConfig } from './pty-registry'
import { createFakePtyFactory, FakePty } from './fake-pty'

type Recorded = {
  data: Array<{ sessionId: string; incarnationId: string; seq: number; data: string }>
  spawned: Array<{ sessionId: string; incarnationId: string; ptyPid: number }>
  exit: Array<{ sessionId: string; incarnationId: string; exitCode: number }>
}

function setup(options: { maxSessions?: number } = {}): {
  registry: PtyRegistry
  fake: ReturnType<typeof createFakePtyFactory>
  events: Recorded
} {
  const fake = createFakePtyFactory()
  const events: Recorded = { data: [], spawned: [], exit: [] }
  const registry = new PtyRegistry({
    ptyFactory: fake.factory,
    events: {
      onData: (event) => events.data.push(event),
      onSpawned: (event) => events.spawned.push(event),
      onExit: (event) => events.exit.push(event)
    },
    now: (() => {
      let tick = 1000
      return () => tick++
    })(),
    env: { PATH: '/usr/bin', HOME: '/home/dev', ELECTRON_RUN_AS_NODE: '1' },
    ...(options.maxSessions !== undefined ? { maxSessions: options.maxSessions } : {})
  })
  return { registry, fake, events }
}

const CWD = process.cwd()

function params(overrides: Partial<PtySpawnConfig> & { sessionId?: string } = {}) {
  return {
    sessionId: overrides.sessionId ?? `ses_${Math.random().toString(16).slice(2).padStart(12, '0')}`,
    cwd: overrides.cwd ?? CWD,
    command: overrides.command ?? '/bin/bash',
    cols: overrides.cols ?? 100,
    rows: overrides.rows ?? 30,
    ...(overrides.args ? { args: overrides.args } : {})
  }
}

afterEach(() => {
  FakePty.reset()
})

describe('session creation', () => {
  it('spawns a PTY with the requested command, cwd, dimensions, and env', async () => {
    const { registry, fake } = setup()
    const request = params({ sessionId: 'ses_aaaaaaaaaaaa', command: '/bin/zsh', cols: 120, rows: 40 })
    const result = registry.createOrAttach(request)

    expect(result.created).toBe(true)
    expect(result.info).toMatchObject({
      sessionId: 'ses_aaaaaaaaaaaa',
      ptyPid: fake.instances[0]!.pid,
      status: 'live',
      cwd: CWD,
      command: '/bin/zsh',
      cols: 120,
      rows: 40,
      exitCode: null
    })
    expect(result.info.incarnationId).toMatch(/^[0-9a-f]{16}$/)
    expect(result.info.incarnationId).not.toBe(result.info.sessionId)

    const config = fake.instances[0]!.config
    expect(config.cwd).toBe(CWD)
    expect(config.cols).toBe(120)
    expect(config.rows).toBe(40)
    expect(config.env.TERM).toBe('xterm-256color')
    expect(config.env.ICODE_SESSION_ID).toBe('ses_aaaaaaaaaaaa')
    expect(config.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    await expect(registry.snapshot(request.sessionId)).resolves.toMatchObject({
      cols: 120,
      rows: 40,
      seq: 0
    })
  })

  it('is idempotent for a live session and never spawns a duplicate', () => {
    const { registry, fake } = setup()
    const request = params({ sessionId: 'ses_duplicate01' })
    const first = registry.createOrAttach(request)
    const second = registry.createOrAttach(request)
    expect(second.created).toBe(false)
    expect(second.info.incarnationId).toBe(first.info.incarnationId)
    expect(fake.instances).toHaveLength(1)
  })

  it('serialises concurrent duplicate requests onto one PTY', async () => {
    const { registry, fake } = setup()
    const request = params({ sessionId: 'ses_concurrent' })
    const results = await Promise.all([
      Promise.resolve().then(() => registry.createOrAttach(request)),
      Promise.resolve().then(() => registry.createOrAttach(request)),
      Promise.resolve().then(() => registry.createOrAttach(request))
    ])
    expect(results.filter((result) => result.created)).toHaveLength(1)
    expect(new Set(results.map((result) => result.info.incarnationId)).size).toBe(1)
    expect(fake.instances).toHaveLength(1)
  })

  it('rejects a missing working directory before spawning', () => {
    const { registry, fake } = setup()
    expect(() => registry.createOrAttach(params({ cwd: '/definitely/not/here' }))).toThrow(
      /Working directory/
    )
    expect(fake.instances).toHaveLength(0)
  })

  it('reports a spawn failure and leaves no phantom session', () => {
    const { registry, fake } = setup()
    fake.failNext(Object.assign(new Error('spawn /bin/nope ENOENT'), { code: 'ENOENT' }))
    let caught: unknown
    try {
      registry.createOrAttach(params({ sessionId: 'ses_failedspawn', command: '/bin/nope' }))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(RegistryError)
    expect((caught as RegistryError).code).toBe('SPAWN_FAILED')
    expect((caught as RegistryError).detail).toContain('ENOENT')
    expect(registry.list()).toHaveLength(0)
    expect(registry.liveCount()).toBe(0)

    // A retry after the failure can still create the session.
    fake.failNext(new Error('once'))
    expect(() => registry.createOrAttach(params({ sessionId: 'ses_afterfailure' }))).toThrow()
    expect(registry.list()).toHaveLength(0)
  })
})

describe('attach-only', () => {
  it('refuses an unknown session and spawns nothing', () => {
    const { registry, fake } = setup()
    expect(() => registry.createOrAttach({ ...params({ sessionId: 'ses_unknown001' }), attachOnly: true }))
      .toThrow(RegistryError)
    expect(fake.instances).toHaveLength(0)
  })

  it('attaches to a live session with its current snapshot', async () => {
    const { registry, fake } = setup()
    const request = params({ sessionId: 'ses_liveattach01' })
    const created = registry.createOrAttach(request)
    fake.instances[0]!.emitData('hello from pty')
    const attached = registry.createOrAttach({ ...request, attachOnly: true })
    expect(attached.created).toBe(false)
    expect(attached.info.incarnationId).toBe(created.info.incarnationId)
    await expect(registry.snapshot(request.sessionId)).resolves.toMatchObject({ seq: 1 })
    expect(fake.instances).toHaveLength(1)
  })

  it('attaches to an exited session and returns its final snapshot', async () => {
    const { registry, fake } = setup()
    const request = params({ sessionId: 'ses_exitedattach' })
    registry.createOrAttach(request)
    fake.instances[0]!.emitData('final output')
    fake.instances[0]!.emitExit({ exitCode: 0 })

    const attached = registry.createOrAttach({ ...request, attachOnly: true })
    expect(attached.created).toBe(false)
    expect(attached.info.status).toBe('exited')
    const snapshot = await registry.snapshot(request.sessionId)
    expect(snapshot.data).toContain('final output')
    expect(fake.instances).toHaveLength(1)
  })
})

describe('restart and incarnation rotation', () => {
  it('rotates the incarnation when restarting an exited session', async () => {
    const { registry, fake } = setup()
    const request = params({ sessionId: 'ses_restart01' })
    const first = registry.createOrAttach(request)
    fake.instances[0]!.emitData('old screen')
    fake.instances[0]!.emitExit({ exitCode: 0 })

    const restarted = registry.createOrAttach(request)
    expect(restarted.created).toBe(true)
    expect(restarted.info.incarnationId).not.toBe(first.info.incarnationId)
    expect(restarted.info.status).toBe('live')
    expect(fake.instances).toHaveLength(2)
    const snapshot = await registry.snapshot(request.sessionId)
    expect(snapshot.seq).toBe(0)
    expect(snapshot.data).not.toContain('old screen')
  })

  it('preserves the previous final screen when a restart fails to spawn', async () => {
    const { registry, fake } = setup()
    const request = params({ sessionId: 'ses_failedrestart' })
    registry.createOrAttach(request)
    fake.instances[0]!.emitData('keep me')
    fake.instances[0]!.emitExit({ exitCode: 1 })
    fake.failNext(new Error('restart spawn failed'))

    expect(() => registry.createOrAttach(request)).toThrow(/could not be started/)
    const listed = registry.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]!.status).toBe('failed')
    registry.createOrAttach({ ...request, attachOnly: true })
    await expect(registry.snapshot(request.sessionId)).resolves.toMatchObject({
      data: expect.stringContaining('keep me')
    })
  })

  it('ignores late output from a replaced incarnation', async () => {
    const { registry, fake, events } = setup()
    const request = params({ sessionId: 'ses_staleoutput' })
    const first = registry.createOrAttach(request)
    const oldPty = fake.instances[0]!
    oldPty.emitData('old')
    oldPty.emitExit({ exitCode: 0 })
    const restarted = registry.createOrAttach(request)
    const dataBefore = events.data.length

    // The retired PTY object can still deliver a queued callback.
    oldPty.emitData('ghost')

    expect(events.data.length).toBe(dataBefore)
    const attached = registry.createOrAttach({ ...request, attachOnly: true })
    expect(attached.info.incarnationId).toBe(restarted.info.incarnationId)
    expect(attached.info.incarnationId).not.toBe(first.info.incarnationId)
    const snapshot = await registry.snapshot(request.sessionId)
    expect(snapshot.data).not.toContain('ghost')
  })
})

describe('input, resize, and stale incarnations', () => {
  it('writes to the addressed live incarnation', () => {
    const { registry, fake } = setup()
    const created = registry.createOrAttach(params({ sessionId: 'ses_write001' }))
    registry.write('ses_write001', created.info.incarnationId, 'ls\r')
    expect(fake.instances[0]!.writes).toEqual(['ls\r'])
  })

  it('rejects writes and resizes for a stale incarnation', () => {
    const { registry, fake } = setup()
    const created = registry.createOrAttach(params({ sessionId: 'ses_stalewrite' }))
    fake.instances[0]!.emitExit({ exitCode: 0 })
    const restarted = registry.createOrAttach(params({ sessionId: 'ses_stalewrite' }))
    expect(restarted.info.incarnationId).not.toBe(created.info.incarnationId)

    let caught: unknown
    try {
      registry.write('ses_stalewrite', created.info.incarnationId, 'boom')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(RegistryError)
    expect((caught as RegistryError).code).toBe('STALE_INCARNATION')

    expect(() =>
      registry.resize('ses_stalewrite', created.info.incarnationId, 80, 24)
    ).toThrow(/previous PTY incarnation/)
    expect(fake.instances.at(-1)!.resizes).toHaveLength(0)
  })

  it('rejects writes to an exited session and unknown sessions', () => {
    const { registry, fake } = setup()
    const created = registry.createOrAttach(params({ sessionId: 'ses_exitedwrite' }))
    fake.instances[0]!.emitExit({ exitCode: 0 })
    expect(() => registry.write('ses_exitedwrite', created.info.incarnationId, 'x')).toThrow(
      /not live/
    )
    expect(() => registry.write('ses_missing', created.info.incarnationId, 'x')).toThrow(
      /not known/
    )
  })

  it('resizes only the addressed session', () => {
    const { registry, fake } = setup()
    const a = registry.createOrAttach(params({ sessionId: 'ses_resize-a' }))
    const b = registry.createOrAttach(params({ sessionId: 'ses_resize-b' }))
    registry.resize('ses_resize-a', a.info.incarnationId, 132, 44)
    expect(fake.instances[0]!.resizes).toEqual([{ cols: 132, rows: 44 }])
    expect(fake.instances[1]!.resizes).toEqual([])
    expect(registry.list().find((entry) => entry.sessionId === 'ses_resize-b')).toMatchObject({
      cols: 100,
      rows: 30
    })
    void b
  })
})

describe('exit and kill isolation', () => {
  it('treats PTY exit as authoritative and records the code', () => {
    const { registry, fake, events } = setup()
    const created = registry.createOrAttach(params({ sessionId: 'ses_exitcode' }))
    fake.instances[0]!.emitExit({ exitCode: 3, signal: 9 })
    const info = registry.list()[0]!
    expect(info.status).toBe('failed')
    expect(info.exitCode).toBe(3)
    expect(events.exit).toEqual([
      {
        sessionId: 'ses_exitcode',
        incarnationId: created.info.incarnationId,
        exitCode: 3,
        signal: 9
      }
    ])
    expect(registry.liveCount()).toBe(0)
  })

  it('kills one session without touching another', () => {
    const { registry, fake } = setup()
    registry.createOrAttach(params({ sessionId: 'ses_kill-a' }))
    registry.createOrAttach(params({ sessionId: 'ses_kill-b' }))
    const [a, b] = fake.instances
    expect(registry.kill('ses_kill-a')).toBe(true)
    expect(a!.killed).toBe(true)
    expect(b!.killed).toBe(false)
    expect(registry.list().find((entry) => entry.sessionId === 'ses_kill-b')?.status).toBe('live')
  })

  it('keeps killing idempotent for an exited session', () => {
    const { registry, fake } = setup()
    registry.createOrAttach(params({ sessionId: 'ses_kill-exited' }))
    fake.instances[0]!.emitExit({ exitCode: 0 })
    expect(registry.kill('ses_kill-exited')).toBe(false)
  })
})

describe('output sequencing', () => {
  it('increments sequence per chunk and notifies listeners once', async () => {
    const { registry, fake, events } = setup()
    const created = registry.createOrAttach(params({ sessionId: 'ses_seq01' }))
    const pty = fake.instances[0]!
    pty.emitData('one')
    pty.emitData('two')
    pty.emitData('three')
    expect(events.data.map((event) => event.seq)).toEqual([1, 2, 3])
    expect(events.data.every((event) => event.incarnationId === created.info.incarnationId)).toBe(
      true
    )
    await expect(registry.snapshot('ses_seq01')).resolves.toMatchObject({ seq: 3 })
  })

  it('pauses the PTY when terminal ingestion falls behind and resumes on drain', async () => {
    const { registry, fake } = setup()
    registry.createOrAttach(params({ sessionId: 'ses_backpressure' }))
    const pty = fake.instances[0]!
    const chunk = 'x'.repeat(256 * 1024)
    for (let i = 0; i < 6; i += 1) pty.emitData(chunk)
    expect(pty.pauseCount).toBeGreaterThanOrEqual(1)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(pty.resumeCount).toBeGreaterThanOrEqual(1)
  })
})

describe('registry bounds', () => {
  it('evicts the oldest finished session when at capacity', () => {
    const { registry, fake } = setup({ maxSessions: 2 })
    registry.createOrAttach(params({ sessionId: 'ses_bound-1' }))
    registry.createOrAttach(params({ sessionId: 'ses_bound-2' }))
    fake.instances[1]!.emitExit({ exitCode: 0 })
    registry.createOrAttach(params({ sessionId: 'ses_bound-3' }))
    expect(registry.totalCount()).toBe(2)
    expect(registry.has('ses_bound-2')).toBe(false)
    expect(registry.has('ses_bound-3')).toBe(true)
  })

  it('rejects new sessions when every slot holds a live PTY', () => {
    const { registry } = setup({ maxSessions: 2 })
    registry.createOrAttach(params({ sessionId: 'ses_full-1' }))
    registry.createOrAttach(params({ sessionId: 'ses_full-2' }))
    expect(() => registry.createOrAttach(params({ sessionId: 'ses_full-3' }))).toThrow(
      /Session limit/
    )
  })

  it('reports live and total counts accurately', () => {
    const { registry, fake } = setup()
    registry.createOrAttach(params({ sessionId: 'ses_counts-1' }))
    registry.createOrAttach(params({ sessionId: 'ses_counts-2' }))
    fake.instances[0]!.emitExit({ exitCode: 0 })
    expect(registry.liveCount()).toBe(1)
    expect(registry.totalCount()).toBe(2)
  })
})
