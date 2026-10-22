import { createServer } from 'node:net'
import type { Server } from 'node:net'
import { timingSafeEqual } from 'node:crypto'
import { chmodSync } from 'node:fs'
import {
  HOST_PROTOCOL_VERSION,
  checkHelloProtocolVersion,
  type HostError,
  type HostEvent,
  type HostHelloResponse,
  type HostResponse,
  type ListSessionsPayload,
  type ShutdownIfIdlePayload
} from '../shared/host-protocol'
import type { HostRequest } from '../shared/host-protocol'
import { ClientConnection } from './client-connection'
import { RegistryError, type PtyRegistry } from './pty-registry'

export type HostLogger = (entry: Record<string, unknown>) => void

export type ProtocolServerOptions = {
  socketPath: string
  token: string
  registry: PtyRegistry
  hostVersion: string
  startedAt: number
  log: HostLogger
  /** Injected for tests; defaults to process.pid. */
  hostPid?: number
}

export type ProtocolServer = {
  listening: Promise<void>
  close: () => Promise<void>
  /** Fan out a registry event to every authenticated and pending client. */
  broadcast: (event: HostEvent) => void
  connectedClients: () => number
  /** Force shutdown, used by the `shutdown` method and signal handlers. */
  requestShutdown: () => void
  onShutdownRequested: (listener: () => void) => void
}

function toHostError(error: unknown): HostError {
  if (error instanceof RegistryError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.detail ? { detail: error.detail } : {})
    }
  }
  return {
    code: 'INTERNAL',
    message: error instanceof Error ? error.message : 'Host request failed'
  }
}

function extractRequestId(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { id?: unknown }
    return typeof parsed.id === 'string' && parsed.id.length > 0 ? parsed.id : 'invalid'
  } catch {
    return 'invalid'
  }
}

function tokenMatches(expected: string, received: string): boolean {
  const a = Buffer.from(expected)
  const b = Buffer.from(received)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function createProtocolServer(options: ProtocolServerOptions): ProtocolServer {
  const hostPid = options.hostPid ?? process.pid
  const clients = new Set<ClientConnection>()
  const authenticatedClients = new WeakSet<ClientConnection>()
  let server: Server | null = null
  let shuttingDown = false
  let shutdownListener: (() => void) | null = null

  const respond = (client: ClientConnection, id: string, payload: unknown): void => {
    const response: HostResponse = { type: 'response', id, ok: true, payload }
    client.sendResponse(response)
  }

  const fail = (client: ClientConnection, id: string, error: HostError): void => {
    const response: HostResponse = { type: 'response', id, ok: false, error }
    client.sendResponse(response)
  }

  const broadcast = (event: HostEvent): void => {
    // Never leak terminal output to a socket that has not authenticated.
    for (const client of clients) {
      if (authenticatedClients.has(client)) client.sendEvent(event)
    }
  }

  const handleRequest = (client: ClientConnection, request: HostRequest): void => {
    try {
      switch (request.method) {
        case 'createOrAttach': {
          const result = options.registry.createOrAttach(request.params)
          client.clearLag(`${result.info.sessionId}:${result.info.incarnationId}`)
          void options.registry
            .snapshot(result.info.sessionId)
            .then((snapshot) =>
              respond(client, request.id, {
                ...result.info,
                created: result.created,
                snapshot
              })
            )
            .catch((error: unknown) => fail(client, request.id, toHostError(error)))
          return
        }
        case 'write': {
          options.registry.write(request.params.sessionId, request.params.incarnationId, request.params.data)
          respond(client, request.id, {})
          return
        }
        case 'resize': {
          options.registry.resize(
            request.params.sessionId,
            request.params.incarnationId,
            request.params.cols,
            request.params.rows
          )
          respond(client, request.id, {
            cols: request.params.cols,
            rows: request.params.rows
          })
          return
        }
        case 'kill': {
          const signaled = options.registry.kill(request.params.sessionId)
          respond(client, request.id, { signaled })
          return
        }
        case 'listSessions': {
          const payload: ListSessionsPayload = {
            hostPid,
            startedAt: options.startedAt,
            sessions: options.registry.list(),
            liveSessions: options.registry.liveCount(),
            connectedClients: clients.size
          }
          respond(client, request.id, payload)
          return
        }
        case 'ping': {
          respond(client, request.id, { hostPid })
          return
        }
        case 'shutdownIfIdle': {
          const live = options.registry.liveCount()
          const others = Math.max(0, clients.size - 1)
          if (live > 0) {
            const payload: ShutdownIfIdlePayload = {
              shutdown: false,
              reason: 'live_sessions',
              liveSessions: live,
              connectedClients: clients.size
            }
            respond(client, request.id, payload)
            return
          }
          if (others > 0) {
            const payload: ShutdownIfIdlePayload = {
              shutdown: false,
              reason: 'connected_clients',
              liveSessions: live,
              connectedClients: clients.size
            }
            respond(client, request.id, payload)
            return
          }
          respond(client, request.id, {
            shutdown: true,
            reason: 'idle',
            liveSessions: 0,
            connectedClients: 1
          } satisfies ShutdownIfIdlePayload)
          requestShutdown()
          return
        }
        case 'shutdown': {
          respond(client, request.id, {})
          requestShutdown()
          return
        }
        default: {
          // Unreachable through the schema, kept as defense in depth.
          const unknown = request as unknown as { id: string }
          fail(client, unknown.id, { code: 'BAD_REQUEST', message: 'Unsupported method' })
        }
      }
    } catch (error) {
      fail(client, request.id, toHostError(error))
    }
  }

  const handleFrame = (client: ClientConnection, raw: string): void => {
    const parsed = client.parseFrame(raw)
    if (!parsed.ok) {
      const { error } = parsed
      // Echo the request id when the envelope still carries one, so a client
      // can correlate a schema rejection instead of waiting for a timeout.
      const id = extractRequestId(raw)
      if (error.code === 'BAD_REQUEST' && error.message.includes('Malformed JSON')) {
        fail(client, id, error)
        client.destroy()
        return
      }
      fail(client, id, error)
      if (error.fatal) client.destroy()
      return
    }

    const message = parsed.value
    if (message.type === 'hello') {
      const versionError = checkHelloProtocolVersion(message)
      if (versionError) {
        sendHelloFailure(client, versionError)
        return
      }
      if (!tokenMatches(options.token, message.token)) {
        options.log({ event: 'auth-failed', clientId: message.clientId })
        sendHelloFailure(client, { code: 'AUTH_FAILED', message: 'Invalid host token' })
        return
      }
      authenticatedClients.add(client)
      const hello: HostHelloResponse = {
        type: 'hello',
        ok: true,
        protocolVersion: HOST_PROTOCOL_VERSION,
        hostPid,
        startedAt: options.startedAt,
        hostVersion: options.hostVersion
      }
      client.send(hello)
      options.log({ event: 'client-connected', clientId: message.clientId })
      return
    }

    if (!authenticatedClients.has(client)) {
      fail(client, message.id, { code: 'AUTH_FAILED', message: 'Hello handshake required' })
      client.destroy()
      return
    }
    handleRequest(client, message)
  }

  const sendHelloFailure = (client: ClientConnection, error: HostError): void => {
    client.send({ type: 'hello', ok: false, error })
    client.destroy()
  }

  const requestShutdown = (): void => {
    if (shuttingDown) return
    shuttingDown = true
    options.log({ event: 'shutdown-requested' })
    shutdownListener?.()
  }

  const listening = new Promise<void>((resolve, reject) => {
    server = createServer((socket) => {
      const client: ClientConnection = new ClientConnection({
        socket,
        onFrame: handleFrame,
        onClose: (closed) => {
          clients.delete(closed)
        },
        onProtocolViolation: (violating, error) => {
          options.log({ event: 'protocol-violation', code: error.code, message: error.message })
          violating.send({
            type: 'response',
            id: 'frame',
            ok: false,
            error
          })
        }
      })
      clients.add(client)
    })
    server.once('error', reject)
    server.listen(options.socketPath, () => {
      try {
        chmodSync(options.socketPath, 0o600)
      } catch {
        // verified by the caller through stat
      }
      options.log({ event: 'host-started', socket: options.socketPath, pid: hostPid })
      resolve()
    })
  })

  return {
    listening,
    broadcast,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of clients) client.destroy()
        clients.clear()
        if (!server) {
          resolve()
          return
        }
        server.close(() => resolve())
        server = null
      }),
    connectedClients: () => clients.size,
    requestShutdown,
    onShutdownRequested: (listener) => {
      shutdownListener = listener
    }
  }
}
