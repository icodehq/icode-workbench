import type { HarnessDetectionResult } from './harness-detector'

const DEFAULT_TTL_MS = 60_000

export type DetectionResultCacheOptions = {
  ttlMs?: number
  now?: () => number
}

export type DetectionResultCache = {
  get(key: string): HarnessDetectionResult | null
  set(key: string, result: HarnessDetectionResult): void
  /** Drops every key with this prefix, or everything when no prefix is given. */
  invalidate(prefix?: string): void
  reset(): void
}

/**
 * A short-lived answer to "can this harness run on this target?".
 *
 * The dialog's harness list and the subsequent Start ask the same question; on
 * WSL each answer used to cost several `wsl.exe` spawns. `detection_failed` is
 * deliberately never cached: it exists to be retried, and memoizing it would
 * turn a transient probe timeout into a persistent failure.
 */
export function createDetectionResultCache(
  options: DetectionResultCacheOptions = {}
): DetectionResultCache {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const now = options.now ?? Date.now
  const entries = new Map<string, { result: HarnessDetectionResult; at: number }>()

  return {
    get(key) {
      const entry = entries.get(key)
      if (entry === undefined) return null
      if (now() - entry.at >= ttlMs) {
        entries.delete(key)
        return null
      }
      return entry.result
    },

    set(key, result) {
      if (result.state === 'detection_failed') return
      entries.set(key, { result, at: now() })
    },

    invalidate(prefix) {
      if (prefix === undefined) {
        entries.clear()
        return
      }
      for (const key of entries.keys()) {
        if (key.startsWith(prefix)) entries.delete(key)
      }
    },

    reset() {
      entries.clear()
    }
  }
}
