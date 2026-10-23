import { realpathSync, statSync } from 'node:fs'
import type { SessionLifecycleState } from '../../shared/domain/session'
import type {
  SessionWorktreeRecord,
  WorktreeSummary
} from '../../shared/domain/worktree'

/**
 * A worktree's user-visible status is derived, never persisted: filesystem and
 * Host truth can change while the app is closed, and a stale durable status
 * could invite the wrong cleanup action.
 */
export function describeWorktree(
  record: SessionWorktreeRecord,
  sessionState: SessionLifecycleState,
  hostCwd?: string | null
): WorktreeSummary {
  const exists = isDirectory(record.path)
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
  const resolve = (value: string): string => {
    try {
      return realpathSync(value)
    } catch {
      return value
    }
  }
  return (
    normalizeForComparison(resolve(left), platform) ===
    normalizeForComparison(resolve(right), platform)
  )
}
