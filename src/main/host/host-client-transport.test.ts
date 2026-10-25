/**
 * The transport union on `HostConnectionOptions`, exercised against the **real**
 * Host protocol over a TCP hop (no `wsl.exe`).
 *
 * The relay in production is: loopback TCP → `wsl.exe` bridge → Unix socket. This
 * test replaces only the middle hop with a plain TCP→socket proxy, which is enough
 * to prove that `{host, port}` carries the actual handshake, authentication,
 * framing and request/response semantics — not a mock of them.
 */

import { createServer, connect, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { startTestHost, type TestHost } from '../../host/test-host'
import { HostClient } from './host-client'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()!()
  }
})

/** Forwards each accepted TCP connection to the Host's Unix socket. */
async function tcpHopTo(socketPath: string): Promise<{ server: Server; port: number }> {
  const server = createServer({ allowHalfOpen: true }, (client: Socket) => {
    const upstream = connect(socketPath)
    client.pipe(upstream)
    upstream.pipe(client)
    client.on('error', () => upstream.destroy())
    upstream.on('error', () => client.destroy())
    client.on('close', () => upstream.destroy())
    upstream.on('close', () => client.destroy())
  })
  await new Promise<void>((resolve) =>
    server.listen({ host: '127.0.0.1', port: 0 }, resolve)
  )
  const address = server.address()
  return { server, port: typeof address === 'object' && address !== null ? address.port : 0 }
}

async function host(): Promise<TestHost> {
  const started = await startTestHost({
    ptyFactory: () => ({
      pid: 4321,
      cols: 80,
      rows: 24,
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      write: () => {},
      resize: () => {},
      kill: () => {}
    })
  })
  cleanup.push(() => started.cleanup())
  return started
}

describe('HostClient over TCP', () => {
  it('completes the real handshake and ping through {host, port}', async () => {
    const running = await host()
    const hop = await tcpHopTo(running.paths.socket)
    cleanup.push(() => new Promise<void>((resolve) => hop.server.close(() => resolve())))

    const client = await HostClient.connect({
      host: '127.0.0.1',
      port: hop.port,
      token: running.token
    })
    cleanup.push(() => client.close())

    await expect(client.ping()).resolves.toBeUndefined()
    expect(client.info?.protocolVersion).toBe(1)
    expect(client.info?.hostPid).toBeGreaterThan(0)
  })

  it('serves real requests over the TCP transport', async () => {
    const running = await host()
    const hop = await tcpHopTo(running.paths.socket)
    cleanup.push(() => new Promise<void>((resolve) => hop.server.close(() => resolve())))

    const client = await HostClient.connect({
      host: '127.0.0.1',
      port: hop.port,
      token: running.token
    })
    cleanup.push(() => client.close())

    await expect(client.listSessions()).resolves.toMatchObject({ sessions: [] })
  })

  it('rejects a wrong token through the TCP transport, as it does locally', async () => {
    const running = await host()
    const hop = await tcpHopTo(running.paths.socket)
    cleanup.push(() => new Promise<void>((resolve) => hop.server.close(() => resolve())))

    await expect(
      HostClient.connect({ host: '127.0.0.1', port: hop.port, token: 'not-the-token' })
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' })
  })

  it('reports a closed port as a connection failure, not a protocol error', async () => {
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen({ host: '127.0.0.1', port: 0 }, resolve))
    const address = probe.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    await new Promise<void>((resolve) => probe.close(() => resolve()))

    await expect(
      HostClient.connect({ host: '127.0.0.1', port, token: 'x', requestTimeoutMs: 2_000 })
    ).rejects.toMatchObject({ code: 'HOST_CONNECT_FAILED' })
  })

  it('still connects over a socket path, unchanged', async () => {
    const running = await host()
    const client = await HostClient.connect({
      socketPath: running.paths.socket,
      token: running.token
    })
    cleanup.push(() => client.close())
    await expect(client.ping()).resolves.toBeUndefined()
  })
})
