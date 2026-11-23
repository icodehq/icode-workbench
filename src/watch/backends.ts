import type {
  SerializedWatchSpec,
  WatchBackendName,
  WatchEventKind
} from '../shared/watch-protocol'
import { createChokidarBackend } from './chokidar-backend'

export type BackendEvent = { type: WatchEventKind; path: string }

export type BackendEmitter = {
  events(events: readonly BackendEvent[]): void
  overflow(): void
  ready(): void
  error(error: unknown): void
}

export type BackendRootsResult = { bound: number; missing: string[] }

export type BackendSubscription = {
  /** Shallow subscriptions only: replace the watched root set in place. */
  setRoots?(roots: readonly string[]): Promise<BackendRootsResult>
  close(): Promise<void>
  stats(): { watches: number; roots: number }
}

export type WatchBackend = {
  readonly name: WatchBackendName
  subscribe(spec: SerializedWatchSpec, emit: BackendEmitter): Promise<BackendSubscription>
}

/**
 * Selects the physical backend.
 *
 * Parcel is preferred; a load failure (missing prebuild, unsupported platform)
 * falls back to chokidar and reports the reason on stderr. `requireParcel`
 * makes the packaged self-test fail instead of quietly accepting the fallback.
 */
export async function selectWatchBackend(
  options: { requireParcel?: boolean } = {}
): Promise<WatchBackend> {
  if (process.env.ICODE_WATCH_BACKEND === 'chokidar') {
    if (options.requireParcel === true) {
      throw new Error('ICODE_WATCH_BACKEND forced chokidar')
    }
    return createChokidarBackend()
  }
  try {
    const { createParcelBackend } = await import('./parcel-backend')
    return createParcelBackend()
  } catch (error) {
    if (options.requireParcel === true) throw error
    process.stderr.write(
      `watcher: parcel unavailable (${error instanceof Error ? error.message : String(error)}); using chokidar\n`
    )
    return createChokidarBackend()
  }
}
