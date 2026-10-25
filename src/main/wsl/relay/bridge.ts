/**
 * One bridge child, its readiness handshake, and the pipe to one client socket.
 *
 * This module is deliberately separate from `WslCommandRunner`: that runner
 * collects and decodes the output of a *request*, which is right for a probe and
 * destructive for a byte stream. A relay must never decode, so it spawns the
 * child directly and moves raw `Buffer`s.
 *
 * Every exit path funnels through `close()`, which is idempotent: killing the
 * child twice, or closing a socket that the peer already dropped, is normal here
 * rather than an error to suppress at each call site.
 */

import { spawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import type { Socket } from 'node:net'
import {
  BRIDGE_NO_NODE,
  BRIDGE_READY,
  BRIDGE_REFUSED,
  HALF_CLOSE_GRACE_MS,
  buildBridgeArgs
} from './bridge-protocol'

/** What a login profile may print before the bridge starts; past this it is not a bridge. */
export const MAX_PRELUDE_BYTES = 64 * 1024
/** How much stderr to keep for the failure detail. */
const MAX_STDERR_BYTES = 2 * 1024

export type BridgeSignal = 'ready' | 'refused' | 'no-node' | 'not-a-bridge'

export type BridgeExit = {
  code: number | null
  signal: NodeJS.Signals | null
  /** `spawn` means the child never ran (missing `wsl.exe`, missing runtime). */
  reason: 'exit' | 'spawn'
}

export type BridgeChild = {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  pid: number | undefined
  kill(): void
  exited: Promise<BridgeExit>
}

export type BridgeChildDeps = {
  program: string
  cwd: string
  env: NodeJS.ProcessEnv
}

/** Production spawner: a detached-free streaming child, raw stdio. */
export function spawnBridgeChild(
  spec: { distro: string; nodePath: string; socketPath: string },
  deps: BridgeChildDeps
): BridgeChild {
  const child = spawn(deps.program, buildBridgeArgs(spec.distro, spec.nodePath, spec.socketPath), {
    cwd: deps.cwd,
    env: { ...deps.env, WSL_UTF8: '1' },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let settle: (exit: BridgeExit) => void = () => {}
  const exited = new Promise<BridgeExit>((resolve) => {
    settle = resolve
  })
  child.once('error', () => settle({ code: null, signal: null, reason: 'spawn' }))
  child.once('exit', (code, signal) => settle({ code, signal, reason: 'exit' }))
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    pid: child.pid,
    kill: () => {
      try {
        child.kill()
      } catch {
        // The child is already gone; the exit promise carries the outcome.
      }
    },
    exited
  }
}

/**
 * Splits the bridge's stdout into prelude and payload.
 *
 * Nothing is forwarded before `ready`, and nothing at all after a refusal: a
 * failure line must never be mistaken for protocol bytes. A bridge that prints
 * more than `MAX_PRELUDE_BYTES` without a sentinel is `not-a-bridge` — that is a
 * wrong runtime or a shell greeting loop, not a slow bridge.
 */
export function readBridgePrelude(
  pending: Buffer,
  chunk: Buffer
): { pending: Buffer; signal: BridgeSignal | null; payload: Buffer } {
  const combined = Buffer.concat([pending, chunk])
  let start = 0
  for (;;) {
    const newline = combined.indexOf(0x0a, start)
    if (newline === -1) {
      if (combined.length - start > MAX_PRELUDE_BYTES) {
        return { pending: Buffer.alloc(0), signal: 'not-a-bridge', payload: Buffer.alloc(0) }
      }
      return {
        pending: combined.subarray(start),
        signal: null,
        payload: Buffer.alloc(0)
      }
    }
    const line = combined.subarray(start, newline).toString('utf8').trim()
    if (line === BRIDGE_READY) {
      return { pending: Buffer.alloc(0), signal: 'ready', payload: combined.subarray(newline + 1) }
    }
    if (line.startsWith(BRIDGE_REFUSED)) {
      return { pending: Buffer.alloc(0), signal: 'refused', payload: Buffer.alloc(0) }
    }
    if (line === BRIDGE_NO_NODE || line.endsWith(BRIDGE_NO_NODE)) {
      return { pending: Buffer.alloc(0), signal: 'no-node', payload: Buffer.alloc(0) }
    }
    start = newline + 1
    if (start > MAX_PRELUDE_BYTES) {
      return { pending: Buffer.alloc(0), signal: 'not-a-bridge', payload: Buffer.alloc(0) }
    }
  }
}

export type BridgeConnectionFailure =
  | { kind: 'bridge'; signal: BridgeSignal }
  | { kind: 'bridge_exited'; exit: BridgeExit; stderr: string }
  | { kind: 'socket_error'; message: string }

export type BridgeConnectionHooks = {
  /** Called once, before any byte is forwarded. */
  onReady?: () => void
  /** Called exactly once, after teardown. `null` means the socket closed normally. */
  onClosed: (failure: BridgeConnectionFailure | null, bytes: { up: number; down: number }) => void
  /** Test seam: the half-close bound. */
  halfCloseGraceMs?: number
}

export type BridgeConnection = {
  /** Idempotent. Ends both directions and reaps the child. */
  close(): void
  done: Promise<void>
}

/**
 * Pipes one client socket through one bridge child.
 *
 * Ownership: this function owns the child for the connection's lifetime. It does
 * not know what the Host is, so it can never stop one — which is exactly the
 * property that keeps a client disconnect from killing the Guest Host.
 */
export function attachBridge(
  socket: Socket,
  child: BridgeChild,
  hooks: BridgeConnectionHooks
): BridgeConnection {
  const graceMs = hooks.halfCloseGraceMs ?? HALF_CLOSE_GRACE_MS
  let closed = false
  let failure: BridgeConnectionFailure | null = null
  let prelude: Buffer = Buffer.alloc(0)
  let ready = false
  let stderrTail = ''
  let halfCloseTimer: ReturnType<typeof setTimeout> | null = null
  let bytesUp = 0
  let bytesDown = 0

  let settle: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    settle = resolve
  })

  const teardown = (reason: BridgeConnectionFailure | null): void => {
    if (closed) return
    closed = true
    if (reason !== null) failure = reason
    if (halfCloseTimer) {
      clearTimeout(halfCloseTimer)
      halfCloseTimer = null
    }
    socket.destroy()
    child.kill()
    hooks.onClosed(failure, { up: bytesUp, down: bytesDown })
    settle()
  }

  child.stderr.on('data', (chunk: Buffer) => {
    // Kept only for the failure detail; never forwarded.
    if (stderrTail.length < MAX_STDERR_BYTES) {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(0, MAX_STDERR_BYTES)
    }
  })
  child.stderr.on('error', () => {})

  void child.exited.then((exit) => {
    if (closed) return
    // A clean exit after the client finished is still a closed connection, but it
    // is only a *failure* if the bridge never became ready.
    if (!ready) {
      teardown({ kind: 'bridge_exited', exit, stderr: stderrTail.trim() })
      return
    }
    teardown(null)
  })

  /**
   * Prelude phase, then `pipe()`.
   *
   * The hand-rolled `pause()`/`resume()` version of this deadlocked on large
   * payloads: a duplex socket is one object, so pausing the read direction while
   * waiting for the write direction to drain can stall both. `pipe()` handles the
   * same backpressure without that coupling, and it is what Orca's bridge uses.
   */
  const onStdout = (chunk: Buffer): void => {
    if (closed) return
    const parsed = readBridgePrelude(prelude, chunk)
    prelude = parsed.pending
    if (parsed.signal !== null && parsed.signal !== 'ready') {
      teardown({ kind: 'bridge', signal: parsed.signal })
      return
    }
    if (parsed.signal === 'ready') {
      ready = true
      child.stdout.off('data', onStdout)
      if (parsed.payload.length > 0) {
        bytesDown += parsed.payload.length
        socket.write(parsed.payload)
      }
      // `end: false` on the reverse leg: the socket's write side is closed by the
      // socket's own lifecycle, not by the bridge's stdout ending.
      child.stdout.pipe(socket, { end: false })
      hooks.onReady?.()
      return
    }
    if (parsed.payload.length > 0) {
      bytesDown += parsed.payload.length
      socket.write(parsed.payload)
    }
  }
  child.stdout.on('data', onStdout)
  child.stdout.on('error', () => teardown(null))

  // Forward leg: `end: false` so half-close stays explicit and bounded.
  // The extra listener only counts; `pipe()` owns the flow control.
  socket.on('data', (chunk: Buffer) => {
    bytesUp += chunk.length
  })
  socket.pipe(child.stdin, { end: false })
  socket.on('error', (error) => teardown({ kind: 'socket_error', message: error.message }))
  socket.on('close', () => teardown(null))

  socket.on('end', () => {
    if (closed) return
    // Half-close: the client is done writing, but still wants its replies.
    child.stdin.end()
    halfCloseTimer = setTimeout(() => teardown(null), graceMs)
    halfCloseTimer.unref?.()
  })
  socket.on('error', (error) => teardown({ kind: 'socket_error', message: error.message }))
  socket.on('close', () => teardown(null))

  return {
    close: () => teardown(null),
    done
  }
}
