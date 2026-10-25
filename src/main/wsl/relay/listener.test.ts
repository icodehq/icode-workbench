import { connect, type Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import type { BridgeChild } from './bridge'
import { BRIDGE_READY } from './bridge-protocol'
import { startRelayListener, type RelayListener } from './listener'

const open: Array<RelayListener | Socket> = []
afterEach(async () => {
  for (const item of open.splice(0)) {
    if ('close' in item && typeof item.close === 'function') {
      await (item as RelayListener).close().catch(() => {})
    } else {
      ;(item as Socket).destroy()
    }
  }
})

/** A bridge child that echoes what it receives, after announcing readiness. */
function echoChild(announce = true): { child: BridgeChild; kill(): void; killed(): boolean } {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let killed = false
  if (announce) stdout.write(`${BRIDGE_READY}\n`)
  stdin.on('data', (chunk: Buffer) => stdout.write(chunk))
  return {
    child: {
      stdin,
      stdout,
      stderr,
      pid: 99,
      kill: () => {
        killed = true
        stdin.end()
        stdout.end()
      },
      exited: new Promise(() => {})
    },
    kill: () => {
      killed = true
    },
    killed: () => killed
  }
}

async function connectTo(port: number): Promise<Socket> {
  const socket = connect({ host: '127.0.0.1', port })
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  open.push(socket)
  return socket
}

function readAtLeast(socket: Socket, length: number, timeoutMs = 3_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${total}/${length} bytes`)),
      timeoutMs
    )
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk)
      total += chunk.length
      if (total >= length) {
        clearTimeout(timer)
        socket.off('data', onData)
        resolve(Buffer.concat(chunks))
      }
    }
    socket.on('data', onData)
  })
}

describe('binding', () => {
  it('listens on loopback and reports the port the OS assigned', async () => {
    const listener = await startRelayListener(async () => echoChild().child)
    open.push(listener)
    expect(listener.host).toBe('127.0.0.1')
    expect(listener.port).toBeGreaterThan(0)
  })

  it('accepts a connection on the reported port', async () => {
    const listener = await startRelayListener(async () => echoChild().child)
    open.push(listener)
    const socket = await connectTo(listener.port)
    socket.write('ping')
    await expect(readAtLeast(socket, 4)).resolves.toBeDefined()
  })

  it('fails loudly when the port is already taken', async () => {
    const first = await startRelayListener(async () => echoChild().child)
    open.push(first)
    await expect(
      startRelayListener(async () => echoChild().child, { port: first.port })
    ).rejects.toMatchObject({ code: 'EADDRINUSE' })
  })

  it('reports port 0 as a real, distinct port per listener', async () => {
    const a = await startRelayListener(async () => echoChild().child)
    const b = await startRelayListener(async () => echoChild().child)
    open.push(a, b)
    expect(a.port).toBeGreaterThan(0)
    expect(b.port).toBeGreaterThan(0)
    expect(a.port).not.toBe(b.port)
  })
})

describe('per-connection bridges', () => {
  it('opens exactly one bridge per connection', async () => {
    let opened = 0
    const listener = await startRelayListener(async () => {
      opened += 1
      return echoChild().child
    })
    open.push(listener)

    const a = await connectTo(listener.port)
    const b = await connectTo(listener.port)
    a.write('one')
    b.write('two')
    await Promise.all([readAtLeast(a, 3), readAtLeast(b, 3)])
    expect(opened).toBe(2)
    expect(listener.stats().accepted).toBe(2)
  })

  it('serves many concurrent clients without mixing their bytes', async () => {
    const listener = await startRelayListener(async () => echoChild().child)
    open.push(listener)

    const clients = await Promise.all(
      Array.from({ length: 6 }, async () => connectTo(listener.port))
    )
    const payloads = clients.map((_, index) => Buffer.from(`client-${index}-payload`))
    clients.forEach((socket, index) => socket.write(payloads[index]!))
    const received = await Promise.all(
      clients.map((socket, index) => readAtLeast(socket, payloads[index]!.length))
    )
    received.forEach((bytes, index) => {
      expect(bytes.subarray(0, payloads[index]!.length).equals(payloads[index]!)).toBe(true)
    })
  })

  it('keeps serving after one client disconnects', async () => {
    const listener = await startRelayListener(async () => echoChild().child)
    open.push(listener)
    const doomed = await connectTo(listener.port)
    doomed.write('bye')
    await readAtLeast(doomed, 3)
    doomed.destroy()
    await new Promise((resolve) => setTimeout(resolve, 100))

    const survivor = await connectTo(listener.port)
    survivor.write('still here')
    await expect(readAtLeast(survivor, 10)).resolves.toBeDefined()
  })
})

describe('admission bounds', () => {
  it('queues past the channel limit instead of opening unbounded bridges', async () => {
    let opened = 0
    const listener = await startRelayListener(
      async () => {
        opened += 1
        return echoChild().child
      },
      // A short half-close bound stands in for the guest bridge exiting, which is
      // what frees a slot in production.
      { maxChannels: 1, halfCloseGraceMs: 40 }
    )
    open.push(listener)

    const first = await connectTo(listener.port)
    const queued = await connectTo(listener.port)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(opened).toBe(1)
    expect(queued.destroyed).toBe(false)
    expect(listener.stats().queued).toBe(1)

    // Releasing the first slot admits the queued socket.
    first.destroy()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(opened).toBe(2)
  })

  it('drops a socket that waits past the queue timeout', async () => {
    const listener = await startRelayListener(async () => echoChild().child, {
      maxChannels: 1,
      queueTimeoutMs: 80
    })
    open.push(listener)
    const first = await connectTo(listener.port)
    const second = await connectTo(listener.port)
    const closed = new Promise<boolean>((resolve) => {
      second.once('close', () => resolve(true))
      second.once('error', () => resolve(true))
    })
    // A live first connection holds the only slot; the waiter is dropped.
    expect(await closed).toBe(true)
    first.destroy()
  })

  it('fails only the connection whose bridge cannot start', async () => {
    let attempt = 0
    const listener = await startRelayListener(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('wsl.exe missing')
      return echoChild().child
    })
    open.push(listener)

    const failed = await connectTo(listener.port)
    const failedClosed = new Promise<void>((resolve) => failed.once('close', () => resolve()))
    await failedClosed
    expect(listener.stats().failed).toBe(1)

    const next = await connectTo(listener.port)
    next.write('ok')
    await expect(readAtLeast(next, 2)).resolves.toBeDefined()
  })
})

describe('shutdown', () => {
  it('is idempotent and bounds its wait', async () => {
    const listener = await startRelayListener(async () => echoChild().child)
    const socket = await connectTo(listener.port)
    socket.write('x')
    await readAtLeast(socket, 1)

    const started = Date.now()
    await listener.close()
    await listener.close()
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(listener.closed).toBe(true)
  })

  it('reaps every bridge it opened', async () => {
    const children: Array<{ kill(): void; killed(): boolean }> = []
    const listener = await startRelayListener(async () => {
      const entry = echoChild()
      children.push(entry)
      return entry.child
    })
    const a = await connectTo(listener.port)
    const b = await connectTo(listener.port)
    a.write('a')
    b.write('b')
    await Promise.all([readAtLeast(a, 1), readAtLeast(b, 1)])

    await listener.close()
    expect(children).toHaveLength(2)
    expect(children.every((entry) => entry.killed())).toBe(true)
  })

  it('closes even when a client never closes its side', async () => {
    const listener = await startRelayListener(async () => echoChild().child, {
      closeTimeoutMs: 200
    })
    const socket = await connectTo(listener.port)
    socket.write('hold')
    await readAtLeast(socket, 4)
    // Deliberately never call `socket.destroy()`; the listener must not wait for it.
    const started = Date.now()
    await listener.close()
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('refuses new connections after close', async () => {
    const listener = await startRelayListener(async () => echoChild().child)
    const port = listener.port
    await listener.close()
    await expect(connectTo(port)).rejects.toBeTruthy()
  })
})
