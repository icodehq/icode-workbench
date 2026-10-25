/**
 * Reaching each distro's managed Host from the session layer.
 *
 * Two boundaries are preserved here and neither is negotiable:
 *
 *   - **The relay is the only path in.** A `HostClient` connects to the loopback
 *     endpoint W5 opened; application code never dials the guest socket. That is
 *     what keeps one bridge per connection, and what let W5 keep the Host alive
 *     across client loss.
 *   - **The lifecycle is W4's.** `WslHostRelay.start` revalidates the target, calls
 *     `WslHostLifecycle.ensure`, deploys and proves the endpoint. This module only
 *     caches the resulting client per distro registration.
 *
 * Events are re-broadcast from every distro's client into the one listener set the
 * session service subscribes to, so a WSL session's output reaches the renderer
 * through exactly the same path as a local one.
 */

import type { ExecutionTarget } from '../../shared/domain/repository'
import type { HostEvent } from '../../shared/host-protocol'
import { HostClient } from '../host/host-client'
import type { WslRelayStartOutcome } from '../wsl/relay/endpoint'

export type WslHostRelayLike = {
  start(
    target: ExecutionTarget,
    options?: { signal?: AbortSignal }
  ): Promise<
    Extract<WslRelayStartOutcome, { status: 'ready' }> | Exclude<WslRelayStartOutcome, { status: 'ready' }>
  >
}

export type WslHostConnectFailure = {
  code: 'WSL_UNAVAILABLE' | 'WSL_HOST_START_FAILED' | 'WSL_HOST_UNVERIFIABLE' | 'HOST_CONNECT_FAILED'
  message: string
  detail?: string
}

export class WslHostConnectError extends Error {
  constructor(readonly failure: WslHostConnectFailure) {
    super(failure.message)
    this.name = 'WslHostConnectError'
  }
}

type Entry =
  | { state: 'connecting'; pending: Promise<HostClient> }
  | { state: 'ready'; client: HostClient; close: () => Promise<void> }
  | { state: 'failed'; failure: WslHostConnectFailure; at: number }

/** How long a failed distro is remembered, so a dead distro is not retried per call. */
const FAILURE_TTL_MS = 5_000

export type WslHostClientPool = {
  client(target: ExecutionTarget): Promise<HostClient>
  onEvent(listener: (event: HostEvent) => void): () => void
  /** Closes the relay endpoints. Never stops a Host. */
  disconnect(): void
}

export type WslHostClientPoolDeps = {
  relay: WslHostRelayLike
  now?: () => number
}

function keyOf(target: Extract<ExecutionTarget, { kind: 'wsl' }>): string {
  return `${target.distro.trim().toLowerCase()}\u0000${target.distroId ?? ''}`
}

function connectFailure(outcome: Exclude<WslRelayStartOutcome, { status: 'ready' }>): WslHostConnectFailure {
  switch (outcome.status) {
    case 'not_wsl':
      return { code: 'WSL_UNAVAILABLE', message: 'That session does not run in WSL.' }
    case 'rejected':
      return {
        code: 'WSL_UNAVAILABLE',
        message: outcome.error.message,
        ...(outcome.error.detail ? { detail: outcome.error.detail } : {})
      }
    case 'unverified':
      return {
        code: 'WSL_HOST_UNVERIFIABLE',
        message: outcome.error.message,
        detail: outcome.detail
      }
    case 'unavailable':
    default:
      return {
        code: outcome.error.code === 'WSL_HOST_DEPLOY_FAILED' ? 'WSL_HOST_START_FAILED' : 'WSL_UNAVAILABLE',
        message: outcome.error.message,
        detail: outcome.detail
      }
  }
}

export function createWslHostClientPool(deps: WslHostClientPoolDeps): WslHostClientPool {
  const now = deps.now ?? Date.now
  const entries = new Map<string, Entry>()
  const listeners = new Set<(event: HostEvent) => void>()
  const unsubscribes = new Map<string, () => void>()

  const broadcast = (event: HostEvent): void => {
    for (const listener of listeners) listener(event)
  }

  const connect = async (target: Extract<ExecutionTarget, { kind: 'wsl' }>): Promise<HostClient> => {
    const outcome = await deps.relay.start(target)
    if (outcome.status !== 'ready') {
      throw new WslHostConnectError(connectFailure(outcome))
    }
    const client = await HostClient.connect({
      host: outcome.endpoint.host,
      port: outcome.endpoint.port,
      token: outcome.endpoint.token
    })
    return client
  }

  return {
    async client(target) {
      if (target.kind !== 'wsl') {
        throw new WslHostConnectError({
          code: 'WSL_UNAVAILABLE',
          message: 'That session does not run in WSL.'
        })
      }
      const key = keyOf(target)
      const existing = entries.get(key)

      if (existing?.state === 'ready') {
        if (!existing.client.isClosed) return existing.client
        // The relay connection dropped: reconnect. The Host itself keeps running;
        // `close` only ended W5's listener, never the Host.
        entries.delete(key)
      }
      if (existing?.state === 'connecting') return existing.pending
      if (existing?.state === 'failed' && now() - existing.at < FAILURE_TTL_MS) {
        throw new WslHostConnectError(existing.failure)
      }

      const pending = (async () => {
        try {
          const client = await connect(target)
          unsubscribes.set(
            key,
            client.onEvent((event) => broadcast(event))
          )
          entries.set(key, {
            state: 'ready',
            client,
            close: async () => {
              client.close()
            }
          })
          return client
        } catch (error) {
          const failure =
            error instanceof WslHostConnectError
              ? error.failure
              : {
                  code: 'HOST_CONNECT_FAILED' as const,
                  message: 'The WSL terminal host could not be reached.',
                  detail: error instanceof Error ? error.message : String(error)
                }
          entries.set(key, { state: 'failed', failure, at: now() })
          throw error instanceof WslHostConnectError ? error : new WslHostConnectError(failure)
        }
      })()

      entries.set(key, { state: 'connecting', pending })
      return pending
    },

    onEvent(listener) {
      listeners.add(listener)
      // The first subscriber is what makes a Host connect at all; a failure here
      // is reported by the next explicit call, not swallowed.
      return () => {
        listeners.delete(listener)
      }
    },

    disconnect() {
      for (const [key, entry] of entries) {
        if (entry.state === 'ready') void entry.close().catch(() => {})
        unsubscribes.get(key)?.()
      }
      entries.clear()
      unsubscribes.clear()
    }
  }
}
