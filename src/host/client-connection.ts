import type { Socket } from 'node:net'
import {
  MAX_FRAME_BYTES,
  type HostError,
  type HostEvent,
  type HostResponse,
  type HostServerMessage
} from '../shared/host-protocol'
import { parseHostClientFrame } from '../shared/host-framing'

/** A single client may not cause the host to buffer more than this. */
export const MAX_CLIENT_QUEUE_BYTES = 1024 * 1024
const MAX_INBOUND_BUFFER_BYTES = MAX_FRAME_BYTES + 1

type QueuedChunk = { data: string; bytes: number; isDataEvent: boolean; sessionKey: string | null }

export type ClientConnectionOptions = {
  socket: Socket
  onFrame: (client: ClientConnection, frame: string) => void
  onClose: (client: ClientConnection) => void
  onProtocolViolation?: (client: ClientConnection, error: HostError) => void
}

function eventKey(event: HostEvent): string | null {
  return event.event === 'data' ? `${event.sessionId}:${event.incarnationId}` : null
}

/**
 * Framing, outbound queueing, and lag accounting for one socket.
 *
 * Data events are droppable: if a client cannot keep up, its queued data is
 * discarded and it receives one `lagged` event telling it to re-attach for a
 * snapshot. Responses are never dropped, so request/response stays reliable.
 */
export class ClientConnection {
  readonly socket: Socket
  private buffer = ''
  private queue: QueuedChunk[] = []
  private queuedBytes = 0
  private flushing = false
  private closed = false
  private laggedFor = new Set<string>()
  private readonly options: ClientConnectionOptions

  constructor(options: ClientConnectionOptions) {
    this.options = options
    this.socket = options.socket
    this.socket.setNoDelay(true)
    this.socket.on('data', (chunk: Buffer | string) => this.onData(chunk.toString()))
    this.socket.on('drain', () => {
      this.flushing = false
      this.flush()
    })
    this.socket.on('close', () => this.finish())
    this.socket.on('error', () => this.finish())
  }

  private onData(chunk: string): void {
    if (this.closed) return
    this.buffer += chunk
    if (this.buffer.length > MAX_INBOUND_BUFFER_BYTES && !this.buffer.includes('\n')) {
      this.options.onProtocolViolation?.(this, {
        code: 'FRAME_TOO_LARGE',
        message: `Frame exceeds ${MAX_FRAME_BYTES} bytes`
      })
      this.destroy()
      return
    }
    for (;;) {
      const index = this.buffer.indexOf('\n')
      if (index === -1) return
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (line.trim().length === 0) continue
      this.options.onFrame(this, line)
      if (this.closed) return
    }
  }

  parseFrame(raw: string): ReturnType<typeof parseHostClientFrame> {
    return parseHostClientFrame(raw)
  }

  send(message: HostServerMessage): void {
    if (this.closed) return
    this.enqueue(JSON.stringify(message), false, null)
  }

  sendResponse(response: HostResponse): void {
    this.send(response)
  }

  /** Called for broadcast events; lag is tracked per session/incarnation. */
  sendEvent(event: HostEvent): void {
    if (this.closed) return
    const line = JSON.stringify(event)
    this.enqueue(line, event.event === 'data', eventKey(event))
  }

  get isClosed(): boolean {
    return this.closed
  }

  get queuedByteCount(): number {
    return this.queuedBytes
  }

  private enqueue(json: string, isDataEvent: boolean, sessionKey: string | null): void {
    const bytes = Buffer.byteLength(json) + 1
    if (isDataEvent && sessionKey !== null) {
      if (this.laggedFor.has(sessionKey)) {
        // Already told this client to re-attach; drop until it does.
        return
      }
      if (this.queuedBytes + bytes > MAX_CLIENT_QUEUE_BYTES) {
        this.dropQueuedData()
        this.laggedFor.add(sessionKey)
        const lag = parseLag(json)
        const notice: HostEvent = {
          type: 'event',
          event: 'lagged',
          sessionId: lag.sessionId,
          incarnationId: lag.incarnationId,
          fromSeq: lag.seq > 0 ? lag.seq - 1 : 0,
          toSeq: lag.seq,
          message: 'Output was dropped because this client fell behind; request a fresh snapshot'
        }
        this.enqueue(JSON.stringify(notice), false, null)
        return
      }
    }
    this.queue.push({ data: json, bytes, isDataEvent, sessionKey })
    this.queuedBytes += bytes
    this.flush()
  }

  private dropQueuedData(): void {
    const kept: QueuedChunk[] = []
    for (const chunk of this.queue) {
      if (chunk.isDataEvent) this.queuedBytes -= chunk.bytes
      else kept.push(chunk)
    }
    this.queue = kept
  }

  private flush(): void {
    if (this.flushing || this.closed) return
    while (this.queue.length > 0) {
      const chunk = this.queue[0]!
      this.queue.shift()
      this.queuedBytes -= chunk.bytes
      const writable = this.socket.write(`${chunk.data}\n`)
      if (!writable) {
        this.flushing = true
        return
      }
    }
  }

  /** Called after a client attaches; it now has a snapshot at this sequence. */
  clearLag(sessionKey: string): void {
    this.laggedFor.delete(sessionKey)
  }

  destroy(): void {
    this.closed = true
    this.socket.destroy()
  }

  private finish(): void {
    if (this.closed) return
    this.closed = true
    this.queue = []
    this.queuedBytes = 0
    this.options.onClose(this)
  }
}

function parseLag(json: string): { sessionId: string; incarnationId: string; seq: number } {
  try {
    const parsed = JSON.parse(json) as { sessionId?: string; incarnationId?: string; seq?: number }
    return {
      sessionId: parsed.sessionId ?? '',
      incarnationId: parsed.incarnationId ?? '',
      seq: typeof parsed.seq === 'number' ? parsed.seq : 0
    }
  } catch {
    return { sessionId: '', incarnationId: '', seq: 0 }
  }
}
