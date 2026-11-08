import { createServer, type Server, type Socket } from 'node:net'
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { isNamedPipe } from '../../shared/domain/endpoint'

export const SUPERVISOR_CONTROL_MAX_BYTES = 64 * 1024
export const SUPERVISOR_CONTROL_READ_TIMEOUT_MS = 5_000

export type SupervisorControlRequest = {
  v: 1
  token: string
  op: string
  input?: unknown
}

export type SupervisorControlResponse =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; detail?: string } }

export type SupervisorControlHandler = (
  request: SupervisorControlRequest
) => Promise<SupervisorControlResponse>

export type SupervisorControlServerOptions = {
  socketPath: string
  handle: SupervisorControlHandler
  onRejected?: (reason: string, detail?: string) => void
  readTimeoutMs?: number
}

/**
 * Request/response control plane for supervisor CLI calls.
 *
 * This is deliberately not `ActivityHookServer`: hooks are one-way and
 * Claude-only, while a supervisor needs a response it can print. The framing is
 * still one small JSON object per connection so a stuck client cannot pin the
 * listener or grow an unbounded buffer.
 */
export class SupervisorControlServer {
  private server: Server | null = null
  private readonly readTimeoutMs: number

  constructor(private readonly options: SupervisorControlServerOptions) {
    this.readTimeoutMs = options.readTimeoutMs ?? SUPERVISOR_CONTROL_READ_TIMEOUT_MS
  }

  async start(): Promise<void> {
    if (this.server) return
    if (!isNamedPipe(this.options.socketPath)) {
      const directory = dirname(this.options.socketPath)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      if (existsSync(this.options.socketPath)) rmSync(this.options.socketPath, { force: true })
    }

    const server = createServer({ allowHalfOpen: true }, (socket) => this.handleConnection(socket))
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.options.socketPath, () => {
        server.removeListener('error', reject)
        try {
          chmodSync(this.options.socketPath, 0o600)
        } catch {
          // Windows named pipes ignore POSIX modes.
        }
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    if (!isNamedPipe(this.options.socketPath) && existsSync(this.options.socketPath)) {
      rmSync(this.options.socketPath, { force: true })
    }
  }

  private handleConnection(socket: Socket): void {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false

    const finish = (reason?: string): void => {
      if (settled) return
      settled = true
      socket.destroy()
      if (reason) this.options.onRejected?.(reason)
    }

    const timer = setTimeout(() => finish('read-timeout'), this.readTimeoutMs)
    timer.unref?.()

    socket.on('error', () => finish('socket-error'))
    socket.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > SUPERVISOR_CONTROL_MAX_BYTES) {
        this.options.onRejected?.('payload-too-large')
        settled = true
        clearTimeout(timer)
        socket.destroy()
        return
      }
      chunks.push(chunk)
      // Windows named pipes do not deliver a request that is half-closed with
      // `socket.end(text)`; the response would arrive after the client's read
      // side is already gone. A newline is the portable frame: the client keeps
      // the connection open until the response, and the server answers as soon
      // as the line is complete.
      const raw = Buffer.concat(chunks).toString('utf8')
      const newline = raw.indexOf('\n')
      if (newline === -1) return
      settled = true
      clearTimeout(timer)
      void this.process(socket, raw.slice(0, newline))
    })
    socket.on('end', () => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      // Tolerate a one-shot client that closes without a newline (the old
      // protocol); the normal CLI always sends one.
      const raw = Buffer.concat(chunks).toString('utf8')
      void this.process(socket, raw)
    })
  }

  private async process(socket: Socket, raw: string): Promise<void> {
    if (raw.trim().length === 0) {
      this.options.onRejected?.('empty-payload')
      await this.replyAndClose(socket, {
        ok: false,
        error: { code: 'INVALID_ARGUMENT', message: 'The control request is empty.' }
      })
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.options.onRejected?.('invalid-json')
      await this.replyAndClose(socket, {
        ok: false,
        error: { code: 'INVALID_ARGUMENT', message: 'The control request is not valid JSON.' }
      })
      return
    }
    if (!isControlRequest(parsed)) {
      this.options.onRejected?.('invalid-payload')
      await this.replyAndClose(socket, {
        ok: false,
        error: { code: 'INVALID_ARGUMENT', message: 'The control request has the wrong shape.' }
      })
      return
    }

    let response: SupervisorControlResponse
    try {
      response = await this.options.handle(parsed)
    } catch (error) {
      response = {
        ok: false,
        error: {
          code: 'INTERNAL',
          message: error instanceof Error ? error.message : String(error)
        }
      }
    }
    await this.replyAndClose(socket, response)
  }

  private async replyAndClose(socket: Socket, response: SupervisorControlResponse): Promise<void> {
    if (socket.destroyed) return
    await new Promise<void>((resolve) => {
      socket.end(JSON.stringify(response), () => resolve())
    })
  }
}

function isControlRequest(value: unknown): value is SupervisorControlRequest {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    record.v === 1 &&
    typeof record.token === 'string' &&
    typeof record.op === 'string' &&
    record.op.length > 0 &&
    record.op.length <= 80
  )
}
