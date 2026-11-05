import type { GitWorkspaceContext } from '../workspace-context'
import type { GitOutcome } from '../git-workspace-service'
import { detailOf } from '../git-helpers'

  /**
   * Cherry-picks or reverts one commit with Git's default message.
   *
   * Conflicts are Git's outcome: the operation marker remains and the user
   * continues or aborts in the terminal until Phase 4 wires that banner. The
   * error text is Git's own reason rather than a fabricated success.
   */
async function applyCommitAction(ctx: GitWorkspaceContext, sessionId: string, oid: string, action: 'cherry-pick' | 'revert'): Promise<GitOutcome<{ oid: string; shortOid: string; subject: string }>> {
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    const commit = await git(worktreePath, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${oid}^{commit}`
    ]).catch(() => null)
    if (commit === null) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That commit is not available in this worktree.'
      }
    }
    try {
      await ctx.queue.runExclusive(worktreePath, async () => {
        await git(worktreePath, [action, '--no-edit', commit])
      })
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, `Git could not ${action.replace('-', ' ')} that commit.`)
      }
    }
    const head = await git(worktreePath, ['rev-parse', 'HEAD']).catch(() => commit)
    const subject = await git(worktreePath, ['log', '-1', '--pretty=%s']).catch(() => '')
    return { status: 'ok', oid: head, shortOid: head.slice(0, 7), subject }
  }


export async function cherryPick(ctx: GitWorkspaceContext, sessionId: string, oid: string): Promise<GitOutcome<{ oid: string; shortOid: string; subject: string }>> {
    return applyCommitAction(ctx, sessionId, oid, 'cherry-pick')
  }


export async function revert(ctx: GitWorkspaceContext, sessionId: string, oid: string): Promise<GitOutcome<{ oid: string; shortOid: string; subject: string }>> {
    return applyCommitAction(ctx, sessionId, oid, 'revert')
  }




  /**
   * Moves the current branch to a commit. `soft` keeps the index, `mixed`
   * resets it, and `hard` also discards tracked worktree changes; the renderer
   * confirms hard mode explicitly. This method does not push.
   */
export async function resetTo(ctx: GitWorkspaceContext, sessionId: string, oid: string, mode: 'soft' | 'mixed' | 'hard'): Promise<GitOutcome<{ oid: string; branch: string | null }>> {
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    const commit = await git(worktreePath, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${oid}^{commit}`
    ]).catch(() => null)
    if (commit === null) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That commit is not available in this worktree.'
      }
    }
    try {
      await ctx.queue.runExclusive(worktreePath, async () => {
        await git(worktreePath, ['reset', `--${mode}`, commit])
      })
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, 'Git could not reset this branch.')
      }
    }
    const head = await git(worktreePath, ['rev-parse', 'HEAD']).catch(() => commit)
    const branch = await git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null)
    return { status: 'ok', oid: head, branch }
  }
