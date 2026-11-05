import type { GitWorkspaceContext } from '../workspace-context'
import type { GitOutcome } from '../git-workspace-service'
import type { GitRemote } from '../../../shared/domain/git-workspace'
import { parseRemotes } from '../repository-model'
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




  /** Configured remotes with their fetch and push URLs. */
export async function remotes(ctx: GitWorkspaceContext, sessionId: string): Promise<GitOutcome<{ remotes: GitRemote[] }>> {
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    try {
      const output = await git(worktreePath, ['remote', '-v'])
      return { status: 'ok', remotes: parseRemotes(output) }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, 'Git could not list the configured remotes.')
      }
    }
  }




  /** Adds a remote. The URL is never logged or echoed with credentials. */
export async function addRemote(ctx: GitWorkspaceContext, sessionId: string, name: string, url: string): Promise<GitOutcome<{ name: string }>> {
    const trimmedName = name.trim()
    const trimmedUrl = url.trim()
    if (
      trimmedName.length === 0 ||
      trimmedName.length > 100 ||
      trimmedName.startsWith('-') ||
      trimmedName.includes('\u0000')
    ) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'That remote name is not valid.' }
    }
    if (
      trimmedUrl.length === 0 ||
      trimmedUrl.length > 2048 ||
      trimmedUrl.startsWith('-') ||
      trimmedUrl.includes('\u0000') ||
      trimmedUrl.includes('\n')
    ) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'That remote URL is not valid.' }
    }
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    try {
      await git(worktreePath, ['check-ref-format', `refs/remotes/${trimmedName}`])
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, 'That remote name is not valid.')
      }
    }
    try {
      await ctx.queue.runExclusive(worktreePath, async () => {
        await git(worktreePath, ['remote', 'add', '--', trimmedName, trimmedUrl])
      })
      return { status: 'ok', name: trimmedName }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, `Git could not add remote ${trimmedName}.`)
      }
    }
  }




  /** Fetches one named remote, optionally pruning deleted remote branches. */
export async function fetchRemote(ctx: GitWorkspaceContext, sessionId: string, remote: string, prune = false): Promise<GitOutcome<{ remote: string }>> {
    const name = remote.trim()
    if (name.length === 0 || name.startsWith('-') || name.includes('\u0000')) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'That remote name is not valid.' }
    }
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    const remotes = await ctx.remoteNames(git, worktreePath)
    if (!remotes.includes(name)) {
      return {
        status: 'unavailable',
        reason: 'no-remote',
        detail: `There is no remote named ${name}.`
      }
    }
    try {
      await git(worktreePath, prune ? ['fetch', '--prune', name] : ['fetch', name], 120_000)
      return { status: 'ok', remote: name }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, `Git could not fetch ${name}.`)
      }
    }
  }




  /** Removes a remote; local branches and commits are untouched. */
export async function removeRemote(ctx: GitWorkspaceContext, sessionId: string, name: string): Promise<GitOutcome<{ name: string }>> {
    const trimmed = name.trim()
    if (trimmed.length === 0 || trimmed.startsWith('-') || trimmed.includes('\u0000')) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'That remote name is not valid.' }
    }
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    try {
      await git(worktreePath, ['remote', 'get-url', trimmed])
    } catch {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: `There is no remote named ${trimmed}.`
      }
    }
    try {
      await ctx.queue.runExclusive(worktreePath, async () => {
        await git(worktreePath, ['remote', 'remove', '--', trimmed])
      })
      return { status: 'ok', name: trimmed }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, `Git could not remove remote ${trimmed}.`)
      }
    }
  }




  /** Pushes local tags to the default remote. Explicit, never automatic. */
export async function pushTags(ctx: GitWorkspaceContext, sessionId: string): Promise<GitOutcome<{ remote: string }>> {
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    const remotes = await ctx.remoteNames(git, worktreePath)
    if (remotes.length === 0) {
      return {
        status: 'unavailable',
        reason: 'no-remote',
        detail: 'This repository has no remote configured, so there are no tags to push.'
      }
    }
    const remote = remotes.includes('origin') ? 'origin' : remotes[0]!
    try {
      await git(worktreePath, ['push', '--tags', remote], 120_000)
      return { status: 'ok', remote }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, `Git could not push tags to ${remote}.`)
      }
    }
  }




  /** Remote-tracking branches, e.g. `origin/main`, for an upstream picker. */
export async function remoteBranches(ctx: GitWorkspaceContext, sessionId: string): Promise<GitOutcome<{ branches: string[] }>> {
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    try {
      const output = await git(worktreePath, [
        'for-each-ref',
        '--format=%(refname:short)',
        'refs/remotes'
      ])
      const branches = output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.endsWith('/HEAD'))
      return { status: 'ok', branches }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, 'Git could not list the remote branches.')
      }
    }
  }




  /** Sets the current branch's upstream to an existing remote-tracking branch. */
export async function setUpstream(ctx: GitWorkspaceContext, sessionId: string, upstream: string): Promise<GitOutcome<{ branch: string; upstream: string }>> {
    const name = upstream.trim()
    if (
      name.length === 0 ||
      name.startsWith('-') ||
      !name.includes('/') ||
      name.includes('\u0000') ||
      name.includes('\n')
    ) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That upstream is not valid. Choose a remote branch such as origin/main.'
      }
    }
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    const branch = await git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null)
    if (branch === null || branch === 'HEAD') {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'Cannot set an upstream on a detached checkout. Switch to a branch first.'
      }
    }
    const exists = await git(worktreePath, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `refs/remotes/${name}`
    ]).catch(() => null)
    if (exists === null) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: `There is no remote branch named ${name}. Fetch first, then choose it again.`
      }
    }
    try {
      await ctx.queue.runExclusive(worktreePath, async () => {
        await git(worktreePath, ['branch', `--set-upstream-to=${name}`, branch])
      })
      return { status: 'ok', branch, upstream: name }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, `Git could not set the upstream for ${branch}.`)
      }
    }
  }




  /** Force-push guarded by the remote-tracking lease; never a bare force. */
export async function forcePush(ctx: GitWorkspaceContext, sessionId: string): Promise<GitOutcome<{ branch: string; upstream: string }>> {
    return ctx.withUpstream(sessionId, 'force-push', ['push', '--force-with-lease'])
  }




  /** Fetches the default remote without changing the working tree. */
export async function fetch(ctx: GitWorkspaceContext, sessionId: string): Promise<GitOutcome<{ remote: string }>> {
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    const remotes = await ctx.remoteNames(git, worktreePath)
    if (remotes.length === 0) {
      return {
        status: 'unavailable',
        reason: 'no-remote',
        detail: 'This repository has no remote configured, so there is nothing to fetch.'
      }
    }
    const remote = remotes.includes('origin') ? 'origin' : remotes[0]!
    try {
      await git(worktreePath, ['fetch', '--prune', remote], 120_000)
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, `Git could not fetch ${remote}. Check network access and credentials in the terminal.`)
      }
    }
    return { status: 'ok', remote }
  }
