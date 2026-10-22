import { randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import type { HostError, SessionInfo, TerminalSnapshot } from '../shared/host-protocol'
import type { HostSessionStatus } from '../shared/domain/session'
import { createEmulator, EMULATOR_HIGH_WATER_BYTES, EMULATOR_LOW_WATER_BYTES, type Emulator } from './terminal-emulator'

export const MAX_SESSIONS = 64

export type PtyExitEvent = { exitCode: number; signal?: number }
export type Disposable = { dispose(): void }

/** Minimal surface of node-pty that the registry depends on. */
export type PtyLike = {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  pause?(): void
  resume?(): void
  onData(listener: (data: string) => void): Disposable
  onExit(listener: (event: PtyExitEvent) => void): Disposable
}

export type PtySpawnConfig = {
  command: string
  args: string[]
  cwd: string
  cols: number
  rows: number
  env: Record<string, string>
}

export type PtyFactory = (config: PtySpawnConfig) => PtyLike
export type EmulatorFactory = (cols: number, rows: number) => Emulator

export type CreateOrAttachParams = {
  sessionId: string
  cwd: string
  command: string
  args?: string[]
  cols: number
  rows: number
  attachOnly?: boolean
}

export type CreateOrAttachResult = {
  info: SessionInfo
  created: boolean
}

export type RegistryEvents = {
  onData: (event: {
    sessionId: string
    incarnationId: string
    seq: number
    data: string
  }) => void
  onSpawned: (event: { sessionId: string; incarnationId: string; ptyPid: number }) => void
  onExit: (event: {
    sessionId: string
    incarnationId: string
    exitCode: number
    signal?: number
  }) => void
}

export class RegistryError extends Error {
  constructor(
    readonly code: HostError['code'],
    message: string,
    readonly detail?: string
  ) {
    super(message)
    this.name = 'RegistryError'
  }
}

export type RegistryOptions = {
  ptyFactory: PtyFactory
  emulatorFactory?: EmulatorFactory
  events: RegistryEvents
  now?: () => number
  env?: Record<string, string>
  maxSessions?: number
}

type Entry = {
  info: SessionInfo
  term: PtyLike
  emulator: Emulator
  seq: number
  paused: boolean
  stopRequested: boolean
  createdAt: number
  dataSub: Disposable
  exitSub: Disposable
}

function buildEnv(base: Record<string, string>, sessionId: string, incarnationId: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    // The host itself runs under ELECTRON_RUN_AS_NODE; child TUIs must not.
    if (key === 'ELECTRON_RUN_AS_NODE') continue
    env[key] = value
  }
  env.TERM = 'xterm-256color'
  env.ADE_SESSION_ID = sessionId
  env.ADE_SESSION_INCARNATION = incarnationId
  return env
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export class PtyRegistry {
  private readonly entries = new Map<string, Entry>()
  private readonly ptyFactory: PtyFactory
  private readonly emulatorFactory: EmulatorFactory
  private readonly events: RegistryEvents
  private readonly now: () => number
  private readonly env: Record<string, string>
  private readonly maxSessions: number
  private closed = false

  constructor(options: RegistryOptions) {
    this.ptyFactory = options.ptyFactory
    this.emulatorFactory = options.emulatorFactory ?? createEmulator
    this.events = options.events
    this.now = options.now ?? Date.now
    this.env = options.env ?? (process.env as Record<string, string>)
    this.maxSessions = options.maxSessions ?? MAX_SESSIONS
  }

  /**
   * Idempotent by durable session ID. Live sessions attach; exited sessions
   * restart with a new incarnation unless attachOnly was requested.
   */
  createOrAttach(params: CreateOrAttachParams): CreateOrAttachResult {
    if (this.closed) throw new RegistryError('INTERNAL', 'Host is shutting down')
    if (!isDirectory(params.cwd)) {
      throw new RegistryError('BAD_REQUEST', 'Working directory does not exist', params.cwd)
    }

    const existing = this.entries.get(params.sessionId)
    if (existing && !params.attachOnly && this.isFinished(existing)) {
      // Restart: build the replacement first so a failed spawn preserves the
      // previous session's final screen instead of destroying evidence.
      const replacement = this.spawnEntry(params, existing)
      this.retire(existing)
      this.entries.set(params.sessionId, replacement)
      return { info: { ...replacement.info }, created: true }
    }

    if (existing) {
      return { info: { ...existing.info }, created: false }
    }

    if (params.attachOnly) {
      throw new RegistryError('SESSION_NOT_FOUND', 'Session is not known to the host')
    }

    this.makeRoom()
    const entry = this.spawnEntry(params, null)
    this.entries.set(params.sessionId, entry)
    return { info: { ...entry.info }, created: true }
  }

  /**
   * Snapshot after the headless terminal has parsed every pending chunk, so an
   * attach cannot race the output it is meant to restore.
   */
  async snapshot(sessionId: string): Promise<TerminalSnapshot> {
    const entry = this.requireEntry(sessionId)
    await entry.emulator.whenIdle()
    // The session may have exited or been replaced while waiting.
    const current = this.entries.get(sessionId)
    if (current !== entry) return this.snapshot(sessionId)
    return entry.emulator.snapshot(entry.seq)
  }

  write(sessionId: string, incarnationId: string, data: string): void {
    const entry = this.requireEntry(sessionId)
    this.assertIncarnation(entry, incarnationId)
    if (entry.info.status !== 'live') {
      throw new RegistryError('BAD_REQUEST', 'Session is not live')
    }
    entry.term.write(data)
  }

  resize(sessionId: string, incarnationId: string, cols: number, rows: number): void {
    const entry = this.requireEntry(sessionId)
    this.assertIncarnation(entry, incarnationId)
    if (this.isFinished(entry)) {
      throw new RegistryError('BAD_REQUEST', 'Session has exited')
    }
    entry.info.cols = cols
    entry.info.rows = rows
    entry.term.resize(cols, rows)
    entry.emulator.resize(cols, rows)
  }

  /** Kills one PTY. Other sessions and their emulators are untouched. */
  kill(sessionId: string): boolean {
    const entry = this.entries.get(sessionId)
    if (!entry) throw new RegistryError('SESSION_NOT_FOUND', 'Session is not known to the host')
    if (this.isFinished(entry)) return false
    entry.stopRequested = true
    entry.info.stopRequested = true
    try {
      entry.term.kill()
    } catch (error) {
      throw new RegistryError(
        'INTERNAL',
        'The process could not be signaled',
        error instanceof Error ? error.message : String(error)
      )
    }
    return true
  }

  list(): SessionInfo[] {
    return [...this.entries.values()]
      .sort((a, b) => a.createdAt - b.createdAt || a.info.sessionId.localeCompare(b.info.sessionId))
      .map((entry) => ({ ...entry.info }))
  }

  liveCount(): number {
    return [...this.entries.values()].filter((entry) => !this.isFinished(entry)).length
  }

  totalCount(): number {
    return this.entries.size
  }

  has(sessionId: string): boolean {
    return this.entries.has(sessionId)
  }

  closeAll(): void {
    if (this.closed) return
    this.closed = true
    for (const entry of this.entries.values()) {
      this.retire(entry, { signal: true })
    }
    this.entries.clear()
  }

  private isFinished(entry: Entry): boolean {
    return entry.info.status === 'exited' || entry.info.status === 'failed'
  }

  private requireEntry(sessionId: string): Entry {
    const entry = this.entries.get(sessionId)
    if (!entry) throw new RegistryError('SESSION_NOT_FOUND', 'Session is not known to the host')
    return entry
  }

  private assertIncarnation(entry: Entry, incarnationId: string): void {
    if (entry.info.incarnationId !== incarnationId) {
      throw new RegistryError(
        'STALE_INCARNATION',
        'The request targets a previous PTY incarnation',
        `current=${entry.info.incarnationId}`
      )
    }
  }

  /** Evict the oldest finished session rather than rejecting new work. */
  private makeRoom(): void {
    if (this.entries.size < this.maxSessions) return
    const finished = [...this.entries.entries()]
      .filter(([, entry]) => this.isFinished(entry))
      .sort((a, b) => a[1].createdAt - b[1].createdAt)
    for (const [sessionId, entry] of finished) {
      this.retire(entry)
      this.entries.delete(sessionId)
      if (this.entries.size < this.maxSessions) return
    }
    throw new RegistryError(
      'BAD_REQUEST',
      `Session limit reached (${this.maxSessions}); close an existing session first`
    )
  }

  private spawnEntry(params: CreateOrAttachParams, previous: Entry | null): Entry {
    const incarnationId = randomBytes(8).toString('hex')
    const emulator = this.emulatorFactory(params.cols, params.rows)
    let term: PtyLike
    try {
      term = this.ptyFactory({
        command: params.command,
        args: params.args ?? [],
        cwd: params.cwd,
        cols: params.cols,
        rows: params.rows,
        env: buildEnv(this.env, params.sessionId, incarnationId)
      })
    } catch (error) {
      emulator.dispose()
      const message = error instanceof Error ? error.message : String(error)
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code)
          : undefined
      throw new RegistryError('SPAWN_FAILED', 'The terminal process could not be started', [message, code, previous ? `previous=${previous.info.incarnationId}` : ''].filter(Boolean).join(' | '))
    }

    const info: SessionInfo = {
      sessionId: params.sessionId,
      incarnationId,
      ptyPid: term.pid,
      cwd: params.cwd,
      command: params.command,
      cols: params.cols,
      rows: params.rows,
      status: 'live' satisfies HostSessionStatus,
      exitCode: null,
      stopRequested: false,
      createdAt: this.now()
    }

    const entry: Entry = {
      info,
      term,
      emulator,
      seq: 0,
      paused: false,
      stopRequested: false,
      createdAt: info.createdAt,
      dataSub: { dispose: () => {} },
      exitSub: { dispose: () => {} }
    }

    entry.dataSub = term.onData((data) => this.ingest(entry, data))
    entry.exitSub = term.onExit((event) => this.handleExit(entry, event))

    this.events.onSpawned({
      sessionId: params.sessionId,
      incarnationId,
      ptyPid: term.pid
    })
    return entry
  }

  private ingest(entry: Entry, data: string): void {
    if (this.entries.get(entry.info.sessionId) !== entry) return
    entry.seq += 1
    entry.emulator.write(data, () => this.maybeResume(entry))
    this.events.onData({
      sessionId: entry.info.sessionId,
      incarnationId: entry.info.incarnationId,
      seq: entry.seq,
      data
    })
    if (!entry.paused && entry.emulator.pendingBytes() > EMULATOR_HIGH_WATER_BYTES) {
      entry.term.pause?.()
      entry.paused = true
    }
  }

  private maybeResume(entry: Entry): void {
    if (!entry.paused) return
    if (entry.emulator.pendingBytes() <= EMULATOR_LOW_WATER_BYTES) {
      entry.paused = false
      entry.term.resume?.()
    }
  }

  private handleExit(entry: Entry, event: PtyExitEvent): void {
    if (this.entries.get(entry.info.sessionId) !== entry) return
    if (this.isFinished(entry)) return
    const requested = entry.stopRequested
    // A requested stop is an exit even when the process reports SIGHUP (129).
    entry.info.status = requested || event.exitCode === 0 ? 'exited' : 'failed'
    entry.info.exitCode = event.exitCode
    this.events.onExit({
      sessionId: entry.info.sessionId,
      incarnationId: entry.info.incarnationId,
      exitCode: event.exitCode,
      ...(event.signal !== undefined ? { signal: event.signal } : {}),
      ...(requested ? { requested: true } : {})
    })
  }

  private retire(entry: Entry, options: { signal?: boolean } = {}): void {
    entry.dataSub.dispose()
    entry.exitSub.dispose()
    if (options.signal && !this.isFinished(entry)) {
      try {
        entry.term.kill()
      } catch {
        // already gone
      }
    }
    entry.emulator.dispose()
  }
}

export function createPtyRegistry(options: RegistryOptions): PtyRegistry {
  return new PtyRegistry(options)
}
