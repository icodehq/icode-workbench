/**
 * The Windows half of the relay: a loopback listener whose every accepted socket
 * rides its own bridge child.
 *
 * Shape follows Orca's stdio-bridge listener: admission and teardown live here,
 * the channel factory knows only how to open one bridge. That split is what makes
 * "one bridge per connection" structural rather than a convention — there is no
 * shared pipe to accidentally reuse.
 *
 * Three deliberate bounds:
 *
 *   - **loopback only.** The listener is never reachable off-machine; anything
 *     else would expose a Host authenticated only by a local token.
 *   - **concurrency + queue timeout.** Each bridge is a `wsl.exe` process, so
 *     unbounded admission is a fork bomb with extra steps. Over the limit a
 *     socket waits, and a socket that waits too long is dropped.
 *   - **bounded close.** Closing must not depend on a peer that never closes; the
 *     listener destroys its sockets and stops waiting after a deadline.
 */

import { createServer, type Server, type Socket } from 'node:net'
import { attachBridge, type BridgeChild, type BridgeConnection, type BridgeConnectionFailure } from './bridge'

/** Concurrent bridges. Each is one `wsl.exe`; Orca bounds this for the same reason. */
export const DEFAULT_MAX_CHANNELS = 8
/** How long an accepted socket may wait for a free slot. */
export const DEFAULT_QUEUE_TIMEOUT_MS = 30_000
/** How long `close()` waits for `server.close()` after destroying its sockets. */
export const DEFAULT_CLOSE_TIMEOUT_MS = 5_000

export type BridgeChannelFactory = () => Promise<BridgeChild>

export type RelayListenerOptions = {
  /** Port 0 asks the OS for one; the listener reports what it actually got. */
  port?: number
  host?: string
  maxChannels?: number
  queueTimeoutMs?: number
  closeTimeoutMs?: number
  halfCloseGraceMs?: number
  /** Diagnostics only: every connection outcome, never used for control flow. */
  onConnectionClosed?: (failure: BridgeConnectionFailure | null) => void
}

export type RelayListener = {
  host: string
  /** The bound port, read from the server after `listen`. */
  port: number
  close(): Promise<void>
  readonly closed: boolean
  stats(): { accepted: number; active: number; queued: number; failed: number }
}

type Waiting = { socket: Socket; timer: ReturnType<typeof setTimeout>; entry: number }

/**
 * Starts listening. Resolves only once the port is actually bound, so a caller
 * never hands out an endpoint that is not accepting yet.
 */
export async function startRelayListener(
  openChannel: BridgeChannelFactory,
  options: RelayListenerOptions = {}
): Promise<RelayListener> {
  const host = options.host ?? '127.0.0.1'
  const maxChannels = options.maxChannels ?? DEFAULT_MAX_CHANNELS
  const queueTimeoutMs = options.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS

  const sockets = new Set<Socket>()
  const connections = new Set<BridgeConnection>()
  const waiting: Waiting[] = []
  let active = 0
  let accepted = 0
  let failed = 0
  let closed = false
  let sequence = 0

  const admitNext = (): void => {
    while (!closed && active < maxChannels) {
      const next = waiting.shift()
      if (!next) return
      clearTimeout(next.timer)
      accepted += 1
      void openFor(next.socket)
    }
  }

  const openFor = async (socket: Socket): Promise<void> => {
    if (closed || socket.destroyed) return
    active += 1
    let child: BridgeChild
    try {
      child = await openChannel()
    } catch {
      // A bridge that cannot start drops its own socket and frees its slot; the
      // Host is untouched, so the next connection can still succeed.
      failed += 1
      active -= 1
      socket.destroy()
      admitNext()
      return
    }
    if (closed || socket.destroyed) {
      child.kill()
      active -= 1
      admitNext()
      return
    }
    const connection = attachBridge(socket, child, {
      ...(options.halfCloseGraceMs !== undefined
        ? { halfCloseGraceMs: options.halfCloseGraceMs }
        : {}),
      onClosed: (failure) => {
        if (failure !== null) failed += 1
        options.onConnectionClosed?.(failure)
      }
    })
    connections.add(connection)
    void connection.done.then(() => {
      connections.delete(connection)
      if (!closed) {
        active -= 1
        admitNext()
      }
    })
  }

  // `allowHalfOpen` is required, not a preference: with Node's default the server
  // side ends its writable half as soon as the client sends EOF, which makes
  // "client finished writing, still wants replies" impossible and turns every
  // half-close into a teardown.
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket)
    socket.setNoDelay(true)
    socket.on('error', () => socket.destroy())
    const entry: Waiting = {
      socket,
      entry: ++sequence,
      timer: setTimeout(() => {
        const index = waiting.indexOf(entry)
        if (index !== -1) waiting.splice(index, 1)
        failed += 1
        socket.destroy()
      }, queueTimeoutMs)
    }
    socket.on('close', () => {
      sockets.delete(socket)
      clearTimeout(entry.timer)
      const index = waiting.indexOf(entry)
      if (index !== -1) waiting.splice(index, 1)
    })
    waiting.push(entry)
    admitNext()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host, port: options.port ?? 0, exclusive: true }, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    for (const item of waiting.splice(0)) {
      clearTimeout(item.timer)
      item.socket.destroy()
    }
    // Sockets first, then the server: `close()` only resolves once every
    // connection is gone, and a peer that never closes must not hold it open.
    for (const socket of sockets) socket.destroy()
    for (const connection of connections) connection.close()
    sockets.clear()

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, closeTimeoutMs)
      timer.unref?.()
      server.close(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  return {
    host,
    port,
    close,
    get closed() {
      return closed
    },
    stats: () => ({ accepted, active, queued: waiting.length, failed })
  }
}
