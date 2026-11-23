/**
 * Shallow Files watching: one `fs.watch` per visible directory.
 *
 * The Files pane only ever shows direct children of its root and expanded
 * folders, so the watch set is proportional to the screen, not the checkout.
 * Physical watches are refcounted across subscriptions (two sessions in one
 * checkout share a root), missing roots retry briefly, and a periodic identity
 * check rebinds a directory that was deleted and recreated under the same name.
 *
 * Windows and Linux use this backend. macOS uses one recursive FSEvents-style
 * subscription filtered to the visible roots instead (see
 * `parcel-files-backend.ts`), because GUI descriptor budgets there are small.
 */

import { statSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { WATCH_MAX_ROOTS, type SerializedWatchSpec } from '../shared/watch-protocol'
import type { BackendEmitter, BackendSubscription, WatchBackend } from './backends'
import { canonicalWatchPath, canonicalWatchSpec } from './canonical'
import { ignoreSpecPath } from './ignore'

const DEFAULT_RETRY_DELAYS_MS = [250, 1_000, 4_000] as const
const DEFAULT_REBIND_INTERVAL_MS = 10_000

export type ShallowBackendOptions = {
  retryDelaysMs?: readonly number[]
  rebindIntervalMs?: number
}

type RootEntry = {
  watcher: FSWatcher | null
  refs: number
  identity: string | null
  retryIndex: number
  retryTimer: ReturnType<typeof setTimeout> | null
}

function identityOf(path: string): string | null {
  try {
    const stats = statSync(path)
    if (!stats.isDirectory()) return null
    return `${String(stats.dev)}:${String(stats.ino)}`
  } catch {
    return null
  }
}

export function createShallowBackend(options: ShallowBackendOptions = {}): WatchBackend {
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
  const rebindIntervalMs = options.rebindIntervalMs ?? DEFAULT_REBIND_INTERVAL_MS
  const entries = new Map<string, RootEntry>()
  const subscriptions = new Set<ShallowSubscription>()
  let rebindTimer: ReturnType<typeof setInterval> | null = null

  const emitOverflow = (root: string): void => {
    for (const subscription of subscriptions) {
      if (subscription.visible.has(root)) subscription.emit.overflow()
    }
  }

  const onRootEvent = (
    root: string,
    eventType: 'rename' | 'change',
    filename: string | Buffer | null
  ): void => {
    const entry = entries.get(root)
    if (entry === undefined || entry.watcher === null) return
    if (filename === null) {
      emitOverflow(root)
      return
    }
    const name = String(filename)
    // Depth-0 should never produce a separator; if it does, rescan rather than
    // guess which directory changed.
    if (name.includes('/') || name.includes('\\')) {
      emitOverflow(root)
      return
    }
    const absolute = join(root, name)
    for (const subscription of subscriptions) {
      if (!subscription.visible.has(root)) continue
      if (ignoreSpecPath(subscription.spec, absolute)) continue
      // `rename` covers both create and delete; the renderer reconciles either
      // way, so no stat is spent to disambiguate.
      subscription.emit.events([
        { type: eventType === 'rename' ? 'add' : 'change', path: absolute }
      ])
    }
  }

  const closeWatcher = (entry: RootEntry): void => {
    const watcher = entry.watcher
    entry.watcher = null
    if (watcher !== null) {
      try {
        watcher.close()
      } catch {
        // Already gone.
      }
    }
  }

  const reportRootError = (root: string): void => {
    for (const subscription of subscriptions) {
      if (subscription.visible.has(root)) subscription.emit.rootError?.(root, 'unavailable')
    }
  }

  const scheduleRetry = (root: string, entry: RootEntry): void => {
    if (entry.retryTimer !== null) return
    const delay = retryDelays[entry.retryIndex]
    if (delay === undefined) {
      reportRootError(root)
      return
    }
    entry.retryIndex += 1
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null
      if (entries.get(root) !== entry || entry.refs === 0) return
      bind(root, entry)
    }, delay)
    entry.retryTimer.unref()
  }

  const bind = (root: string, entry: RootEntry): boolean => {
    const identity = identityOf(root)
    if (identity === null) {
      scheduleRetry(root, entry)
      return false
    }
    entry.identity = identity
    try {
      const watcher = watch(root, { persistent: true }, (eventType, filename) =>
        onRootEvent(root, eventType, filename)
      )
      watcher.on('error', () => {
        closeWatcher(entry)
        scheduleRetry(root, entry)
      })
      entry.watcher = watcher
      entry.retryIndex = 0
      return true
    } catch {
      scheduleRetry(root, entry)
      return false
    }
  }

  const acquire = (root: string): RootEntry => {
    let entry = entries.get(root)
    if (entry === undefined) {
      entry = {
        watcher: null,
        refs: 0,
        identity: null,
        retryIndex: 0,
        retryTimer: null
      }
      entries.set(root, entry)
      bind(root, entry)
      ensureRebindTimer()
    }
    entry.refs += 1
    return entry
  }

  const release = (root: string): void => {
    const entry = entries.get(root)
    if (entry === undefined) return
    entry.refs -= 1
    if (entry.refs > 0) return
    closeWatcher(entry)
    if (entry.retryTimer !== null) clearTimeout(entry.retryTimer)
    entry.retryTimer = null
    entries.delete(root)
    if (entries.size === 0 && rebindTimer !== null) {
      clearInterval(rebindTimer)
      rebindTimer = null
    }
  }

  function ensureRebindTimer(): void {
    if (rebindTimer !== null || entries.size === 0) return
    rebindTimer = setInterval(() => {
      for (const [root, entry] of entries) {
        if (entry.refs === 0) continue
        const identity = identityOf(root)
        if (identity === entry.identity) continue
        closeWatcher(entry)
        if (identity === null) scheduleRetry(root, entry)
        else bind(root, entry)
      }
    }, rebindIntervalMs)
    rebindTimer.unref()
  }

  class ShallowSubscription implements BackendSubscription {
    readonly visible = new Set<string>()
    private closed = false

    constructor(
      readonly spec: SerializedWatchSpec,
      readonly emit: BackendEmitter
    ) {}

    async setRoots(roots: readonly string[]): Promise<{ bound: number; missing: string[] }> {
      const next = new Set<string>()
      for (const root of roots) {
        if (next.size >= WATCH_MAX_ROOTS) break
        next.add(canonicalWatchPath(root))
      }
      const missing: string[] = []
      for (const root of this.visible) {
        if (!next.has(root)) {
          this.visible.delete(root)
          release(root)
        }
      }
      for (const root of next) {
        if (!this.visible.has(root)) {
          this.visible.add(root)
          acquire(root)
        }
        if (entries.get(root)?.watcher === null) missing.push(root)
      }
      return { bound: next.size - missing.length, missing }
    }

    stats(): { watches: number; roots: number } {
      let watches = 0
      for (const root of this.visible) {
        const entry = entries.get(root)
        if (entry !== undefined && entry.watcher !== null) watches += 1
      }
      return { watches, roots: this.visible.size }
    }

    async close(): Promise<void> {
      if (this.closed) return
      this.closed = true
      for (const root of this.visible) release(root)
      this.visible.clear()
      subscriptions.delete(this)
    }
  }

  // Backend name for the child's stat/ack is supplied by the wrapper below.
  const backend: ShallowBackend = {
    name: 'fswatch',
    async subscribe(spec, emit): Promise<BackendSubscription> {
      const canonicalSpec = canonicalWatchSpec(spec)
      const subscription = new ShallowSubscription(canonicalSpec, emit)
      subscriptions.add(subscription)
      await subscription.setRoots(canonicalSpec.roots)
      emit.ready()
      return subscription
    }
  }
  return backend
}

type ShallowBackend = WatchBackend
