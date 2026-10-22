import { statSync } from 'node:fs'
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

export function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => value.replace(/\/+$/u, '')
  return normalize(left) === normalize(right)
}
