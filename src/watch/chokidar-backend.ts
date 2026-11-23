/**
 * Chokidar backend for the watcher child.
 *
 * This is the Phase 1 backend and the Phase 2 fallback. It mirrors the old
 * main-process factory exactly, except the process boundary is now the child's
 * stdin/stdout rather than the Electron main thread. On Windows chokidar still
 * opens one `fs.watch` per file; the child isolates that cost, and Phase 2's
 * parcel backend removes it.
 */

import { watch as chokidarWatch, type FSWatcher } from 'chokidar'
import type { SerializedWatchSpec, WatchEventKind } from '../shared/watch-protocol'
import type {
  BackendEmitter,
  BackendSubscription,
  WatchBackend
} from './backends'
import { canonicalWatchSpec } from './canonical'
import { ignoreSpecPath } from './ignore'

function countWatched(watcher: FSWatcher): number {
  const watched = watcher.getWatched()
  let count = 0
  for (const files of Object.values(watched)) {
    count += files.length + 1
  }
  return count
}

export function createChokidarBackend(): WatchBackend {
  return {
    name: 'chokidar',
    async subscribe(spec: SerializedWatchSpec, emit: BackendEmitter): Promise<BackendSubscription> {
      const canonicalSpec = canonicalWatchSpec(spec)
      const roots = canonicalSpec.roots
      const watcher = chokidarWatch(roots, {
        ignoreInitial: true,
        persistent: true,
        followSymlinks: false,
        ...(canonicalSpec.kind === 'shallow' ? { depth: 0 } : {}),
        ignored: (path: string) => ignoreSpecPath(canonicalSpec, path)
      })
      let closed = false
      watcher.on('all', (event, path) => {
        if (closed) return
        // Chokidar's event names match the wire kinds for the five we forward.
        emit.events([{ type: event as WatchEventKind, path }])
      })
      watcher.on('ready', () => {
        if (!closed) emit.ready()
      })
      watcher.on('error', (error) => {
        if (!closed) emit.error(error)
      })
      return {
        stats: () => ({ watches: countWatched(watcher), roots: roots.length }),
        close: async () => {
          if (closed) return
          closed = true
          await watcher.close()
        }
      }
    }
  }
}
