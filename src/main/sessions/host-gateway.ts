import type {
  CreateOrAttachPayload,
  HostEvent,
  ListSessionsPayload
} from '../../shared/host-protocol'
import type { ExecutionTarget } from '../../shared/domain/repository'
import type { HostSupervisor } from '../host/host-supervisor'
import type { HostClient } from '../host/host-client'
import {
  WslHostConnectError,
  type WslHostClientPool
} from './wsl-host-client-pool'

/**
 * The slice of host behaviour the session service depends on. Tests substitute
 * a deterministic implementation; production delegates to HostSupervisor.
 */
/**
 * Where a session's Host lives.
 *
 * Omitted means local, which is what every pre-W7 caller passes and what keeps the
 * existing local path byte-identical. A WSL target is never inferred from a path:
 * the caller supplies the target the repository record owns.
 */
export type HostTarget = ExecutionTarget | undefined

export type HostGateway = {
  createOrAttach(
    params: {
      sessionId: string
      cwd: string
      command: string
      args?: string[] | string
      cols: number
      rows: number
      env?: Record<string, string>
      attachOnly?: boolean
    },
    target?: HostTarget
  ): Promise<CreateOrAttachPayload>
  write(
    sessionId: string,
    incarnationId: string,
    data: string,
    target?: HostTarget
  ): Promise<void>
  resize(
    sessionId: string,
    incarnationId: string,
    cols: number,
    rows: number,
    target?: HostTarget
  ): Promise<void>
  kill(sessionId: string, target?: HostTarget): Promise<void>
  /** Explicit target: reconcile asks each host it knows about, rather than guessing. */
  listSessions(target?: HostTarget): Promise<ListSessionsPayload>
  onEvent(listener: (event: HostEvent) => void): () => void
  disconnect(): void
}

export class SupervisorHostGateway implements HostGateway {
  private readonly listeners = new Set<(event: HostEvent) => void>()
  private readonly attached = new WeakSet<object>()

  /**
   * `wsl` is optional so a local-only composition (and every existing test) is
   * unchanged; without it a WSL target is refused rather than served locally.
   */
  constructor(
    private readonly supervisor: HostSupervisor,
    private readonly wsl?: WslHostClientPool
  ) {}

  /** The client for one target: local supervisor, or the distro's relayed Host. */
  private async clientFor(target: HostTarget): Promise<HostClient> {
    if (target === undefined || target.kind === 'local') return this.client()
    if (!this.wsl) {
      throw new WslHostConnectError({
        code: 'WSL_UNAVAILABLE',
        message: 'This build has no WSL terminal host configured.'
      })
    }
    const client = await this.wsl.client(target)
    // WSL clients broadcast through the pool; local ones are subscribed here.
    return client
  }

  private async client() {
    const client = await this.supervisor.ensure()
    if (!this.attached.has(client)) {
      this.attached.add(client)
      client.onEvent((event) => {
        for (const listener of this.listeners) listener(event)
      })
    }
    return client
  }

  async createOrAttach(
    params: Parameters<HostGateway['createOrAttach']>[0],
    target?: HostTarget
  ): Promise<CreateOrAttachPayload> {
    const client = await this.clientFor(target)
    return client.createOrAttach(params)
  }

  async write(
    sessionId: string,
    incarnationId: string,
    data: string,
    target?: HostTarget
  ): Promise<void> {
    const client = await this.clientFor(target)
    await client.write(sessionId, incarnationId, data)
  }

  async resize(
    sessionId: string,
    incarnationId: string,
    cols: number,
    rows: number,
    target?: HostTarget
  ): Promise<void> {
    const client = await this.clientFor(target)
    await client.resize(sessionId, incarnationId, cols, rows)
  }

  async kill(sessionId: string, target?: HostTarget): Promise<void> {
    const client = await this.clientFor(target)
    await client.kill(sessionId)
  }

  async listSessions(target?: HostTarget): Promise<ListSessionsPayload> {
    const client = await this.clientFor(target)
    return client.listSessions()
  }

  onEvent(listener: (event: HostEvent) => void): () => void {
    this.listeners.add(listener)
    // Attach to the current client (and start the host if needed). A reconnect
    // re-attaches because `client()` checks the WeakSet per connection.
    void this.client().catch(() => {})
    const offWsl = this.wsl?.onEvent(listener)
    return () => {
      this.listeners.delete(listener)
      offWsl?.()
    }
  }

  disconnect(): void {
    this.supervisor.disconnect()
    // Ends W5 endpoints only. A managed Host -- and any agent running in it --
    // keeps running; that separation is the whole point of the W4 anchor.
    this.wsl?.disconnect()
  }
}
