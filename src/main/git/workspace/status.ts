import type { GitWorkspaceContext } from '../workspace-context'
import type { GitOutcome, GitUnavailable } from '../git-workspace-service'
import type {
  GitOperationKind,
  GitStatusEntry,
  GitWorkspaceStatus
} from '../../../shared/domain/git-workspace'
import type { ExecutionTarget } from '../../../shared/domain/repository'
import { parseOperationMarker } from '../repository-model'
import { STATUS_V2_ARGS, PorcelainV2Parser, parsePorcelainV2, type ParsedRepositoryStatus } from '../status-reader'
import { isAbortError } from '../operation-queue'
import { STATUS_ARGS, parseNumstatZ, type ParsedNumstat } from '../git-helpers'
import { detailOf } from '../git-helpers'


export async function status(ctx: GitWorkspaceContext, sessionId: string, options: { signal?: AbortSignal } = {}): Promise<GitOutcome<{ snapshot: GitWorkspaceStatus }>> {
    ctx.statusReads.get(sessionId)?.abort()
    const controller = new AbortController()
    const forwardAbort = (): void => controller.abort()
    if (options.signal?.aborted) controller.abort()
    else options.signal?.addEventListener('abort', forwardAbort, { once: true })
    ctx.statusReads.set(sessionId, controller)
    try {
      return await ctx.readStatusSnapshot(sessionId, controller.signal)
    } finally {
      options.signal?.removeEventListener('abort', forwardAbort)
      if (ctx.statusReads.get(sessionId) === controller) ctx.statusReads.delete(sessionId)
    }
  }



  /**
   * The merge/rebase/cherry-pick/revert/bisect marker in the repository, if any.
   *
   * This is a repository-level fact, not a worktree status field. It is read
   * from the common Git directory by the existing inspection path, which knows
   * whether to stat locally or ask the guest.
   */
export async function operationState(ctx: GitWorkspaceContext, sessionId: string): Promise<GitOutcome<{ operation: GitOperationKind | null; marker: string | null }>> {
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    try {
      const state = await ctx.deps.gitWorktrees.inspectRepository(
        resolved.worktreePath,
        resolved.target
      )
      const marker = state.inProgressOperation
      return { status: 'ok', operation: parseOperationMarker(marker), marker }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'worktree-unavailable',
        detail: detailOf(error, 'Git could not inspect the repository operation state.')
      }
    }
  }




  /**
   * Continues an in-progress merge/rebase/cherry-pick/revert.
   *
   * Conflicts must be resolved and staged first. The editor is forced to
   * `true` so a rebase or sequencer step can never block on an interactive
   * editor; the operation marker is the source of truth for which command runs.
   */
export async function continueOperation(ctx: GitWorkspaceContext, sessionId: string): Promise<GitOutcome<{ operation: GitOperationKind }>> {
    const state = await operationState(ctx, sessionId)
    if (state.status !== 'ok') return state
    if (state.operation === null) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'There is no merge, rebase, cherry-pick or revert to continue.'
      }
    }
    if (state.operation === 'bisect') {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'A bisect is in progress. Finish or reset it in the terminal.'
      }
    }
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved

    const conflicts = await git(worktreePath, ['diff', '--name-only', '--diff-filter=U']).catch(
      () => ''
    )
    if (conflicts.trim().length > 0) {
      const count = conflicts.split('\n').filter((line) => line.trim().length > 0).length
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: `Resolve ${String(count)} conflict${count === 1 ? '' : 's'} before continuing.`
      }
    }

    try {
      await ctx.queue.runExclusive(worktreePath, async () => {
        await git(worktreePath, [
          '-c',
          'core.editor=true',
          '-c',
          'sequence.editor=true',
          state.operation!,
          '--continue'
        ])
      })
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, `Git could not continue the ${state.operation}.`)
      }
    }
    return { status: 'ok', operation: state.operation }
  }




  /** Aborts an in-progress merge/rebase/cherry-pick/revert. */
export async function abortOperation(ctx: GitWorkspaceContext, sessionId: string): Promise<GitOutcome<{ operation: GitOperationKind }>> {
    const state = await operationState(ctx, sessionId)
    if (state.status !== 'ok') return state
    if (state.operation === null) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'There is no merge, rebase, cherry-pick or revert to abort.'
      }
    }
    if (state.operation === 'bisect') {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'A bisect is in progress. Reset it in the terminal.'
      }
    }
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    try {
      await ctx.queue.runExclusive(worktreePath, async () => {
        await git(worktreePath, [state.operation!, '--abort'])
      })
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, `Git could not abort the ${state.operation}.`)
      }
    }
    return { status: 'ok', operation: state.operation }
  }




  /**
   * The paths and target a worktree watcher needs.
   *
   * A guest worktree's paths are guest paths; the caller decides whether it can
   * translate them to a Windows path (DrvFs) or must use the Host (ext4).
   */
export async function watchTargetDetails(ctx: GitWorkspaceContext, sessionId: string): Promise<{ worktreePath: string; gitDir: string; target: ExecutionTarget } | null> {
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return null
    const gitDir = await resolved
      .git(resolved.worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
      .catch(() => null)
    if (gitDir === null) return null
    return { worktreePath: resolved.worktreePath, gitDir, target: resolved.target }
  }




  export async function readStatusSnapshot(ctx: GitWorkspaceContext, sessionId: string, signal: AbortSignal): Promise<GitOutcome<{ snapshot: GitWorkspaceStatus }>> {
    const cancelled = (): GitUnavailable => ({
      status: 'unavailable',
      reason: 'git-failed',
      detail: 'The status read was cancelled.'
    })
    if (signal.aborted) return cancelled()
    const resolved = await ctx.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { raw, worktreePath } = resolved

    let parsed: ParsedRepositoryStatus
    try {
      const stream = await ctx.deps.gitWorktrees.streamGitFor(resolved.target)
      if (stream !== null) {
        const parser = new PorcelainV2Parser()
        let limitHit = false
        const limitController = new AbortController()
        const forwardAbort = (): void => limitController.abort()
        if (signal.aborted) limitController.abort()
        else signal.addEventListener('abort', forwardAbort, { once: true })
        try {
          const result = await stream(
            worktreePath,
            [...STATUS_V2_ARGS],
            (chunk) => {
              if (!parser.push(chunk)) {
                // The parser has what it needs; stop the Git process instead of
                // waiting for output the UI is not going to show.
                limitHit = true
                limitController.abort()
              }
            },
            { signal: limitController.signal }
          )
          if (result.timedOut) {
            return {
              status: 'unavailable',
              reason: 'worktree-unavailable',
              detail: 'Git timed out while reading this worktree.'
            }
          }
          if (result.exitCode !== 0 && !limitHit) {
            return {
              status: 'unavailable',
              reason: 'not-a-repository',
              detail: 'Git could not read this worktree as a repository.'
            }
          }
        } catch (error) {
          // A limit-triggered abort is a successful partial read; any other
          // abort is real cancellation and is handled below.
          if (!(limitHit && isAbortError(error))) throw error
        } finally {
          signal.removeEventListener('abort', forwardAbort)
        }
        parsed = parser.finish()
      } else {
        const statusRead = await raw(worktreePath, STATUS_ARGS)
        if (statusRead.exitCode !== 0) {
          return {
            status: 'unavailable',
            reason: 'not-a-repository',
            detail: 'Git could not read this worktree as a repository.'
          }
        }
        parsed = parsePorcelainV2(statusRead.stdout)
      }
    } catch (error) {
      if (isAbortError(error) || signal.aborted) return cancelled()
      return {
        status: 'unavailable',
        reason: 'worktree-unavailable',
        detail: detailOf(error, 'Git could not read this worktree.')
      }
    }

    // Status lists paths; the staged and working-tree numbers are separate
    // projections of one checkout, so they need separate numstat reads. This is
    // still the expensive part of a refresh; Phase 1b moves it off the watcher
    // path and computes stats lazily (Phase 0 spike: 1.7 s for 12k files).
    const [stagedNumstat, unstagedNumstat] = await Promise.all([
      raw(worktreePath, ['diff', '--cached', '--numstat', '-z', '-M']).catch(() => null),
      raw(worktreePath, ['diff', '--numstat', '-z', '-M']).catch(() => null)
    ])
    const statsByPath = (result: { stdout: string } | null): Map<string, ParsedNumstat> =>
      new Map((result === null ? [] : parseNumstatZ(result.stdout)).map((entry) => [entry.path, entry]))
    const stagedStats = statsByPath(stagedNumstat)
    const unstagedStats = statsByPath(unstagedNumstat)
    const withStats = (entry: GitStatusEntry): GitStatusEntry => {
      const stats =
        entry.area === 'staged'
          ? stagedStats.get(entry.path)
          : entry.area === 'unstaged'
            ? unstagedStats.get(entry.path)
            : undefined
      if (!stats) return entry
      return {
        ...entry,
        added: stats.additions,
        removed: stats.deletions,
        binary: stats.binary
      }
    }
    const withAreaStats = (entries: GitStatusEntry[]): GitStatusEntry[] => entries.map(withStats)

    return {
      status: 'ok',
      snapshot: {
        branch: parsed.branch,
        headOid: parsed.headOid,
        upstream: parsed.upstream,
        ahead: parsed.ahead,
        behind: parsed.behind,
        staged: withAreaStats(parsed.staged),
        unstaged: withAreaStats(parsed.unstaged),
        untracked: withAreaStats(parsed.untracked),
        conflicted: withAreaStats(parsed.conflicted),
        clean: parsed.clean,
        statusLength: parsed.statusLength,
        didHitLimit: parsed.didHitLimit,
        revision: parsed.revision
      }
    }
  }
