import type { WslCommandRunner } from '../exec'
import { readGuestHome } from './lifecycle'

const DEFAULT_TTL_MS = 300_000

export type GuestHomeCacheOptions = {
  /** How long a successful answer stays usable; HOME is stable per registration. */
  ttlMs?: number
  now?: () => number
}

export type GuestHomeCache = {
  read(distro: string, options?: { signal?: AbortSignal }): Promise<string | null>
  /** Drops one distro, or everything when called with no argument. */
  invalidate(distro?: string): void
  /** Test seam: forget everything, including an answer still in flight. */
  reset(): void
}

/**
 * One `$HOME` probe per distro per process.
 *
 * `readGuestHome` decides the managed worktree root, the trust config path and
 * the relay's host root. It used to be re-run by every caller — one `wsl.exe`
 * spawn each, all asking the same immutable question. Only a successful absolute
 * answer is cached: a transport failure must remain retryable, and `null` is an
 * answer about a broken guest, not about the distro's home.
 *
 * Concurrent first callers share one probe, mirroring the guest Git environment
 * cache. A caller's AbortSignal only governs its own wait; the shared probe is
 * allowed to finish for the others.
 */
export function createGuestHomeCache(
  runner: WslCommandRunner,
  options: GuestHomeCacheOptions = {}
): GuestHomeCache {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const now = options.now ?? Date.now
  const settled = new Map<string, { home: string; at: number }>()
  const inFlight = new Map<string, Promise<string | null>>()

  const keyOf = (distro: string): string => distro.trim().toLowerCase()

  return {
    async read(distro, readOptions = {}) {
      const key = keyOf(distro)
      const cached = settled.get(key)
      if (cached !== undefined) {
        if (now() - cached.at < ttlMs) return cached.home
        settled.delete(key)
      }

      const pending = inFlight.get(key)
      if (pending !== undefined) return pending

      const attempt = (async (): Promise<string | null> => {
        const home = await readGuestHome(runner, distro, readOptions)
        if (home !== null) settled.set(key, { home, at: now() })
        return home
      })()
      inFlight.set(key, attempt)
      try {
        return await attempt
      } finally {
        inFlight.delete(key)
      }
    },

    invalidate(distro) {
      if (distro === undefined) {
        settled.clear()
        inFlight.clear()
        return
      }
      const key = keyOf(distro)
      settled.delete(key)
      inFlight.delete(key)
    },

    reset() {
      settled.clear()
      inFlight.clear()
    }
  }
}
