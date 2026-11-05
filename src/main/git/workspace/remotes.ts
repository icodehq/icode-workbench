import type { GitWorkspaceContext } from '../workspace-context'
import type { GitOutcome } from '../git-workspace-service'
import { detailOf } from '../git-helpers'




  /** Pushes the current branch to its configured upstream. */
export async function push(ctx: GitWorkspaceContext, sessionId: string): Promise<GitOutcome<{ branch: string; upstream: string }>> {
    return ctx.withUpstream(sessionId, 'push', ['push'])
  }




  /** Pulls into the current branch from its configured upstream. */
export async function pull(ctx: GitWorkspaceContext, sessionId: string, rebase = false): Promise<GitOutcome<{ branch: string; upstream: string }>> {
    return ctx.withUpstream(sessionId, 'pull', ['pull', rebase ? '--rebase' : '--ff-only'])
  }




  /**
   * Publishes the current branch by setting its upstream.
   *
   * The remote is the conventional `origin` when present, otherwise the first
   * configured remote. The operation never chooses a remote interactively from
   * a background UI event; the user can open the terminal for anything unusual.
   */
export async function publish(ctx: GitWorkspaceContext, sessionId: string): Promise<GitOutcome<{ branch: string; upstream: string }>> {
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    const branch = await git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null)
    if (branch === null || branch === 'HEAD') {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'Cannot publish a detached checkout. Switch to a branch first.'
      }
    }
    const remotes = await ctx.remoteNames(git, worktreePath)
    if (remotes.length === 0) {
      return {
        status: 'unavailable',
        reason: 'no-remote',
        detail: 'This repository has no remote configured, so there is nowhere to publish.'
      }
    }
    const remote = remotes.includes('origin') ? 'origin' : remotes[0]!
    try {
      await git(worktreePath, ['push', '-u', remote, branch], 120_000)
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, `Git could not publish ${branch}. Check network access and credentials in the terminal.`)
      }
    }
    return { status: 'ok', branch, upstream: `${remote}/${branch}` }
  }
