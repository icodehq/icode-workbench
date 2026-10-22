import { afterEach, describe, expect, it } from 'vitest'
import { createFakePtyFactory, FakePty } from './fake-pty'
import { MAX_CLIENT_QUEUE_BYTES, ClientConnection } from './client-connection'
import { connectTestClient, startTestHost, type TestHost } from './test-host'
import type { HostEvent } from '../shared/host-protocol'

const hosts: TestHost[] = []
const clients: Array<{ close: () => void }> = []

afterEach(async () => {
  while (clients.length > 0) clients.pop()?.close()
  while (hosts.length > 0) await hosts.pop()?.cleanup()
  FakePty.reset()
})

function createParams(sessionId: string) {
  return { sessionId, cwd: process.cwd(), command: '/bin/bash', cols: 100, rows: 30 }
}

describe('per-client output queue', () => {
  type FakeSocket = {
    writes: string[]
    writable: boolean
    setNoDelay: () => void
    on: (event: string, handler: () => void) => void
    write: (data: string) => boolean
    destroy: () => void
    drain: () => void
    blocked: boolean
  }

  function fakeSocket(): FakeSocket {
    const handlers: Record<string, Array<() => void>> = {}
    return {
      writes: [],
      writable: true,
      blocked: true,
      setNoDelay: () => {},
      on(event, handler) {
        ;(handlers[event] ??= []).push(handler)
      },
      write(data: string) {
        this.writes.push(data)
        // Simulate a slow client with a full kernel buffer until drain().
        return !this.blocked
      },
      destroy: () => {},
      drain() {
        this.blocked = false
        for (const handler of handlers.drain ?? []) handler()
      }
    }
  }

  it('drops data for a lagging client and emits one lagged notice', () => {
    const socket = fakeSocket()
    const client = new ClientConnection({
      socket: socket as unknown as import('node:net').Socket,
      onFrame: () => {},
      onClose: () => {}
    })

    const chunk = 'x'.repeat(200_000)
    for (let seq = 1; seq <= 12; seq += 1) {
      const event: HostEvent = {
        type: 'event',
        event: 'data',
        sessionId: 'ses_slow',
        incarnationId: 'abcdef1234567890',
        seq,
        data: chunk
      }
      client.sendEvent(event)
    }

    // Let the socket accept queued bytes; the lag notice was queued behind them.
    socket.drain()
    const lagged = socket.writes
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as HostEvent)
      .filter((event) => event.event === 'lagged')
    expect(lagged).toHaveLength(1)
    const notice = lagged[0]!
    if (notice.event !== 'lagged') throw new Error('unreachable')
    expect(notice).toMatchObject({
      sessionId: 'ses_slow',
      incarnationId: 'abcdef1234567890'
    })
    expect(notice.toSeq).toBeGreaterThan(notice.fromSeq)
    expect(client.queuedByteCount).toBeLessThanOrEqual(MAX_CLIENT_QUEUE_BYTES)
  })

  it('keeps responses even when data is dropped', () => {
    const socket = fakeSocket()
    const client = new ClientConnection({
      socket: socket as unknown as import('node:net').Socket,
      onFrame: () => {},
      onClose: () => {}
    })
    const chunk = 'y'.repeat(300_000)
    for (let seq = 1; seq <= 8; seq += 1) {
      client.sendEvent({
        type: 'event',
        event: 'data',
        sessionId: 'ses_slow',
        incarnationId: 'abcdef1234567890',
        seq,
        data: chunk
      })
    }
    client.sendResponse({ type: 'response', id: 'r1', ok: true, payload: { still: 'delivered' } })
    socket.drain()
    expect(socket.writes.join('')).toContain('still')
  })
})

describe('slow and healthy clients together', () => {
  it('one stalled client does not stop another from receiving output', async () => {
    const fake = createFakePtyFactory()
    const host = await startTestHost({ ptyFactory: fake.factory })
    hosts.push(host)

    const healthy = await connectTestClient(host.paths, host.token)
    clients.push(healthy)
    await healthy.request('createOrAttach', createParams('ses_fanout'))

    // A second client attaches, then stops reading entirely.
    const stalled = await connectTestClient(host.paths, host.token)
    clients.push(stalled)
    await stalled.request('createOrAttach', { ...createParams('ses_fanout'), attachOnly: true })
    stalled.socket.pause()

    const pty = fake.instances[0]!
    for (let i = 0; i < 20; i += 1) pty.emitData(`chunk-${i}-${'z'.repeat(20_000)}`)

    const seen = new Set<number>()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('healthy client did not receive output')), 6000)
      const check = (): void => {
        for (const message of healthy.messages) {
          if (message.type === 'event' && message.event === 'data') {
            seen.add(message.seq as number)
          }
        }
        if (seen.size >= 20) {
          clearTimeout(timer)
          resolve()
        } else {
          setTimeout(check, 25)
        }
      }
      check()
    })
    expect(seen.size).toBe(20)
    expect(host.events.filter((event) => event.event === 'data')).toHaveLength(20)
  })

  it('a reconnected client recovers a snapshot at the latest sequence', async () => {
    const fake = createFakePtyFactory()
    const host = await startTestHost({ ptyFactory: fake.factory })
    hosts.push(host)
    const client = await connectTestClient(host.paths, host.token)
    clients.push(client)
    // Wide terminal: 6 x 200 KB stays inside the 5,000-line scrollback.
    await client.request('createOrAttach', { ...createParams('ses_gap'), cols: 250 })
    const pty = fake.instances[0]!

    pty.emitData('before-gap')
    await client.waitFor((message) => message.event === 'data' && message.seq === 1)

    client.socket.pause()
    for (let i = 0; i < 6; i += 1) pty.emitData('z'.repeat(200_000))
    await new Promise((resolve) => setTimeout(resolve, 100))
    client.socket.resume()

    // Fresh attach must carry a snapshot at the latest sequence, and must be
    // explicit when scrollback was lost rather than silently pretending.
    const attached = await client.request('createOrAttach', {
      ...createParams('ses_gap'),
      cols: 250,
      attachOnly: true
    })
    const payload = attached.payload as {
      snapshot: { seq: number; data: string; truncated: boolean }
    }
    expect(payload.snapshot.seq).toBe(7)
    expect(payload.snapshot.truncated || payload.snapshot.data.includes('before-gap')).toBe(true)
  })
})
