import type {
  CreateOrAttachPayload,
  HostEvent,
  ListSessionsPayload
} from '../../shared/host-protocol'
import type { HostSupervisor } from '../host/host-supervisor'

/**
 * The slice of host behaviour the session service depends on. Tests substitute
 * a deterministic implementation; production delegates to HostSupervisor.
 */
export type HostGateway = {
  createOrAttach(params: {
    sessionId: string
    cwd: string
    command: string
    args?: string[]
    cols: number
    rows: number
    attachOnly?: boolean
  }): Promise<CreateOrAttachPayload>
  write(sessionId: string, incarnationId: string, data: string): Promise<void>
  resize(sessionId: string, incarnationId: string, cols: number, rows: number): Promise<void>
  kill(sessionId: string): Promise<void>
  listSessions(): Promise<ListSessionsPayload>
  onEvent(listener: (event: HostEvent) => void): () => void
  disconnect(): void
}

export class SupervisorHostGateway implements HostGateway {
  private readonly listeners = new Set<(event: HostEvent) => void>()
  private readonly attached = new WeakSet<object>()

  constructor(private readonly supervisor: HostSupervisor) {}

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
    params: Parameters<HostGateway['createOrAttach']>[0]
  ): Promise<CreateOrAttachPayload> {
    const client = await this.client()
    return client.createOrAttach(params)
  }

  async write(sessionId: string, incarnationId: string, data: string): Promise<void> {
    const client = await this.client()
    await client.write(sessionId, incarnationId, data)
  }

  async resize(
    sessionId: string,
    incarnationId: string,
    cols: number,
    rows: number
  ): Promise<void> {
    const client = await this.client()
    await client.resize(sessionId, incarnationId, cols, rows)
  }

  async kill(sessionId: string): Promise<void> {
    const client = await this.client()
    await client.kill(sessionId)
  }

  async listSessions(): Promise<ListSessionsPayload> {
    const client = await this.client()
    return client.listSessions()
  }

  onEvent(listener: (event: HostEvent) => void): () => void {
    this.listeners.add(listener)
    // Attach to the current client (and start the host if needed). A reconnect
    // re-attaches because `client()` checks the WeakSet per connection.
    void this.client().catch(() => {})
    return () => {
      this.listeners.delete(listener)
    }
  }

  disconnect(): void {
    this.supervisor.disconnect()
  }
}
