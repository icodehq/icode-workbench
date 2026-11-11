import { createServer, type Server, type Socket } from 'node:net'
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { activityHookPayloadSchema, type ActivityHookPayload } from '../../shared/schemas/activity'
import { ACTIVITY_MAX_PAYLOAD_BYTES, type ActivityHookEvent } from '../../shared/domain/activity'
import { isNamedPipe } from '../../shared/domain/endpoint'

export type ActivityIngestResult = 'accepted' | 'duplicate' | 'stale' | 'unknown-session' | 'stale-incarnation'

export type ActivityHookServerOptions = {
  socketPath: string
  ingest: (event: ActivityHookEvent) => ActivityIngestResult
  onRejected?: (reason: string, detail?: string) => void
  /** Per-connection read budget; a stuck client must not hold a socket forever. */
  readTimeoutMs?: number
}

const DEFAULT_READ_TIMEOUT_MS = 2000

/**
 * Unix-socket ingress for Claude hook payloads.
 *
 * Framing is one JSON object per connection, capped at 8 KiB. The connection is
 * closed as soon as the payload is read or the budget is exceeded, so a broken
 * hook can never pin the listener. Nothing here touches sessions, PTYs, or
 * lifecycle state.
 */
export class ActivityHookServer {
  private server: Server | null = null
  private readonly readTimeoutMs: number

  constructor(private readonly options: ActivityHookServerOptions) {
    this.readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS
  }

  async start(): Promise<void> {
    if (this.server) return
    // A named pipe lives in the kernel namespace: there is no directory to
    // create and no stale file to unlink. Only POSIX sockets need that.
    if (!isNamedPipe(this.options.socketPath)) {
      const directory = dirname(this.options.socketPath)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      if (existsSync(this.options.socketPath)) rmSync(this.options.socketPath, { force: true })
    }

    const server = createServer((socket) => this.handleConnection(socket))
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.options.socketPath, () => {
        server.removeListener('error', reject)
        // The parent is owner-only, but the socket may live directly in a
        // shared temp root after the long-path fallback. A 0600 socket keeps
        // hook delivery private without relying on the directory.
        try {
          chmodSync(this.options.socketPath, 0o600)
        } catch {
          // Non-POSIX filesystems decide their own permissions.
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
      if (size > ACTIVITY_MAX_PAYLOAD_BYTES) {
        finish('payload-too-large')
        return
      }
      chunks.push(chunk)
    })
    socket.on('end', () => {
      clearTimeout(timer)
      if (settled) return
      const raw = Buffer.concat(chunks).toString('utf8')
      this.process(raw)
      finish()
    })
  }

  private process(raw: string): void {
    if (raw.trim().length === 0) {
      this.options.onRejected?.('empty-payload')
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.options.onRejected?.('invalid-json')
      return
    }
    const result = activityHookPayloadSchema.safeParse(parsed)
    if (!result.success) {
      this.options.onRejected?.('invalid-payload', result.error.issues[0]?.path.join('.'))
      return
    }
    const payload: ActivityHookPayload = result.data
    this.options.ingest({
      event: payload.event,
      sessionId: payload.sessionId,
      incarnationId: payload.incarnationId,
      claudeSessionId: payload.claudeSessionId,
      promptId: payload.promptId,
      toolName: payload.toolName,
      sentAt: payload.sentAt
    })
  }
}
