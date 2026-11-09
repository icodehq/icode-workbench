import { translate } from '../i18n/i18n-store'
import type { IcodeProductApi } from '../../../shared/icode-api'
import type { AppError } from '../../../shared/domain/errors'
import { makeAppError } from '../../../shared/domain/errors'
import type {
  RendererSessionEvent,
  SessionSummary,
  TerminalAttachPayload
} from '../../../shared/schemas/ipc'

/**
 * Renderer-side terminal session controller.
 *
 * It is deliberately independent of React and Electron so ordering rules can be
 * tested headlessly. The xterm instance is hidden behind `TerminalSink`.
 */

export type TerminalPhase =
  | 'connecting'
  | 'resyncing'
  | 'live'
  | 'exited'
  | 'failed'
  | 'unavailable'
  | 'error'

export type TerminalStatus = {
  phase: TerminalPhase
  message: string | null
  incarnationId: string | null
  exitCode: number | null
  error: AppError | null
}

export type TerminalSink = {
  reset: () => void
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
}

export type TerminalApi = Pick<IcodeProductApi, 'terminal' | 'onSessionEvent'>

export type SessionTerminalOptions = {
  sessionId: string
  api: TerminalApi
  sink: TerminalSink
  onStatus?: (status: TerminalStatus) => void
  /** Called after a snapshot is applied and buffered output is drained. */
  onAttached?: (payload: TerminalAttachPayload) => void
  onError?: (error: AppError) => void
  /** A wall preview may read the snapshot but must never resize or type into the PTY. */
  readOnly?: boolean
  bufferLimitBytes?: number
  maxResyncs?: number
  resyncWindowMs?: number
  resyncCooldownMs?: number
}

type BufferedData = {
  incarnationId: string
  seq: number
  data: string
}

const DEFAULT_BUFFER_LIMIT_BYTES = 1024 * 1024
const DEFAULT_MAX_RESYNCS = 3
const DEFAULT_RESYNC_WINDOW_MS = 10_000
const DEFAULT_RESYNC_COOLDOWN_MS = 250
function messageForError(error: AppError): string {
  return error.detail ? `${error.message} ${error.detail}` : error.message
}

function rejected(error: unknown): AppError {
  return makeAppError('INTERNAL', translate('terminal.requestFailed'), {
    detail: error instanceof Error ? error.message : String(error),
    messageKey: 'terminal.requestFailed'
  })
}

function exitMessage(code: number): string {
  return code === 0
    ? translate('terminal.processExited')
    : translate('terminal.exitCodeMessage', { code })
}

export class SessionTerminal {
  private readonly api: TerminalApi
  private readonly sink: TerminalSink
  private readonly sessionId: string
  private readonly bufferLimitBytes: number
  private readonly maxResyncs: number
  private readonly resyncWindowMs: number
  private readonly resyncCooldownMs: number
  private readonly readOnly: boolean

  private started = false
  private disposed = false
  private unsubscribe: (() => void) | null = null
  private generation = 0
  private attachInFlight = false
  private synced = false
  private incarnationId: string | null = null
  private lastSeq = 0
  private buffer: BufferedData[] = []
  private bufferBytes = 0
  private bufferOverflowed = false
  private resyncTimestamps: number[] = []
  private resyncTimer: ReturnType<typeof setTimeout> | null = null
  private pendingResize: { cols: number; rows: number } | null = null
  private lastSentResize: { cols: number; rows: number } | null = null
  private pendingExit: number | null = null
  private lastState: SessionSummary | null = null
  private status: TerminalStatus = {
    phase: 'connecting',
    message: null,
    incarnationId: null,
    exitCode: null,
    error: null
  }

  constructor(options: SessionTerminalOptions) {
    this.sessionId = options.sessionId
    this.api = options.api
    this.sink = options.sink
    this.bufferLimitBytes = options.bufferLimitBytes ?? DEFAULT_BUFFER_LIMIT_BYTES
    this.maxResyncs = options.maxResyncs ?? DEFAULT_MAX_RESYNCS
    this.resyncWindowMs = options.resyncWindowMs ?? DEFAULT_RESYNC_WINDOW_MS
    this.resyncCooldownMs = options.resyncCooldownMs ?? DEFAULT_RESYNC_COOLDOWN_MS
    this.readOnly = options.readOnly === true
    this.onStatus = options.onStatus
    this.onAttached = options.onAttached
    this.onError = options.onError
  }

  private readonly onStatus?: (status: TerminalStatus) => void
  private readonly onAttached?: (payload: TerminalAttachPayload) => void
  private readonly onError?: (error: AppError) => void

  get currentIncarnationId(): string | null {
    return this.incarnationId
  }

  getStatus(): TerminalStatus {
    return this.status
  }

  getLastSessionState(): SessionSummary | null {
    return this.lastState
  }

  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    // Subscribe before attaching so output produced during the attach round
    // trip is buffered rather than silently lost.
    this.unsubscribe = this.api.onSessionEvent((event) => this.handleEvent(event))
    this.beginAttach('connecting')
  }

  /** Manual retry after an attach or resynchronization failure. */
  retry(): void {
    if (this.disposed) return
    this.resyncTimestamps = []
    this.bufferOverflowed = false
    this.setStatus({ phase: 'connecting', message: null, error: null, exitCode: null })
    this.beginAttach('connecting')
  }

  async write(data: string): Promise<boolean> {
    if (
      this.readOnly ||
      this.disposed ||
      this.status.phase !== 'live' ||
      this.incarnationId === null
    ) {
      return false
    }
    const incarnationId = this.incarnationId
    try {
      const result = await this.api.terminal.write({ sessionId: this.sessionId, incarnationId, data })
      if (result.ok) return true
      this.handleOperationError(result.error)
      return false
    } catch (error) {
      this.handleOperationError(rejected(error))
      return false
    }
  }

  resize(cols: number, rows: number): void {
    if (this.disposed || this.readOnly) return
    const width = Math.max(1, Math.min(1000, Math.floor(cols)))
    const height = Math.max(1, Math.min(1000, Math.floor(rows)))
    this.pendingResize = { cols: width, rows: height }
    if (this.status.phase !== 'live' || this.incarnationId === null) return
    this.flushResize()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.resyncTimer !== null) {
      clearTimeout(this.resyncTimer)
      this.resyncTimer = null
    }
    this.buffer = []
    this.bufferBytes = 0
    // A renderer teardown must never stop the PTY.
  }

  // ─── Attach and sequencing ────────────────────────────────────────

  private beginAttach(phase: TerminalPhase): void {
    const generation = ++this.generation
    this.attachInFlight = true
    this.synced = false
    this.buffer = []
    this.bufferBytes = 0
    this.bufferOverflowed = false
    this.pendingExit = null
    this.setStatus({ phase, message: null, error: null, exitCode: null })
    void this.runAttach(generation)
  }

  private async runAttach(generation: number): Promise<void> {
    let result: Awaited<ReturnType<TerminalApi['terminal']['attach']>>
    try {
      result = await this.api.terminal.attach({ sessionId: this.sessionId })
    } catch (error) {
      result = { ok: false, error: rejected(error) }
    }
    if (this.disposed || generation !== this.generation) return
    this.attachInFlight = false

    if (!result.ok) {
      this.synced = false
      this.setStatus({
        phase: result.error.code === 'SESSION_NOT_FOUND' ? 'unavailable' : 'error',
        message: messageForError(result.error),
        error: result.error
      })
      return
    }

    const payload = result.value
    this.incarnationId = payload.incarnationId
    // Match the emulator to the host's dimensions before replaying the
    // serialized snapshot, so its cursor and line wrapping are correct.
    this.sink.reset()
    this.sink.resize(payload.cols, payload.rows)
    this.sink.write(payload.snapshot)
    this.lastSeq = payload.seq
    this.synced = true

    const overflowedDuringAttach = this.bufferOverflowed
    this.setStatus({
      phase: 'live',
      message: null,
      incarnationId: payload.incarnationId,
      exitCode: null,
      error: null
    })
    this.drainBuffer(payload.incarnationId)

    if (this.status.phase === 'live' && this.synced) {
      this.flushResize()
      this.onAttached?.(payload)
    }

    if (this.pendingExit !== null && this.status.phase === 'live') {
      const code = this.pendingExit
      this.pendingExit = null
      this.setStatus({
        phase: code === 0 ? 'exited' : 'failed',
        message: exitMessage(code),
        exitCode: code
      })
    }

    if (overflowedDuringAttach && this.status.phase === 'live') {
      this.requestResync('overflow')
    }
  }

  private drainBuffer(incarnationId: string): void {
    const queued = this.buffer.filter((item) => item.incarnationId === incarnationId)
    this.buffer = []
    this.bufferBytes = 0
    queued.sort((a, b) => a.seq - b.seq)
    for (const item of queued) {
      if (item.seq <= this.lastSeq) continue
      if (item.seq !== this.lastSeq + 1) {
        this.requestResync('gap')
        return
      }
      this.sink.write(item.data)
      this.lastSeq = item.seq
    }
  }

  private handleEvent(event: RendererSessionEvent): void {
    if (this.disposed) return
    if (event.type === 'state') {
      this.handleState(event.session)
      return
    }
    if (event.sessionId !== this.sessionId) return

    if (event.type === 'data') {
      this.handleData(event.incarnationId, event.seq, event.data)
      return
    }

    if (event.type === 'exit') {
      if (this.incarnationId !== null && event.incarnationId !== this.incarnationId) return
      if (!this.synced) {
        this.pendingExit = event.exitCode
        return
      }
      this.synced = false
      this.setStatus({
        phase: event.exitCode === 0 ? 'exited' : 'failed',
        message: exitMessage(event.exitCode),
        exitCode: event.exitCode
      })
    }
  }

  private handleData(incarnationId: string, seq: number, data: string): void {
    if (this.incarnationId !== null && incarnationId !== this.incarnationId) return
    if (!this.synced || incarnationId !== this.incarnationId) {
      this.buffer.push({ incarnationId, seq, data })
      this.bufferBytes += data.length
      if (this.bufferBytes > this.bufferLimitBytes) {
        this.buffer = []
        this.bufferBytes = 0
        this.bufferOverflowed = true
        if (!this.attachInFlight) this.requestResync('overflow')
      }
      return
    }

    if (seq <= this.lastSeq) return
    if (seq !== this.lastSeq + 1) {
      this.requestResync('gap')
      return
    }
    this.sink.write(data)
    this.lastSeq = seq
  }

  private handleState(session: SessionSummary): void {
    if (session.id !== this.sessionId) return
    this.lastState = session

    if (session.state === 'exited' || session.state === 'failed' || session.state === 'unavailable') {
      if (
        this.incarnationId !== null &&
        session.incarnationId !== null &&
        session.incarnationId !== this.incarnationId
      ) {
        return
      }
      this.synced = false
      this.setStatus({
        phase: session.state,
        message:
          session.error !== null
            ? messageForError(session.error)
            : session.exitCode !== null
              ? exitMessage(session.exitCode)
              : null,
        incarnationId: session.incarnationId,
        exitCode: session.exitCode,
        error: session.error
      })
      return
    }

    if (this.incarnationId === null) {
      // The initial attach is still in flight; its snapshot supersedes this.
      return
    }
    if (session.incarnationId !== null && session.incarnationId !== this.incarnationId) {
      // A restart produced a new incarnation. Reattach rather than writing new
      // output into the previous process's screen.
      this.requestResync('incarnation')
      return
    }
    if (this.status.phase === 'live') {
      // The host reports event lag by refreshing an otherwise live state, so a
      // state event is the renderer's signal to resynchronize.
      this.requestResync('state')
    }
  }

  private requestResync(reason: string): void {
    if (this.disposed) return
    if (this.attachInFlight) {
      // The in-flight response will drain its buffer; overflow is re-checked there.
      return
    }
    const now = Date.now()
    this.resyncTimestamps = this.resyncTimestamps.filter(
      (stamp) => now - stamp < this.resyncWindowMs
    )
    if (this.resyncTimestamps.length >= this.maxResyncs) {
      this.synced = false
      this.setStatus({
        phase: 'error',
        message: translate('terminal.fellBehind'),
        error: null
      })
      return
    }
    const last = this.resyncTimestamps[this.resyncTimestamps.length - 1]
    if (last !== undefined && now - last < this.resyncCooldownMs) {
      if (this.resyncTimer !== null) return
      this.resyncTimer = setTimeout(() => {
        this.resyncTimer = null
        this.requestResync(reason)
      }, this.resyncCooldownMs)
      return
    }
    this.resyncTimestamps.push(now)
    this.beginAttach('resyncing')
  }

  // ─── Input and resize ─────────────────────────────────────────────

  private flushResize(): void {
    if (this.readOnly || this.pendingResize === null || this.incarnationId === null) return
    const next = this.pendingResize
    if (
      this.lastSentResize !== null &&
      this.lastSentResize.cols === next.cols &&
      this.lastSentResize.rows === next.rows
    ) {
      return
    }
    this.pendingResize = null
    this.lastSentResize = next
    const incarnationId = this.incarnationId
    void this.api.terminal
      .resize({
        sessionId: this.sessionId,
        incarnationId,
        cols: next.cols,
        rows: next.rows
      })
      .then((result) => {
        if (this.disposed || incarnationId !== this.incarnationId) return
        if (result.ok) return
        // Let the next fit retry the size change.
        this.lastSentResize = null
        this.handleOperationError(result.error)
      })
      .catch((error: unknown) => {
        if (this.disposed) return
        this.lastSentResize = null
        this.handleOperationError(rejected(error))
      })
  }

  private handleOperationError(error: AppError): void {
    this.onError?.(error)
    if (error.code === 'SESSION_NOT_FOUND') {
      this.requestResync('operation')
    }
  }

  private setStatus(next: Partial<TerminalStatus>): void {
    if (this.disposed) return
    const merged: TerminalStatus = {
      phase: next.phase ?? this.status.phase,
      message: next.message === undefined ? this.status.message : next.message,
      incarnationId:
        next.incarnationId === undefined ? this.incarnationId : next.incarnationId,
      exitCode: next.exitCode === undefined ? this.status.exitCode : next.exitCode,
      error: next.error === undefined ? this.status.error : next.error
    }
    const changed =
      merged.phase !== this.status.phase ||
      merged.message !== this.status.message ||
      merged.incarnationId !== this.status.incarnationId ||
      merged.exitCode !== this.status.exitCode ||
      merged.error !== this.status.error
    this.status = merged
    if (changed) this.onStatus?.(merged)
  }
}
