import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  encodeWatchMessage,
  parseParentMessage,
  type SerializedWatchSpec,
  type WatcherToParentMessage
} from '../../shared/watch-protocol'
import type {
  WatchEvent,
  WatchSubscriptionHandlers
} from './watch-client'
import { WatcherSupervisor } from './watcher-supervisor'

class FakeChild extends EventEmitter {
  readonly pid = 4242
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killed = false
  ignoreNextSub = false
  failNextSub = false
  private inbound = ''
  private exited = false

  constructor() {
    super()
    this.stdin.on('end', () => this.exit(0))
    this.stdin.on('data', (chunk: Buffer | string) => {
      this.inbound += String(chunk)
      for (;;) {
        const newline = this.inbound.indexOf('\n')
        if (newline === -1) return
        const line = this.inbound.slice(0, newline)
        this.inbound = this.inbound.slice(newline + 1)
        this.respond(line)
      }
    })
    queueMicrotask(() => this.send({ t: 'hello', v: 1, pid: this.pid, backend: 'chokidar' }))
  }

  send(message: WatcherToParentMessage): void {
    this.stdout.write(encodeWatchMessage(message))
  }

  exit(code: number | null): void {
    if (this.exited) return
    this.exited = true
    this.emit('exit', code, null)
  }

  kill(): boolean {
    this.killed = true
    this.exit(0)
    return true
  }

  private respond(line: string): void {
    const message = parseParentMessage(line)
    if (message === null) return
    switch (message.t) {
      case 'sub':
        if (this.ignoreNextSub) {
          this.ignoreNextSub = false
          return
        }
        if (this.failNextSub) {
          this.failNextSub = false
          this.send({ t: 'err', rid: message.rid, sub: message.sub, code: 'denied', msg: 'no' })
          return
        }
        this.send({ t: 'ok', rid: message.rid, backend: 'chokidar' })
        return
      case 'roots':
        this.send({ t: 'ok', rid: message.rid, bound: message.roots.length, missing: [] })
        return
      case 'unsub':
        this.send({ t: 'ok', rid: message.rid })
        return
      case 'ping':
        this.send({ t: 'pong', rid: message.rid })
        return
      case 'bye':
        this.exit(0)
        return
    }
  }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const spec: SerializedWatchSpec = {
  kind: 'recursive',
  id: 'files:ses_x',
  roots: ['/wt'],
  worktreePath: '/wt',
  ignore: { skipDirectories: ['node_modules'], skipSuffixes: ['.swp'], stagingMarker: null }
}

function harness(options: Partial<ConstructorParameters<typeof WatcherSupervisor>[0]> = {}) {
  const children: FakeChild[] = []
  const supervisor = new WatcherSupervisor({
    entryPath: '/fake/out/watch/index.js',
    logPath: null,
    helloTimeoutMs: 500,
    requestTimeoutMs: 200,
    subTimeoutMs: 500,
    pingIntervalMs: 60_000,
    idleShutdownMs: 60_000,
    restartKillMs: 100,
    spawn: () => {
      const child = new FakeChild()
      children.push(child)
      return child as unknown as ChildProcess
    },
    ...options
  })
  return { supervisor, children, last: () => children[children.length - 1]! }
}

function handlers(): WatchSubscriptionHandlers & {
  events: WatchEvent[][]
  overflows: number
  readies: number
  errors: Error[]
} {
  const record = {
    events: [] as WatchEvent[][],
    overflows: 0,
    readies: 0,
    errors: [] as Error[],
    onEvents(events: readonly WatchEvent[]) {
      record.events.push([...events])
    },
    onOverflow() {
      record.overflows += 1
    },
    onReady() {
      record.readies += 1
    },
    onError(error: Error) {
      record.errors.push(error)
    }
  }
  return record
}

describe('WatcherSupervisor', () => {
  it('handshakes, subscribes, and reports the backend', async () => {
    const { supervisor, last } = harness()
    const watch = handlers()
    await expect(supervisor.subscribe(spec, watch)).resolves.toEqual({
      ok: true,
      backend: 'chokidar'
    })
    expect(last().killed).toBe(false)
    expect(supervisor.stats()).toMatchObject({
      running: true,
      pid: 4242,
      backend: 'chokidar',
      subscriptions: 1
    })
    await supervisor.shutdown()
  })

  it('dispatches events, overflow, and ready to the subscription', async () => {
    const { supervisor, last } = harness()
    const watch = handlers()
    await supervisor.subscribe(spec, watch)
    last().send({ t: 'ev', sub: spec.id, events: [['change', '/wt/src/a.ts']] })
    last().send({ t: 'ovf', sub: spec.id })
    last().send({ t: 'ready', sub: spec.id })
    await wait(10)
    expect(watch.events).toEqual([[{ type: 'change', path: '/wt/src/a.ts' }]])
    expect(watch.overflows).toBe(1)
    expect(watch.readies).toBe(1)
    await supervisor.shutdown()
  })

  it('ignores malformed frames and keeps working', async () => {
    const { supervisor, last } = harness()
    const watch = handlers()
    await supervisor.subscribe(spec, watch)
    last().stdout.write('this is not json\n')
    last().send({ t: 'ev', sub: spec.id, events: [['add', '/wt/a.ts']] })
    await wait(10)
    expect(watch.events).toHaveLength(1)
    await supervisor.shutdown()
  })

  it('kills a child that emits an oversized frame', async () => {
    const { supervisor, last } = harness({ maxFrameBytes: 64 })
    const watch = handlers()
    await supervisor.subscribe(spec, watch)
    last().stdout.write(`${'x'.repeat(200)}\n`)
    await wait(10)
    expect(last().killed).toBe(true)
    expect(watch.errors.length).toBeGreaterThan(0)
  })

  it('turns a subscribe timeout into a failed result', async () => {
    const { supervisor, last } = harness()
    const watch = handlers()
    // subscribe spawns synchronously before its first await, so the child exists
    // by the time this returns.
    const pending = supervisor.subscribe(spec, watch)
    last().ignoreNextSub = true
    await expect(pending).resolves.toMatchObject({ ok: false })
    expect(supervisor.stats().subscriptions).toBe(0)
    await supervisor.shutdown()
  })

  it('fails every subscription when the child exits', async () => {
    const { supervisor, last } = harness()
    const watch = handlers()
    await supervisor.subscribe(spec, watch)
    last().exit(1)
    await wait(10)
    expect(watch.errors.length).toBeGreaterThan(0)
    expect(supervisor.stats().running).toBe(false)
    expect(supervisor.stats().subscriptions).toBe(0)
  })

  it('stops spawning after repeated crashes', async () => {
    const { supervisor } = harness({ startFuseLimit: 2, startFuseWindowMs: 60_000 })
    const first = handlers()
    await supervisor.subscribe(spec, first)
    // The helper returned a supervisor over a fresh spawn each call; crash the
    // first child, then subscribe again to spawn the second.
    const child = (supervisor as unknown as { child: FakeChild | null }).child
    child?.exit(1)
    await wait(10)

    const second = handlers()
    await expect(supervisor.subscribe(spec, second)).resolves.toMatchObject({ ok: true })
    const secondChild = (supervisor as unknown as { child: FakeChild | null }).child
    secondChild?.exit(1)
    await wait(10)

    await expect(supervisor.subscribe(spec, handlers())).resolves.toEqual({
      ok: false,
      reason: 'watcher restart fuse is open'
    })
  })

  it('shuts down within the bounded window', async () => {
    const { supervisor, last } = harness()
    await supervisor.subscribe(spec, handlers())
    await supervisor.shutdown()
    expect(last().killed || last().stdin.destroyed || last().stdout.destroyed).toBe(true)
    expect(supervisor.stats().running).toBe(false)
  })
})
