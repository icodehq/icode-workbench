/**
 * Native recursive backend.
 *
 * `@parcel/watcher` uses ReadDirectoryChangesW on Windows, FSEvents on macOS,
 * and inotify per directory on Linux. Generated directories are pruned with
 * native globs, so a checkout with package-level `node_modules` costs a handful
 * of OS subscriptions instead of one `fs.watch` per file.
 *
 * The ignore globs are generated per root because a Source Control spec opens
 * two roots with different meanings: the worktree (where `.git` is noise) and
 * the Git directory (where `index`/`HEAD` matter while `objects`/`logs` churn).
 */

import {
  subscribe as parcelSubscribe,
  type Event as ParcelEvent,
  type Options as ParcelOptions
} from '@parcel/watcher'
import type { SerializedWatchSpec, WatchEventKind } from '../shared/watch-protocol'
import type { BackendEmitter, BackendSubscription, WatchBackend } from './backends'
import { canonicalWatchPath } from './canonical'
import { ignoreSpecPath, parcelIgnoreRegexesForRoot } from './ignore'

type ParcelSubscription = Awaited<ReturnType<typeof parcelSubscribe>>

/** `ignoreGlobs` is implemented by the native backend but absent from the types. */
type ParcelOptionsWithGlobs = ParcelOptions & { ignoreGlobs?: string[]; backend?: string }

function mapEventType(type: ParcelEvent['type']): WatchEventKind {
  if (type === 'create') return 'add'
  if (type === 'delete') return 'unlink'
  return 'change'
}

function isRescanRequired(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('ENOSPC') || /inotify|watch limit/iu.test(message)
}

export function createParcelBackend(): WatchBackend {
  return {
    name: 'parcel',
    async subscribe(spec: SerializedWatchSpec, emit: BackendEmitter): Promise<BackendSubscription> {
      const roots = spec.roots.map(canonicalWatchPath)
      const subscriptions: ParcelSubscription[] = []
      try {
        for (const root of roots) {
          const options: ParcelOptionsWithGlobs = {
            ignoreGlobs: parcelIgnoreRegexesForRoot(spec, root),
            ...(process.platform === 'win32' ? { backend: 'windows' } : {})
          }
          subscriptions.push(
            await parcelSubscribe(
              root,
              (error: Error | null, events: ParcelEvent[]) => {
                if (error !== null) {
                  if (isRescanRequired(error)) emit.overflow()
                  else emit.error(error)
                  return
                }
                const mapped = []
                for (const event of events) {
                  if (ignoreSpecPath(spec, event.path)) continue
                  mapped.push({ type: mapEventType(event.type), path: event.path })
                }
                if (mapped.length > 0) emit.events(mapped)
              },
              options
            )
          )
        }
      } catch (error) {
        await Promise.allSettled(subscriptions.map((subscription) => subscription.unsubscribe()))
        throw error
      }
      // Parcel has no initial-scan callback; all roots are bound once every
      // subscribe call resolved. The child still re-applies the ignore rules
      // on delivery, so a glob-semantics difference cannot leak paths.
      emit.ready()
      let closed = false
      return {
        stats: () => ({ watches: subscriptions.length, roots: roots.length }),
        close: async () => {
          if (closed) return
          closed = true
          await Promise.allSettled(subscriptions.map((subscription) => subscription.unsubscribe()))
        }
      }
    }
  }
}
