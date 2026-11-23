/**
 * The watcher child.
 *
 * One process owns every physical filesystem watch. The Electron main process
 * can therefore never be stalled by a crawl, a native watcher crash, or a
 * backend teardown. stdout carries only newline-delimited protocol frames;
 * everything else goes to stderr, which the supervisor appends to a log.
 *
 * The child is not detached. It exits when its stdin closes (the parent died),
 * when asked with `bye`, or when no parent frame has arrived for two minutes.
 */

import {
  WATCH_MAX_EVENTS_PER_FRAME,
  WATCH_MAX_FRAME_BYTES,
  WATCH_PROTOCOL_VERSION,
  encodeWatchMessage,
  parseParentMessage,
  type SerializedWatchSpec,
  type WatcherToParentMessage
} from '../shared/watch-protocol'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  BackendEvent,
  BackendSubscription,
  WatchBackend
} from './backends'
import { selectFilesBackend, selectWatchBackend } from './backends'

const writeStdout = process.stdout.write.bind(process.stdout)
const NO_PARENT_FRAME_MS = 120_000
const WATCHDOG_INTERVAL_MS = 15_000
const STAT_INTERVAL_MS = 10_000
const MAX_URGENT_QUEUE = 256

for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  ;(console as unknown as Record<string, (...args: unknown[]) => void>)[method] = (
    ...args: unknown[]
  ): void => {
    const line = args
      .map((arg) => {
        if (typeof arg === 'string') return arg
        try {
          return JSON.stringify(arg)
        } catch {
          return String(arg)
        }
      })
      .join(' ')
    process.stderr.write(`${line}\n`)
  }
}

type Subscription = {
  spec: SerializedWatchSpec
  backend: BackendSubscription
  backendName: WatchBackend['name']
  buffer: BackendEvent[]
  overflowed: boolean
  flushScheduled: boolean
  readySent: boolean
  closed: boolean
}

const subscriptions = new Map<string, Subscription>()
let backend: WatchBackend
let backpressured = false
const urgentQueue: string[] = []
let lastParentFrameAt = Date.now()
let shuttingDown = false

function send(message: WatcherToParentMessage): void {
  const line = encodeWatchMessage(message)
  if (backpressured) {
    urgentQueue.push(line)
    if (urgentQueue.length > MAX_URGENT_QUEUE) urgentQueue.shift()
    return
  }
  if (!writeStdout(line)) backpressured = true
}

function flushUrgent(): void {
  while (urgentQueue.length > 0) {
    const line = urgentQueue.shift()
    if (line === undefined) return
    if (!writeStdout(line)) {
      backpressured = true
      return
    }
  }
}

function flushSub(sub: Subscription): void {
  sub.flushScheduled = false
  if (sub.closed || backpressured) return
  if (sub.overflowed) {
    sub.overflowed = false
    sub.buffer = []
    send({ t: 'ovf', sub: sub.spec.id })
    return
  }
  if (sub.buffer.length === 0) return
  const events = sub.buffer
  sub.buffer = []
  send({ t: 'ev', sub: sub.spec.id, events: events.map((event) => [event.type, event.path]) })
}

function scheduleFlush(sub: Subscription): void {
  if (sub.flushScheduled) return
  sub.flushScheduled = true
  setImmediate(() => flushSub(sub))
}

function emitEvents(sub: Subscription, events: readonly BackendEvent[]): void {
  if (sub.closed) return
  if (sub.overflowed) return
  if (sub.buffer.length + events.length > WATCH_MAX_EVENTS_PER_FRAME) {
    sub.overflowed = true
    sub.buffer = []
  } else {
    sub.buffer.push(...events)
  }
  scheduleFlush(sub)
}

function emitOverflow(sub: Subscription): void {
  if (sub.closed) return
  sub.overflowed = true
  sub.buffer = []
  scheduleFlush(sub)
}

function emitError(sub: Subscription, error: unknown): void {
  if (sub.closed) return
  sub.closed = true
  subscriptions.delete(sub.spec.id)
  send({
    t: 'err',
    sub: sub.spec.id,
    code: 'watch-error',
    msg: error instanceof Error ? error.message : String(error)
  })
  void sub.backend.close().catch(() => undefined)
}

async function handleSubscribe(rid: number, id: string, spec: SerializedWatchSpec): Promise<void> {
  const existing = subscriptions.get(id)
  if (existing) {
    existing.closed = true
    subscriptions.delete(id)
    await existing.backend.close().catch(() => undefined)
  }
  /*
   * Register the record before the backend starts. Chokidar can emit an initial
   * event or `ready` while `subscribe()` is still settling; dropping those
   * would lose the write that landed during the scan.
   */
  const placeholder: Subscription = {
    spec,
    backend: {
      close: async () => undefined,
      stats: () => ({ watches: 0, roots: 0 })
    },
    backendName: backend.name,
    buffer: [],
    overflowed: false,
    flushScheduled: false,
    readySent: false,
    closed: false
  }
  subscriptions.set(id, placeholder)
  try {
    // Files watches only visible directories; recursive Source Control watches
    // share the app-wide backend.
    const selected = spec.kind === 'shallow' ? await selectFilesBackend() : backend
    const backendSubscription = await selected.subscribe(spec, {
      events: (events) => {
        const sub = subscriptions.get(id)
        if (sub) emitEvents(sub, events)
      },
      overflow: () => {
        const sub = subscriptions.get(id)
        if (sub) emitOverflow(sub)
      },
      ready: () => {
        const sub = subscriptions.get(id)
        if (!sub || sub.closed || sub.readySent) return
        sub.readySent = true
        send({ t: 'ready', sub: id })
      },
      error: (error) => {
        const sub = subscriptions.get(id)
        if (sub) emitError(sub, error)
      },
      rootError: (root, code) => {
        send({ t: 'werr', sub: id, root, code })
      }
    })
    if (shuttingDown || placeholder.closed) {
      await backendSubscription.close().catch(() => undefined)
      return
    }
    placeholder.backend = backendSubscription
    placeholder.backendName = selected.name
    send({ t: 'ok', rid, backend: selected.name })
  } catch (error) {
    if (subscriptions.get(id) === placeholder) subscriptions.delete(id)
    placeholder.closed = true
    send({
      t: 'err',
      rid,
      sub: id,
      code: 'subscribe-failed',
      msg: error instanceof Error ? error.message : String(error)
    })
  }
}

async function handleRoots(rid: number, id: string, roots: string[]): Promise<void> {
  const sub = subscriptions.get(id)
  if (!sub || sub.backend.setRoots === undefined) {
    send({ t: 'err', rid, sub: id, code: 'roots-unsupported', msg: 'this backend has no root set' })
    return
  }
  try {
    const result = await sub.backend.setRoots(roots)
    send({ t: 'ok', rid, bound: result.bound, missing: result.missing })
  } catch (error) {
    send({
      t: 'err',
      rid,
      sub: id,
      code: 'roots-failed',
      msg: error instanceof Error ? error.message : String(error)
    })
  }
}

async function handleUnsubscribe(rid: number, id: string): Promise<void> {
  const sub = subscriptions.get(id)
  if (sub) {
    sub.closed = true
    subscriptions.delete(id)
    await sub.backend.close().catch(() => undefined)
  }
  send({ t: 'ok', rid })
}

function sendStat(): void {
  let watches = 0
  let roots = 0
  for (const sub of subscriptions.values()) {
    const stats = sub.backend.stats()
    watches += stats.watches
    roots += stats.roots
  }
  send({
    t: 'stat',
    watches,
    subs: subscriptions.size,
    roots,
    rss: process.memoryUsage().rss,
    backend: backend.name
  })
}

async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  for (const sub of subscriptions.values()) {
    sub.closed = true
    await sub.backend.close().catch(() => undefined)
  }
  subscriptions.clear()
  process.exit(code)
}

function handleFrame(line: string): void {
  lastParentFrameAt = Date.now()
  const message = parseParentMessage(line)
  if (message === null) {
    process.stderr.write('watcher: ignored malformed frame\n')
    return
  }
  switch (message.t) {
    case 'sub':
      void handleSubscribe(message.rid, message.sub, message.spec)
      return
    case 'roots':
      void handleRoots(message.rid, message.sub, message.roots)
      return
    case 'unsub':
      void handleUnsubscribe(message.rid, message.sub)
      return
    case 'ping':
      send({ t: 'pong', rid: message.rid })
      return
    case 'bye':
      void shutdown(0)
      return
  }
}

async function selftest(): Promise<void> {
  const selected = await selectWatchBackend({ requireParcel: true })
  const directory = mkdtempSync(join(tmpdir(), 'icode-watch-selftest-'))
  let failed = false
  try {
    const subscription = await selected.subscribe(
      {
        kind: 'recursive',
        id: 'selftest',
        roots: [directory],
        worktreePath: directory,
        ignore: { skipDirectories: [], skipSuffixes: [], stagingMarker: null }
      },
      {
        events: () => undefined,
        overflow: () => undefined,
        ready: () => undefined,
        error: () => {
          failed = true
        }
      }
    )
    await subscription.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  if (failed) throw new Error('the native watcher reported an error')
  process.stdout.write(`selftest ${selected.name}\n`)
  process.exit(0)
}

async function main(): Promise<void> {
  if (process.argv.includes('--selftest')) {
    await selftest()
    return
  }

  backend = await selectWatchBackend()
  send({
    t: 'hello',
    v: WATCH_PROTOCOL_VERSION,
    pid: process.pid,
    backend: backend.name
  })

  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk
    if (buffer.length > WATCH_MAX_FRAME_BYTES * 2) {
      process.stderr.write('watcher: inbound frame runaway\n')
      void shutdown(1)
      return
    }
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.length > WATCH_MAX_FRAME_BYTES) {
        process.stderr.write('watcher: oversized frame\n')
        void shutdown(1)
        return
      }
      if (line.trim().length > 0) handleFrame(line)
    }
  })
  process.stdin.on('end', () => void shutdown(0))
  process.stdin.on('error', () => void shutdown(1))

  process.stdout.on('drain', () => {
    backpressured = false
    flushUrgent()
    for (const sub of subscriptions.values()) {
      if (sub.flushScheduled || sub.buffer.length > 0 || sub.overflowed) {
        sub.flushScheduled = true
        setImmediate(() => flushSub(sub))
      }
    }
  })

  const watchdog = setInterval(() => {
    if (Date.now() - lastParentFrameAt > NO_PARENT_FRAME_MS) {
      process.stderr.write('watcher: no parent frame for two minutes\n')
      void shutdown(1)
    }
  }, WATCHDOG_INTERVAL_MS)
  watchdog.unref()
  const stats = setInterval(sendStat, STAT_INTERVAL_MS)
  stats.unref()

  process.on('SIGTERM', () => void shutdown(0))
  process.on('SIGINT', () => void shutdown(0))
}

try {
  void main().catch((error: unknown) => {
    process.stderr.write(`watcher: fatal ${String(error)}\n`)
    process.exit(1)
  })
} catch (error) {
  process.stderr.write(`watcher: fatal ${String(error)}\n`)
  process.exit(1)
}
