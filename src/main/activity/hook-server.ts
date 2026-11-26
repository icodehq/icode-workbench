import { createServer, type Server, type Socket } from 'node:net'
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { activityHookPayloadSchema, type ActivityHookPayload } from '../../shared/schemas/activity'
import { ACTIVITY_MAX_PAYLOAD_BYTES, type ActivityHookEvent } from '../../shared/domain/activity'
import { isNamedPipe } from '../../shared/domain/endpoint'

export type ActivityIngestResult = 'accepted' | 'duplicate' | 'stale' | 'unknown-session' | 'stale-incarnation'

/** Claude's PermissionRequest answer; null asks Claude to fall back to the terminal. */
export type ActivityPermissionDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; message: string }

export type ActivityHookServerOptions = {
  socketPath: string
  ingest: (event: ActivityHookEvent) => ActivityIngestResult
  /**
   * Holds a Claude PermissionRequest until a person answers. The returned
   * promise resolves with the decision; null answers `{}` immediately.
   * Only events whose hook waits (`permissionHold`) are held.
   */
  onPermissionRequest?: (
    event: ActivityHookEvent
  ) => Promise<ActivityPermissionDecision | null> | null
  onRejected?: (reason: string, detail?: string) => void
  /** Per-connection read budget; a stuck client must not hold a socket forever. */
  readTimeoutMs?: number
  /** How long a permission request stays open before answering `{}`. */
  permissionHoldMs?: number
}

const DEFAULT_READ_TIMEOUT_MS = 2000
/** Past Claude's 2:00 auto-block, inside the hook script's 126 s wait. */
const DEFAULT_PERMISSION_HOLD_MS = 122_000

function permissionReply(decision: ActivityPermissionDecision | null): string {
  if (decision === null) return '{}'
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision }
  })
}

/**
 * Unix-socket ingress for Claude hook payloads.
 *
 * Framing is one JSON object per connection, capped at 8 KiB. The connection is
 * closed as soon as the payload is read or the budget is exceeded, so a broken
 * hook can never pin the listener. A PermissionRequest whose hook script waits
 * is the one exception: it stays open until a decision or the hold budget.
 */
export class ActivityHookServer {
  private server: Server | null = null
  private readonly readTimeoutMs: number
  private readonly permissionHoldMs: number
  /** Open permission holds, drained with `{}` before the server stops. */
  private readonly holds = new Set<() => void>()

  constructor(private readonly options: ActivityHookServerOptions) {
    this.readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS
    this.permissionHoldMs = options.permissionHoldMs ?? DEFAULT_PERMISSION_HOLD_MS
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

    // A PermissionRequest hook half-closes after its frame and waits for the
    // decision; keep the writable side open so the answer can still be sent.
    const server = createServer({ allowHalfOpen: true }, (socket) => this.handleConnection(socket))
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
    for (const drain of [...this.holds]) drain()
    this.holds.clear()
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

    const reject = (reason: string): void => {
      if (settled) return
      settled = true
      socket.destroy()
      this.options.onRejected?.(reason)
    }

    const timer = setTimeout(() => reject('read-timeout'), this.readTimeoutMs)
    timer.unref?.()

    socket.on('error', () => reject('socket-error'))
    socket.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > ACTIVITY_MAX_PAYLOAD_BYTES) {
        reject('payload-too-large')
        return
      }
      chunks.push(chunk)
    })
    socket.on('end', () => {
      clearTimeout(timer)
      if (settled) return
      const processed = this.process(Buffer.concat(chunks).toString('utf8'))
      if (processed === null) {
        settled = true
        socket.destroy()
        return
      }
      if (processed.event.event === 'PermissionRequest' && processed.event.permissionHold) {
        const pending =
          processed.result === 'accepted'
            ? (this.options.onPermissionRequest?.(processed.event) ?? null)
            : null
        if (pending !== null) {
          this.hold(socket, pending)
          return
        }
        // The hook is waiting for an answer. `{}` makes Claude ask in the
        // terminal, exactly as it would without iCode's hook.
        settled = true
        socket.end(permissionReply(null))
        return
      }
      settled = true
      socket.destroy()
    })
  }

  /** Keeps the hook open until the decision, the budget, or a hang-up. */
  private hold(
    socket: Socket,
    pending: Promise<ActivityPermissionDecision | null>
  ): void {
    let settled = false
    let timer: NodeJS.Timeout | null = null
    const drain = (): void => finish(null)
    const finish = (decision: ActivityPermissionDecision | null): void => {
      if (settled) return
      settled = true
      this.holds.delete(drain)
      if (timer !== null) clearTimeout(timer)
      try {
        socket.end(permissionReply(decision))
      } catch {
        socket.destroy()
      }
    }
    this.holds.add(drain)
    timer = setTimeout(() => finish(null), this.permissionHoldMs)
    timer.unref?.()
    pending.then((decision) => finish(decision)).catch(() => finish(null))
    socket.once('close', () => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
    })
    socket.once('error', () => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
    })
  }

  private process(
    raw: string
  ): { event: ActivityHookEvent; result: ActivityIngestResult } | null {
    if (raw.trim().length === 0) {
      this.options.onRejected?.('empty-payload')
      return null
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.options.onRejected?.('invalid-json')
      return null
    }
    const result = activityHookPayloadSchema.safeParse(parsed)
    if (!result.success) {
      this.options.onRejected?.('invalid-payload', result.error.issues[0]?.path.join('.'))
      return null
    }
    const payload: ActivityHookPayload = result.data
    const event: ActivityHookEvent = {
      event: payload.event,
      sessionId: payload.sessionId,
      incarnationId: payload.incarnationId,
      claudeSessionId: payload.claudeSessionId,
      promptId: payload.promptId,
      toolName: payload.toolName,
      toolInput: payload.toolInput ?? null,
      permissionHold: payload.permissionHold,
      sentAt: payload.sentAt
    }
    return { event, result: this.options.ingest(event) }
  }
}
