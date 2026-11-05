import type { GitWorkspaceContext } from '../workspace-context'
import type { GitOutcome } from '../git-workspace-service'
import type { GitTag } from '../../../shared/domain/git-workspace'
import { parsePorcelainV2 } from '../status-reader'
import { parseWorktreeList } from '../repository-model'
import { STATUS_ARGS, detailOf, entriesOf } from '../git-helpers'



  /** Local branches, for the branch switcher. */
export async function branches(ctx: GitWorkspaceContext, sessionId: string): Promise<GitOutcome<{ current: string | null; names: string[] }>> {
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    try {
      const output = await git(worktreePath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
      const names = output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .sort((left, right) => left.localeCompare(right))
      const current = await git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null)
      return { status: 'ok', current: current === 'HEAD' ? null : current, names }
    } catch (error) {
      return { status: 'unavailable', reason: 'git-failed', detail: detailOf(error, 'Git could not list branches.') }
    }
  }




  /**
   * Switches this worktree to another branch.
   *
   * A dirty worktree is refused rather than carried across: Git would either
   * fail halfway or copy unrelated edits onto the other branch, and neither is
   * something to do on the user's behalf. Conflicts with the target branch are
   * reported by name so the user can choose.
   */
export async function switchBranch(ctx: GitWorkspaceContext, sessionId: string, branch: string): Promise<GitOutcome<{ branch: string }>> {
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, raw, worktreePath } = resolved

    const name = branch.trim()
    if (name.length === 0 || name.startsWith('-') || name.length > 255) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'That branch name is not valid.' }
    }

    return ctx.queue.runExclusive(worktreePath, async () => {
      const statusRead = await raw(worktreePath, STATUS_ARGS)
      if (statusRead.exitCode !== 0) {
        return {
          status: 'unavailable' as const,
          reason: 'not-a-repository' as const,
          detail: 'Git could not read this worktree as a repository.'
        }
      }
      const dirty = entriesOf(parsePorcelainV2(statusRead.stdout))
      if (dirty.length > 0) {
        const sample = dirty.slice(0, 3).map((entry) => entry.path).join(', ')
        return {
          status: 'unavailable' as const,
          reason: 'dirty-worktree' as const,
          detail: `Commit or stash ${String(dirty.length)} change(s) before switching branches (${sample}${
            dirty.length > 3 ? ', …' : ''
          }).`
        }
      }

      const current = await git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null)
      if (current === name) {
        return {
          status: 'unavailable' as const,
          reason: 'git-failed' as const,
          detail: `This worktree is already on ${name}.`
        }
      }

      try {
        await git(worktreePath, ['checkout', name])
      } catch (error) {
        return {
          status: 'unavailable' as const,
          reason: 'git-failed' as const,
          detail: detailOf(error, `Git could not switch to ${name}.`)
        }
      }
      return { status: 'ok' as const, branch: name }
    })
  }




  /**
   * Creates a local branch at HEAD without checking it out.
   *
   * Creating a branch is safe on a dirty worktree because it does not move the
   * checkout; switching is a separate operation and still refuses dirty work.
   */
export async function createBranch(ctx: GitWorkspaceContext, sessionId: string, branch: string, at?: string): Promise<GitOutcome<{ branch: string }>> {
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    const name = branch.trim()
    if (name.length === 0 || name.startsWith('-') || name.length > 255) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'That branch name is not valid.' }
    }

    try {
      await git(worktreePath, ['check-ref-format', '--branch', name])
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, 'That branch name is not valid.')
      }
    }

    try {
      await git(worktreePath, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`])
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: `A local branch named ${name} already exists.`
      }
    } catch {
      // The expected path: no local ref by that name.
    }

    let start = 'HEAD'
    if (at !== undefined) {
      const oid = await git(worktreePath, [
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${at}^{commit}`
      ]).catch(() => null)
      if (oid === null) {
        return {
          status: 'unavailable',
          reason: 'git-failed',
          detail: 'That commit is not available in this worktree.'
        }
      }
      start = oid
    }

    try {
      await git(worktreePath, ['branch', name, start])
      return { status: 'ok', branch: name }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, `Git could not create ${name}.`)
      }
    }
  }




  /**
   * Creates a lightweight local tag at one commit. Tags are local until the
   * user explicitly pushes them; there is no automatic push here.
   */
export async function createTag(ctx: GitWorkspaceContext, sessionId: string, name: string, oid: string): Promise<GitOutcome<{ name: string; oid: string }>> {
    const trimmed = name.trim()
    if (trimmed.length === 0 || trimmed.length > 200) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'That tag name is not valid.' }
    }
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved

    try {
      await git(worktreePath, ['check-ref-format', `refs/tags/${trimmed}`])
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, 'That tag name is not valid.')
      }
    }
    try {
      await git(worktreePath, ['show-ref', '--verify', '--quiet', `refs/tags/${trimmed}`])
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: `A tag named ${trimmed} already exists.`
      }
    } catch {
      // Expected: the tag is free.
    }
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
        await git(worktreePath, ['tag', trimmed, commit])
      })
      return { status: 'ok', name: trimmed, oid: commit }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, `Git could not create tag ${trimmed}.`)
      }
    }
  }




  /** Renames a local branch without changing the checkout. */
export async function renameBranch(ctx: GitWorkspaceContext, sessionId: string, from: string, to: string): Promise<GitOutcome<{ from: string; branch: string }>> {
    const source = from.trim()
    const target = to.trim()
    if (source.length === 0 || target.length === 0) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'Both branch names are required.' }
    }
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    try {
      await git(worktreePath, ['check-ref-format', '--branch', target])
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, 'That branch name is not valid.')
      }
    }
    try {
      await git(worktreePath, ['show-ref', '--verify', '--quiet', `refs/heads/${source}`])
    } catch {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: `There is no local branch named ${source}.`
      }
    }
    try {
      await git(worktreePath, ['show-ref', '--verify', '--quiet', `refs/heads/${target}`])
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: `A local branch named ${target} already exists.`
      }
    } catch {
      // The target name is free.
    }
    try {
      await ctx.queue.runExclusive(worktreePath, async () => {
        await git(worktreePath, ['branch', '-m', source, target])
      })
      return { status: 'ok', from: source, branch: target }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, `Git could not rename ${source}.`)
      }
    }
  }




  /**
   * Deletes a local branch only when it is merged and not checked out by any
   * worktree. This is deliberately the safe `-d` form; force deletion is not
   * offered from the menu.
   */
export async function deleteBranch(ctx: GitWorkspaceContext, sessionId: string, branch: string): Promise<GitOutcome<{ branch: string }>> {
    const name = branch.trim()
    if (name.length === 0 || name.startsWith('-')) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'That branch name is not valid.' }
    }
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    const current = await git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null)
    if (current === name) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: `Cannot delete ${name}: this worktree is on that branch.`
      }
    }
    try {
      await git(worktreePath, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`])
    } catch {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: `There is no local branch named ${name}.`
      }
    }
    try {
      const worktrees = await git(worktreePath, ['worktree', 'list', '--porcelain'])
      const occupied = parseWorktreeList(worktrees).some((entry) => entry.branch === name)
      if (occupied) {
        return {
          status: 'unavailable',
          reason: 'git-failed',
          detail: `${name} is checked out in another worktree. Remove or switch that worktree first.`
        }
      }
    } catch {
      // If worktree occupancy cannot be read, Git's own `-d` check still protects
      // the current checkout and unmerged commits.
    }
    try {
      await ctx.queue.runExclusive(worktreePath, async () => {
        await git(worktreePath, ['branch', '-d', name])
      })
      return { status: 'ok', branch: name }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, `Git could not delete ${name}. It may contain unmerged commits.`)
      }
    }
  }




  /**
   * Merges a local branch into the current branch. Conflicts are Git's outcome:
   * the operation banner then offers Continue or Abort.
   */
export async function mergeBranch(ctx: GitWorkspaceContext, sessionId: string, branch: string): Promise<GitOutcome<{ branch: string }>> {
    const name = branch.trim()
    if (name.length === 0 || name.startsWith('-')) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'That branch name is not valid.' }
    }
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    const current = await git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null)
    if (current === name) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: `This worktree is already on ${name}.`
      }
    }
    const commit = await git(worktreePath, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${name}^{commit}`
    ]).catch(() => null)
    if (commit === null) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: `There is no local branch named ${name}.`
      }
    }
    try {
      await ctx.queue.runExclusive(worktreePath, async () => {
        await git(worktreePath, ['merge', '--no-edit', commit])
      })
      return { status: 'ok', branch: name }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, `Git could not merge ${name}. Resolve conflicts or abort the merge.`)
      }
    }
  }




  /**
   * Rebases the current branch onto another local branch or commit.
   *
   * This rewrites local history, so the UI confirms it. Conflicts leave the
   * rebase marker and are handled by the operation banner's Continue/Abort.
   */
export async function rebaseBranch(ctx: GitWorkspaceContext, sessionId: string, branch: string): Promise<GitOutcome<{ branch: string }>> {
    const name = branch.trim()
    if (name.length === 0 || name.startsWith('-')) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'That branch name is not valid.' }
    }
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    const current = await git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null)
    if (current === null || current === 'HEAD') {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'Cannot rebase a detached checkout. Switch to a branch first.'
      }
    }
    if (current === name) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: `This worktree is already on ${name}.`
      }
    }
    const commit = await git(worktreePath, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${name}^{commit}`
    ]).catch(() => null)
    if (commit === null) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: `There is no branch or commit named ${name}.`
      }
    }
    try {
      await ctx.queue.runExclusive(worktreePath, async () => {
        await git(worktreePath, ['rebase', commit])
      })
      return { status: 'ok', branch: name }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, `Git could not rebase onto ${name}. Resolve conflicts or abort the rebase.`)
      }
    }
  }




  /** Deletes a local tag. Remote tags are never touched. */
export async function deleteTag(ctx: GitWorkspaceContext, sessionId: string, name: string): Promise<GitOutcome<{ name: string }>> {
    const trimmed = name.trim()
    if (trimmed.length === 0 || trimmed.startsWith('-')) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'That tag name is not valid.' }
    }
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    try {
      await git(worktreePath, ['show-ref', '--verify', '--quiet', `refs/tags/${trimmed}`])
    } catch {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: `There is no local tag named ${trimmed}.`
      }
    }
    try {
      await ctx.queue.runExclusive(worktreePath, async () => {
        await git(worktreePath, ['tag', '-d', trimmed])
      })
      return { status: 'ok', name: trimmed }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, `Git could not delete tag ${trimmed}.`)
      }
    }
  }




  /** Local tags with the object each points at. Remote tags are not listed. */
export async function tags(ctx: GitWorkspaceContext, sessionId: string): Promise<GitOutcome<{ tags: GitTag[] }>> {
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    try {
      const output = await git(worktreePath, [
        'for-each-ref',
        '--format=%(refname:short)%09%(objectname)',
        'refs/tags'
      ])
      const tags = output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          const [name = '', oid = ''] = line.split('\t')
          return { name, oid }
        })
        .filter((tag) => tag.name.length > 0)
      return { status: 'ok', tags }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, 'Git could not list the local tags.')
      }
    }
  }




  /**
   * Checks out a tag or commit detached. A dirty worktree is refused for the
   * same reason as a branch switch: carrying uncommitted work across a
   * checkout can lose it.
   */
export async function checkoutRef(ctx: GitWorkspaceContext, sessionId: string, ref: string): Promise<GitOutcome<{ ref: string; headOid: string }>> {
    const name = ref.trim()
    if (name.length === 0 || name.startsWith('-') || name.includes('\u0000')) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'That revision is not valid.' }
    }
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, raw, worktreePath } = resolved
    const oid = await git(worktreePath, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${name}^{commit}`
    ]).catch(() => null)
    if (oid === null) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That revision is not available in this worktree.'
      }
    }
    return ctx.queue.runExclusive(worktreePath, async () => {
      const statusRead = await raw(worktreePath, STATUS_ARGS)
      if (statusRead.exitCode !== 0) {
        return {
          status: 'unavailable' as const,
          reason: 'not-a-repository' as const,
          detail: 'Git could not read this worktree as a repository.'
        }
      }
      const dirty = entriesOf(parsePorcelainV2(statusRead.stdout))
      if (dirty.length > 0) {
        const sample = dirty.slice(0, 3).map((entry) => entry.path).join(', ')
        return {
          status: 'unavailable' as const,
          reason: 'dirty-worktree' as const,
          detail: `Commit or discard ${String(dirty.length)} change(s) before checking out ${name} (${sample}${
            dirty.length > 3 ? ', …' : ''
          }).`
        }
      }
      try {
        await git(worktreePath, ['checkout', '--detach', oid])
      } catch (error) {
        return {
          status: 'unavailable' as const,
          reason: 'git-failed' as const,
          detail: detailOf(error, `Git could not check out ${name}.`)
        }
      }
      return { status: 'ok' as const, ref: name, headOid: oid }
    })
  }




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
