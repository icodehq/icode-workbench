import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { canConnect, hostSocketPath } from '../../host/paths'
import { isNamedPipe } from '../../shared/domain/endpoint'
import { HOST_PROTOCOL_VERSION } from '../../shared/host-protocol'
import { HostClient, HostRequestError, type HostConnectionOptions } from './host-client'

export type HostMeta = {
  pid: number
  startedAt: number
  protocolVersion: number
  hostVersion: string
  socket: string
  tokenFile: string
}

type StaleHostConnection = {
  info: { hostPid: number } | null
  shutdown(): Promise<void>
  close(): void
}

/**
 * Ask a profile-owned host that speaks an older protocol to shut down.
 *
 * A terminal host is detached and survives an app update, so the new build must
 * replace it before it can send v2 `createOrAttach` frames. The old process is
 * never signalled: we speak its protocol with this profile's token, prove the
 * hello reports the recorded PID, and then send the explicit `shutdown` request.
 * Every proof must pass, or the caller refuses and asks the user to stop it.
 */
export async function shutdownStaleHost(input: {
  meta: HostMeta
  socketPath: string
  tokenPath: string
  token: string | null
  connect?: (options: HostConnectionOptions) => Promise<StaleHostConnection>
  isAlive?: (pid: number) => boolean
  wait?: (ms: number) => Promise<void>
  timeoutMs?: number
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const connect = input.connect ?? ((options) => HostClient.connect(options))
  const isAlive = input.isAlive ?? isProcessAlive
  const wait = input.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const meta = input.meta

  if (!Number.isInteger(meta.protocolVersion) || meta.protocolVersion === HOST_PROTOCOL_VERSION) {
    return { ok: false, message: 'The recorded terminal host does not report an older protocol.' }
  }
  if (meta.socket !== input.socketPath) {
    return {
      ok: false,
      message: `The recorded terminal host uses ${meta.socket}, not this profile's endpoint. Refusing to replace it.`
    }
  }
  if (meta.tokenFile !== input.tokenPath) {
    return {
      ok: false,
      message: 'The recorded terminal host belongs to another profile. Refusing to replace it.'
    }
  }
  if (input.token === null) {
    return { ok: false, message: 'This profile has no terminal-host token. Refusing to replace the host.' }
  }

  let client: StaleHostConnection | null = null
  try {
    client = await connect({
      socketPath: input.socketPath,
      token: input.token,
      protocolVersion: meta.protocolVersion
    })
    if (client.info?.hostPid !== meta.pid) {
      return {
        ok: false,
        message: `The terminal host did not identify itself as pid ${meta.pid}. Refusing to replace it.`
      }
    }
    await client.shutdown()
  } catch (error) {
    return {
      ok: false,
      message:
        `The previous terminal host (pid ${meta.pid}) could not be stopped: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        'Stop that process, then retry.'
    }
  } finally {
    client?.close()
  }

  const deadline = Date.now() + (input.timeoutMs ?? 5_000)
  while (Date.now() < deadline) {
    if (!isAlive(meta.pid)) return { ok: true }
    await wait(100)
  }
  return {
    ok: false,
    message:
      `The previous terminal host (pid ${meta.pid}) is still running after shutdown. ` +
      'Stop that process, then retry.'
  }
}

export class HostSupervisor {
  private client: HostClient | null = null
  private connecting: Promise<HostClient> | null = null

  /**
   * `extraEnv` is used for values the Host must forward to every PTY child
   * (currently the activity socket). It is explicit rather than mutating
   * `process.env` so the dependency is visible at the composition root.
   */
  constructor(
    private readonly hostDir?: string,
    private readonly extraEnv: Record<string, string> = {}
  ) {}

  get directory(): string {
    return this.hostDir ?? process.env.ICODE_HOST_DIR ?? join(app.getPath('userData'), 'run')
  }

  /**
   * Scoped to this profile, so two iCode profiles sharing one XDG_RUNTIME_DIR
   * cannot collide and one can never clean up the other's endpoint.
   */
  get socketPath(): string {
    // Why: some WSL mounts cannot bind Unix sockets; the runtime dir is a Linux filesystem.
    return hostSocketPath({ profileDir: this.directory, env: process.env })
  }

  get tokenPath(): string {
    return join(this.directory, 'token')
  }

  get metaPath(): string {
    return join(this.directory, 'meta.json')
  }

  get logPath(): string {
    return join(this.directory, 'host.log')
  }

  get hostEntryPath(): string {
    if (app.isPackaged) {
      return join(process.resourcesPath, 'app.asar.unpacked', 'out', 'host', 'index.js')
    }
    return join(app.getAppPath(), 'out', 'host', 'index.js')
  }

  readMeta(): HostMeta | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.metaPath, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null) return null
      const record = parsed as Record<string, unknown>
      if (typeof record.pid !== 'number' || typeof record.startedAt !== 'number') return null
      return record as unknown as HostMeta
    } catch {
      return null
    }
  }

  readToken(): string | null {
    try {
      return readFileSync(this.tokenPath, 'utf8').trim()
    } catch {
      return null
    }
  }

  async ensure(): Promise<HostClient> {
    if (this.client && !this.client.isClosed) return this.client
    if (this.connecting) return this.connecting
    this.connecting = this.connectOrStart().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private async connectOrStart(): Promise<HostClient> {
    const existing = await this.tryConnect()
    if (existing) {
      this.client = existing
      return existing
    }

    const meta = this.readMeta()
    if (meta && isProcessAlive(meta.pid)) {
      if (meta.protocolVersion !== HOST_PROTOCOL_VERSION) {
        // A detached host from the previous app version. Replace it only after
        // proving this profile owns it; otherwise keep the refusal below.
        const replaced = await shutdownStaleHost({
          meta,
          socketPath: this.socketPath,
          tokenPath: this.tokenPath,
          token: this.readToken()
        })
        if (!replaced.ok) {
          throw new HostRequestError('HOST_UNREACHABLE', replaced.message, this.logPath)
        }
      } else {
        throw new HostRequestError(
          'HOST_UNREACHABLE',
          unreachableMessage(meta, this.socketPath),
          this.logPath
        )
      }
    }

    // Ownership-safe: nothing is unlinked here. The endpoint is probed first, so
    // a socket this profile cannot prove it owns is never removed. A genuinely
    // stale socket is removed by the Host itself, which re-checks the same rules
    // (refused connection plus a dead or absent recorded owner).
    if (isNamedPipe(this.socketPath)) {
      // A named pipe is not a filesystem object: there is nothing to stat and
      // nothing to unlink, and `existsSync` is always false for `\\.\pipe\...`.
      // The connect probe is the only source of truth.
      const probe = await canConnect(this.socketPath)
      if (probe === 'connected') {
        throw new HostRequestError(
          'HOST_UNREACHABLE',
          `Another terminal host is listening on ${this.socketPath}, but this profile has no matching credentials. Refusing to replace it.`,
          this.logPath
        )
      }
      if (probe === 'unknown') {
        throw new HostRequestError(
          'HOST_UNREACHABLE',
          `Cannot prove ${this.socketPath} is stale (the connection attempt was inconclusive). Refusing to remove it.`,
          this.logPath
        )
      }
    } else {
      const present = existsSync(this.socketPath)
      if (present && !lstatSync(this.socketPath).isSocket()) {
        throw new HostRequestError(
          'HOST_UNREACHABLE',
          `${this.socketPath} exists but is not a Unix socket. Refusing to remove it.`,
          this.logPath
        )
      }
      const probe = present ? await canConnect(this.socketPath) : 'absent'
      if (probe === 'connected') {
        throw new HostRequestError(
          'HOST_UNREACHABLE',
          `Another terminal host is listening on ${this.socketPath}, but this profile has no matching credentials. Refusing to replace it.`,
          this.logPath
        )
      }
      if (probe === 'unknown') {
        throw new HostRequestError(
          'HOST_UNREACHABLE',
          `Cannot prove ${this.socketPath} is stale (the connection attempt was inconclusive). Refusing to remove it.`,
          this.logPath
        )
      }
    }

    await this.spawnHost()
    const client = await this.waitForHost()
    this.client = client
    return client
  }

  private async tryConnect(): Promise<HostClient | null> {
    const token = this.readToken()
    if (!token) return null
    try {
      return await HostClient.connect({ socketPath: this.socketPath, token })
    } catch {
      return null
    }
  }

  private spawnHost(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      } catch (error) {
        reject(
          new HostRequestError(
            'HOST_CONNECT_FAILED',
            `Could not prepare the terminal host directory: ${
              error instanceof Error ? error.message : String(error)
            }`,
            this.logPath
          )
        )
        return
      }
      if (!existsSync(this.hostEntryPath)) {
        reject(
          new HostRequestError(
            'HOST_CONNECT_FAILED',
            `Terminal host entry is missing at ${this.hostEntryPath}`,
            'Run the build before starting iCode.'
          )
        )
        return
      }
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(process.execPath, [this.hostEntryPath], {
          cwd: this.directory,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            ICODE_HOST_DIR: this.directory,
            ICODE_HOST_SOCKET: this.socketPath,
            ...this.extraEnv
          }
        })
      } catch (error) {
        reject(
          new HostRequestError(
            'HOST_CONNECT_FAILED',
            `Could not start terminal host: ${
              error instanceof Error ? error.message : String(error)
            }`,
            this.logPath
          )
        )
        return
      }
      let settled = false
      child.once('error', (error) => {
        if (settled) return
        settled = true
        reject(
          new HostRequestError('HOST_CONNECT_FAILED', `Could not start terminal host: ${error.message}`)
        )
      })
      child.once('spawn', () => {
        settled = true
        child.unref()
        resolve()
      })
    })
  }

  private async waitForHost(): Promise<HostClient> {
    const deadline = Date.now() + 10_000
    let lastError: Error | null = null
    while (Date.now() < deadline) {
      const token = this.readToken()
      const meta = this.readMeta()
      if (token && meta) {
        try {
          const client = await HostClient.connect({ socketPath: this.socketPath, token })
          await client.ping()
          return client
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new HostRequestError(
      'HOST_CONNECT_FAILED',
      `Terminal host did not become ready: ${lastError?.message ?? 'timed out'}`,
      this.logPath
    )
  }

  disconnect(): void {
    this.client?.close()
    this.client = null
  }
}

/**
 * Keeps the original diagnostic while making it actionable. A host recorded in
 * this profile is left untouched: iCode never signals it, and its endpoint stays
 * in place for whoever still owns it.
 */
function unreachableMessage(meta: HostMeta, socketPath: string): string {
  const endpoint = meta.socket ?? socketPath
  const moved =
    meta.socket && meta.socket !== socketPath
      ? ` (it recorded ${meta.socket}; this profile now uses ${socketPath})`
      : ` at ${endpoint}`
  return (
    `Terminal host ${meta.pid} is running but is not accepting connections${moved}. ` +
    'iCode will not stop it or remove its endpoint. Save any work in its sessions, stop that process, then retry.'
  )
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
