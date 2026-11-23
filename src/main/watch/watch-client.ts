/**
 * The seam between the watcher services and the process that owns the watches.
 *
 * Tests inject a fake; production injects the supervisor. The services keep
 * their debounce/coalescing state and never learn how the physical watch is
 * opened, so swapping chokidar for parcel (or disabling watching entirely)
 * cannot change the IPC contract.
 */

import type {
  SerializedWatchSpec,
  WatchBackendName,
  WatchEventKind
} from '../../shared/watch-protocol'

export type WatchEvent = { type: WatchEventKind; path: string }

export type WatchSubscriptionHandlers = {
  onEvents(events: readonly WatchEvent[]): void
  onOverflow(): void
  onReady(): void
  onError(error: Error): void
}

export type WatchSubscribeResult =
  | { ok: true; backend: WatchBackendName }
  | { ok: false; reason: string }

export type WatchRootsResult =
  | { ok: true; bound: number; missing: string[] }
  | { ok: false; reason: string }

export type WatchClientStats = {
  running: boolean
  pid: number | null
  backend: WatchBackendName | null
  subscriptions: number
  watches: number
  roots: number
  restarts: number
  fused: boolean
}

export interface WatchClient {
  subscribe(
    spec: SerializedWatchSpec,
    handlers: WatchSubscriptionHandlers
  ): Promise<WatchSubscribeResult>
  updateRoots(id: string, roots: readonly string[]): Promise<WatchRootsResult>
  unsubscribe(id: string): Promise<void>
  stats(): WatchClientStats
}

const IDLE_STATS: WatchClientStats = {
  running: false,
  pid: null,
  backend: null,
  subscriptions: 0,
  watches: 0,
  roots: 0,
  restarts: 0,
  fused: false
}

/** The polling-only client used when `ICODE_WATCH_CHILD=0` or tests ask for it. */
export function createDisabledWatchClient(reason = 'disabled'): WatchClient {
  return {
    async subscribe() {
      return { ok: false, reason }
    },
    async updateRoots() {
      return { ok: false, reason }
    },
    async unsubscribe() {
      // Nothing was ever subscribed.
    },
    stats() {
      return IDLE_STATS
    }
  }
}
