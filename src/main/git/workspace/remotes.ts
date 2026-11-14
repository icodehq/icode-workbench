import type { GitWorkspaceContext } from '../workspace-context'
import type { GitOutcome } from '../git-workspace-service'
import { detailOf } from '../git-helpers'
import { authFailureDetail } from '../remote-failure'




  /** Pushes the current branch to its configured upstream. */
export async function push(ctx: GitWorkspaceContext, sessionId: string): Promise<GitOutcome<{ branch: string; upstream: string }>> {
    return ctx.withUpstream(sessionId, 'push', ['push'])
  }




  /** Pulls into the current branch from its configured upstream. */
export async function pull(ctx: GitWorkspaceContext, sessionId: string, rebase = false): Promise<GitOutcome<{ branch: string; upstream: string }>> {
    return ctx.withUpstream(sessionId, 'pull', ['pull', rebase ? '--rebase' : '--ff-only'])
  }




  /**
   * Pushes the checked-out branch to an explicitly chosen remote/branch.
   *
   * Unlike `publish`, this does not guess a remote and does not merge anything.
   * It is the "share this branch as-is" path; dependency readiness is untouched.
   */
export async function pushTo(
    ctx: GitWorkspaceContext,
    sessionId: string,
    input: { remote: string; branch: string }
  ): Promise<
    GitOutcome<{ branch: string; remote: string; remoteBranch: string; upstream: string }>
  > {
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath, target } = resolved
    const localBranch = await git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(
      () => null
    )
    if (localBranch === null || localBranch === 'HEAD') {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'Cannot push a detached checkout. Switch to a branch first.'
      }
    }
    const remotes = await ctx.remoteNames(git, worktreePath)
    if (!remotes.includes(input.remote)) {
      return {
        status: 'unavailable',
        reason: 'no-remote',
        detail: `The remote "${input.remote}" is not configured.`
      }
    }
    try {
      await git(worktreePath, ['check-ref-format', '--branch', input.branch])
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, 'The remote branch name is not valid.')
      }
    }
    try {
      await git(
        worktreePath,
        ['push', '--set-upstream', input.remote, `${localBranch}:${input.branch}`],
        120_000
      )
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail:
          authFailureDetail({ error, operation: 'push', target }) ??
          detailOf(
            error,
            `Git could not push ${localBranch}. Check network access and credentials in the terminal.`
          )
      }
    }
    return {
      status: 'ok',
      branch: localBranch,
      remote: input.remote,
      remoteBranch: input.branch,
      upstream: `${input.remote}/${input.branch}`
    }
  }

  /** Remote names for the push dialog. */
export async function remotes(
    ctx: GitWorkspaceContext,
    sessionId: string
  ): Promise<GitOutcome<{ remotes: string[] }>> {
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const list = await ctx.remoteNames(resolved.git, resolved.worktreePath)
    return { status: 'ok', remotes: list }
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
    const { git, worktreePath, target } = resolved
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
        detail:
          authFailureDetail({ error, operation: 'publish', target }) ??
          detailOf(
            error,
            `Git could not publish ${branch}. Check network access and credentials in the terminal.`
          )
      }
    }
    return { status: 'ok', branch, upstream: `${remote}/${branch}` }
  }
