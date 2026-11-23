/**
 * macOS Files backend: one recursive subscription, filtered to visible roots.
 *
 * GUI processes on macOS live under a small descriptor budget, so opening one
 * `fs.watch` per expanded folder is risky. FSEvents is a single stream, so the
 * child subscribes recursively to the checkout and only forwards events whose
 * parent directory is currently visible. The OS watch is broader than the UI,
 * but it is native and the delivery set is exactly what the pane shows.
 */

import { dirname } from 'node:path'
import type { SerializedWatchSpec } from '../shared/watch-protocol'
import type { BackendEmitter, BackendSubscription, WatchBackend } from './backends'
import { canonicalWatchPath } from './canonical'

export function createParcelFilesBackend(recursive: WatchBackend): WatchBackend {
  return {
    name: recursive.name,
    async subscribe(spec: SerializedWatchSpec, emit: BackendEmitter): Promise<BackendSubscription> {
      const visible = new Set<string>(spec.roots.map(canonicalWatchPath))
      const recursiveSpec: SerializedWatchSpec = {
        ...spec,
        kind: 'recursive',
        roots: [spec.worktreePath]
      }
      const subscription = await recursive.subscribe(recursiveSpec, {
        events: (events) => {
          const filtered = events.filter((event) => visible.has(dirname(event.path)))
          if (filtered.length > 0) emit.events(filtered)
        },
        overflow: () => emit.overflow(),
        ready: () => emit.ready(),
        error: (error) => emit.error(error),
        ...(emit.rootError !== undefined ? { rootError: emit.rootError } : {})
      })
      return {
        async setRoots(roots) {
          visible.clear()
          for (const root of roots) visible.add(canonicalWatchPath(root))
          return { bound: visible.size, missing: [] }
        },
        stats: () => subscription.stats(),
        close: () => subscription.close()
      }
    }
  }
}
