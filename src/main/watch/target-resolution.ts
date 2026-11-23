/**
 * Which checkouts may be watched by the desktop process.
 *
 * Only local targets are watchable. A WSL repository is owned by the distro,
 * and its path may be reachable through DrvFs — but Linux writes on DrvFs do
 * not produce reliable notifications on this side, and translating the path to
 * a Windows spelling turned a monorepo checkout into tens of thousands of
 * native handles. The renderer's polling fallback is the intended behavior for
 * every guest target, so the gate here must run before any guest call: a
 * `wslpath` or guest `git rev-parse` merely to decide not to watch would be
 * exactly the cost this module exists to avoid.
 */

import type { RepoId } from '../../shared/domain/ids'
import type { ExecutionTarget } from '../../shared/domain/repository'

export type WatchCheckoutRef = { repoId: RepoId; path: string }

export type GitWatchDetails = {
  worktreePath: string
  gitDir: string
  target: ExecutionTarget
}

export type WatchTargetResolverDeps = {
  /** A session's own worktree, when it has one. Persisted data only. */
  worktrees: { findBySession(sessionId: string): WatchCheckoutRef | null }
  /** The primary checkout a default-checkout session runs in. Persisted only. */
  sessions: { sessionWorkspaceFor(sessionId: string): WatchCheckoutRef | null }
  repositories: {
    findById(repoId: RepoId): { executionTarget: ExecutionTarget } | null
  }
  gitWorkspace: {
    watchTargetDetails(sessionId: string): Promise<GitWatchDetails | null>
  }
}

export type WatchTargetResolvers = {
  /** The worktree plus Git directory a Source Control watcher may watch. */
  resolveGitWatchTarget(sessionId: string): Promise<{ worktreePath: string; gitDir: string } | null>
  /** The checkout a Files watcher may watch. */
  resolveFilesWatchTarget(sessionId: string): Promise<{ worktreePath: string } | null>
}

export function createWatchTargetResolvers(
  deps: WatchTargetResolverDeps
): WatchTargetResolvers {
  const localCheckout = (
    sessionId: string
  ): { checkout: WatchCheckoutRef; repository: { executionTarget: ExecutionTarget } } | null => {
    const worktree = deps.worktrees.findBySession(sessionId)
    const checkout = worktree ?? deps.sessions.sessionWorkspaceFor(sessionId)
    if (checkout === null) return null
    const repository = deps.repositories.findById(checkout.repoId)
    if (repository === null) return null
    return { checkout, repository }
  }

  return {
    async resolveGitWatchTarget(sessionId) {
      const resolved = localCheckout(sessionId)
      if (resolved === null) return null
      // The target is read from the persisted repository row, never inferred
      // from the path spelling, and the gate precedes every guest call.
      if (resolved.repository.executionTarget.kind !== 'local') return null
      const details = await deps.gitWorkspace.watchTargetDetails(sessionId)
      if (details === null || details.target.kind !== 'local') return null
      return { worktreePath: details.worktreePath, gitDir: details.gitDir }
    },

    async resolveFilesWatchTarget(sessionId) {
      const resolved = localCheckout(sessionId)
      if (resolved === null) return null
      if (resolved.repository.executionTarget.kind !== 'local') return null
      return { worktreePath: resolved.checkout.path }
    }
  }
}
