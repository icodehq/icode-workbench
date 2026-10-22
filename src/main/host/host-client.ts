import { connect } from 'node:net'
import type { Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import {
  HOST_PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  type CreateOrAttachPayload,
  type HostError,
  type HostEvent,
  type HostHelloResponse,
  type ListSessionsPayload,
  type ShutdownIfIdlePayload
} from '../../shared/host-protocol'

export class HostRequestError extends Error {
  constructor(
    readonly code:
      | HostError['code']
      | 'HOST_TIMEOUT'
      | 'HOST_CONNECT_FAILED'
      | 'HOST_PROTOCOL_ERROR'
      | 'HOST_UNREACHABLE',
    message: string,
    readonly detail?: string
  ) {
    super(message)
  }
}

type Pending = {
  resolve: (payload: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

type Handshake = {
  resolve: (reply: HostHelloResponse) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export type HostConnectionOptions = {
  socketPath: string
  token: string
  clientId?: string
  requestTimeoutMs?: number
}

export type HostClientInfo = {
  hostPid: number
  startedAt: number
  protocolVersion: number
  hostVersion: string
}

export class HostClient {
  private socket: Socket | null = null
  private buffer = ''
  private pending = new Map<string, Pending>()
  private handshake: Handshake | null = null
  private listeners = new Set<(event: HostEvent) => void>()
  private closed = false
  info: HostClientInfo | null = null

  private constructor(private readonly timeoutMs: number) {}

  static async connect(options: HostConnectionOptions): Promise<HostClient> {
    const client = new HostClient(options.requestTimeoutMs ?? 10_000)
    await client.open(options)
    return client
  }

  private open(options: HostConnectionOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect(options.socketPath)
      this.socket = socket
      let settled = false
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        socket.destroy()
        reject(error)
      }
      socket.setNoDelay(true)
      socket.once('error', (error) => {
        fail(new HostRequestError('HOST_CONNECT_FAILED', `Cannot reach terminal host: ${error.message}`))
      })
      socket.once('connect', () => {
        this.attachSocket(socket)
        const timer = setTimeout(() => {
          this.handshake = null
          fail(new HostRequestError('HOST_TIMEOUT', 'Terminal host handshake timed out'))
        }, 5_000)
        this.handshake = {
          resolve: (reply) => {
            clearTimeout(timer)
            this.handshake = null
            this.info = {
              hostPid: reply.hostPid,
              startedAt: reply.startedAt,
              protocolVersion: reply.protocolVersion,
              hostVersion: reply.hostVersion
            }
            settled = true
            resolve()
          },
          reject: (error) => {
            clearTimeout(timer)
            this.handshake = null
            fail(error)
          },
          timer
        }
        socket.write(
          `${JSON.stringify({
            type: 'hello',
            protocolVersion: HOST_PROTOCOL_VERSION,
            token: options.token,
            clientId: options.clientId ?? `ade-main-${process.pid}`
          })}\n`
        )
      })
    })
  }

  private attachSocket(socket: Socket): void {
    socket.on('data', (chunk) => this.onData(chunk.toString('utf8')))
    socket.on('close', () => this.onClose())
    socket.on('error', () => this.onClose())
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > MAX_FRAME_BYTES && !this.buffer.includes('\n')) {
      this.onClose()
      return
    }
    for (;;) {
      const index = this.buffer.indexOf('\n')
      if (index === -1) return
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (!line.trim()) continue
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof message !== 'object' || message === null) continue
      const record = message as Record<string, unknown>
      if (record.type === 'hello') {
        const handshake = this.handshake
        if (!handshake) continue
        if (record.ok === true) {
          handshake.resolve(record as unknown as HostHelloResponse)
        } else {
          const error = record.error as HostError | undefined
          handshake.reject(
            new HostRequestError(
              error?.code ?? 'HOST_PROTOCOL_ERROR',
              error?.message ?? 'Terminal host rejected the handshake',
              error?.detail
            )
          )
        }
        continue
      }
      if (record.type === 'event') {
        const event = record as unknown as HostEvent
        for (const listener of this.listeners) listener(event)
        continue
      }
      if (record.type === 'response' && typeof record.id === 'string') {
        const pending = this.pending.get(record.id)
        if (!pending) continue
        this.pending.delete(record.id)
        clearTimeout(pending.timer)
        if (record.ok === true) {
          pending.resolve(record.payload)
        } else {
          const error = record.error as HostError | undefined
          pending.reject(
            new HostRequestError(
              error?.code ?? 'INTERNAL',
              error?.message ?? 'Terminal host request failed',
              error?.detail
            )
          )
        }
      }
    }
  }

  private onClose(): void {
    if (this.closed) return
    this.closed = true
    this.socket = null
    if (this.handshake) {
      clearTimeout(this.handshake.timer)
      this.handshake.reject(new HostRequestError('HOST_CONNECT_FAILED', 'Terminal host connection closed'))
      this.handshake = null
    }
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new HostRequestError('HOST_CONNECT_FAILED', 'Terminal host connection closed'))
      this.pending.delete(id)
    }
  }

  get isClosed(): boolean {
    return this.closed
  }

  onEvent(listener: (event: HostEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async ping(): Promise<void> {
    await this.request({ type: 'request', method: 'ping', params: {} })
  }

  async createOrAttach(params: {
    sessionId: string
    cwd: string
    command: string
    args?: string[]
    cols: number
    rows: number
    attachOnly?: boolean
  }): Promise<CreateOrAttachPayload> {
    return this.request<CreateOrAttachPayload>({
      type: 'request',
      method: 'createOrAttach',
      params
    })
  }

  async write(sessionId: string, incarnationId: string, data: string): Promise<void> {
    await this.request({
      type: 'request',
      method: 'write',
      params: { sessionId, incarnationId, data }
    })
  }

  async resize(sessionId: string, incarnationId: string, cols: number, rows: number): Promise<void> {
    await this.request({
      type: 'request',
      method: 'resize',
      params: { sessionId, incarnationId, cols, rows }
    })
  }

  async kill(sessionId: string): Promise<void> {
    await this.request({ type: 'request', method: 'kill', params: { sessionId } })
  }

  async listSessions(): Promise<ListSessionsPayload> {
    return this.request<ListSessionsPayload>({ type: 'request', method: 'listSessions', params: {} })
  }

  async shutdownIfIdle(): Promise<ShutdownIfIdlePayload> {
    return this.request<ShutdownIfIdlePayload>({
      type: 'request',
      method: 'shutdownIfIdle',
      params: {}
    })
  }

  async shutdown(): Promise<void> {
    await this.request({ type: 'request', method: 'shutdown', params: {} })
    this.close()
  }

  close(): void {
    this.socket?.destroy()
    this.onClose()
  }

  private request<T>(message: unknown): Promise<T> {
    const socket = this.socket
    if (!socket || !socket.writable) {
      return Promise.reject(new HostRequestError('HOST_CONNECT_FAILED', 'Terminal host is not connected'))
    }
    const withId = { ...(message as Record<string, unknown>), id: randomUUID() }
    const id = String(withId.id)
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new HostRequestError('HOST_TIMEOUT', 'Terminal host did not answer in time'))
      }, this.timeoutMs)
      this.pending.set(id, {
        resolve: (payload) => resolve(payload as T),
        reject,
        timer
      })
      socket.write(`${JSON.stringify(withId)}\n`)
    })
  }
}
