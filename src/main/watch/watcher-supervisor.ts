/**
 * Owns the watcher child process and its NDJSON connection.
 *
 * The supervisor is deliberately narrower than the terminal Host supervisor:
 * the child is app-scoped (not detached), so it needs no socket, token, meta
 * file, or stale-version replacement. It does need the parts that keep a
 * failure local: a hello deadline, request timeouts, a heartbeat, a restart
 * fuse, idle shutdown, and a bounded frame reader.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  WATCH_MAX_FRAME_BYTES,
  WATCH_PROTOCOL_VERSION,
  encodeWatchMessage,
  parseWatcherMessage,
  type ParentToWatcherMessage,
  type SerializedWatchSpec,
  type WatchBackendName,
  type WatcherToParentMessage
} from '../../shared/watch-protocol'
import type {
  WatchClient,
  WatchClientStats,
  WatchEvent,
  WatchRootsResult,
  WatchSubscribeResult,
  WatchSubscriptionHandlers
} from './watch-client'

export type WatcherSpawn = (entryPath: string) => ChildProcess

export type WatcherSupervisorOptions = {
  entryPath: string
  logPath?: string | null
  /** Test seam: builds the child without touching the real process table. */
  spawn?: WatcherSpawn
  now?: () => number
  idleShutdownMs?: number
  startFuseWindowMs?: number
  startFuseLimit?: number
  pingIntervalMs?: number
  pingTimeoutMs?: number
  helloTimeoutMs?: number
  requestTimeoutMs?: number
  subTimeoutMs?: number
  maxFrameBytes?: number
  restartKillMs?: number
}

type PendingRequest = {
  resolve: (message: WatcherToParentMessage) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type StatMessage = Extract<WatcherToParentMessage, { t: 'stat' }>

type ResolvedOptions = {
  entryPath: string
  logPath: string | null
  spawn: WatcherSpawn
  now: () => number
  idleShutdownMs: number
  startFuseWindowMs: number
  startFuseLimit: number
  pingIntervalMs: number
  pingTimeoutMs: number
  helloTimeoutMs: number
  requestTimeoutMs: number
  subTimeoutMs: number
  maxFrameBytes: number
  restartKillMs: number
}

const DEFAULT_OPTIONS = {
  idleShutdownMs: 60_000,
  startFuseWindowMs: 60_000,
  startFuseLimit: 5,
  pingIntervalMs: 15_000,
  pingTimeoutMs: 5_000,
  helloTimeoutMs: 5_000,
  requestTimeoutMs: 2_000,
  subTimeoutMs: 10_000,
  maxFrameBytes: WATCH_MAX_FRAME_BYTES,
  restartKillMs: 2_000
} as const

function defaultSpawn(entryPath: string): ChildProcess {
  return spawn(process.execPath, [entryPath], {
    cwd: dirname(entryPath),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: false
  })
}

export class WatcherSupervisor implements WatchClient {
  private readonly options: ResolvedOptions
  private child: ChildProcess | null = null
  private starting: Promise<void> | null = null
  private backend: WatchBackendName | null = null
  private pid: number | null = null
  private readonly subscriptions = new Map<string, WatchSubscriptionHandlers>()
  private readonly pending = new Map<number, PendingRequest>()
  private nextRequestId = 1
  private spawnCount = 0
  private restarts = 0
  private readonly startTimes: number[] = []
  private fused = false
  private stopped = false
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private pingPending = false
  private missedPings = 0
  private helloWaiter: {
    resolve: () => void
    reject: (error: Error) => void
  } | null = null
  private inbound = ''
  private lastStat: StatMessage | null = null
  private logDirectoryReady = false

  constructor(options: WatcherSupervisorOptions) {
    this.options = {
      entryPath: options.entryPath,
      logPath: options.logPath ?? null,
      spawn: options.spawn ?? defaultSpawn,
      now: options.now ?? Date.now,
      idleShutdownMs: options.idleShutdownMs ?? DEFAULT_OPTIONS.idleShutdownMs,
      startFuseWindowMs: options.startFuseWindowMs ?? DEFAULT_OPTIONS.startFuseWindowMs,
      startFuseLimit: options.startFuseLimit ?? DEFAULT_OPTIONS.startFuseLimit,
      pingIntervalMs: options.pingIntervalMs ?? DEFAULT_OPTIONS.pingIntervalMs,
      pingTimeoutMs: options.pingTimeoutMs ?? DEFAULT_OPTIONS.pingTimeoutMs,
      helloTimeoutMs: options.helloTimeoutMs ?? DEFAULT_OPTIONS.helloTimeoutMs,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_OPTIONS.requestTimeoutMs,
      subTimeoutMs: options.subTimeoutMs ?? DEFAULT_OPTIONS.subTimeoutMs,
      maxFrameBytes: options.maxFrameBytes ?? DEFAULT_OPTIONS.maxFrameBytes,
      restartKillMs: options.restartKillMs ?? DEFAULT_OPTIONS.restartKillMs
    }
  }

  async subscribe(
    spec: SerializedWatchSpec,
    handlers: WatchSubscriptionHandlers
  ): Promise<WatchSubscribeResult> {
    if (this.stopped) return { ok: false, reason: 'stopped' }
    if (this.fused) return { ok: false, reason: 'fused' }
    try {
      await this.ensureChild()
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }

    this.subscriptions.set(spec.id, handlers)
    this.clearIdleTimer()
    try {
      const message = await this.request(
        { t: 'sub', rid: this.nextRid(), sub: spec.id, spec },
        this.options.subTimeoutMs
      )
      if (message.t === 'ok') {
        return { ok: true, backend: message.backend ?? this.backend ?? 'chokidar' }
      }
      throw new Error(`unexpected reply to subscribe: ${message.t}`)
    } catch (error) {
      this.subscriptions.delete(spec.id)
      this.scheduleIdle()
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  async updateRoots(id: string, roots: readonly string[]): Promise<WatchRootsResult> {
    if (this.stopped || this.child === null) return { ok: false, reason: 'not-running' }
    try {
      const message = await this.request(
        { t: 'roots', rid: this.nextRid(), sub: id, roots: [...roots] },
        this.options.requestTimeoutMs
      )
      if (message.t === 'ok') {
        return { ok: true, bound: message.bound ?? roots.length, missing: message.missing ?? [] }
      }
      throw new Error(`unexpected reply to roots: ${message.t}`)
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  async unsubscribe(id: string): Promise<void> {
    this.subscriptions.delete(id)
    this.scheduleIdle()
    if (this.child === null) return
    try {
      await this.request(
        { t: 'unsub', rid: this.nextRid(), sub: id },
        this.options.requestTimeoutMs
      )
    } catch {
      // The child may be gone; forgetting the subscription is what matters.
    }
  }

  stats(): WatchClientStats {
    return {
      running: this.child !== null,
      pid: this.pid,
      backend: this.backend,
      subscriptions: this.subscriptions.size,
      watches: this.lastStat?.watches ?? 0,
      roots: this.lastStat?.roots ?? 0,
      restarts: this.restarts,
      fused: this.fused
    }
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.clearTimers()
    const child = this.child
    if (child === null) return
    try {
      this.write({ t: 'bye' })
      child.stdin?.end()
    } catch {
      // A dead pipe is expected during teardown.
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          // Already gone.
        }
        resolve()
      }, this.options.restartKillMs)
      timer.unref()
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    this.child = null
    this.pid = null
    this.backend = null
    this.rejectAll(new Error('watcher shut down'))
  }

  // ─── Child lifecycle ──────────────────────────────────────────────

  private ensureChild(): Promise<void> {
    if (this.child !== null) return Promise.resolve()
    if (this.starting !== null) return this.starting
    if (this.fused) return Promise.reject(new Error('watcher restart fuse is open'))
    const now = this.options.now()
    while (
      this.startTimes.length > 0 &&
      now - (this.startTimes[0] ?? now) > this.options.startFuseWindowMs
    ) {
      this.startTimes.shift()
    }
    if (this.startTimes.length >= this.options.startFuseLimit) {
      this.fused = true
      return Promise.reject(new Error('watcher restart fuse is open'))
    }
    this.startTimes.push(now)

    this.starting = new Promise<void>((resolve, reject) => {
      let child: ChildProcess
      try {
        child = this.options.spawn(this.options.entryPath)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      this.child = child
      this.pid = child.pid ?? null
      this.backend = null
      this.inbound = ''
      this.lastStat = null
      this.missedPings = 0
      this.pingPending = false
      this.spawnCount += 1
      if (this.spawnCount > 1) this.restarts += 1

      const hello = this.options.helloTimeoutMs
      const timer = setTimeout(() => {
        this.helloWaiter = null
        reject(new Error('watcher hello timed out'))
        this.killChild(child)
      }, hello)
      timer.unref()
      this.helloWaiter = {
        resolve: () => {
          clearTimeout(timer)
          this.helloWaiter = null
          resolve()
        },
        reject: (error) => {
          clearTimeout(timer)
          this.helloWaiter = null
          reject(error)
        }
      }

      child.stdout?.on('data', (chunk: Buffer | string) => this.onData(String(chunk)))
      child.stderr?.on('data', (chunk: Buffer | string) => this.appendLog(String(chunk)))
      child.on('error', (error) => this.handleChildGone(child, error))
      child.on('exit', (code, signal) => this.handleChildGone(child, undefined, code, signal))
    }).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private startPing(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer)
    this.pingTimer = setInterval(() => {
      if (this.child === null) return
      if (this.pingPending) {
        this.missedPings += 1
        this.pingPending = false
        if (this.missedPings >= 2) {
          this.appendLog('watcher: heartbeat missed twice; killing child\n')
          this.killChild(this.child)
          return
        }
      }
      this.pingPending = true
      try {
        this.write({ t: 'ping', rid: this.nextRid() })
      } catch {
        // The exit handler owns recovery.
      }
    }, this.options.pingIntervalMs)
    this.pingTimer.unref()
  }

  private handleChildGone(
    child: ChildProcess,
    error?: Error,
    code?: number | null,
    signal?: NodeJS.Signals | null
  ): void {
    if (this.child !== child) return
    this.clearTimers()
    this.child = null
    this.pid = null
    this.backend = null
    this.inbound = ''
    const detail = error !== undefined ? error.message : `code ${String(code)} signal ${String(signal)}`
    const failure = new Error(`watcher process exited: ${detail}`)
    this.helloWaiter?.reject(failure)
    this.helloWaiter = null
    this.rejectAll(failure)
    for (const handlers of this.subscriptions.values()) {
      handlers.onError(failure)
    }
    this.subscriptions.clear()
    if (!this.stopped) {
      this.appendLog(`watcher: child gone (${detail})\n`)
      // The renderer retries through its polling fallback; no eager respawn
      // here, because a crash loop must stay visible as polling rather than
      // spin two processes.
    }
  }

  private killChild(child: ChildProcess): void {
    try {
      child.kill()
    } catch {
      // Already gone.
    }
  }

  private clearTimers(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer)
    this.pingTimer = null
    this.clearIdleTimer()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private scheduleIdle(): void {
    if (this.stopped || this.subscriptions.size > 0 || this.idleTimer !== null) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.subscriptions.size > 0) return
      if (this.child !== null) {
        try {
          this.write({ t: 'bye' })
          this.child.stdin?.end()
        } catch {
          // Ignore a dead pipe.
        }
      }
    }, this.options.idleShutdownMs)
    this.idleTimer.unref()
  }

  // ─── Protocol ─────────────────────────────────────────────────────

  private onData(chunk: string): void {
    this.inbound += chunk
    if (this.inbound.length > this.options.maxFrameBytes * 2) {
      this.appendLog('watcher: inbound frame runaway; killing child\n')
      if (this.child !== null) this.killChild(this.child)
      return
    }
    for (;;) {
      const newline = this.inbound.indexOf('\n')
      if (newline === -1) return
      const line = this.inbound.slice(0, newline)
      this.inbound = this.inbound.slice(newline + 1)
      if (line.trim().length === 0) continue
      if (line.length > this.options.maxFrameBytes) {
        this.appendLog('watcher: oversized frame; killing child\n')
        if (this.child !== null) this.killChild(this.child)
        return
      }
      const message = parseWatcherMessage(line)
      if (message === null) {
        this.appendLog(`watcher: ignored malformed frame ${line.slice(0, 200)}\n`)
        continue
      }
      this.handleMessage(message)
    }
  }

  private handleMessage(message: WatcherToParentMessage): void {
    switch (message.t) {
      case 'hello':
        if (message.v !== WATCH_PROTOCOL_VERSION) {
          this.helloWaiter?.reject(new Error(`watcher protocol ${String(message.v)}`))
          this.helloWaiter = null
          if (this.child !== null) this.killChild(this.child)
          return
        }
        this.backend = message.backend
        this.pid = message.pid
        this.startPing()
        this.helloWaiter?.resolve()
        return
      case 'ok':
      case 'pong':
        this.settle(message.rid, message)
        if (message.t === 'pong') {
          this.pingPending = false
          this.missedPings = 0
        }
        return
      case 'ev': {
        const handlers = this.subscriptions.get(message.sub)
        if (handlers === undefined) return
        const events: WatchEvent[] = message.events.map(([type, path]) => ({ type, path }))
        handlers.onEvents(events)
        return
      }
      case 'ovf': {
        this.subscriptions.get(message.sub)?.onOverflow()
        return
      }
      case 'ready':
        this.subscriptions.get(message.sub)?.onReady()
        return
      case 'err': {
        if (message.rid !== undefined) {
          // A command failed: the caller owns the subscription's fate.
          this.reject(message.rid, new Error(message.msg))
          return
        }
        if (message.sub !== undefined) {
          // A running subscription failed asynchronously.
          const handlers = this.subscriptions.get(message.sub)
          this.subscriptions.delete(message.sub)
          handlers?.onError(new Error(message.msg))
          this.scheduleIdle()
        }
        return
      }
      case 'werr':
        this.appendLog(`watcher: root ${message.root} failed (${message.code})\n`)
        return
      case 'stat':
        this.lastStat = message
        return
    }
  }

  private request(
    message: ParentToWatcherMessage & { rid: number },
    timeoutMs: number
  ): Promise<WatcherToParentMessage> {
    const child = this.child
    if (child === null) return Promise.reject(new Error('watcher is not running'))
    return new Promise<WatcherToParentMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.rid)
        reject(new Error(`watcher request timed out: ${message.t}`))
      }, timeoutMs)
      timer.unref()
      this.pending.set(message.rid, { resolve, reject, timer })
      try {
        this.write(message)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(message.rid)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private settle(rid: number, message: WatcherToParentMessage): void {
    const pending = this.pending.get(rid)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    this.pending.delete(rid)
    pending.resolve(message)
  }

  private reject(rid: number, error: Error): void {
    const pending = this.pending.get(rid)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    this.pending.delete(rid)
    pending.reject(error)
  }

  private rejectAll(error: Error): void {
    for (const [rid, pending] of this.pending) {
      clearTimeout(pending.timer)
      this.pending.delete(rid)
      pending.reject(error)
    }
  }

  private write(message: ParentToWatcherMessage): void {
    const child = this.child
    if (child === null || child.stdin === null || child.stdin.destroyed) {
      throw new Error('watcher stdin is unavailable')
    }
    child.stdin.write(encodeWatchMessage(message))
  }

  private nextRid(): number {
    const rid = this.nextRequestId
    this.nextRequestId += 1
    return rid
  }

  private appendLog(chunk: string): void {
    if (this.options.logPath === null) return
    try {
      if (!this.logDirectoryReady) {
        mkdirSync(dirname(this.options.logPath), { recursive: true })
        this.logDirectoryReady = true
      }
      appendFileSync(this.options.logPath, `${new Date().toISOString()} ${chunk}`)
    } catch {
      // Diagnostics must never affect watcher availability.
    }
  }
}
