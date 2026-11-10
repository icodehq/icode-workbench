import { afterEach, describe, expect, it } from 'vitest'
import { createFakePtyFactory, FakePty } from './fake-pty'
import { connectTestClient, socketMode, startTestHost, type TestHost } from './test-host'
import { MAX_FRAME_BYTES } from '../shared/host-protocol'

const hosts: TestHost[] = []
const clients: Array<{ close: () => void }> = []

function track<T extends { close: () => void }>(client: T): T {
  clients.push(client)
  return client
}

async function hostWith(fake: ReturnType<typeof createFakePtyFactory>): Promise<TestHost> {
  const host = await startTestHost({ ptyFactory: fake.factory })
  hosts.push(host)
  return host
}

afterEach(async () => {
  while (clients.length > 0) clients.pop()?.close()
  while (hosts.length > 0) await hosts.pop()?.cleanup()
  FakePty.reset()
})

const CWD = process.cwd()

function createParams(sessionId = 'ses_protocol-a') {
  return { sessionId, cwd: CWD, command: '/bin/bash', cols: 100, rows: 30 }
}

describe('handshake', () => {
  it('accepts the correct token and reports host identity', async () => {
    const fake = createFakePtyFactory()
    const host = await hostWith(fake)
    const client = track(await connectTestClient(host.paths, host.token))
    const hello = client.messages[0]!
    expect(hello).toMatchObject({ type: 'hello', ok: true, hostPid: 4242, protocolVersion: 2 })
  })

  it('rejects an invalid token and closes the connection', async () => {
    const fake = createFakePtyFactory()
    const host = await hostWith(fake)
    const client = track(await connectTestClient(host.paths, 'f'.repeat(64)))
    const hello = client.messages[0]!
    expect(hello).toMatchObject({ type: 'hello', ok: false })
    expect((hello.error as { code: string }).code).toBe('AUTH_FAILED')

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(client.socket.destroyed).toBe(true)
  })

  it('rejects an unsupported protocol version with a structured error', async () => {
    const fake = createFakePtyFactory()
    const host = await hostWith(fake)
    const client = track(await connectTestClient(host.paths, host.token, { protocolVersion: 9 }))
    const hello = client.messages[0]!
    expect((hello.error as { code: string }).code).toBe('UNSUPPORTED_VERSION')
    expect((hello.error as { message: string }).message).toContain('v9')
  })

  it('refuses a request sent before the handshake', async () => {
    const fake = createFakePtyFactory()
    const host = await hostWith(fake)
    const socket = await connectTestClientRaw(host.paths.socket)
    socket.write(`${JSON.stringify({ type: 'request', id: 'early', method: 'ping', params: {} })}\n`)
    const reply = await socket.next()
    expect(reply).toMatchObject({ type: 'response', ok: false })
    expect((reply.error as { code: string }).code).toBe('AUTH_FAILED')
  })

  it.skipIf(process.platform === 'win32')(
    'reports effective private permissions for token and socket',
    async () => {
    const fake = createFakePtyFactory()
    const host = await hostWith(fake)
    expect(socketMode(host.paths.token)).toBe('600')
    expect(socketMode(host.paths.socket)).toBe('600')
  })
})

describe('request validation', () => {
  async function authed(): Promise<{
    host: TestHost
    fake: ReturnType<typeof createFakePtyFactory>
    client: Awaited<ReturnType<typeof connectTestClient>>
  }> {
    const fake = createFakePtyFactory()
    const host = await hostWith(fake)
    const client = track(await connectTestClient(host.paths, host.token))
    return { host, fake, client }
  }

  it('creates, lists, and pings', async () => {
    const { client } = await authed()
    const create = await client.request('createOrAttach', createParams())
    expect(create).toMatchObject({ ok: true })
    const payload = create.payload as { created: boolean; snapshot: { data: string } }
    expect(payload.created).toBe(true)
    expect(payload.snapshot.data).toBeDefined()

    const list = await client.request('listSessions')
    expect(list.payload).toMatchObject({ liveSessions: 1, connectedClients: 1 })
    expect((list.payload as { sessions: unknown[] }).sessions).toHaveLength(1)

    const ping = await client.request('ping')
    expect(ping.payload).toMatchObject({ hostPid: 4242 })
  })

  it('rejects an unknown method', async () => {
    const { client } = await authed()
    const reply = await client.request('exec', { command: 'rm' })
    expect(reply).toMatchObject({ ok: false })
    expect((reply.error as { code: string }).code).toBe('BAD_REQUEST')
    expect((reply.error as { message: string }).message).toContain('Unsupported request method: exec')
  })

  it('rejects invalid dimensions, relative cwd, and extra fields', async () => {
    const { client } = await authed()
    const badSize = await client.request('createOrAttach', { ...createParams(), cols: 0 })
    expect((badSize.error as { code: string }).code).toBe('BAD_REQUEST')

    const relative = await client.request('createOrAttach', {
      ...createParams(),
      cwd: 'relative/path'
    })
    expect((relative.error as { code: string }).code).toBe('BAD_REQUEST')

    const extra = await client.request('ping', { surprise: true })
    expect(extra).toMatchObject({ ok: false })
  })

  it('rejects an unknown top-level message type', async () => {
    const { client } = await authed()
    client.raw(JSON.stringify({ type: 'command', id: 'x' }))
    const reply = await client.waitFor(
      (message) => message.type === 'response' && message.id === 'x'
    )
    expect((reply.error as { message: string }).message).toContain('Unsupported host message type')
  })

  it('rejects malformed JSON and closes the socket', async () => {
    const { client } = await authed()
    client.raw('{ not json')
    await client.waitFor((message) => message.type === 'response' && message.id === 'invalid')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(client.socket.destroyed).toBe(true)
  })

  it('rejects an oversized frame without parsing it', async () => {
    const { client } = await authed()
    client.raw('x'.repeat(MAX_FRAME_BYTES + 1024))
    await client.waitFor(
      (message) =>
        message.type === 'response' &&
        (message.error as { code?: string } | undefined)?.code === 'FRAME_TOO_LARGE',
      // The x64 macOS runner can starve this socket for several seconds while
      // 100+ Vitest workers start; the protocol behavior is still immediate.
      15_000
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(client.socket.destroyed).toBe(true)
  })

  it('rejects a write that omits the incarnation', async () => {
    const { client } = await authed()
    const create = await client.request('createOrAttach', createParams())
    const incarnationId = (create.payload as { incarnationId: string }).incarnationId
    const missing = await client.request('write', { sessionId: 'ses_protocol-a', data: 'ls\r' })
    expect((missing.error as { code: string }).code).toBe('BAD_REQUEST')

    const ok = await client.request('write', {
      sessionId: 'ses_protocol-a',
      incarnationId,
      data: 'ls\r'
    })
    expect(ok).toMatchObject({ ok: true })
  })

  it('rejects a stale incarnation with a distinct error code', async () => {
    const { client } = await authed()
    const create = await client.request('createOrAttach', createParams())
    const oldIncarnation = (create.payload as { incarnationId: string }).incarnationId
    const reply = await client.request('write', {
      sessionId: 'ses_protocol-a',
      incarnationId: 'deadbeefdeadbeef',
      data: 'x'
    })
    expect((reply.error as { code: string }).code).toBe('STALE_INCARNATION')
    expect(oldIncarnation).not.toBe('deadbeefdeadbeef')
  })

  it('refuses attachOnly for an unknown session', async () => {
    const { client, fake } = await authed()
    const reply = await client.request('createOrAttach', {
      ...createParams('ses_missing-attach'),
      attachOnly: true
    })
    expect((reply.error as { code: string }).code).toBe('SESSION_NOT_FOUND')
    expect(fake.instances).toHaveLength(0)
  })

  it('returns one PTY for concurrent duplicate create requests', async () => {
    const { client, fake } = await authed()
    const ids = ['r1', 'r2', 'r3']
    for (const id of ids) {
      client.socket.write(
        `${JSON.stringify({ type: 'request', id, method: 'createOrAttach', params: createParams('ses_concurrent-proto') })}\n`
      )
    }
    const responses = await Promise.all(
      ids.map((id) => client.waitFor((message) => message.type === 'response' && message.id === id))
    )
    expect(responses.every((response) => response.ok === true)).toBe(true)
    const incarnations = new Set(
      responses.map((response) => (response.payload as { incarnationId: string }).incarnationId)
    )
    expect(incarnations.size).toBe(1)
    expect(fake.instances).toHaveLength(1)
    expect(
      responses.filter((response) => (response.payload as { created: boolean }).created)
    ).toHaveLength(1)
  })
})

describe('unauthenticated sockets', () => {
  it('receive no session events before completing the handshake', async () => {
    const fake = createFakePtyFactory()
    const host = await hostWith(fake)
    const authed = track(await connectTestClient(host.paths, host.token))
    await authed.request('createOrAttach', createParams('ses_no-leak'))

    const raw = await connectTestClientRaw(host.paths.socket)
    fake.instances[0]!.emitData('SECRET-OUTPUT')
    await authed.waitFor((message) => message.event === 'data')

    const drained = await Promise.race([
      raw.next().then(() => 'message'),
      new Promise<'silent'>((resolve) => setTimeout(() => resolve('silent'), 200))
    ])
    expect(drained).toBe('silent')
  })
})

describe('shutdown semantics', () => {
  it('refuses shutdownIfIdle while a PTY is live', async () => {
    const fake = createFakePtyFactory()
    const host = await hostWith(fake)
    const client = track(await connectTestClient(host.paths, host.token))
    await client.request('createOrAttach', createParams())
    const reply = await client.request('shutdownIfIdle')
    expect(reply.payload).toMatchObject({ shutdown: false, reason: 'live_sessions', liveSessions: 1 })
  })

  it('refuses shutdownIfIdle while another client is connected', async () => {
    const fake = createFakePtyFactory()
    const host = await hostWith(fake)
    const first = track(await connectTestClient(host.paths, host.token))
    const second = track(await connectTestClient(host.paths, host.token))
    const reply = await first.request('shutdownIfIdle')
    expect(reply.payload).toMatchObject({ shutdown: false, reason: 'connected_clients' })
    expect(second.authenticated).toBe(true)
  })

  it('shuts down when idle and no other client is connected', async () => {
    const fake = createFakePtyFactory()
    const host = await hostWith(fake)
    const client = track(await connectTestClient(host.paths, host.token))
    const reply = await client.request('shutdownIfIdle')
    expect(reply.payload).toMatchObject({ shutdown: true, reason: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(host.server.connectedClients()).toBe(0)
  })

  it('disconnect does not affect sessions', async () => {
    const fake = createFakePtyFactory()
    const host = await hostWith(fake)
    const first = await connectTestClient(host.paths, host.token)
    await first.request('createOrAttach', createParams('ses_survives-disconnect'))
    first.close()
    await new Promise((resolve) => setTimeout(resolve, 50))

    const second = track(await connectTestClient(host.paths, host.token))
    const list = await second.request('listSessions')
    expect(list.payload).toMatchObject({ liveSessions: 1, connectedClients: 1 })
  })
})

describe('multiple clients', () => {
  it('broadcasts one session to multiple clients without duplicate PTYs', async () => {
    const fake = createFakePtyFactory()
    const host = await hostWith(fake)
    const a = track(await connectTestClient(host.paths, host.token))
    const b = track(await connectTestClient(host.paths, host.token))

    await a.request('createOrAttach', createParams('ses_multi-client'))
    await b.request('createOrAttach', {
      ...createParams('ses_multi-client'),
      attachOnly: true
    })
    expect(fake.instances).toHaveLength(1)

    fake.instances[0]!.emitData('shared output')
    const eventA = await a.waitFor((message) => message.event === 'data')
    const eventB = await b.waitFor((message) => message.event === 'data')
    expect((eventA as { data: string }).data).toBe('shared output')
    expect(eventB).toMatchObject({ sessionId: 'ses_multi-client' })
  })
})

type RawClient = {
  socket: import('node:net').Socket
  write: (line: string) => void
  next: () => Promise<Record<string, unknown>>
}

async function connectTestClientRaw(path: string): Promise<RawClient> {
  const { connect } = await import('node:net')
  const socket = connect(path)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('error', reject)
  })
  const queue: Array<Record<string, unknown>> = []
  const waiters: Array<(message: Record<string, unknown>) => void> = []
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
      const waiter = waiters.shift()
      if (waiter) waiter(message)
      else queue.push(message)
    }
  })
  clients.push({ close: () => socket.destroy() })
  return {
    socket,
    write: (line) => socket.write(`${line}\n`),
    next: () =>
      queue.length > 0
        ? Promise.resolve(queue.shift()!)
        : new Promise((resolve) => waiters.push(resolve))
  }
}
