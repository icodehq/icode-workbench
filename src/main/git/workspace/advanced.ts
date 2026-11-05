import { win32 } from 'node:path'
import type { GitWorkspaceContext } from '../workspace-context'
import type { GitOutcome } from '../git-workspace-service'
import {
  parseSubmoduleStatus,
  parseWorktreeList,
  type GitSubmoduleEntry,
  type GitWorktreeEntry
} from '../repository-model'
import { detailOf, MAX_MESSAGE_LENGTH, MAX_PATCH_BYTES } from '../git-helpers'
import { samePathResolved } from '../../worktrees/worktree-status'



  /** Local branches, remotes and tags with the current branch marked. */
export async function worktreeList(ctx: GitWorkspaceContext, sessionId: string): Promise<
    GitOutcome<{
      worktrees: Array<
        GitWorktreeEntry & { sessionId: string | null; active: boolean; primary: boolean }
      >
    }>
  > {
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, repositoryPath, repoId, worktreePath } = resolved
    try {
      const output = await git(worktreePath, ['worktree', 'list', '--porcelain'])
      const records = ctx.deps.worktrees.listByRepo(repoId)
      const entries = parseWorktreeList(output)
      for (const entry of entries) {
        // Git prints forward slashes on Windows; guest POSIX paths start with /.
        if (process.platform === 'win32' && /^[A-Za-z]:[\\/]/u.test(entry.path)) {
          entry.path = win32.normalize(entry.path)
        }
      }
      return {
        status: 'ok',
        worktrees: entries.map((entry) => {
          const owner = records.find((record) => samePathResolved(record.path, entry.path))
          return {
            ...entry,
            sessionId: owner?.sessionId ?? null,
            active: owner !== undefined,
            primary: samePathResolved(entry.path, repositoryPath)
          }
        })
      }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, 'Git could not list worktrees.')
      }
    }
  }




  /** Locks, unlocks, prunes or removes a registered worktree. */
export async function worktreeAction(ctx: GitWorkspaceContext, sessionId: string, action: 'lock' | 'unlock' | 'prune' | 'remove', path?: string, reason?: string): Promise<GitOutcome<{ action: 'lock' | 'unlock' | 'prune' | 'remove'; path: string | null }>> {
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    if (action === 'prune') {
      return ctx.queue.runExclusive(worktreePath, async () => {
        try {
          await git(worktreePath, ['worktree', 'prune'])
          return { status: 'ok' as const, action, path: null }
        } catch (error) {
          return {
            status: 'unavailable' as const,
            reason: 'git-failed' as const,
            detail: detailOf(error, 'Git could not prune worktrees.')
          }
        }
      })
    }
    if (path === undefined || path.length === 0 || path.includes('\u0000') || path.includes('\n')) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That worktree path is not valid.'
      }
    }
    const listing = await worktreeList(ctx, sessionId)
    if (listing.status !== 'ok') return listing
    const entry = listing.worktrees.find((candidate) => samePathResolved(candidate.path, path))
    if (entry === undefined) {
      return {
        status: 'unavailable',
        reason: 'not-found',
        detail: 'Git does not report that path as a worktree of this repository.'
      }
    }
    if (action === 'remove') {
      if (entry.primary) {
        return {
          status: 'unavailable',
          reason: 'git-failed',
          detail: 'The primary checkout cannot be removed from Source Control.'
        }
      }
      if (entry.active) {
        return {
          status: 'unavailable',
          reason: 'git-failed',
          detail: `That worktree belongs to session ${entry.sessionId ?? 'unknown'}. Remove the session first.`
        }
      }
    }
    if (action === 'lock' && entry.active) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'A session worktree cannot be locked while its session owns it.'
      }
    }
    if (reason !== undefined && reason.length > 200) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That lock reason is too long.'
      }
    }
    return ctx.queue.runExclusive(worktreePath, async () => {
      try {
        if (action === 'lock') {
          await git(
            worktreePath,
            reason !== undefined && reason.trim().length > 0
              ? ['worktree', 'lock', '--reason', reason.trim(), entry.path]
              : ['worktree', 'lock', entry.path]
          )
        } else if (action === 'unlock') {
          await git(worktreePath, ['worktree', 'unlock', entry.path])
        } else {
          await git(worktreePath, ['worktree', 'remove', entry.path])
        }
        return { status: 'ok' as const, action, path: entry.path }
      } catch (error) {
        return {
          status: 'unavailable' as const,
          reason: 'git-failed' as const,
          detail: detailOf(
            error,
            action === 'remove'
              ? 'Git could not remove that worktree. It may contain uncommitted files.'
              : `Git could not ${action} that worktree.`
          )
        }
      }
    })
  }




  /** Submodules of this worktree and their pointer state. */
export async function submoduleStatus(ctx: GitWorkspaceContext, sessionId: string): Promise<GitOutcome<{ submodules: GitSubmoduleEntry[] }>> {
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { raw, worktreePath } = resolved
    try {
      // The clean marker is a leading space; the trimmed helper would turn
      // every clean line into a bare object id that the parser cannot read.
      const result = await raw(worktreePath, ['submodule', 'status'])
      if (result.exitCode !== 0) {
        return {
          status: 'unavailable',
          reason: 'git-failed',
          detail: 'Git could not read submodule status.'
        }
      }
      return { status: 'ok', submodules: parseSubmoduleStatus(result.stdout) }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, 'Git could not read submodule status.')
      }
    }
  }




  /** Initializes, updates, syncs or stages one or all submodules. */
export async function submoduleAction(ctx: GitWorkspaceContext, sessionId: string, action: 'init' | 'update' | 'sync' | 'stage', path?: string): Promise<GitOutcome<{ action: 'init' | 'update' | 'sync' | 'stage'; path: string | null }>> {
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    if (path !== undefined && (path.length === 0 || path.includes('\u0000') || path.includes('\n'))) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That submodule path is not valid.'
      }
    }
    const listing = await submoduleStatus(ctx, sessionId)
    if (listing.status !== 'ok') return listing
    if (path !== undefined) {
      const entry = listing.submodules.find((candidate) => candidate.path === path)
      if (entry === undefined) {
        return {
          status: 'unavailable',
          reason: 'not-found',
          detail: 'Git does not report that path as a submodule.'
        }
      }
    }
    if (action === 'stage' && path === undefined) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'A submodule path is required to stage a pointer.'
      }
    }
    return ctx.queue.runExclusive(worktreePath, async () => {
      try {
        if (action === 'stage') {
          await git(worktreePath, ['add', '--', path!])
        } else {
          const args =
            action === 'init'
              ? ['submodule', 'init']
              : action === 'sync'
                ? ['submodule', 'sync']
                : ['submodule', 'update', '--init']
          if (path !== undefined) args.push('--', path)
          await git(worktreePath, args, action === 'update' ? 120_000 : 30_000)
        }
        return { status: 'ok' as const, action, path: path ?? null }
      } catch (error) {
        return {
          status: 'unavailable' as const,
          reason: 'git-failed' as const,
          detail: detailOf(
            error,
            action === 'stage'
              ? 'Git could not stage that submodule pointer.'
              : `Git could not ${action} ${path ?? 'submodules'}.`
          )
        }
      }
    })
  }



  /**
   * Lists stashes with their selector, subject, date and commit id.
   *
   * NUL-separated fields keep a stash message containing tabs or newlines from
   * shifting later entries. The selector is parsed back into a numeric index so
   * every later action is addressed as `stash@{n}` rather than trusting a ref
   * string supplied by the renderer.
   */
export async function stashList(ctx: GitWorkspaceContext, sessionId: string): Promise<
    GitOutcome<{
      stashes: Array<{ index: number; ref: string; subject: string; date: string; oid: string }>
    }>
  > {
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { raw, worktreePath } = resolved
    let result
    try {
      result = await raw(worktreePath, [
        'stash',
        'list',
        '--format=%gd%x00%gs%x00%ci%x00%H%x00'
      ])
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, 'Git could not list stashes.')
      }
    }
    if (result.exitCode !== 0) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'Git could not list stashes.'
      }
    }
    const parts = result.stdout.split('\u0000')
    const stashes: Array<{ index: number; ref: string; subject: string; date: string; oid: string }> =
      []
    for (let offset = 0; offset + 3 < parts.length; offset += 4) {
      const ref = parts[offset] ?? ''
      const subject = parts[offset + 1] ?? ''
      const date = parts[offset + 2] ?? ''
      const oid = parts[offset + 3] ?? ''
      const match = /^stash@\{(\d+)\}$/u.exec(ref)
      if (match === null || !/^[0-9a-f]{7,64}$/u.test(oid)) continue
      stashes.push({ index: Number.parseInt(match[1]!, 10), ref, subject, date, oid })
    }
    return { status: 'ok', stashes }
  }




  /** Creates a stash. `includeUntracked` also saves files Git has not added yet. */
export async function stashPush(ctx: GitWorkspaceContext, sessionId: string, message: string, includeUntracked: boolean, keepIndex: boolean): Promise<GitOutcome<{ created: boolean }>> {
    const subject = message.trim()
    if (subject.length > MAX_MESSAGE_LENGTH) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That stash message is too long.'
      }
    }
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    return ctx.queue.runExclusive(worktreePath, async () => {
      const args = ['stash', 'push']
      if (subject.length > 0) args.push('-m', subject)
      if (includeUntracked) args.push('--include-untracked')
      if (keepIndex) args.push('--keep-index')
      try {
        const output = await git(worktreePath, args)
        return {
          status: 'ok' as const,
          created: !/No local changes to save/iu.test(output)
        }
      } catch (error) {
        return {
          status: 'unavailable' as const,
          reason: 'git-failed' as const,
          detail: detailOf(error, 'Git could not create a stash.')
        }
      }
    })
  }




  /** Unified patch for one stash, including untracked files when present. */
export async function stashDiff(ctx: GitWorkspaceContext, sessionId: string, index: number): Promise<GitOutcome<{ ref: string; patch: string; truncated: boolean }>> {
    if (!Number.isInteger(index) || index < 0 || index > 10_000) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'That stash does not exist.' }
    }
    const ref = `stash@{${String(index)}}`
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    try {
      const output = await git(worktreePath, [
        'stash',
        'show',
        '-p',
        '--include-untracked',
        '--no-color',
        ref
      ])
      const bytes = Buffer.from(output, 'utf8')
      const truncated = bytes.byteLength > MAX_PATCH_BYTES
      return {
        status: 'ok',
        ref,
        patch: truncated ? bytes.subarray(0, MAX_PATCH_BYTES).toString('utf8') : output,
        truncated
      }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, 'Git could not read that stash.')
      }
    }
  }




  /** Applies, pops or drops one stash addressed by its list index. */
export async function stashAction(ctx: GitWorkspaceContext, sessionId: string, index: number, action: 'apply' | 'pop' | 'drop'): Promise<GitOutcome<{ ref: string; action: 'apply' | 'pop' | 'drop' }>> {
    if (!Number.isInteger(index) || index < 0 || index > 10_000) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'That stash does not exist.' }
    }
    const ref = `stash@{${String(index)}}`
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    return ctx.queue.runExclusive(worktreePath, async () => {
      try {
        await git(worktreePath, ['stash', action, ref])
        return { status: 'ok' as const, ref, action }
      } catch (error) {
        return {
          status: 'unavailable' as const,
          reason: 'git-failed' as const,
          detail: detailOf(
            error,
            action === 'drop'
              ? 'Git could not drop that stash.'
              : 'Git could not apply that stash. It may conflict with the current worktree.'
          )
        }
      }
    })
  }
