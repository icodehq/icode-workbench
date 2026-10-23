import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { isNamedPipe, namedPipe } from '../shared/domain/endpoint'

export type HostPaths = {
  dir: string
  socket: string
  token: string
  meta: string
  log: string
}

export type HostMeta = {
  pid: number
  startedAt: number
  protocolVersion: number
  hostVersion: string
  socket: string
  tokenFile: string
  dirMode: string
  tokenMode: string
  socketMode?: string
}

export class HostStartupError extends Error {
  constructor(
    readonly code: 'PERMISSIONS' | 'SOCKET_IN_USE' | 'SOCKET_PATH_INVALID' | 'SOCKET_STALE_UNSAFE',
    message: string
  ) {
    super(message)
    this.name = 'HostStartupError'
  }
}

export const HOST_SOCKET_NAME = 'terminal-host.sock'

/**
 * Linux `sockaddr_un.sun_path` is 108 bytes including the terminator. Staying
 * well below that leaves room for a caller's longer XDG_RUNTIME_DIR.
 */
const MAX_SOCKET_PATH_BYTES = 100

/**
 * Stable, filesystem-safe identity for one ADE profile directory.
 *
 * The runtime directory (`XDG_RUNTIME_DIR`) is shared by every ADE instance the
 * user runs, so the socket must be namespaced by profile. A truncated digest
 * keeps the name short, collision-resistant, and valid on any filesystem.
 */
export function profileSocketScope(profileDir: string): string {
  return createHash('sha256').update(resolve(profileDir)).digest('hex').slice(0, 12)
}

/**
 * Socket location: explicit override, then a profile-scoped directory on the
 * XDG runtime filesystem (supports Unix sockets and POSIX modes), then the
 * profile's own directory.
 *
 * Windows has no Unix-domain socket in the filesystem, and `listen()` there
 * only accepts a named pipe, so the endpoint becomes a deterministic pipe name
 * scoped to the profile. `ADE_HOST_SOCKET` still wins on every platform, which
 * is how the packaging gates pin an endpoint.
 *
 * The last POSIX fallback is still per-profile, so no branch can collide with
 * another ADE profile that shares the same runtime directory.
 */
export function hostSocketPath(options: {
  profileDir: string
  env: NodeJS.ProcessEnv
  /** Test seam: lets a test select the Windows branch without a Windows host. */
  platform?: NodeJS.Platform
}): string {
  const { profileDir, env } = options
  const platform = options.platform ?? process.platform
  const explicit = env.ADE_HOST_SOCKET
  if (explicit && explicit.length > 0) return explicit
  if (platform === 'win32') {
    return namedPipe('ade-host', profileSocketScope(profileDir))
  }
  const xdg = env.XDG_RUNTIME_DIR
  if (xdg && xdg.length > 0) {
    const scoped = join(xdg, 'ade', profileSocketScope(profileDir), HOST_SOCKET_NAME)
    if (Buffer.byteLength(scoped) <= MAX_SOCKET_PATH_BYTES) return scoped
  }
  return join(profileDir, HOST_SOCKET_NAME)
}

export function hostPathsFromEnv(env: NodeJS.ProcessEnv): HostPaths {
  const dir = env.ADE_HOST_DIR
  if (!dir) throw new Error('ADE_HOST_DIR is required')
  const socket = hostSocketPath({ profileDir: dir, env })
  return {
    dir,
    socket,
    token: join(dir, 'token'),
    meta: join(dir, 'meta.json'),
    log: join(dir, 'host.log')
  }
}

function modeOf(path: string): string {
  try {
    return (statSync(path).mode & 0o777).toString(8).padStart(3, '0')
  } catch {
    return 'unknown'
  }
}

/**
 * Verify effective modes rather than trusting chmod. On filesystems that
 * cannot enforce POSIX modes (e.g. DrvFs), refuse to run with an exposed token.
 */
export type PrepareOptions = {
  /** Test seam: lets a test model a filesystem that ignores chmod. */
  chmod?: (path: string, mode: number) => void
}

export function prepareHostDirectory(paths: HostPaths, options: PrepareOptions = {}): void {
  const chmod = options.chmod ?? chmodSync
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
  // A named pipe has no parent directory to create: `\\.\pipe` is a kernel
  // namespace, not a folder. Only the host's own directory exists on disk.
  const pipe = isNamedPipe(paths.socket)
  if (!pipe) mkdirSync(dirname(paths.socket), { recursive: true, mode: 0o700 })
  try {
    chmod(paths.dir, 0o700)
    if (!pipe) chmod(dirname(paths.socket), 0o700)
  } catch {
    // chmod support varies; verification below decides whether it is safe
  }

  const supportsPosixModes = process.platform !== 'win32'
  const dirMode = modeOf(paths.dir)
  if (supportsPosixModes && (Number.parseInt(dirMode, 8) & 0o077) !== 0) {
    throw new HostStartupError(
      'PERMISSIONS',
      `Host directory ${paths.dir} has mode ${dirMode}; expected 700. Move ADE_HOST_DIR to a filesystem that enforces POSIX permissions.`
    )
  }
}

export function writeToken(path: string): string {
  const token = randomBytes(32).toString('hex')
  const temp = `${path}.tmp-${process.pid}`
  const { writeFileSync } = require('node:fs') as typeof import('node:fs')
  writeFileSync(temp, token, { mode: 0o600 })
  try {
    chmodSync(temp, 0o600)
  } catch {
    // verified below
  }
  const mode = modeOf(temp)
  if (process.platform !== 'win32' && (Number.parseInt(mode, 8) & 0o077) !== 0) {
    rmSync(temp, { force: true })
    throw new HostStartupError(
      'PERMISSIONS',
      `Token file mode is ${mode}; expected 600. Refusing to expose the host token.`
    )
  }
  const { renameSync } = require('node:fs') as typeof import('node:fs')
  renameSync(temp, path)
  return token
}

export function readToken(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim() || null
  } catch {
    return null
  }
}

export function writeMeta(path: string, meta: HostMeta): void {
  const { writeFileSync, renameSync } = require('node:fs') as typeof import('node:fs')
  const temp = `${path}.tmp-${process.pid}`
  writeFileSync(temp, JSON.stringify(meta, null, 2), { mode: 0o600 })
  try {
    chmodSync(temp, 0o600)
  } catch {
    // metadata is non-secret
  }
  renameSync(temp, path)
}

export function readMeta(path: string): HostMeta | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (typeof record.pid !== 'number') return null
    return record as unknown as HostMeta
  } catch {
    return null
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function canConnect(socketPath: string): Promise<'connected' | 'refused' | 'unknown'> {
  return new Promise((resolve) => {
    const socket = connect(socketPath)
    const timer = setTimeout(() => {
      socket.destroy()
      resolve('unknown')
    }, 500)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve('connected')
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      if (error.code === 'ECONNREFUSED') resolve('refused')
      else resolve('unknown')
    })
  })
}

/**
 * Never unlink an arbitrary path. Only a socket whose recorded owner is dead and
 * which actively refuses connections is removed.
 */
export async function acquireSocketPath(paths: HostPaths): Promise<void> {
  // A named pipe is not a filesystem object: there is nothing to stat, no mode
  // to verify, and nothing to unlink. Ownership is resolved by the kernel, and a
  // live peer surfaces as EADDRINUSE when the server binds.
  if (isNamedPipe(paths.socket)) return
  if (!existsSync(paths.socket)) return
  let stats
  try {
    stats = lstatSync(paths.socket)
  } catch {
    return
  }
  if (!stats.isSocket()) {
    throw new HostStartupError(
      'SOCKET_PATH_INVALID',
      `Refusing to use ${paths.socket}: it exists and is not a Unix socket.`
    )
  }

  const connection = await canConnect(paths.socket)
  if (connection === 'connected') {
    throw new HostStartupError(
      'SOCKET_IN_USE',
      `Another terminal host is already listening on ${paths.socket}.`
    )
  }
  if (connection === 'unknown') {
    throw new HostStartupError(
      'SOCKET_STALE_UNSAFE',
      `Cannot prove ${paths.socket} is stale (connection attempt was inconclusive). Refusing to remove it.`
    )
  }

  const meta = readMeta(paths.meta)
  if (meta && isAlive(meta.pid)) {
    throw new HostStartupError(
      'SOCKET_STALE_UNSAFE',
      `Socket ${paths.socket} is not accepting connections but host pid ${meta.pid} is still alive.`
    )
  }
  rmSync(paths.socket, { force: true })
}

export function cleanupHostFiles(paths: HostPaths): void {
  const files = isNamedPipe(paths.socket)
    ? [paths.token, paths.meta]
    : [paths.socket, paths.token, paths.meta]
  for (const file of files) {
    try {
      rmSync(file, { force: true })
    } catch {
      // best-effort cleanup; never resurrect state
    }
  }
}

export { modeOf }
