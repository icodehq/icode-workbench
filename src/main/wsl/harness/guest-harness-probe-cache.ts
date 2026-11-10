import type { WslCommandRunner } from '../exec'
import {
  resolveGuestHarnessSnapshot,
  type GuestHarnessSnapshot
} from './guest-harness'

const DEFAULT_TTL_MS = 60_000

export type GuestHarnessProbeResult = {
  snapshot: GuestHarnessSnapshot
  /** True when at least one discovery call hit a transport failure. */
  transient: boolean
}

export type GuestHarnessProbeCacheOptions = {
  ttlMs?: number
  now?: () => number
}

export type GuestHarnessProbeCache = {
  get(
    distro: string,
    options?: { force?: boolean; signal?: AbortSignal }
  ): Promise<GuestHarnessProbeResult>
  invalidate(distro?: string): void
  reset(): void
}

/**
 * One harness-discovery snapshot per distro.
 *
 * Opening the New Session dialog and then pressing Start used to run the shell,
 * login-PATH and executable-lookup probes twice. This cache makes the second
 * answer free, while keeping a short TTL so a newly installed harness becomes
 * visible without restarting iCode. A transient result is returned to the
 * current caller but never settled: the next call retries.
 */
export function createGuestHarnessProbeCache(
  runner: WslCommandRunner,
  options: GuestHarnessProbeCacheOptions = {}
): GuestHarnessProbeCache {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const now = options.now ?? Date.now
  const settled = new Map<string, { snapshot: GuestHarnessSnapshot; at: number }>()
  const inFlight = new Map<string, Promise<GuestHarnessProbeResult>>()

  const keyOf = (distro: string): string => distro.trim().toLowerCase()

  return {
    async get(distro, getOptions = {}) {
      const key = keyOf(distro)
      if (getOptions.force === true) settled.delete(key)
      const cached = settled.get(key)
      if (cached !== undefined) {
        if (now() - cached.at < ttlMs) {
          return { snapshot: cached.snapshot, transient: false }
        }
        settled.delete(key)
      }

      const pending = inFlight.get(key)
      if (pending !== undefined) return pending

      const attempt = (async (): Promise<GuestHarnessProbeResult> => {
        const snapshot = await resolveGuestHarnessSnapshot({
          runner,
          distro,
          ...(getOptions.signal ? { signal: getOptions.signal } : {})
        })
        if (!snapshot.transient) {
          settled.set(key, { snapshot, at: now() })
        }
        return { snapshot, transient: snapshot.transient }
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
