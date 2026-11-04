/**
 * The guest half of one relay connection.
 *
 * A constant script, run by the pinned Node that W3 shipped and W4 deployed. It
 * dials the Host's Unix socket and pipes its own stdin/stdout to it, which turns
 * `wsl.exe --exec` into a byte pipe over an arbitrary Windows-side transport.
 *
 * Why a Unix socket and not Orca's loopback TCP: iCode's Host listens on a socket
 * path (`ICODE_HOST_SOCKET`), and a path is also what proves the endpoint belongs
 * to this profile — see `endpoint.ts`. The piping rules are Orca's, because they
 * are what makes a bridge survive real traffic:
 *
 *   - a **sentinel line first**, so the listener can skip anything a login
 *     profile prints and tell "running" from "could not start";
 *   - raw Buffers, never text: the relay carries a framed binary protocol;
 *   - explicit backpressure in both directions, because either side can be the
 *     slow one;
 *   - **half-close with a grace period**: a client that ends its write direction
 *     still wants its replies, so the socket is only destroyed after a bound.
 */

/** Printed once the Host socket is connected. */
export const BRIDGE_READY = 'ICODE-STDIO-BRIDGE READY'
/** The Host socket refused the dial: the Host is not listening. */
export const BRIDGE_REFUSED = 'ICODE-STDIO-BRIDGE REFUSED'
/** The pinned runtime could not start the script at all. */
export const BRIDGE_NO_NODE = 'ICODE-STDIO-BRIDGE NO_NODE'

/**
 * Bounds a half-closed bridge whose Host side never closes after the client's
 * EOF. Without it one abandoned client would hold a `wsl.exe` forever.
 */
export const HALF_CLOSE_GRACE_MS = 30_000

/**
 * The script body. `process.argv[1]` is the socket path.
 *
 * Written as a single-quoted JS string so it survives `--exec` unchanged: no
 * shell is involved on the guest side, and the path arrives as argv rather than
 * being interpolated, so a path can never become code.
 */
export const BRIDGE_SCRIPT = `'use strict'
const net = require('net')
const socketPath = process.argv[1]
const out = process.stdout
const fail = (line) => {
  out.write(line + '\\n', () => process.exit(0))
}
out.on('error', () => process.exit(0))
let connected = false
const socket = net.connect({ path: socketPath })
socket.on('error', (error) => {
  if (!connected) fail(${JSON.stringify(BRIDGE_REFUSED)} + ' ' + String(error.code || 'ERROR'))
})
socket.on('close', () => {
  if (connected) out.write('', () => process.exit(0))
})
socket.on('connect', () => {
  connected = true
  out.write(${JSON.stringify(BRIDGE_READY)} + '\\n')
  const input = process.stdin
  input.on('error', () => socket.destroy())
  socket.on('error', () => process.exit(0))
  input.on('end', () => {
    socket.end()
    setTimeout(() => socket.destroy(), ${HALF_CLOSE_GRACE_MS}).unref()
  })
  // pipe() rather than hand-rolled pause/resume: a socket is one duplex object,
  // so manual pausing in both directions can stall the pair. This is the shape
  // Orca's bridge uses, and it is what makes multi-megabyte payloads reliable.
  input.pipe(socket, { end: false })
  socket.pipe(out, { end: false })
})
`

/** `wsl.exe` argv for one bridge. The socket path is argv, never shell syntax. */
export function buildBridgeArgs(distro: string, nodePath: string, socketPath: string): string[] {
  return ['-d', distro, '--exec', nodePath, '-e', BRIDGE_SCRIPT, socketPath]
}
