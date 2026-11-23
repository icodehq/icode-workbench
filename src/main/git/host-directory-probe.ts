import type { ExecutionTarget } from '../../shared/domain/repository'

/**
 * A short-lived cache for "does this checkout directory exist on its host?".
 *
 * Every Git and Files request resolves its checkout before touching it, and a
 * WSL resolution costs a whole `wsl.exe` process for `test -d`. Status polling
 * and the Files pane ask the same question every couple of seconds for a path
 * whose answer only changes when the user creates or removes a worktree, so a
 * cache with a bounded staleness window removes most of those processes.
 *
 * Concurrent callers share one in-flight probe. A transport failure is never
 * cached: "we could not ask" must stay retryable, and callers turn it into
 * `worktree-unavailable`, not `worktree-missing`.
 */

export type HostDirectoryProbeFs = {
  isDirectory(path: string): Promise<boolean>
}

export type HostDirectoryProbe = {
  isDirectory(target: ExecutionTarget, path: string): Promise<boolean>
  clear(): void
}

export type HostDirectoryProbeOptions = {
  hostFsFor: (target: ExecutionTarget) => Promise<HostDirectoryProbeFs>
  /** Remote answers older than this are asked again. Local paths never cache. */
  ttlMs?: number
  now?: () => number
  /** Hard bound on remembered checkouts; oldest entries are dropped first. */
  maxEntries?: number
}

const DEFAULT_TTL_MS = 5_000
const DEFAULT_MAX_ENTRIES = 128

export function createHostDirectoryProbe(
  options: HostDirectoryProbeOptions
): HostDirectoryProbe {
  const ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_TTL_MS)
  const now = options.now ?? Date.now
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES)
  const entries = new Map<string, { at: number; promise: Promise<boolean> }>()

  const prune = (at: number): void => {
    if (entries.size <= maxEntries) return
    for (const [key, entry] of entries) {
      if (at - entry.at >= ttlMs) entries.delete(key)
    }
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next()
      if (oldest.done === true) break
      entries.delete(oldest.value)
    }
  }

  return {
    async isDirectory(target, path) {
      // A local stat is cheap and synchronous under `hostFsFor`; caching it
      // would only add staleness around worktree create/remove.
      if (target.kind === 'local' || ttlMs === 0) {
        const fs = await options.hostFsFor(target)
        return fs.isDirectory(path)
      }
      const key = `${target.distro}\u0000${target.distroId ?? ''}\u0000${path}`
      const at = now()
      const cached = entries.get(key)
      if (cached !== undefined && at - cached.at < ttlMs) return cached.promise
      // Register the in-flight probe before the first await so a concurrent
      // caller joins it instead of starting a second `wsl.exe`.
      const promise = options.hostFsFor(target).then((fs) => fs.isDirectory(path))
      entries.set(key, { at, promise })
      promise.catch(() => {
        if (entries.get(key)?.promise === promise) entries.delete(key)
      })
      prune(at)
      return promise
    },
    clear() {
      entries.clear()
    }
  }
}
