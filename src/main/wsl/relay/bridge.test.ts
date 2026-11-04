import { createHash, randomBytes } from 'node:crypto'
import { createServer, connect as netConnect, type Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  attachBridge,
  MAX_PRELUDE_BYTES,
  readBridgePrelude,
  type BridgeChild,
  type BridgeConnectionFailure,
  type BridgeExit
} from './bridge'
import { BRIDGE_NO_NODE, BRIDGE_READY, BRIDGE_REFUSED } from './bridge-protocol'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

type FakeChild = {
  child: BridgeChild
  /** What the guest actually received (stdin, fully drained as a real bridge does). */
  guestBytes: () => Buffer
  /** Guest → client bytes (the bridge's stdout). */
  toClient: PassThrough
  /** Client → guest bytes (the bridge's stdin). */
  fromClient: PassThrough
  /** The bridge's stderr, writable for failure diagnostics. */
  stderr: PassThrough
  killed: () => boolean
  finish(code?: number | null): void
}

function fakeChild(): FakeChild {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const guestChunks: Buffer[] = []
  // A real bridge reads its stdin continuously; a fake that does not would apply
  // backpressure forever and make the test lie about truncation.
  stdin.on('data', (chunk: Buffer) => guestChunks.push(chunk))
  let killed = false
  let settle: (exit: BridgeExit) => void = () => {}
  const exited = new Promise<BridgeExit>((resolve) => {
    settle = resolve
  })
  return {
    child: {
      stdin,
      stdout,
      stderr,
      pid: 1234,
      kill: () => {
        killed = true
      },
      exited
    },
    guestBytes: () => Buffer.concat(guestChunks),
    toClient: stdout,
    fromClient: stdin,
    stderr,
    killed: () => killed,
    finish: (code: number | null = 0) => settle({ code, signal: null, reason: 'exit' })
  }
}

/**
 * A loopback pair standing in for the relay listener.
 *
 * `serverSide` is what `attachBridge` receives — an *accepted* connection — and
 * `client` is the peer, which is where reverse-direction bytes arrive and where
 * a client disconnect is simulated.
 */
type TestPair = { serverSide: Socket; client: Socket; guestReceived: () => Buffer }

async function clientServer(): Promise<TestPair> {
  let accepted: Socket | null = null
  const acceptedReady = new Promise<void>((resolve) => {
    // Half-open, matching the listener: otherwise the accepted socket ends its
    // writable half on the client's EOF and half-close cannot be tested.
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      accepted = socket
      resolve()
    })
    void new Promise<void>((listen) =>
      server.listen({ host: '127.0.0.1', port: 0 }, () => listen())
    ).then(() => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      client = netConnect({ host: '127.0.0.1', port })
    })
    cleanups.push(() => {
      client?.destroy()
      accepted?.destroy()
      server.close()
    })
  })
  let client: Socket | null = null
  await acceptedReady
  await new Promise<void>((resolve) => client!.once('connect', resolve))
  const chunks: Buffer[] = []
  accepted!.on('data', (chunk: Buffer) => chunks.push(chunk))
  return { serverSide: accepted!, client: client!, guestReceived: () => Buffer.concat(chunks) }
}

/** Everything a socket receives, tracked without end-of-stream semantics. */
function sinkFor(socket: Socket): { readonly length: number; bytes: () => Buffer } {
  const chunks: Buffer[] = []
  socket.on('data', (chunk: Buffer) => chunks.push(chunk))
  return {
    get length() {
      return chunks.reduce((total, chunk) => total + chunk.length, 0)
    },
    bytes: () => Buffer.concat(chunks)
  }
}

function sha(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

const tick = (ms = 100) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('prelude parsing', () => {
  it('skips a login banner and reports ready', () => {
    const result = readBridgePrelude(
      Buffer.alloc(0),
      Buffer.from(`Welcome to Ubuntu\nrun updates\n${BRIDGE_READY}\npayload`)
    )
    expect(result.signal).toBe('ready')
    expect(result.payload.toString()).toBe('payload')
  })

  it('waits across chunk boundaries', () => {
    const first = readBridgePrelude(Buffer.alloc(0), Buffer.from('ICODE-STDIO-'))
    expect(first.signal).toBeNull()
    const second = readBridgePrelude(first.pending, Buffer.from('BRIDGE READY\ndata'))
    expect(second.signal).toBe('ready')
    expect(second.payload.toString()).toBe('data')
  })

  it('forwards nothing before ready', () => {
    const result = readBridgePrelude(Buffer.alloc(0), Buffer.from('partial line without newline'))
    expect(result.signal).toBeNull()
    expect(result.payload).toHaveLength(0)
  })

  it('reports a refused dial', () => {
    const result = readBridgePrelude(Buffer.alloc(0), Buffer.from(`${BRIDGE_REFUSED} ENOENT\n`))
    expect(result.signal).toBe('refused')
    expect(result.payload).toHaveLength(0)
  })

  it('reports a missing pinned runtime', () => {
    expect(readBridgePrelude(Buffer.alloc(0), Buffer.from(`${BRIDGE_NO_NODE}\n`)).signal).toBe(
      'no-node'
    )
  })

  it('rejects output that never becomes a bridge', () => {
    const noise = Buffer.alloc(MAX_PRELUDE_BYTES + 10, 0x41)
    expect(readBridgePrelude(Buffer.alloc(0), noise).signal).toBe('not-a-bridge')
  })

  it('preserves payload bytes exactly after ready', () => {
    const payload = randomBytes(4096)
    const result = readBridgePrelude(
      Buffer.alloc(0),
      Buffer.concat([Buffer.from(`${BRIDGE_READY}\n`), payload])
    )
    expect(result.payload.equals(payload)).toBe(true)
  })
})

describe('connection piping', () => {
  it('carries binary payloads both ways, byte for byte', async () => {
    const { serverSide, client } = await clientServer()
    const fake = fakeChild()
    const failure: { value: BridgeConnectionFailure | null } = { value: null }
    const connection = attachBridge(serverSide, fake.child, {
      onClosed: (value) => {
        failure.value = value
      }
    })
    cleanups.push(() => connection.close())

    fake.toClient.write(`${BRIDGE_READY}\n`)

    const toClient = randomBytes(256 * 1024)
    const toGuest = randomBytes(256 * 1024)
    const back = sinkFor(client)
    fake.toClient.write(toClient)
    client.write(toGuest)
    await tick(250)

    expect(back.length).toBe(toClient.length)
    expect(sha(back.bytes())).toBe(sha(toClient))

    fake.finish()
    await tick(100)
    const guestSide = fake.guestBytes()
    expect(guestSide.length).toBe(toGuest.length)
    expect(sha(guestSide)).toBe(sha(toGuest))
    expect(failure.value).toBeNull()
  })

  it('does not forward the sentinel to the client', async () => {
    const { serverSide, client } = await clientServer()
    const fake = fakeChild()
    const seen = sinkFor(client)
    const connection = attachBridge(serverSide, fake.child, { onClosed: () => {} })
    cleanups.push(() => connection.close())
    fake.toClient.write(`${BRIDGE_READY}\nhello`)
    await tick()
    expect(seen.bytes().toString()).toBe('hello')
  })

  it('tears down and reports a refusal without forwarding anything', async () => {
    const { serverSide } = await clientServer()
    const fake = fakeChild()
    const failure: { value: BridgeConnectionFailure | null } = { value: null }
    attachBridge(serverSide, fake.child, {
      onClosed: (value) => {
        failure.value = value
      }
    })
    fake.toClient.write(`${BRIDGE_REFUSED} ENOENT\n`)
    await tick()
    expect(failure.value).toMatchObject({ kind: 'bridge', signal: 'refused' })
    expect(fake.killed()).toBe(true)
  })

  it('reports a bridge that exited before it was ready', async () => {
    const { serverSide } = await clientServer()
    const fake = fakeChild()
    const failure: { value: BridgeConnectionFailure | null } = { value: null }
    attachBridge(serverSide, fake.child, {
      onClosed: (value) => {
        failure.value = value
      }
    })
    fake.stderr.write('node: cannot execute\n')
    fake.finish(127)
    await tick()
    const value = failure.value
    expect(value).toMatchObject({ kind: 'bridge_exited' })
    if (value !== null && value.kind === 'bridge_exited') {
      expect(value.exit.code).toBe(127)
      expect(value.stderr).toContain('cannot execute')
    }
  })

  it('half-closes the guest stdin and destroys only after the grace period', async () => {
    const { serverSide, client } = await clientServer()
    const fake = fakeChild()
    const closedAt: number[] = []
    const connection = attachBridge(serverSide, fake.child, {
      halfCloseGraceMs: 120,
      onClosed: () => closedAt.push(Date.now())
    })
    cleanups.push(() => connection.close())
    fake.toClient.write(`${BRIDGE_READY}\n`)
    await tick(30)
    const before = Date.now()
    client.end()
    await tick(40)
    // The read direction stays open during the grace window.
    expect(closedAt).toHaveLength(0)
    fake.toClient.write('late reply')
    await tick(150)
    expect(closedAt).toHaveLength(1)
    expect(closedAt[0]! - before).toBeGreaterThanOrEqual(100)
  })

  it('closes idempotently under repeated and racing teardown', async () => {
    const { serverSide, client } = await clientServer()
    const fake = fakeChild()
    let closes = 0
    const connection = attachBridge(serverSide, fake.child, {
      onClosed: () => {
        closes += 1
      }
    })
    fake.toClient.write(`${BRIDGE_READY}\n`)
    await tick(30)
    connection.close()
    connection.close()
    client.destroy()
    fake.finish()
    await connection.done
    expect(closes).toBe(1)
  })

  it('reaps the child when the client disconnects', async () => {
    const { serverSide, client } = await clientServer()
    const fake = fakeChild()
    // The bound is what makes this observable: a polite FIN leaves the reply
    // direction open until the grace expires, so the reaping must be bounded.
    const connection = attachBridge(serverSide, fake.child, {
      halfCloseGraceMs: 60,
      onClosed: () => {}
    })
    fake.toClient.write(`${BRIDGE_READY}\n`)
    await tick(30)
    client.destroy()
    await connection.done
    expect(fake.killed()).toBe(true)
  })

  it('applies backpressure instead of buffering without bound', async () => {
    const { serverSide, client } = await clientServer()
    const fake = fakeChild()
    const connection = attachBridge(serverSide, fake.child, { onClosed: () => {} })
    cleanups.push(() => connection.close())
    fake.toClient.write(`${BRIDGE_READY}\n`)
    // Stop the client from reading, then flood; the bridge must pause its source.
    client.pause()
    await tick(50)
    let paused = false
    fake.toClient.on('pause', () => {
      paused = true
    })
    for (let index = 0; index < 64; index += 1) fake.toClient.write(randomBytes(1024 * 1024))
    await tick(300)
    expect(paused).toBe(true)
    client.resume()
  })
})
