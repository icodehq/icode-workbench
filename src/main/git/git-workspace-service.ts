import { win32 } from 'node:path'
import type { RepositoryStore } from '../persistence/repository-store'
import type { WorktreeStore } from '../persistence/worktree-store'
import type { GitWorktreeService } from '../worktrees/git-worktree-service'
import { samePathResolved } from '../worktrees/worktree-status'
import {
  parseAheadBehind,
  type GitCommitDetail,
  type GitCommitResult,
  type GitLogPage,
  type GitRangeFile,
  type GitRemote,
  type GitTag,
  type GitStatusEntry,
  type GitWorkspaceStatus
} from '../../shared/domain/git-workspace'
import {
  STATUS_V2_ARGS,
  PorcelainV2Parser,
  parsePorcelainV2,
  type ParsedRepositoryStatus
} from './status-reader'
import { GitOperationQueue, isAbortError } from './operation-queue'
import {
  executeDiscardBatch,
  executePathBatch,
  type GitBatchResult,
  type GitPathTarget
} from './batch-ops'
import {
  parseOperationMarker,
  parseRefs,
  parseRemotes,
  parseSubmoduleStatus,
  parseWorktreeList,
  type GitOperationKind,
  type GitRef,
  type GitSubmoduleEntry,
  type GitWorktreeEntry
} from './repository-model'
import { parseBlamePorcelain, type BlameLine } from './blame-reader'
import {
  EMPTY_TREE_OID,
  LOG_PRETTY_FORMAT,
  parseCommitMetadata,
  parseLogOutput
} from './history-reader'
import type { ExecutionTarget } from '../../shared/domain/repository'
import type { RepoId } from '../../shared/domain/ids'
import type { FilesUnavailable } from '../files/workspace-files-service'
import { FILES_MAX_FILE_BYTES } from '../../shared/domain/workspace-files'

/**
 * Git answers with the same shape as files for anything about the checkout
 * itself, plus its own operation failures.
 */
export type GitUnavailable = FilesUnavailable | {
  status: 'unavailable'
  reason:
    | 'not-a-repository'
    | 'nothing-to-commit'
    | 'commit-failed'
    | 'git-failed'
    | 'dirty-worktree'
    | 'no-upstream'
    | 'no-remote'
  detail: string
}

export type GitWorkspaceDeps = {
  repositories: RepositoryStore
  worktrees: WorktreeStore
  gitWorktrees: GitWorktreeService
}

export type GitOutcome<T> = ({ status: 'ok' } & T) | GitUnavailable

/** A commit message is one line of intent; blank messages are refused. */
const MAX_MESSAGE_LENGTH = 4000

/** Matches the review reader's patch cap so a huge commit file stays bounded. */
const MAX_PATCH_BYTES = 2 * 1024 * 1024 + 64 * 1024

/**
 * `-uall` reports every untracked file. Without it Git collapses a new
 * directory to `dir/`, and per-file stage/discard cannot find the file the
 * reviewer selected. v2 answers branch and ahead/behind in the same call.
 */
const STATUS_ARGS: string[] = [...STATUS_V2_ARGS]

/**
 * Git state and the common write operations, scoped to one session's checkout.
 *
 * Reads run where the checkout lives, through the same target-aware Git the rest
 * of the app uses. Nothing here rewrites history, and nothing runs on a
 * repository the user has not selected.
 */
export class GitWorkspaceService {
  private readonly queue = new GitOperationQueue()
  /** One live status read per session; a newer read supersedes the older one. */
  private readonly statusReads = new Map<string, AbortController>()

  constructor(private readonly deps: GitWorkspaceDeps) {}

  async status(
    sessionId: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<GitOutcome<{ snapshot: GitWorkspaceStatus }>> {
    this.statusReads.get(sessionId)?.abort()
    const controller = new AbortController()
    const forwardAbort = (): void => controller.abort()
    if (options.signal?.aborted) controller.abort()
    else options.signal?.addEventListener('abort', forwardAbort, { once: true })
    this.statusReads.set(sessionId, controller)
    try {
      return await this.readStatusSnapshot(sessionId, controller.signal)
    } finally {
      options.signal?.removeEventListener('abort', forwardAbort)
      if (this.statusReads.get(sessionId) === controller) this.statusReads.delete(sessionId)
    }
  }

  /** Cancels a status read currently in flight for a session. */
  cancelReads(sessionId: string): boolean {
    const controller = this.statusReads.get(sessionId)
    if (!controller) return false
    controller.abort()
    this.statusReads.delete(sessionId)
    return true
  }

  private async readStatusSnapshot(
    sessionId: string,
    signal: AbortSignal
  ): Promise<GitOutcome<{ snapshot: GitWorkspaceStatus }>> {
    const cancelled = (): GitUnavailable => ({
      status: 'unavailable',
      reason: 'git-failed',
      detail: 'The status read was cancelled.'
    })
    if (signal.aborted) return cancelled()
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { raw, worktreePath } = resolved

    let parsed: ParsedRepositoryStatus
    try {
      const stream = await this.deps.gitWorktrees.streamGitFor(resolved.target)
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

  /**
   * The merge/rebase/cherry-pick/revert/bisect marker in the repository, if any.
   *
   * This is a repository-level fact, not a worktree status field. It is read
   * from the common Git directory by the existing inspection path, which knows
   * whether to stat locally or ask the guest.
   */
  async operationState(
    sessionId: string
  ): Promise<GitOutcome<{ operation: GitOperationKind | null; marker: string | null }>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    try {
      const state = await this.deps.gitWorktrees.inspectRepository(
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
  async continueOperation(
    sessionId: string
  ): Promise<GitOutcome<{ operation: GitOperationKind }>> {
    const state = await this.operationState(sessionId)
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
    const resolved = await this.resolve(sessionId)
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
      await this.queue.runExclusive(worktreePath, async () => {
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
  async abortOperation(
    sessionId: string
  ): Promise<GitOutcome<{ operation: GitOperationKind }>> {
    const state = await this.operationState(sessionId)
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
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    try {
      await this.queue.runExclusive(worktreePath, async () => {
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

  /** Local branches, remotes and tags with the current branch marked. */
  async refs(sessionId: string): Promise<GitOutcome<{ refs: GitRef[] }>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    try {
      const output = await git(worktreePath, [
        'for-each-ref',
        '--format=%(refname)%09%(objectname)%09%(upstream:short)%09%(HEAD)',
        'refs/heads',
        'refs/remotes',
        'refs/tags'
      ])
      return { status: 'ok', refs: parseRefs(output) }
    } catch (error) {
      return { status: 'unavailable', reason: 'git-failed', detail: detailOf(error, 'Git could not list refs.') }
    }
  }

  /** Every worktree registered for this repository, for branch-in-use checks. */
  async worktrees(sessionId: string): Promise<GitOutcome<{ worktrees: GitWorktreeEntry[] }>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    try {
      const output = await git(worktreePath, ['worktree', 'list', '--porcelain'])
      return { status: 'ok', worktrees: parseWorktreeList(output) }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, 'Git could not list worktrees.')
      }
    }
  }

  /**
   * Worktrees with the session that owns each checkout.
   *
   * The first entry is Git's primary checkout. A path that appears in the
   * session worktree store is marked active; the UI uses that to refuse lock
   * and removal, because those checkouts belong to a live or resumable session.
   */
  async worktreeList(sessionId: string): Promise<
    GitOutcome<{
      worktrees: Array<
        GitWorktreeEntry & { sessionId: string | null; active: boolean; primary: boolean }
      >
    }>
  > {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, repositoryPath, repoId, worktreePath } = resolved
    try {
      const output = await git(worktreePath, ['worktree', 'list', '--porcelain'])
      const records = this.deps.worktrees.listByRepo(repoId)
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
  async worktreeAction(
    sessionId: string,
    action: 'lock' | 'unlock' | 'prune' | 'remove',
    path?: string,
    reason?: string
  ): Promise<GitOutcome<{ action: 'lock' | 'unlock' | 'prune' | 'remove'; path: string | null }>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    if (action === 'prune') {
      return this.queue.runExclusive(worktreePath, async () => {
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
    const listing = await this.worktreeList(sessionId)
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
    return this.queue.runExclusive(worktreePath, async () => {
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
  async submoduleStatus(
    sessionId: string
  ): Promise<GitOutcome<{ submodules: GitSubmoduleEntry[] }>> {
    const resolved = await this.resolve(sessionId)
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
  async submoduleAction(
    sessionId: string,
    action: 'init' | 'update' | 'sync' | 'stage',
    path?: string
  ): Promise<GitOutcome<{ action: 'init' | 'update' | 'sync' | 'stage'; path: string | null }>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    if (path !== undefined && (path.length === 0 || path.includes('\u0000') || path.includes('\n'))) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That submodule path is not valid.'
      }
    }
    const listing = await this.submoduleStatus(sessionId)
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
    return this.queue.runExclusive(worktreePath, async () => {
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
   * Changed files between two revisions.
   *
   * Refs are resolved to commits before `diff` runs, so an arbitrary string is
   * never handed to Git as an option. The file list is bounded; the returned
   * `truncated` flag tells the history view to paginate instead of pretending
   * the range ended.
   */
  async rangeDiff(
    sessionId: string,
    from: string,
    to = 'HEAD'
  ): Promise<GitOutcome<{ fromOid: string; toOid: string; files: GitRangeFile[]; truncated: boolean }>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved

    const resolveRef = async (ref: string): Promise<string | null> => {
      if (ref.length === 0 || ref.startsWith('-') || ref.includes('\u0000')) return null
      // A root commit is diffed against the empty tree, which is not a commit;
      // `^{commit}` would reject it.
      if (ref === EMPTY_TREE_OID) return EMPTY_TREE_OID
      return git(worktreePath, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).catch(
        () => null
      )
    }
    const [fromOid, toOid] = await Promise.all([resolveRef(from), resolveRef(to)])
    if (fromOid === null || toOid === null) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That revision is not available in this worktree.'
      }
    }

    try {
      const [nameStatus, numstat] = await Promise.all([
        git(worktreePath, ['diff', '--name-status', '-z', '-M', fromOid, toOid, '--']),
        git(worktreePath, ['diff', '--numstat', '-z', '-M', fromOid, toOid, '--'])
      ])
      const counts = new Map(parseNumstatZ(numstat).map((entry) => [entry.path, entry]))
      const files: GitRangeFile[] = parseNameStatusZ(nameStatus).map((entry) => {
        const count = counts.get(entry.path)
        const status =
          entry.status === 'A'
            ? 'added'
            : entry.status === 'D'
              ? 'deleted'
              : entry.status === 'R'
                ? 'renamed'
                : entry.status === 'C'
                  ? 'copied'
                  : 'modified'
        return {
          path: entry.path,
          oldPath: entry.oldPath,
          status,
          additions: count?.additions ?? null,
          deletions: count?.deletions ?? null,
          binary: count?.binary ?? false
        }
      })
      const limit = 5000
      return {
        status: 'ok',
        fromOid,
        toOid,
        files: files.slice(0, limit),
        truncated: files.length > limit
      }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, 'Git could not compare those revisions.')
      }
    }
  }

  /**
   * The paths and target a worktree watcher needs.
   *
   * A guest worktree's paths are guest paths; the caller decides whether it can
   * translate them to a Windows path (DrvFs) or must use the Host (ext4).
   */
  async watchTargetDetails(
    sessionId: string
  ): Promise<{ worktreePath: string; gitDir: string; target: ExecutionTarget } | null> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return null
    const gitDir = await resolved
      .git(resolved.worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
      .catch(() => null)
    if (gitDir === null) return null
    return { worktreePath: resolved.worktreePath, gitDir, target: resolved.target }
  }

  /**
   * The paths for a local watcher.
   *
   * Returns null for a guest target: Phase 1c decides whether its worktree is a
   * translatable DrvFs path or needs the Host watcher, and must not silently
   * watch the controller's filesystem in the guest's place.
   */
  async watchTarget(sessionId: string): Promise<{ worktreePath: string; gitDir: string } | null> {
    const details = await this.watchTargetDetails(sessionId)
    if (details === null || details.target.kind !== 'local') return null
    const { worktreePath, gitDir } = details
    if (!gitDir.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(gitDir)) return null
    return { worktreePath, gitDir }
  }

  /** Stages everything, the way `git add -A` does from the worktree root. */
  async stageAll(sessionId: string): Promise<GitOutcome<{ staged: number }>> {
    return this.mutate(sessionId, ['add', '-A'], (before) => {
      const status = before as GitWorkspaceStatus
      const paths = new Set(
        [...status.staged, ...status.unstaged, ...status.untracked].map((entry) => entry.path)
      )
      return { staged: paths.size }
    })
  }

  async unstageAll(sessionId: string): Promise<GitOutcome<{ unstaged: number }>> {
    return this.mutate(sessionId, ['reset'], (before) => {
      const status = before as GitWorkspaceStatus
      return { unstaged: new Set(status.staged.map((entry) => entry.path)).size }
    })
  }

  /**
   * Commits the index as it stands, or every tracked change with `all`.
   *
   * The message is passed as argv, never through a shell, and an empty index is
   * refused before Git runs so the user gets a sentence rather than Git's
   * "nothing to commit" exit status.
   */
  async commit(
    sessionId: string,
    message: string,
    options: { all?: boolean; signOff?: boolean; sign?: boolean } = {}
  ): Promise<GitOutcome<GitCommitResult>> {
    const trimmed = message.trim()
    if (trimmed.length === 0) {
      return { status: 'unavailable', reason: 'commit-failed', detail: 'A commit message is required.' }
    }
    if (trimmed.length > MAX_MESSAGE_LENGTH) {
      return {
        status: 'unavailable',
        reason: 'commit-failed',
        detail: `The commit message is longer than ${String(MAX_MESSAGE_LENGTH)} characters.`
      }
    }

    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved

    const stagedCount = await git(worktreePath, ['diff', '--cached', '--name-only'])
      .then((value) => value.split('\n').filter((line) => line.trim().length > 0).length)
      .catch(() => 0)
    // `git commit -a` also picks up tracked working-tree changes, so a staged
    // index is not required for it.
    const trackedUnstagedCount =
      options.all === true
        ? await git(worktreePath, ['diff', '--name-only'])
            .then((value) => value.split('\n').filter((line) => line.trim().length > 0).length)
            .catch(() => 0)
        : 0
    if (stagedCount === 0 && trackedUnstagedCount === 0) {
      return {
        status: 'unavailable',
        reason: 'nothing-to-commit',
        detail: 'There is nothing staged to commit. Stage the changes you want first.'
      }
    }

    const args = ['commit']
    if (options.all === true) args.push('-a')
    if (options.signOff === true) args.push('--signoff')
    if (options.sign === true) args.push('-S')
    args.push('-m', trimmed)

    try {
      await this.queue.runExclusive(worktreePath, async () => {
        await git(worktreePath, args)
      })
    } catch (error) {
      return { status: 'unavailable', reason: 'commit-failed', detail: detailOf(error, 'Git refused the commit.') }
    }

    const oid = await git(worktreePath, ['rev-parse', 'HEAD']).catch(() => '')
    const subject = await git(worktreePath, ['log', '-1', '--pretty=%s']).catch(() => trimmed)
    return {
      status: 'ok',
      oid: oid.slice(0, 7),
      subject,
      files: stagedCount
    }
  }

  /**
   * Stages or unstages a selection in one serialized operation.
   *
   * Each target keeps its own outcome, so a path the live Agent changed between
   * the snapshot and the command is reported as failed rather than failing the
   * whole batch. `unborn` selects `git rm --cached` for unstage, because there is
   * no HEAD to reset to.
   */
  async setPathsStaged(
    sessionId: string,
    targets: readonly GitPathTarget[],
    staged: boolean
  ): Promise<GitOutcome<{ result: GitBatchResult }>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, raw, worktreePath } = resolved
    const before = await this.readStatus(raw, worktreePath)
    if (before === null) {
      return { status: 'unavailable', reason: 'worktree-unavailable', detail: 'Git could not read this worktree.' }
    }
    const result = await this.queue.runExclusive(worktreePath, () =>
      executePathBatch({
        action: staged ? 'stage' : 'unstage',
        targets,
        unborn: before.headOid === null,
        execute: async (args) => {
          await git(worktreePath, [...args])
        }
      })
    )
    return { status: 'ok', result }
  }

  /**
   * Discards a selection after checking that it still describes the worktree.
   *
   * `expectedRevision` is the status stamp from the snapshot the user saw. A
   * mismatch means the live Agent edited the checkout in between, and a
   * destructive command must not proceed on the old assumption.
   */
  async discardPaths(
    sessionId: string,
    targets: readonly GitPathTarget[],
    expectedRevision?: string
  ): Promise<GitOutcome<{ result: GitBatchResult }>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, raw, worktreePath } = resolved
    const before = await this.readStatus(raw, worktreePath)
    if (before === null) {
      return { status: 'unavailable', reason: 'worktree-unavailable', detail: 'Git could not read this worktree.' }
    }
    if (expectedRevision !== undefined && before.revision !== expectedRevision) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'The worktree changed since this selection was read. Refresh and select the paths again.'
      }
    }
    const result = await this.queue.runExclusive(worktreePath, () =>
      executeDiscardBatch({
        targets,
        execute: async (commands) => {
          for (const args of commands) await git(worktreePath, [...args])
        }
      })
    )
    return { status: 'ok', result }
  }

  /** Stages or unstages one path, leaving every other path as it was. */
  async setPathStaged(
    sessionId: string,
    path: string,
    staged: boolean
  ): Promise<GitOutcome<{ path: string; staged: boolean }>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, raw, worktreePath } = resolved
    const relative = path
    if (
      relative.length === 0 ||
      relative.startsWith('/') ||
      relative.split('/').some((segment) => segment === '..' || segment === '.')
    ) {
      return { status: 'unavailable', reason: 'path-outside', detail: 'That path is not inside this worktree.' }
    }

    return this.queue.runExclusive(worktreePath, async () => {
      const statusRead = await raw(worktreePath, STATUS_ARGS)
      if (statusRead.exitCode !== 0) {
        return {
          status: 'unavailable' as const,
          reason: 'not-a-repository' as const,
          detail: 'Git could not read this worktree as a repository.'
        }
      }
      const entries = entriesOf(parsePorcelainV2(statusRead.stdout)).filter(
        (candidate) => candidate.path === relative
      )
      const entry = entries.find((candidate) =>
        staged ? candidate.area === 'unstaged' || candidate.area === 'untracked' : candidate.area === 'staged'
      )
      if (!entry) {
        return {
          status: 'unavailable' as const,
          reason: 'not-found' as const,
          detail: 'Git does not report that path as changed in that area.'
        }
      }
      if (entries.some((candidate) => candidate.area === 'conflicted')) {
        return {
          status: 'unavailable' as const,
          reason: 'git-failed' as const,
          detail: 'That path has a conflict. Resolve it in the terminal before staging it here.'
        }
      }

      try {
        await git(worktreePath, staged ? ['add', '--', relative] : ['reset', '--', relative])
        return { status: 'ok' as const, path: relative, staged }
      } catch (error) {
        return {
          status: 'unavailable' as const,
          reason: 'git-failed' as const,
          detail: detailOf(error, `Git could not ${staged ? 'stage' : 'unstage'} that path.`)
        }
      }
    })
  }

  /** Local branches, for the branch switcher. */
  async branches(sessionId: string): Promise<GitOutcome<{ current: string | null; names: string[] }>> {
    const resolved = await this.resolve(sessionId)
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
  async switchBranch(sessionId: string, branch: string): Promise<GitOutcome<{ branch: string }>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, raw, worktreePath } = resolved

    const name = branch.trim()
    if (name.length === 0 || name.startsWith('-') || name.length > 255) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'That branch name is not valid.' }
    }

    return this.queue.runExclusive(worktreePath, async () => {
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
  async createBranch(
    sessionId: string,
    branch: string,
    at?: string
  ): Promise<GitOutcome<{ branch: string }>> {
    const resolved = await this.resolve(sessionId)
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
  async createTag(
    sessionId: string,
    name: string,
    oid: string
  ): Promise<GitOutcome<{ name: string; oid: string }>> {
    const trimmed = name.trim()
    if (trimmed.length === 0 || trimmed.length > 200) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'That tag name is not valid.' }
    }
    const resolved = await this.resolve(sessionId)
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
      await this.queue.runExclusive(worktreePath, async () => {
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
  async renameBranch(
    sessionId: string,
    from: string,
    to: string
  ): Promise<GitOutcome<{ from: string; branch: string }>> {
    const source = from.trim()
    const target = to.trim()
    if (source.length === 0 || target.length === 0) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'Both branch names are required.' }
    }
    const resolved = await this.resolve(sessionId)
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
      await this.queue.runExclusive(worktreePath, async () => {
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
  async deleteBranch(
    sessionId: string,
    branch: string
  ): Promise<GitOutcome<{ branch: string }>> {
    const name = branch.trim()
    if (name.length === 0 || name.startsWith('-')) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'That branch name is not valid.' }
    }
    const resolved = await this.resolve(sessionId)
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
      await this.queue.runExclusive(worktreePath, async () => {
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
  async mergeBranch(
    sessionId: string,
    branch: string
  ): Promise<GitOutcome<{ branch: string }>> {
    const name = branch.trim()
    if (name.length === 0 || name.startsWith('-')) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'That branch name is not valid.' }
    }
    const resolved = await this.resolve(sessionId)
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
      await this.queue.runExclusive(worktreePath, async () => {
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
  async rebaseBranch(
    sessionId: string,
    branch: string
  ): Promise<GitOutcome<{ branch: string }>> {
    const name = branch.trim()
    if (name.length === 0 || name.startsWith('-')) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'That branch name is not valid.' }
    }
    const resolved = await this.resolve(sessionId)
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
      await this.queue.runExclusive(worktreePath, async () => {
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
  async deleteTag(sessionId: string, name: string): Promise<GitOutcome<{ name: string }>> {
    const trimmed = name.trim()
    if (trimmed.length === 0 || trimmed.startsWith('-')) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'That tag name is not valid.' }
    }
    const resolved = await this.resolve(sessionId)
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
      await this.queue.runExclusive(worktreePath, async () => {
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
  async tags(sessionId: string): Promise<GitOutcome<{ tags: GitTag[] }>> {
    const resolved = await this.resolve(sessionId)
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
  async checkoutRef(
    sessionId: string,
    ref: string
  ): Promise<GitOutcome<{ ref: string; headOid: string }>> {
    const name = ref.trim()
    if (name.length === 0 || name.startsWith('-') || name.includes('\u0000')) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'That revision is not valid.' }
    }
    const resolved = await this.resolve(sessionId)
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
    return this.queue.runExclusive(worktreePath, async () => {
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
  private async applyCommitAction(
    sessionId: string,
    oid: string,
    action: 'cherry-pick' | 'revert'
  ): Promise<GitOutcome<{ oid: string; shortOid: string; subject: string }>> {
    const resolved = await this.resolve(sessionId)
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
      await this.queue.runExclusive(worktreePath, async () => {
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

  async cherryPick(
    sessionId: string,
    oid: string
  ): Promise<GitOutcome<{ oid: string; shortOid: string; subject: string }>> {
    return this.applyCommitAction(sessionId, oid, 'cherry-pick')
  }

  async revert(
    sessionId: string,
    oid: string
  ): Promise<GitOutcome<{ oid: string; shortOid: string; subject: string }>> {
    return this.applyCommitAction(sessionId, oid, 'revert')
  }

  /**
   * Moves the current branch to a commit. `soft` keeps the index, `mixed`
   * resets it, and `hard` also discards tracked worktree changes; the renderer
   * confirms hard mode explicitly. This method does not push.
   */
  async resetTo(
    sessionId: string,
    oid: string,
    mode: 'soft' | 'mixed' | 'hard'
  ): Promise<GitOutcome<{ oid: string; branch: string | null }>> {
    const resolved = await this.resolve(sessionId)
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
      await this.queue.runExclusive(worktreePath, async () => {
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

  /** Pushes the current branch to its configured upstream. */
  async push(sessionId: string): Promise<GitOutcome<{ branch: string; upstream: string }>> {
    return this.withUpstream(sessionId, 'push', ['push'])
  }

  /** Pulls into the current branch from its configured upstream. */
  async pull(
    sessionId: string,
    rebase = false
  ): Promise<GitOutcome<{ branch: string; upstream: string }>> {
    return this.withUpstream(sessionId, 'pull', ['pull', rebase ? '--rebase' : '--ff-only'])
  }

  /**
   * Publishes the current branch by setting its upstream.
   *
   * The remote is the conventional `origin` when present, otherwise the first
   * configured remote. The operation never chooses a remote interactively from
   * a background UI event; the user can open the terminal for anything unusual.
   */
  async publish(sessionId: string): Promise<GitOutcome<{ branch: string; upstream: string }>> {
    const resolved = await this.resolve(sessionId)
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
    const remotes = await this.remoteNames(git, worktreePath)
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
  async remotes(sessionId: string): Promise<GitOutcome<{ remotes: GitRemote[] }>> {
    const resolved = await this.resolve(sessionId)
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
  async addRemote(
    sessionId: string,
    name: string,
    url: string
  ): Promise<GitOutcome<{ name: string }>> {
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
    const resolved = await this.resolve(sessionId)
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
      await this.queue.runExclusive(worktreePath, async () => {
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
  async fetchRemote(
    sessionId: string,
    remote: string,
    prune = false
  ): Promise<GitOutcome<{ remote: string }>> {
    const name = remote.trim()
    if (name.length === 0 || name.startsWith('-') || name.includes('\u0000')) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'That remote name is not valid.' }
    }
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    const remotes = await this.remoteNames(git, worktreePath)
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
  async removeRemote(sessionId: string, name: string): Promise<GitOutcome<{ name: string }>> {
    const trimmed = name.trim()
    if (trimmed.length === 0 || trimmed.startsWith('-') || trimmed.includes('\u0000')) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'That remote name is not valid.' }
    }
    const resolved = await this.resolve(sessionId)
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
      await this.queue.runExclusive(worktreePath, async () => {
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
  async pushTags(sessionId: string): Promise<GitOutcome<{ remote: string }>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    const remotes = await this.remoteNames(git, worktreePath)
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
  async remoteBranches(sessionId: string): Promise<GitOutcome<{ branches: string[] }>> {
    const resolved = await this.resolve(sessionId)
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
  async setUpstream(
    sessionId: string,
    upstream: string
  ): Promise<GitOutcome<{ branch: string; upstream: string }>> {
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
    const resolved = await this.resolve(sessionId)
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
      await this.queue.runExclusive(worktreePath, async () => {
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
  async forcePush(sessionId: string): Promise<GitOutcome<{ branch: string; upstream: string }>> {
    return this.withUpstream(sessionId, 'force-push', ['push', '--force-with-lease'])
  }

  /** Fetches the default remote without changing the working tree. */
  async fetch(sessionId: string): Promise<GitOutcome<{ remote: string }>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    const remotes = await this.remoteNames(git, worktreePath)
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

  /**
   * Rewrites the last commit's message. This is deliberately local; no
   * force-push is offered here, because a rewritten commit is not safe to send
   * to a shared branch without a separate decision.
   */
  async amend(
    sessionId: string,
    message?: string,
    options: { sign?: boolean } = {}
  ): Promise<GitOutcome<GitCommitResult>> {
    const trimmed = (message ?? '').trim()
    if (trimmed.length > MAX_MESSAGE_LENGTH) {
      return {
        status: 'unavailable',
        reason: 'commit-failed',
        detail: `The commit message is longer than ${String(MAX_MESSAGE_LENGTH)} characters.`
      }
    }

    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    const head = await git(worktreePath, ['rev-parse', '--verify', 'HEAD']).catch(() => null)
    if (head === null) {
      return {
        status: 'unavailable',
        reason: 'commit-failed',
        detail: 'This worktree has no commit to amend yet.'
      }
    }
    try {
      await this.queue.runExclusive(worktreePath, async () => {
        await git(worktreePath, [
          'commit',
          '--amend',
          ...(options.sign === true ? ['-S'] : []),
          ...(trimmed.length > 0 ? ['-m', trimmed] : ['--no-edit'])
        ])
      })
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'commit-failed',
        detail: detailOf(error, 'Git refused to amend the last commit.')
      }
    }
    const oid = await git(worktreePath, ['rev-parse', 'HEAD']).catch(() => '')
    const subject = await git(worktreePath, ['log', '-1', '--pretty=%s']).catch(() => trimmed)
    return { status: 'ok', oid: oid.slice(0, 7), subject, files: 0 }
  }

  /** Recent commits for this worktree, including the current branch's HEAD. */
  async history(
    sessionId: string,
    limit = 20
  ): Promise<
    GitOutcome<{
      branch: string | null
      commits: Array<{ oid: string; subject: string; author: string; when: string }>
    }>
  > {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    const branch = await git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null)
    const head = await git(worktreePath, ['rev-parse', '--verify', 'HEAD']).catch(() => null)
    if (head === null) return { status: 'ok', branch, commits: [] }

    try {
      const output = await git(worktreePath, [
        'log',
        `-n${String(limit)}`,
        '--date=relative',
        '--pretty=format:%h%x00%an%x00%ar%x00%s'
      ])
      const commits = output
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => {
          const [oid = '', author = '', when = '', subject = ''] = line.split('\u0000')
          return { oid, author, when, subject }
        })
      return { status: 'ok', branch, commits }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, 'Git could not read the commit history.')
      }
    }
  }

  /**
   * Paginated History feed.
   *
   * Unlike `history()`, this returns full parent hashes, author dates and ref
   * decorations so the renderer can draw graph lanes and open a commit detail.
   * `ref` and `path` are validated before being passed to Git; the path is
   * always placed after `--` so a path that looks like a revision is inert.
   */
  async log(
    sessionId: string,
    options: {
      limit?: number
      skip?: number
      ref?: string
      allRefs?: boolean
      path?: string
    } = {}
  ): Promise<GitOutcome<GitLogPage>> {
    const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 50)))
    const skip = Math.min(100_000, Math.max(0, Math.floor(options.skip ?? 0)))
    const ref = options.ref?.trim() ?? ''
    if (
      ref.length > 0 &&
      (ref.startsWith('-') || ref.includes('\u0000') || ref.includes('\n'))
    ) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'That revision is not valid.' }
    }
    const path = options.path?.trim() ?? ''
    if (
      path.length > 0 &&
      (path.includes('\u0000') ||
        path.startsWith('/') ||
        path.startsWith('-') ||
        path.split('/').includes('..'))
    ) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That path is not valid for this worktree.'
      }
    }

    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    const branch = await git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null)
    const headOid = await git(worktreePath, ['rev-parse', '--verify', 'HEAD']).catch(() => null)
    if (headOid === null) {
      return {
        status: 'ok',
        branch,
        headOid: null,
        upstream: null,
        ahead: 0,
        behind: 0,
        commits: [],
        hasMore: false,
        nextSkip: skip
      }
    }

    const upstream = await git(worktreePath, [
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{upstream}'
    ]).catch(() => null)
    let ahead = 0
    let behind = 0
    if (upstream !== null) {
      const counts = await git(worktreePath, [
        'rev-list',
        '--left-right',
        '--count',
        `${upstream}...HEAD`
      ]).catch(() => null)
      if (counts !== null) {
        const parsed = parseAheadBehind(counts)
        ahead = parsed.ahead
        behind = parsed.behind
      }
    }

    const args = [
      'log',
      '--no-color',
      `-n${String(limit + 1)}`,
      `--skip=${String(skip)}`,
      '--date=unix',
      `--pretty=format:${LOG_PRETTY_FORMAT}`
    ]
    if (ref.length > 0) args.push(ref)
    else if (options.allRefs === true) args.push('--all')
    args.push('--')
    if (path.length > 0) args.push(path)

    try {
      const output = await git(worktreePath, args)
      const all = parseLogOutput(output)
      const hasMore = all.length > limit
      const commits = hasMore ? all.slice(0, limit) : all
      return {
        status: 'ok',
        branch,
        headOid,
        upstream,
        ahead,
        behind,
        commits,
        hasMore,
        nextSkip: skip + commits.length
      }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, 'Git could not read the commit history.')
      }
    }
  }

  /**
   * One commit's metadata plus the files of its first parent comparison.
   *
   * A root commit diffs against the empty tree. `rangeDiff` owns the file
   * parsing and the 5,000-file cap, so this method does not grow a second diff
   * parser.
   */
  async commitDetail(
    sessionId: string,
    oid: string,
    parent?: string
  ): Promise<GitOutcome<GitCommitDetail>> {
    if (!/^[0-9a-f]{4,64}$/iu.test(oid)) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'That commit id is not valid.' }
    }
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved

    let metadata
    try {
      const output = await git(worktreePath, [
        'show',
        '-s',
        '--no-patch',
        '--no-color',
        '--format=%H%x00%h%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%B',
        oid
      ])
      metadata = parseCommitMetadata(output)
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, 'Git could not read that commit.')
      }
    }
    if (metadata === null) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That commit is not available in this worktree.'
      }
    }

    if (parent !== undefined && !metadata.parents.includes(parent)) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That revision is not a parent of this commit.'
      }
    }
    const parentOid = parent ?? metadata.parents[0] ?? null
    const diff = await this.rangeDiff(sessionId, parentOid ?? EMPTY_TREE_OID, metadata.oid)
    if (diff.status !== 'ok') return diff
    let additions = 0
    let deletions = 0
    for (const file of diff.files) {
      additions += file.additions ?? 0
      deletions += file.deletions ?? 0
    }
    return {
      status: 'ok',
      ...metadata,
      parentOid,
      files: diff.files,
      additions,
      deletions,
      truncated: diff.truncated
    }
  }

  /**
   * Unified diff for one file between two revisions.
   *
   * History reuses the review renderer instead of growing a second diff view.
   * The patch is capped and binary output is reported explicitly; renames pass
   * both paths so Git can pair them.
   */
  async revisionFileDiff(
    sessionId: string,
    from: string,
    to: string,
    path: string,
    oldPath?: string
  ): Promise<
    GitOutcome<{
      patch: string
      truncated: boolean
      binary: boolean
      additions: number | null
      deletions: number | null
      fromOid: string
      toOid: string
    }>
  > {
    const validRef = (ref: string): boolean =>
      ref.length > 0 && !ref.startsWith('-') && !ref.includes('\u0000') && !ref.includes('\n')
    if (!validRef(from) || !validRef(to)) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'That revision is not valid.' }
    }
    if (
      path.length === 0 ||
      path.includes('\u0000') ||
      path.startsWith('/') ||
      path.startsWith('-') ||
      path.split('/').includes('..')
    ) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That path is not valid for this worktree.'
      }
    }

    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    const resolveRef = async (ref: string): Promise<string | null> => {
      if (ref === EMPTY_TREE_OID) return EMPTY_TREE_OID
      return git(worktreePath, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).catch(
        () => null
      )
    }
    const [fromOid, toOid] = await Promise.all([resolveRef(from), resolveRef(to)])
    if (fromOid === null || toOid === null) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That revision is not available in this worktree.'
      }
    }

    const paths = oldPath !== undefined && oldPath !== path ? [oldPath, path] : [path]
    try {
      const output = await git(worktreePath, [
        'diff',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '-M',
        '--unified=3',
        fromOid,
        toOid,
        '--',
        ...paths
      ])
      const binary = output.includes('Binary files ') || output.includes('GIT binary patch')
      if (binary) {
        return {
          status: 'ok',
          patch: output,
          truncated: false,
          binary: true,
          additions: null,
          deletions: null,
          fromOid,
          toOid
        }
      }
      let additions = 0
      let deletions = 0
      let inHunk = false
      for (const line of output.split('\n')) {
        if (line.startsWith('@@')) {
          inHunk = true
          continue
        }
        if (!inHunk || line.startsWith('\\')) continue
        if (line.startsWith('+')) additions += 1
        else if (line.startsWith('-')) deletions += 1
      }
      const bytes = Buffer.from(output, 'utf8')
      const truncated = bytes.byteLength > MAX_PATCH_BYTES
      return {
        status: 'ok',
        patch: truncated ? bytes.subarray(0, MAX_PATCH_BYTES).toString('utf8') : output,
        truncated,
        binary: false,
        additions,
        deletions,
        fromOid,
        toOid
      }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, 'Git could not read that file at those revisions.')
      }
    }
  }

  /**
   * Per-line blame for the working file, used by the editor's inline annotation.
   *
   * `--line-porcelain` is deterministic and complete per line, so no state is
   * carried between lines. Uncommitted lines are reported as such instead of
   * being attributed to the previous commit. The result is capped so a huge
   * file cannot dominate the renderer.
   */
  async blame(
    sessionId: string,
    path: string
  ): Promise<GitOutcome<{ lines: BlameLine[]; truncated: boolean }>> {
    if (
      path.length === 0 ||
      path.includes('\u0000') ||
      path.startsWith('/') ||
      path.startsWith('-') ||
      path.split('/').includes('..')
    ) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That path is not valid for this worktree.'
      }
    }
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { raw, worktreePath } = resolved
    let result
    try {
      result = await raw(worktreePath, ['blame', '--line-porcelain', '--', path])
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, 'Git could not read blame for that file.')
      }
    }
    if (result.exitCode !== 0) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'Git could not read blame for that file. It may be untracked or binary.'
      }
    }
    const all = parseBlamePorcelain(result.stdout)
    const limit = 50_000
    return {
      status: 'ok',
      lines: all.slice(0, limit),
      truncated: all.length > limit
    }
  }

  /**
   * Reads one file at a revision, with worktree filters applied.
   *
   * The Files editor uses this as its quick-diff baseline. The size check runs
   * before content is requested so a huge blob cannot enter the renderer, and a
   * NUL byte marks a binary blob instead of pretending it is editable text.
   */
  async fileAtRevision(
    sessionId: string,
    rev: string,
    path: string
  ): Promise<
    GitOutcome<{
      rev: string
      oid: string
      text: string
      binary: boolean
      tooLarge: boolean
    }>
  > {
    const revision = rev.trim()
    if (
      revision.length === 0 ||
      revision.startsWith('-') ||
      revision.includes('\u0000') ||
      revision.includes('\n')
    ) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'That revision is not valid.' }
    }
    if (
      path.length === 0 ||
      path.includes('\u0000') ||
      path.startsWith('/') ||
      path.startsWith('-') ||
      path.split('/').includes('..')
    ) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That path is not valid for this worktree.'
      }
    }
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, raw, worktreePath } = resolved
    const oid = await git(worktreePath, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${revision}^{commit}`
    ]).catch(() => null)
    if (oid === null) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That revision is not available in this worktree.'
      }
    }
    const spec = `${oid}:${path}`
    const sizeText = await git(worktreePath, ['cat-file', '-s', spec]).catch(() => null)
    if (sizeText === null) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That file is not present at the requested revision.'
      }
    }
    const size = Number.parseInt(sizeText.trim(), 10)
    if (!Number.isFinite(size)) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'Git did not report a size for that file.'
      }
    }
    if (size > FILES_MAX_FILE_BYTES) {
      return { status: 'ok', rev: revision, oid, text: '', binary: false, tooLarge: true }
    }
    try {
      // `raw` preserves the exact blob text, including a trailing newline; the
      // trimmed `git` helper would corrupt the quick-diff baseline.
      const content = await raw(worktreePath, [
        'cat-file',
        '--filters',
        `--path=${path}`,
        spec
      ])
      if (content.exitCode !== 0) {
        return {
          status: 'unavailable',
          reason: 'git-failed',
          detail: 'Git could not read that file at the revision.'
        }
      }
      const text = content.stdout
      const binary = text.includes('\u0000')
      return {
        status: 'ok',
        rev: revision,
        oid,
        text: binary ? '' : text,
        binary,
        tooLarge: false
      }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, 'Git could not read that file at the revision.')
      }
    }
  }

  /**
   * Reads one file from the index (stage 0).
   *
   * The working-tree split diff needs both sides as complete text, not just the
   * patch. The index side is the middle term of a staged diff (HEAD→index) and
   * the pre-image of an unstaged diff (index→worktree). An unmerged path has no
   * stage 0, so it is reported as unavailable rather than silently reading a
   * conflict stage.
   */
  async indexFile(
    sessionId: string,
    path: string
  ): Promise<
    GitOutcome<{
      path: string
      text: string
      binary: boolean
      tooLarge: boolean
    }>
  > {
    if (
      path.length === 0 ||
      path.includes('\u0000') ||
      path.startsWith('/') ||
      path.startsWith('-') ||
      path.split('/').includes('..')
    ) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That path is not valid for this worktree.'
      }
    }
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, raw, worktreePath } = resolved
    let listing
    try {
      listing = await raw(worktreePath, ['ls-files', '--stage', '-z', '--', path])
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, 'Git could not read the index for that file.')
      }
    }
    if (listing.exitCode !== 0) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'Git could not read the index for that file.'
      }
    }
    const record = listing.stdout.split('\u0000').find((entry) => entry.length > 0)
    if (record === undefined) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That file is not in the index.'
      }
    }
    const tab = record.indexOf('\t')
    const meta = (tab === -1 ? record : record.slice(0, tab)).split(' ')
    const oid = meta[1] ?? ''
    const stage = meta[2] ?? ''
    if (!/^[0-9a-f]{40,64}$/u.test(oid)) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'Git did not report a blob for that file.'
      }
    }
    if (stage !== '0') {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That file has unresolved conflict stages in the index.'
      }
    }
    const sizeText = await git(worktreePath, ['cat-file', '-s', oid]).catch(() => null)
    if (sizeText === null) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'Git could not read that file from the index.'
      }
    }
    const size = Number.parseInt(sizeText.trim(), 10)
    if (!Number.isFinite(size)) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'Git did not report a size for that file.'
      }
    }
    if (size > FILES_MAX_FILE_BYTES) {
      return { status: 'ok', path, text: '', binary: false, tooLarge: true }
    }
    try {
      const content = await raw(worktreePath, ['cat-file', '--filters', `--path=${path}`, oid])
      if (content.exitCode !== 0) {
        return {
          status: 'unavailable',
          reason: 'git-failed',
          detail: 'Git could not read that file from the index.'
        }
      }
      const binary = content.stdout.includes('\u0000')
      return {
        status: 'ok',
        path,
        text: binary ? '' : content.stdout,
        binary,
        tooLarge: false
      }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, 'Git could not read that file from the index.')
      }
    }
  }

  /**
   * Reads the three index stages of one conflicted path.
   *
   * Stage 1 is the merge base, 2 is current/ours and 3 is incoming/theirs. Base
   * is absent for add/add conflicts. Binary and oversized sides are reported as
   * flags so the renderer falls back to the terminal instead of showing mojibake.
   */
  async conflictFile(
    sessionId: string,
    path: string
  ): Promise<
    GitOutcome<{
      path: string
      base: { oid: string; text: string; binary: boolean; tooLarge: boolean } | null
      current: { oid: string; text: string; binary: boolean; tooLarge: boolean }
      incoming: { oid: string; text: string; binary: boolean; tooLarge: boolean }
    }>
  > {
    if (
      path.length === 0 ||
      path.includes('\u0000') ||
      path.startsWith('/') ||
      path.startsWith('-') ||
      path.split('/').includes('..')
    ) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That path is not valid for this worktree.'
      }
    }
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, raw, worktreePath } = resolved
    let listing
    try {
      listing = await raw(worktreePath, ['ls-files', '--stage', '-z', '--', path])
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, 'Git could not read the index for that conflict.')
      }
    }
    if (listing.exitCode !== 0) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'Git could not read the index for that conflict.'
      }
    }
    const stages = new Map<number, string>()
    for (const record of listing.stdout.split('\u0000')) {
      if (record.length === 0) continue
      const tab = record.indexOf('\t')
      const meta = (tab === -1 ? record : record.slice(0, tab)).split(' ')
      const oid = meta[1] ?? ''
      const stage = Number.parseInt(meta[2] ?? '', 10)
      if (/^[0-9a-f]{40,64}$/u.test(oid) && Number.isFinite(stage) && stage >= 1 && stage <= 3) {
        stages.set(stage, oid)
      }
    }
    if (!stages.has(2) || !stages.has(3)) {
      return {
        status: 'unavailable',
        reason: 'not-found',
        detail: 'That path does not have both conflict sides in the index.'
      }
    }

    const readSide = async (
      oid: string
    ): Promise<
      | { ok: true; side: { oid: string; text: string; binary: boolean; tooLarge: boolean } }
      | { ok: false; detail: string }
    > => {
      const sizeText = await git(worktreePath, ['cat-file', '-s', oid]).catch(() => null)
      const size = sizeText === null ? Number.NaN : Number.parseInt(sizeText.trim(), 10)
      if (!Number.isFinite(size)) return { ok: false, detail: 'Git did not report a conflict side.' }
      if (size > FILES_MAX_FILE_BYTES) {
        return { ok: true, side: { oid, text: '', binary: false, tooLarge: true } }
      }
      try {
        const content = await raw(worktreePath, ['cat-file', '--filters', `--path=${path}`, oid])
        if (content.exitCode !== 0) {
          return { ok: false, detail: 'Git could not read a side of that conflict.' }
        }
        const binary = content.stdout.includes('\u0000')
        return {
          ok: true,
          side: { oid, text: binary ? '' : content.stdout, binary, tooLarge: false }
        }
      } catch (error) {
        return { ok: false, detail: detailOf(error, 'Git could not read a side of that conflict.') }
      }
    }

    const current = await readSide(stages.get(2)!)
    if (!current.ok) {
      return { status: 'unavailable', reason: 'git-failed', detail: current.detail }
    }
    const incoming = await readSide(stages.get(3)!)
    if (!incoming.ok) {
      return { status: 'unavailable', reason: 'git-failed', detail: incoming.detail }
    }
    const baseOid = stages.get(1)
    let base = null
    if (baseOid !== undefined) {
      const read = await readSide(baseOid)
      if (!read.ok) {
        return { status: 'unavailable', reason: 'git-failed', detail: read.detail }
      }
      base = read.side
    }
    return { status: 'ok', path, base, current: current.side, incoming: incoming.side }
  }

  /**
   * Marks a conflicted path resolved by adding its worktree result to the index.
   *
   * This is separate from `setPathStaged`, which deliberately refuses conflicted
   * paths; the merge editor calls it only after all markers are gone.
   */
  async resolveConflict(
    sessionId: string,
    path: string
  ): Promise<GitOutcome<{ path: string }>> {
    if (
      path.length === 0 ||
      path.includes('\u0000') ||
      path.startsWith('/') ||
      path.startsWith('-') ||
      path.split('/').some((segment) => segment === '..' || segment === '.')
    ) {
      return {
        status: 'unavailable',
        reason: 'path-outside',
        detail: 'That path is not inside this worktree.'
      }
    }
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, raw, worktreePath } = resolved
    return this.queue.runExclusive(worktreePath, async () => {
      const statusRead = await raw(worktreePath, STATUS_ARGS)
      if (statusRead.exitCode !== 0) {
        return {
          status: 'unavailable' as const,
          reason: 'not-a-repository' as const,
          detail: 'Git could not read this worktree as a repository.'
        }
      }
      const entry = entriesOf(parsePorcelainV2(statusRead.stdout)).find(
        (candidate) => candidate.path === path && candidate.area === 'conflicted'
      )
      if (entry === undefined) {
        return {
          status: 'unavailable' as const,
          reason: 'not-found' as const,
          detail: 'Git does not report that path as conflicted.'
        }
      }
      try {
        await git(worktreePath, ['add', '--', path])
        return { status: 'ok' as const, path }
      } catch (error) {
        return {
          status: 'unavailable' as const,
          reason: 'git-failed' as const,
          detail: detailOf(error, 'Git could not mark that conflict resolved.')
        }
      }
    })
  }

  /**
   * Stages or unstages one hunk by applying its patch to the index.
   *
   * The patch comes from the same `git diff` the renderer displayed. `git apply`
   * checks the hunk's context against the index before writing, so a stale
   * patch is rejected rather than applied to a different revision. Only one
   * plain file patch is accepted: renames, copies, binary/submodule patches and
   * mode changes stay with the whole-file actions.
   */
  async applyPatch(
    sessionId: string,
    patch: string,
    path: string,
    mode: 'stage' | 'unstage' | 'discard'
  ): Promise<GitOutcome<{ path: string; mode: 'stage' | 'unstage' | 'discard' }>> {
    if (
      path.length === 0 ||
      path.includes('\u0000') ||
      path.startsWith('/') ||
      path.startsWith('-') ||
      path.split('/').some((segment) => segment === '..' || segment === '.')
    ) {
      return {
        status: 'unavailable',
        reason: 'path-outside',
        detail: 'That path is not inside this worktree.'
      }
    }
    // `git apply` rejects a final hunk line without a newline. The renderer
    // slices hunks out of a larger patch, so the last line may arrive bare.
    const inputPatch = patch.endsWith('\n') ? patch : `${patch}\n`
    const invalid = validateSingleFilePatch(inputPatch, path)
    if (invalid !== null) {
      return { status: 'unavailable', reason: 'git-failed', detail: invalid }
    }
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { input, raw, worktreePath } = resolved
    return this.queue.runExclusive(worktreePath, async () => {
      const statusRead = await raw(worktreePath, STATUS_ARGS)
      if (statusRead.exitCode !== 0) {
        return {
          status: 'unavailable' as const,
          reason: 'not-a-repository' as const,
          detail: 'Git could not read this worktree as a repository.'
        }
      }
      const entries = entriesOf(parsePorcelainV2(statusRead.stdout)).filter(
        (candidate) => candidate.path === path
      )
      if (entries.some((candidate) => candidate.area === 'conflicted')) {
        return {
          status: 'unavailable' as const,
          reason: 'git-failed' as const,
          detail: 'That path has a conflict. Resolve it before staging a hunk here.'
        }
      }
      if (mode === 'discard') {
        if (entries.some((candidate) => candidate.area === 'untracked')) {
          return {
            status: 'unavailable' as const,
            reason: 'git-failed' as const,
            detail: 'Untracked files are not discarded by hunk; delete the file instead.'
          }
        }
        if (!entries.some((candidate) => candidate.area === 'unstaged')) {
          return {
            status: 'unavailable' as const,
            reason: 'not-found' as const,
            detail: 'Git does not report that path as unstaged.'
          }
        }
      } else {
        const expectedArea = mode === 'stage' ? ['unstaged', 'untracked'] : ['staged']
        if (!entries.some((candidate) => expectedArea.includes(candidate.area))) {
          return {
            status: 'unavailable' as const,
            reason: 'not-found' as const,
            detail: `Git does not report that path as ${mode === 'stage' ? 'unstaged' : 'staged'}.`
          }
        }
      }
      const args = [
        'apply',
        ...(mode === 'discard' ? [] : ['--cached']),
        ...(mode === 'stage' ? [] : ['--reverse']),
        '--recount',
        '--whitespace=nowarn',
        `--include=${path}`,
        '-'
      ]
      const result = await input(worktreePath, args, inputPatch)
      if (result.timedOut) {
        return {
          status: 'unavailable' as const,
          reason: 'git-failed' as const,
          detail: 'Git timed out while applying that hunk.'
        }
      }
      if (result.exitCode !== 0) {
        const detail = result.stderr.trim().slice(0, 800)
        return {
          status: 'unavailable' as const,
          reason: 'git-failed' as const,
          detail:
            detail.length > 0
              ? `Git rejected that hunk: ${detail}`
              : 'Git rejected that hunk.'
        }
      }
      return { status: 'ok' as const, path, mode }
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
  async stashList(sessionId: string): Promise<
    GitOutcome<{
      stashes: Array<{ index: number; ref: string; subject: string; date: string; oid: string }>
    }>
  > {
    const resolved = await this.resolve(sessionId)
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
  async stashPush(
    sessionId: string,
    message: string,
    includeUntracked: boolean,
    keepIndex: boolean
  ): Promise<GitOutcome<{ created: boolean }>> {
    const subject = message.trim()
    if (subject.length > MAX_MESSAGE_LENGTH) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: 'That stash message is too long.'
      }
    }
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    return this.queue.runExclusive(worktreePath, async () => {
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
  async stashDiff(
    sessionId: string,
    index: number
  ): Promise<GitOutcome<{ ref: string; patch: string; truncated: boolean }>> {
    if (!Number.isInteger(index) || index < 0 || index > 10_000) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'That stash does not exist.' }
    }
    const ref = `stash@{${String(index)}}`
    const resolved = await this.resolve(sessionId)
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
  async stashAction(
    sessionId: string,
    index: number,
    action: 'apply' | 'pop' | 'drop'
  ): Promise<GitOutcome<{ ref: string; action: 'apply' | 'pop' | 'drop' }>> {
    if (!Number.isInteger(index) || index < 0 || index > 10_000) {
      return { status: 'unavailable', reason: 'git-failed', detail: 'That stash does not exist.' }
    }
    const ref = `stash@{${String(index)}}`
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved
    return this.queue.runExclusive(worktreePath, async () => {
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

  /**
   * Compares the worktree's starting baseline with HEAD.
   *
   * The baseline is the exact commit the session was created from, not the
   * repository's current branch, so a concurrent checkout or branch move cannot
   * change what "this session changed" means.
   */
  async compare(
    sessionId: string
  ): Promise<
    GitOutcome<{
      baseOid: string
      ahead: number
      behind: number
      files: Array<{
        path: string
        oldPath: string | null
        status: string
        additions: number | null
        deletions: number | null
        binary: boolean
      }>
      truncated: boolean
    }>
  > {
    const record = this.deps.worktrees.findBySession(sessionId)
    if (!record) {
      return {
        status: 'unavailable',
        reason: 'primary-checkout',
        detail: 'This session runs in the primary checkout, so it has no baseline to compare.'
      }
    }
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved

    try {
      await git(worktreePath, ['cat-file', '-e', `${record.baseOid}^{commit}`])
      const head = await git(worktreePath, ['rev-parse', '--verify', 'HEAD']).catch(() => null)
      if (head === null) {
        return {
          status: 'unavailable',
          reason: 'git-failed',
          detail: 'This worktree has no commit to compare yet.'
        }
      }
      const counts = await git(worktreePath, [
        'rev-list',
        '--left-right',
        '--count',
        `${record.baseOid}...HEAD`
      ])
      const { ahead, behind } = parseAheadBehind(counts)
      const [nameStatusOutput, numstatOutput] = await Promise.all([
        git(worktreePath, ['diff', '--name-status', '-z', `${record.baseOid}...HEAD`]),
        git(worktreePath, ['diff', '--numstat', '-z', `${record.baseOid}...HEAD`])
      ])
      const statuses = parseNameStatusZ(nameStatusOutput)
      const stats = new Map(parseNumstatZ(numstatOutput).map((entry) => [entry.path, entry]))
      const files = statuses.map((entry) => {
        const stat = stats.get(entry.path)
        return {
          path: entry.path,
          oldPath: entry.oldPath,
          status: entry.status,
          additions: stat?.additions ?? null,
          deletions: stat?.deletions ?? null,
          binary: stat?.binary ?? false
        }
      })
      return {
        status: 'ok',
        baseOid: record.baseOid,
        ahead,
        behind,
        files: files.slice(0, 200),
        truncated: files.length > 200
      }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, 'Git could not compare this worktree with its baseline.')
      }
    }
  }

  private async remoteNames(
    git: (cwd: string, args: string[], timeoutMs?: number) => Promise<string>,
    worktreePath: string
  ): Promise<string[]> {
    const output = await git(worktreePath, ['remote']).catch(() => '')
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  }

  /**
   * Runs a remote operation that needs a configured upstream.
   *
   * Fast-forward-only pulls are deliberate: a local merge commit is a decision
   * the user should make, and a worktree holding an Agent's work is the wrong
   * place to invent one.
   */
  private async withUpstream(
    sessionId: string,
    verb: 'push' | 'pull' | 'force-push',
    args: string[]
  ): Promise<GitOutcome<{ branch: string; upstream: string }>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved

    const branch = await git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null)
    if (branch === null || branch === 'HEAD') {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: `Cannot ${verb} a detached checkout. Switch to a branch first.`
      }
    }
    const upstream = await git(worktreePath, [
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{upstream}'
    ]).catch(() => null)
    if (!upstream) {
      return {
        status: 'unavailable',
        reason: 'no-upstream',
        detail: `Branch ${branch} has no upstream. Set one with "git push -u <remote> ${branch}" in the terminal, then try again.`
      }
    }
    const remote = await git(worktreePath, ['remote']).catch(() => '')
    if (remote.trim().length === 0) {
      return {
        status: 'unavailable',
        reason: 'no-remote',
        detail: 'This repository has no remote configured, so there is nowhere to push or pull.'
      }
    }

    try {
      await git(worktreePath, args, 120_000)
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: detailOf(error, `Git could not ${verb}. Check network access and credentials in the terminal.`)
      }
    }
    return { status: 'ok', branch, upstream }
  }

  /** Discards one unstaged/untracked path, at the user's explicit request. */
  async discardPath(sessionId: string, path: string): Promise<GitOutcome<{ restored: boolean }>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, raw, worktreePath } = resolved
    const relative = path
    if (
      relative.length === 0 ||
      relative.startsWith('/') ||
      relative.split('/').some((segment) => segment === '..' || segment === '.')
    ) {
      return { status: 'unavailable', reason: 'path-outside', detail: 'That path is not inside this worktree.' }
    }

    return this.queue.runExclusive(worktreePath, async () => {
      const statusRead = await raw(worktreePath, STATUS_ARGS)
      if (statusRead.exitCode !== 0) {
        return {
          status: 'unavailable' as const,
          reason: 'not-a-repository' as const,
          detail: 'Git could not read this worktree as a repository.'
        }
      }
      const entries = entriesOf(parsePorcelainV2(statusRead.stdout)).filter(
        (candidate) => candidate.path === relative
      )
      // A partially staged path has both entries. Discard is a working-tree
      // operation, so prefer the unstaged side and leave the index alone.
      const entry =
        entries.find((candidate) => candidate.area === 'unstaged' || candidate.area === 'untracked') ??
        entries.find((candidate) => candidate.area === 'conflicted') ??
        entries[0]
      if (!entry) {
        return {
          status: 'unavailable' as const,
          reason: 'not-found' as const,
          detail: 'Git does not report that path as changed.'
        }
      }

      try {
        if (entry.area === 'untracked') {
          // Untracked files are not restorable, so this removes the file itself.
          await git(worktreePath, ['clean', '-f', '--', relative])
        } else if (entry.area === 'staged' && entry.status === 'added') {
          await git(worktreePath, ['rm', '--cached', '--force', '--', relative])
        } else {
          await git(worktreePath, ['checkout', '--', relative])
        }
        return { status: 'ok' as const, restored: true }
      } catch (error) {
        return {
          status: 'unavailable' as const,
          reason: 'git-failed' as const,
          detail: detailOf(error, 'Git could not discard that path.')
        }
      }
    })
  }

  private async mutate<T>(
    sessionId: string,
    args: string[],
    shape: (before: GitWorkspaceStatus) => T
  ): Promise<GitOutcome<T>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, raw, worktreePath } = resolved

    const before = await this.readStatus(raw, worktreePath)
    if (before === null) {
      return { status: 'unavailable', reason: 'worktree-unavailable', detail: 'Git could not read this worktree.' }
    }
    try {
      await this.queue.runExclusive(worktreePath, async () => {
        await git(worktreePath, args)
      })
    } catch (error) {
      return { status: 'unavailable', reason: 'git-failed', detail: detailOf(error, 'Git refused that operation.') }
    }
    return { status: 'ok', ...shape(before) }
  }

  private async readStatus(
    raw: (cwd: string, args: string[]) => Promise<{ stdout: string; exitCode: number | null }>,
    worktreePath: string
  ): Promise<GitWorkspaceStatus | null> {
    try {
      const read = await raw(worktreePath, STATUS_ARGS)
      if (read.exitCode !== 0) return null
      const parsed = parsePorcelainV2(read.stdout)
      return {
        branch: parsed.branch,
        headOid: parsed.headOid,
        upstream: parsed.upstream,
        ahead: parsed.ahead,
        behind: parsed.behind,
        staged: parsed.staged,
        unstaged: parsed.unstaged,
        untracked: parsed.untracked,
        conflicted: parsed.conflicted,
        clean: parsed.clean,
        statusLength: parsed.statusLength,
        didHitLimit: parsed.didHitLimit,
        revision: parsed.revision
      }
    } catch {
      return null
    }
  }

  private async resolve(
    sessionId: string
  ): Promise<
    | {
        status: 'ok'
        worktreePath: string
        /** Primary checkout, used for repository-level operation markers. */
        repositoryPath: string
        repoId: RepoId
        target: ExecutionTarget
        git: (cwd: string, args: string[], timeoutMs?: number) => Promise<string>
        /** Verbatim stdout, for fixed-width output such as porcelain status. */
        raw: (cwd: string, args: string[]) => Promise<{ stdout: string; exitCode: number | null }>
        /** Runs a mutation with patch/text input on stdin. */
        input: (
          cwd: string,
          args: string[],
          stdin: string,
          timeoutMs?: number
        ) => Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }>
      }
    | GitUnavailable
  > {
    const record = this.deps.worktrees.findBySession(sessionId)
    if (!record) {
      return {
        status: 'unavailable',
        reason: 'primary-checkout',
        detail: 'This session runs in the primary checkout, so it has no worktree Git state.'
      }
    }
    const repository = this.deps.repositories.findById(record.repoId)
    if (!repository) {
      return { status: 'unavailable', reason: 'not-found', detail: 'The session repository is no longer registered.' }
    }

    let exists: boolean
    try {
      const fs = await this.deps.gitWorktrees.hostFsFor(repository.executionTarget)
      exists = await fs.isDirectory(record.path)
    } catch {
      return {
        status: 'unavailable',
        reason: 'worktree-unavailable',
        detail:
          repository.executionTarget.kind === 'local'
            ? 'The session worktree could not be inspected.'
            : 'The session distro could not be reached, so its Git state is unavailable right now.'
      }
    }
    if (!exists) {
      return {
        status: 'unavailable',
        reason: 'worktree-missing',
        detail:
          repository.executionTarget.kind === 'local'
            ? 'The session worktree directory is missing.'
            : 'The session worktree directory is missing inside its distro.'
      }
    }

    const git = await this.deps.gitWorktrees.gitFor(repository.executionTarget)
    const raw = await this.deps.gitWorktrees.gitRawFor(repository.executionTarget)
    const input = await this.deps.gitWorktrees.gitInputFor(repository.executionTarget)
    return {
      status: 'ok',
      worktreePath: record.path,
      repositoryPath: repository.path,
      repoId: record.repoId,
      target: repository.executionTarget,
      git,
      raw,
      input
    }
  }
}

/**
 * Path identity for worktree ownership checks.
 *
 * Git may report a Windows path with either separator and a different drive
 * letter case than the session store. Lower-casing is deliberately generous:
 * over-identifying a session checkout can only make a lock/remove refuse, never
 * delete a live session's worktree.
 */
/**
 * Accepts exactly one plain-file patch whose paths match the selected file.
 *
 * `git apply --include` is a second boundary, but the patch is still checked
 * here so a renderer bug cannot smuggle a rename, copy, binary blob, submodule
 * pointer or mode change through a hunk action. Quoted (non-ASCII) Git paths are
 * refused explicitly rather than being guessed at.
 */
function validateSingleFilePatch(patch: string, path: string): string | null {
  if (patch.length === 0) return 'The hunk patch is empty.'
  if (patch.length > MAX_PATCH_BYTES) return 'That hunk patch is too large to apply.'
  if (patch.includes('\u0000')) return 'That hunk patch is not valid text.'
  const lines = patch.split('\n')
  const structural = lines.map((line) => line.replace(/\r$/u, ''))
  if (structural.filter((line) => line.startsWith('diff --git ')).length !== 1) {
    return 'A hunk action must contain exactly one file patch.'
  }
  if (!structural.some((line) => line.startsWith('@@ '))) {
    return 'That patch contains no hunk.'
  }
  if (patch.includes('GIT binary patch') || patch.includes('Subproject commit')) {
    return 'Hunk staging is unavailable for binary files and submodules.'
  }
  if (
    structural.some((line) =>
      /^(rename from|rename to|copy from|copy to|old mode|new mode|similarity index|dissimilarity index)\b/u.test(
        line
      )
    )
  ) {
    return 'Hunk staging is unavailable for renames, copies and mode changes.'
  }
  const plus = structural.find((line) => line.startsWith('+++ '))
  const minus = structural.find((line) => line.startsWith('--- '))
  if (plus === undefined || minus === undefined) {
    return 'That patch has no file headers.'
  }
  const plusPath = plus.slice(4)
  const minusPath = minus.slice(4)
  if (plusPath.startsWith('"') || minusPath.startsWith('"')) {
    return 'Hunk staging does not support this path encoding yet.'
  }
  if (plusPath !== '/dev/null' && plusPath !== `b/${path}`) {
    return 'That patch targets a different path.'
  }
  if (minusPath !== '/dev/null' && minusPath !== `a/${path}`) {
    return 'That patch reads from a different path.'
  }
  return null
}

type ParsedNameStatus = { path: string; oldPath: string | null; status: string }
type ParsedNumstat = {
  path: string
  oldPath: string | null
  additions: number | null
  deletions: number | null
  binary: boolean
}

/** One flat list in the order the UI groups it. */
function entriesOf(status: ParsedRepositoryStatus): GitStatusEntry[] {
  return [...status.staged, ...status.unstaged, ...status.untracked, ...status.conflicted]
}

/**
 * `git diff --name-status -z` uses NUL-delimited records. A rename/copy record
 * has three fields (status, old path, new path); every other record has two.
 */
function parseNameStatusZ(output: string): ParsedNameStatus[] {
  const fields = output.split('\u0000')
  const parsed: ParsedNameStatus[] = []
  let index = 0
  while (index < fields.length) {
    const status = fields[index++]
    if (!status) continue
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = fields[index++] ?? ''
      const path = fields[index++] ?? ''
      if (path.length > 0) parsed.push({ path, oldPath: oldPath || null, status: status[0]! })
      continue
    }
    const path = fields[index++] ?? ''
    if (path.length > 0) parsed.push({ path, oldPath: null, status: status[0]! })
  }
  return parsed
}

/** `--numstat -z` puts an empty path field before the two names of a rename. */
function parseNumstatZ(output: string): ParsedNumstat[] {
  const fields = output.split('\u0000')
  const parsed: ParsedNumstat[] = []
  let index = 0
  while (index < fields.length) {
    const line = fields[index++]
    if (!line) continue
    const [rawAdd = '', rawDel = '', rawPath = ''] = line.split('\t')
    let oldPath: string | null = null
    let path = rawPath
    if (path.length === 0) {
      oldPath = fields[index++] ?? null
      path = fields[index++] ?? ''
    }
    if (path.length === 0) continue
    const binary = rawAdd === '-' || rawDel === '-'
    const additions = binary ? null : Number.parseInt(rawAdd, 10)
    const deletions = binary ? null : Number.parseInt(rawDel, 10)
    parsed.push({
      path,
      oldPath,
      additions: Number.isFinite(additions) ? additions : null,
      deletions: Number.isFinite(deletions) ? deletions : null,
      binary
    })
  }
  return parsed
}

function detailOf(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message
  return fallback
}
