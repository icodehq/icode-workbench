import { connect } from 'node:net'
import type { Socket } from 'node:net'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MAX_FRAME_BYTES, type HostEvent, type HostRequest } from '../shared/host-protocol'
import { createPtyRegistry, type PtyLike } from './pty-registry'
import { createProtocolServer, type ProtocolServer } from './protocol-server'
import { prepareHostDirectory, writeToken, type HostPaths } from './paths'

export type TestHost = {
  dir: string
  paths: HostPaths
  token: string
  server: ProtocolServer
  events: HostEvent[]
  cleanup: () => Promise<void>
}

export type TestHostOptions = {
  ptyFactory: (config: {
    command: string
    args: string[]
    cwd: string
    cols: number
    rows: number
    env: Record<string, string>
  }) => PtyLike
  /** Override token/hello to exercise rejection paths. */
  rejectFrames?: boolean
}

export function makeHostPaths(root: string): HostPaths {
  const dir = join(root, 'state')
  return {
    dir,
    socket: join(root, 'socket', 'terminal-host.sock'),
    token: join(dir, 'token'),
    meta: join(dir, 'meta.json'),
    log: join(dir, 'host.log')
  }
}

export async function startTestHost(options: TestHostOptions): Promise<TestHost> {
  const dir = mkdtempSync(join(tmpdir(), 'icode-host-'))
  const paths = makeHostPaths(dir)
  prepareHostDirectory(paths)
  const token = writeToken(paths.token)
  const events: HostEvent[] = []
  let serverRef: ProtocolServer | null = null

  const registry = createPtyRegistry({
    ptyFactory: options.ptyFactory,
    events: {
      onData: (event) => {
        const message: HostEvent = { type: 'event', event: 'data', ...event }
        events.push(message)
        serverRef?.broadcast(message)
      },
      onSpawned: (event) => {
        const message: HostEvent = { type: 'event', event: 'spawned', ...event }
        events.push(message)
        serverRef?.broadcast(message)
      },
      onExit: (event) => {
        const message: HostEvent = { type: 'event', event: 'exit', ...event }
        events.push(message)
        serverRef?.broadcast(message)
      }
    }
  })

  const server = createProtocolServer({
    socketPath: paths.socket,
    token,
    registry,
    hostVersion: 'test',
    startedAt: Date.now(),
    log: () => {},
    hostPid: 4242
  })
  serverRef = server
  // Mirror the production host: a shutdown request closes the server.
  server.onShutdownRequested(() => {
    void server.close()
  })
  await server.listening

  return {
    dir,
    paths,
    token,
    server,
    events,
    cleanup: async () => {
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

export type TestClient = {
  socket: Socket
  messages: Array<Record<string, unknown>>
  waitFor: (predicate: (message: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>
  request: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
  raw: (line: string) => void
  close: () => void
  authenticated: boolean
}

export async function connectTestClient(
  paths: HostPaths,
  token: string,
  options: { protocolVersion?: number } = {}
): Promise<TestClient> {
  const socket = connect(paths.socket)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('error', reject)
  })
  const messages: Array<Record<string, unknown>> = []
  const waiters: Array<{
    predicate: (message: Record<string, unknown>) => boolean
    resolve: (message: Record<string, unknown>) => void
  }> = []
  let buffer = ''
  socket.on('data', (chunk) => {
    buffer += chunk.toString()
    for (;;) {
      const index = buffer.indexOf('\n')
      if (index === -1) break
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line) as Record<string, unknown>
      messages.push(message)
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        if (waiters[i]!.predicate(message)) {
          const waiter = waiters[i]!
          waiters.splice(i, 1)
          waiter.resolve(message)
        }
      }
    }
  })

  const waitFor = (
    predicate: (message: Record<string, unknown>) => boolean,
    timeoutMs = 3000
  ): Promise<Record<string, unknown>> => {
    const existing = messages.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for host message')), timeoutMs)
      waiters.push({
        predicate,
        resolve: (message) => {
          clearTimeout(timer)
          resolve(message)
        }
      })
    })
  }

  const client: TestClient = {
    socket,
    messages,
    waitFor,
    authenticated: false,
    raw: (line) => socket.write(`${line}\n`),
    request: async (method, params = {}) => {
      const id = randomUUID()
      const message = { type: 'request', id, method, params } as unknown as HostRequest
      socket.write(`${JSON.stringify(message)}\n`)
      const response = await waitFor(
        (message) => message.type === 'response' && message.id === id
      )
      return response
    },
    close: () => socket.destroy()
  }

  socket.write(
    `${JSON.stringify({
      type: 'hello',
      protocolVersion: options.protocolVersion ?? 1,
      token,
      clientId: `test-${randomUUID().slice(0, 8)}`
    })}\n`
  )
  const hello = await waitFor((message) => message.type === 'hello')
  if (hello.ok === true) client.authenticated = true
  return client
}

export function socketMode(path: string): string {
  return (statSync(path).mode & 0o777).toString(8).padStart(3, '0')
}

export { MAX_FRAME_BYTES }
