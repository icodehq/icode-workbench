import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { HostClient, HostRequestError } from './host-client'

export type HostMeta = {
  pid: number
  startedAt: number
  protocolVersion: number
  hostVersion: string
  socket: string
  tokenFile: string
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
    return this.hostDir ?? process.env.ADE_HOST_DIR ?? join(app.getPath('userData'), 'run')
  }

  get socketPath(): string {
    if (process.env.ADE_HOST_SOCKET && process.env.ADE_HOST_SOCKET.length > 0) {
      return process.env.ADE_HOST_SOCKET
    }
    // Why: some WSL mounts cannot bind Unix sockets; the runtime dir is a Linux filesystem.
    const runtimeDir = process.env.XDG_RUNTIME_DIR
    if (runtimeDir && runtimeDir.length > 0) return join(runtimeDir, 'ade', 'terminal-host.sock')
    return join(this.directory, 'terminal-host.sock')
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
      throw new HostRequestError(
        'HOST_UNREACHABLE',
        `Terminal host ${meta.pid} is running but is not accepting connections`,
        this.logPath
      )
    }

    // Stale handshake files are safe to remove only after the recorded host is confirmed dead.
    rmSync(this.socketPath, { force: true })
    rmSync(this.tokenPath, { force: true })
    rmSync(this.metaPath, { force: true })

    await this.spawnHost()
    const client = await this.waitForHost()
    this.client = client
    return client
  }

  private async tryConnect(): Promise<HostClient | null> {
    const token = this.readToken()
    if (!token || !existsSync(this.socketPath)) return null
    try {
      return await HostClient.connect({ socketPath: this.socketPath, token })
    } catch {
      return null
    }
  }

  private spawnHost(): Promise<void> {
    return new Promise((resolve, reject) => {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      if (!existsSync(this.hostEntryPath)) {
        reject(
          new HostRequestError(
            'HOST_CONNECT_FAILED',
            `Terminal host entry is missing at ${this.hostEntryPath}`,
            'Run the build before starting ADE.'
          )
        )
        return
      }
      const child = spawn(process.execPath, [this.hostEntryPath], {
        cwd: this.directory,
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          ADE_HOST_DIR: this.directory,
          ADE_HOST_SOCKET: this.socketPath,
          ...this.extraEnv
        }
      })
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
      if (token && meta && existsSync(this.socketPath)) {
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
