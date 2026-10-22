import { appendFileSync, chmodSync, statSync } from 'node:fs'
import * as pty from 'node-pty'
import { HOST_PROTOCOL_VERSION } from '../shared/host-protocol'
import {
  acquireSocketPath,
  cleanupHostFiles,
  hostPathsFromEnv,
  prepareHostDirectory,
  readToken,
  writeMeta,
  writeToken,
  type HostPaths
} from './paths'
import { createPtyRegistry, type PtyLike, type PtySpawnConfig } from './pty-registry'
import { createProtocolServer, type HostLogger, type ProtocolServer } from './protocol-server'

export const HOST_VERSION = '0.1.0-work4'

export type HostOptions = {
  paths: HostPaths
  shell: string
  /** Test seam: real node-pty by default. */
  ptyFactory?: (config: PtySpawnConfig) => PtyLike
}

export type RunningHost = {
  server: ProtocolServer
  paths: HostPaths
  /** Runtime token; only for in-process clients and tests. */
  token: string
  hostPid: number
  startedAt: number
  stop: () => void
  /** Resolves after PTYs are killed and socket/token files are removed. */
  stopped: Promise<void>
}

function defaultPtyFactory(config: PtySpawnConfig): PtyLike {
  return pty.spawn(config.command, config.args, {
    name: 'xterm-256color',
    cols: config.cols,
    rows: config.rows,
    cwd: config.cwd,
    env: config.env
  })
}

function createLogger(paths: HostPaths): HostLogger {
  return (entry) => {
    try {
      appendFileSync(
        paths.log,
        `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...entry })}\n`,
        { mode: 0o600 }
      )
    } catch {
      // logging must never take the host down
    }
  }
}

/**
 * Start the detached host. PTY ownership, output sequencing, and snapshots live
 * here; durable app state remains in the Electron main process.
 */
export async function startTerminalHost(options: HostOptions): Promise<RunningHost> {
  const { paths } = options
  const log = createLogger(paths)

  prepareHostDirectory(paths)
  await acquireSocketPath(paths)
  const token = writeToken(paths.token)
  const startedAt = Date.now()

  let server: ProtocolServer | null = null

  const registry = createPtyRegistry({
    ptyFactory: options.ptyFactory ?? defaultPtyFactory,
    events: {
      onData: (event) =>
        server?.broadcast({
          type: 'event',
          event: 'data',
          sessionId: event.sessionId,
          incarnationId: event.incarnationId,
          seq: event.seq,
          data: event.data
        }),
      onSpawned: (event) => {
        log({ event: 'pty-spawn', ...event })
        server?.broadcast({ type: 'event', event: 'spawned', ...event })
      },
      onExit: (event) => {
        log({ event: 'pty-exit', ...event })
        server?.broadcast({ type: 'event', event: 'exit', ...event })
      }
    }
  })

  server = createProtocolServer({
    socketPath: paths.socket,
    token,
    registry,
    hostVersion: HOST_VERSION,
    startedAt,
    log
  })

  await server.listening

  const socketMode = (() => {
    try {
      return (statSync(paths.socket).mode & 0o777).toString(8).padStart(3, '0')
    } catch {
      return 'unknown'
    }
  })()

  writeMeta(paths.meta, {
    pid: process.pid,
    startedAt,
    protocolVersion: HOST_PROTOCOL_VERSION,
    hostVersion: HOST_VERSION,
    socket: paths.socket,
    tokenFile: paths.token,
    dirMode: (statSync(paths.dir).mode & 0o777).toString(8).padStart(3, '0'),
    tokenMode: (statSync(paths.token).mode & 0o777).toString(8).padStart(3, '0'),
    socketMode
  })

  let stopped = false
  let resolveStopped: () => void = () => {}
  const stoppedPromise = new Promise<void>((resolve) => {
    resolveStopped = resolve
  })
  const stop = (): void => {
    if (stopped) return
    stopped = true
    registry.closeAll()
    void server.close().then(() => {
      cleanupHostFiles(paths)
      log({ event: 'host-stopped' })
      resolveStopped()
    })
  }
  server.onShutdownRequested(stop)

  return {
    server,
    paths,
    token,
    hostPid: process.pid,
    startedAt,
    stop,
    stopped: stoppedPromise
  }
}

/**
 * Work 1 compatibility entry point: synchronous signature, process-level
 * lifecycle. Work 4 internals are asynchronous but the entry stays the same.
 */
export function createTerminalHost(options: HostOptions): void {
  startTerminalHost(options)
    .then((host) => {
      // `shutdown`, `shutdownIfIdle`, and signals all funnel through stop().
      void host.stopped.then(() => process.exit(0))
      process.on('SIGTERM', () => host.stop())
      process.on('SIGINT', () => host.stop())
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? `${error.stack ?? error.message}` : String(error)
      try {
        appendFileSync(options.paths.log, `${new Date().toISOString()} startup-failed ${message}\n`)
      } catch {
        // no log directory
      }
      process.stderr.write(`[ade-host] ${message}\n`)
      process.exit(1)
    })
}

export { hostPathsFromEnv, readToken, chmodSync }
export type { HostPaths }
