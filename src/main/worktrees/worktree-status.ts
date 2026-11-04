import { realpathSync, statSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import type { SessionLifecycleState } from '../../shared/domain/session'
import type {
  SessionWorktreeRecord,
  WorktreeSummary
} from '../../shared/domain/worktree'

/**
 * A worktree's user-visible status is derived, never persisted: filesystem and
 * Host truth can change while the app is closed, and a stale durable status
 * could invite the wrong cleanup action.
 *
 * `directoryExists` exists because existence is a question about *where the
 * checkout lives*. A call site that already knows the answer from the right
 * place passes it; otherwise this function would answer with the host's
 * `statSync`, which for a WSL checkout is a question about the wrong machine
 * (the guest path does not exist on Windows) and would report a healthy
 * worktree as missing.
 */
export function describeWorktree(
  record: SessionWorktreeRecord,
  sessionState: SessionLifecycleState,
  hostCwd?: string | null,
  directoryExists?: boolean
): WorktreeSummary {
  const exists = directoryExists ?? isDirectory(record.path)
  let status: WorktreeSummary['status']
  if (record.state === 'failed') {
    status = 'failed'
  } else if (record.state === 'creating') {
    status = exists ? 'incomplete' : 'creating'
  } else if (!exists) {
    status = 'missing'
  } else if (hostCwd !== undefined && hostCwd !== null && !samePath(hostCwd, record.path)) {
    status = 'inconsistent'
  } else if (
    record.state === 'ready' &&
    (sessionState === 'live' || sessionState === 'starting')
  ) {
    status = 'active'
  } else {
    status = 'ready-to-start'
  }
  return {
    path: record.path,
    branch: record.branch,
    baseOid: record.baseOid,
    state: record.state,
    status,
    error: record.error
  }
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Whether two strings denote the same path.
 *
 * Git reports `rev-parse --show-toplevel` and `worktree list` with forward
 * slashes even on Windows, while Node composes paths with backslashes and the
 * drive letter may differ in case. Comparing the raw strings therefore declares
 * a freshly created worktree inconsistent and blocks the session from starting.
 * On Windows the comparison is therefore separator- and case-insensitive; POSIX
 * keeps an exact, case-sensitive comparison.
 */
function normalizeForComparison(value: string, platform: NodeJS.Platform): string {
  const trimmed = value.replace(/[\\/]+$/u, '')
  if (platform !== 'win32') return trimmed
  return trimmed.replace(/\\/gu, '/').toLowerCase()
}

export function samePath(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return normalizeForComparison(left, platform) === normalizeForComparison(right, platform)
}

/**
 * The same comparison, after resolving symlinks when the path exists.
 *
 * Worktree registration comparisons need the resolved location (Git may record a
 * link target), but resolution alone is not enough on Windows: the JS
 * `realpathSync` keeps the caller's casing, so `C:/Temp` and `C:\temp` resolve to
 * differently-cased strings for the same directory.
 */
export function samePathResolved(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  // File identity is the strongest comparison: it treats Windows 8.3 short
  // names, drive-letter case, separators, and symlinks as the same object. It
  // also avoids relying on realpath spelling, which differs between the JS and
  // native resolvers. Non-existent paths fall back to normalized spelling.
  const identity = (value: string): string | null => {
    try {
      const stats = statSync(value)
      return stats.ino === 0 ? null : `${String(stats.dev)}:${String(stats.ino)}`
    } catch {
      return null
    }
  }
  const leftIdentity = identity(left)
  const rightIdentity = identity(right)
  if (leftIdentity !== null && rightIdentity !== null) return leftIdentity === rightIdentity

  /**
   * Resolves the nearest existing ancestor so a missing leaf still gets the
   * canonical spelling of its parent. A removed worktree is exactly that case:
   * the directory is gone, but its 8.3/case variants must still compare equal.
   */
  const api = platform === 'win32' ? win32 : posix
  const resolve = (value: string): string => {
    const suffix: string[] = []
    let current = value
    for (;;) {
      try {
        return api.join(realpathSync.native(current), ...[...suffix].reverse())
      } catch {
        const parent = api.dirname(current)
        if (parent === current) return value
        suffix.push(api.basename(current))
        current = parent
      }
    }
  }
  return (
    normalizeForComparison(resolve(left), platform) ===
    normalizeForComparison(resolve(right), platform)
  )
}
