import type { RepositoryStore } from '../persistence/repository-store'
import type { WorktreeStore } from '../persistence/worktree-store'
import type { GitWorktreeService } from '../worktrees/git-worktree-service'
import {
  type GitCommitDetail,
  type GitCommitResult,
  type GitLogPage,
  type GitRangeFile,
  type GitRemote,
  type GitTag,
  type GitWorkspaceStatus
} from '../../shared/domain/git-workspace'
import {
  parsePorcelainV2,
} from './status-reader'
import { GitOperationQueue } from './operation-queue'
import {
} from './batch-ops'
import {
  type GitOperationKind,
  type GitSubmoduleEntry,
  type GitWorktreeEntry
} from './repository-model'
import type { BlameLine } from './blame-reader'
import type { ExecutionTarget } from '../../shared/domain/repository'
import type { RepoId } from '../../shared/domain/ids'
import type { FilesUnavailable } from '../files/workspace-files-service'
import { normalizeRelativePath } from '../../shared/domain/workspace-files'
import type {
  ChangeDiffOutcome,
  ChangeListOutcome,
  ChangeUnavailable
} from '../../shared/domain/changes'
import type { ChangeDiffInput } from '../../shared/schemas/changes'
import { readChangeDiff, type ReadContext } from './change-reader'
import { readSessionChanges, type SessionStateSource } from './session-changes'
import * as historyOps from './workspace/history'
import * as advancedOps from './workspace/advanced'
import * as branchOps from './workspace/branches'
import * as remoteOps from './workspace/remotes'
import * as changeOps from './workspace/changes'
import * as statusOps from './workspace/status'
import type { GitBatchResult, GitPathTarget } from './batch-ops'
import {
  STATUS_ARGS,
  detailOf,
} from './git-helpers'

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
  /** Session state is needed only to validate a session baseline listing. */
  sessions: SessionStateSource
}

export type GitOutcome<T> = ({ status: 'ok' } & T) | GitUnavailable

/**
 * Maps the Git engine's unavailability reasons onto the change surface's
 * smaller vocabulary. Both describe "the checkout cannot be read"; the change
 * UI only distinguishes the reasons it can act on.
 */
function changeUnavailableFrom(unavailable: GitUnavailable): ChangeUnavailable {
  if (unavailable.reason === 'primary-checkout' || unavailable.reason === 'worktree-missing') {
    return {
      status: 'unavailable',
      reason: unavailable.reason,
      detail: unavailable.detail
    }
  }
  return {
    status: 'unavailable',
    reason: 'worktree-inconsistent',
    detail: unavailable.detail
  }
}

/**
 * `-uall` reports every untracked file. Without it Git collapses a new
 * directory to `dir/`, and per-file stage/discard cannot find the file the
 * reviewer selected. v2 answers branch and ahead/behind in the same call.
 */
/**
 * Git state and the common write operations, scoped to one session's checkout.
 *
 * Reads run where the checkout lives, through the same target-aware Git the rest
 * of the app uses. Nothing here rewrites history, and nothing runs on a
 * repository the user has not selected.
 */
export class GitWorkspaceService {
  readonly queue = new GitOperationQueue()
  /** One live status read per session; a newer read supersedes the older one. */
  readonly statusReads = new Map<string, AbortController>()

  constructor(readonly deps: GitWorkspaceDeps) {}
  async status(sessionId: string, options: { signal?: AbortSignal } = {}): Promise<GitOutcome<{ snapshot: GitWorkspaceStatus }>> {
    return statusOps.status(this, sessionId, options)
  }


  /**
   * Authoritative `.gitignore` check for a bounded set of worktree paths.
   *
   * `git check-ignore --stdin -z` handles nested ignore files and tracked-file
   * rules; exit code 1 simply means nothing matched.
   */
  async checkIgnore(
    sessionId: string,
    paths: readonly string[]
  ): Promise<GitOutcome<{ ignored: string[] }>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const cleaned: string[] = []
    for (const path of paths) {
      const relative = normalizeRelativePath(path)
      if (relative === null || relative === '') {
        return {
          status: 'unavailable',
          reason: 'path-outside',
          detail: 'That path is not inside this worktree.'
        }
      }
      cleaned.push(relative)
    }
    if (cleaned.length === 0) return { status: 'ok', ignored: [] }
    try {
      const result = await resolved.input(
        resolved.worktreePath,
        ['check-ignore', '--stdin', '-z'],
        `${cleaned.join('\u0000')}\u0000`
      )
      if (result.timedOut) {
        return {
          status: 'unavailable',
          reason: 'git-failed',
          detail: 'The ignore check timed out.'
        }
      }
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        return {
          status: 'unavailable',
          reason: 'git-failed',
          detail: result.stderr.trim() || 'Git could not check the ignore rules.'
        }
      }
      const ignored = result.exitCode === 0
        ? result.stdout
            .split('\u0000')
            .map((path) => path.replace(/\\/gu, '/').replace(/^\.\//u, ''))
            .filter((path) => path !== '')
        : []
      return { status: 'ok', ignored }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'git-failed',
        detail: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /**
   * One side of the working tree for one path.
   *
   * Staged compares HEAD to the index; unstaged compares the index to the
   * working tree; untracked compares /dev/null to the file; conflict compares
   * HEAD to the worktree so the markers stay readable. A working-tree diff does
   * not depend on the session baseline, so a deleted baseline cannot block it.
   */
  async changeDiff(input: ChangeDiffInput): Promise<ChangeDiffOutcome> {
    const resolved = await this.resolve(input.sessionId)
    if (resolved.status !== 'ok') return changeUnavailableFrom(resolved)
    let context: ReadContext
    try {
      context = await this.deps.gitWorktrees.readContextFor(resolved.target)
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'worktree-inconsistent',
        detail:
          error instanceof Error
            ? error.message
            : 'The session worktree could not be read.'
      }
    }
    const diff = await readChangeDiff(context, {
      worktreePath: resolved.worktreePath,
      sessionId: input.sessionId,
      path: input.path,
      oldPath: input.oldPath ?? null,
      scope: input.scope,
      status: input.status,
      binary: input.binary,
      symlink: input.symlink,
      additions: input.additions,
      deletions: input.deletions
    })
    return { status: 'available', ...diff }
  }

  /** Changed files in the session's worktree, relative to its recorded baseline. */
  async sessionChanges(sessionId: string): Promise<ChangeListOutcome> {
    return readSessionChanges(this.deps, sessionId)
  }
  async readStatusSnapshot(sessionId: string, signal: AbortSignal): Promise<GitOutcome<{ snapshot: GitWorkspaceStatus }>> {
    return statusOps.readStatusSnapshot(this, sessionId, signal)
  }


  /**
   * The merge/rebase/cherry-pick/revert/bisect marker in the repository, if any.
   *
   * This is a repository-level fact, not a worktree status field. It is read
   * from the common Git directory by the existing inspection path, which knows
   * whether to stat locally or ask the guest.
   */
  async operationState(sessionId: string): Promise<GitOutcome<{ operation: GitOperationKind | null; marker: string | null }>> {
    return statusOps.operationState(this, sessionId)
  }


  /**
   * Continues an in-progress merge/rebase/cherry-pick/revert.
   *
   * Conflicts must be resolved and staged first. The editor is forced to
   * `true` so a rebase or sequencer step can never block on an interactive
   * editor; the operation marker is the source of truth for which command runs.
   */
  async continueOperation(sessionId: string): Promise<GitOutcome<{ operation: GitOperationKind }>> {
    return statusOps.continueOperation(this, sessionId)
  }


  /** Aborts an in-progress merge/rebase/cherry-pick/revert. */
  async abortOperation(sessionId: string): Promise<GitOutcome<{ operation: GitOperationKind }>> {
    return statusOps.abortOperation(this, sessionId)
  }


  /** Local branches, remotes and tags with the current branch marked. */
  async worktreeList(sessionId: string): Promise<
    GitOutcome<{
      worktrees: Array<
        GitWorktreeEntry & { sessionId: string | null; active: boolean; primary: boolean }
      >
    }>
  > {
    return advancedOps.worktreeList(this, sessionId)
  }


  /** Locks, unlocks, prunes or removes a registered worktree. */
  async worktreeAction(sessionId: string, action: 'lock' | 'unlock' | 'prune' | 'remove', path?: string, reason?: string): Promise<GitOutcome<{ action: 'lock' | 'unlock' | 'prune' | 'remove'; path: string | null }>> {
    return advancedOps.worktreeAction(this, sessionId, action, path, reason)
  }


  /** Submodules of this worktree and their pointer state. */
  async submoduleStatus(sessionId: string): Promise<GitOutcome<{ submodules: GitSubmoduleEntry[] }>> {
    return advancedOps.submoduleStatus(this, sessionId)
  }


  /** Initializes, updates, syncs or stages one or all submodules. */
  async submoduleAction(sessionId: string, action: 'init' | 'update' | 'sync' | 'stage', path?: string): Promise<GitOutcome<{ action: 'init' | 'update' | 'sync' | 'stage'; path: string | null }>> {
    return advancedOps.submoduleAction(this, sessionId, action, path)
  }


  /**
   * Changed files between two revisions.
   *
   * Refs are resolved to commits before `diff` runs, so an arbitrary string is
   * never handed to Git as an option. The file list is bounded; the returned
   * `truncated` flag tells the history view to paginate instead of pretending
   * the range ended.
   */
  async rangeDiff(sessionId: string, from: string, to = 'HEAD'): Promise<GitOutcome<{ fromOid: string; toOid: string; files: GitRangeFile[]; truncated: boolean }>> {
    return historyOps.rangeDiff(this, sessionId, from, to)
  }


  /**
   * The paths and target a worktree watcher needs.
   *
   * A guest worktree's paths are guest paths; the caller decides whether it can
   * translate them to a Windows path (DrvFs) or must use the Host (ext4).
   */
  async watchTargetDetails(sessionId: string): Promise<{ worktreePath: string; gitDir: string; target: ExecutionTarget } | null> {
    return statusOps.watchTargetDetails(this, sessionId)
  }


  /**
   * The paths for a local watcher.
   *
   * Returns null for a guest target: Phase 1c decides whether its worktree is a
   * translatable DrvFs path or needs the Host watcher, and must not silently
   * watch the controller's filesystem in the guest's place.
   */
  async commit(sessionId: string, message: string, options: { all?: boolean; signOff?: boolean; sign?: boolean } = {}): Promise<GitOutcome<GitCommitResult>> {
    return changeOps.commit(this, sessionId, message, options)
  }


  /**
   * Stages or unstages a selection in one serialized operation.
   *
   * Each target keeps its own outcome, so a path the live Agent changed between
   * the snapshot and the command is reported as failed rather than failing the
   * whole batch. `unborn` selects `git rm --cached` for unstage, because there is
   * no HEAD to reset to.
   */
  async setPathsStaged(sessionId: string, targets: readonly GitPathTarget[], staged: boolean): Promise<GitOutcome<{ result: GitBatchResult }>> {
    return changeOps.setPathsStaged(this, sessionId, targets, staged)
  }


  /**
   * Discards a selection after checking that it still describes the worktree.
   *
   * `expectedRevision` is the status stamp from the snapshot the user saw. A
   * mismatch means the live Agent edited the checkout in between, and a
   * destructive command must not proceed on the old assumption.
   */
  async discardPaths(sessionId: string, targets: readonly GitPathTarget[], expectedRevision?: string): Promise<GitOutcome<{ result: GitBatchResult }>> {
    return changeOps.discardPaths(this, sessionId, targets, expectedRevision)
  }


  /** Stages or unstages one path, leaving every other path as it was. */
  async setPathStaged(sessionId: string, path: string, staged: boolean): Promise<GitOutcome<{ path: string; staged: boolean }>> {
    return changeOps.setPathStaged(this, sessionId, path, staged)
  }


  /** Local branches, for the branch switcher. */
  async branches(sessionId: string): Promise<GitOutcome<{ current: string | null; names: string[] }>> {
    return branchOps.branches(this, sessionId)
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
    return branchOps.switchBranch(this, sessionId, branch)
  }


  /**
   * Creates a local branch at HEAD without checking it out.
   *
   * Creating a branch is safe on a dirty worktree because it does not move the
   * checkout; switching is a separate operation and still refuses dirty work.
   */
  async createBranch(sessionId: string, branch: string, at?: string): Promise<GitOutcome<{ branch: string }>> {
    return branchOps.createBranch(this, sessionId, branch, at)
  }


  /**
   * Creates a lightweight local tag at one commit. Tags are local until the
   * user explicitly pushes them; there is no automatic push here.
   */
  async createTag(sessionId: string, name: string, oid: string): Promise<GitOutcome<{ name: string; oid: string }>> {
    return branchOps.createTag(this, sessionId, name, oid)
  }


  /** Renames a local branch without changing the checkout. */
  async renameBranch(sessionId: string, from: string, to: string): Promise<GitOutcome<{ from: string; branch: string }>> {
    return branchOps.renameBranch(this, sessionId, from, to)
  }


  /**
   * Deletes a local branch only when it is merged and not checked out by any
   * worktree. This is deliberately the safe `-d` form; force deletion is not
   * offered from the menu.
   */
  async deleteBranch(sessionId: string, branch: string): Promise<GitOutcome<{ branch: string }>> {
    return branchOps.deleteBranch(this, sessionId, branch)
  }


  /**
   * Merges a local branch into the current branch. Conflicts are Git's outcome:
   * the operation banner then offers Continue or Abort.
   */
  async mergeBranch(sessionId: string, branch: string): Promise<GitOutcome<{ branch: string }>> {
    return branchOps.mergeBranch(this, sessionId, branch)
  }


  /**
   * Rebases the current branch onto another local branch or commit.
   *
   * This rewrites local history, so the UI confirms it. Conflicts leave the
   * rebase marker and are handled by the operation banner's Continue/Abort.
   */
  async rebaseBranch(sessionId: string, branch: string): Promise<GitOutcome<{ branch: string }>> {
    return branchOps.rebaseBranch(this, sessionId, branch)
  }


  /** Deletes a local tag. Remote tags are never touched. */
  async deleteTag(sessionId: string, name: string): Promise<GitOutcome<{ name: string }>> {
    return branchOps.deleteTag(this, sessionId, name)
  }


  /** Local tags with the object each points at. Remote tags are not listed. */
  async tags(sessionId: string): Promise<GitOutcome<{ tags: GitTag[] }>> {
    return branchOps.tags(this, sessionId)
  }


  /**
   * Checks out a tag or commit detached. A dirty worktree is refused for the
   * same reason as a branch switch: carrying uncommitted work across a
   * checkout can lose it.
   */
  async checkoutRef(sessionId: string, ref: string): Promise<GitOutcome<{ ref: string; headOid: string }>> {
    return branchOps.checkoutRef(this, sessionId, ref)
  }


  /**
   * Cherry-picks or reverts one commit with Git's default message.
   *
   * Conflicts are Git's outcome: the operation marker remains and the user
   * continues or aborts in the terminal until Phase 4 wires that banner. The
   * error text is Git's own reason rather than a fabricated success.
   */
  async cherryPick(sessionId: string, oid: string): Promise<GitOutcome<{ oid: string; shortOid: string; subject: string }>> {
    return branchOps.cherryPick(this, sessionId, oid)
  }
  async revert(sessionId: string, oid: string): Promise<GitOutcome<{ oid: string; shortOid: string; subject: string }>> {
    return branchOps.revert(this, sessionId, oid)
  }


  /**
   * Moves the current branch to a commit. `soft` keeps the index, `mixed`
   * resets it, and `hard` also discards tracked worktree changes; the renderer
   * confirms hard mode explicitly. This method does not push.
   */
  async resetTo(sessionId: string, oid: string, mode: 'soft' | 'mixed' | 'hard'): Promise<GitOutcome<{ oid: string; branch: string | null }>> {
    return branchOps.resetTo(this, sessionId, oid, mode)
  }


  /** Pushes the current branch to its configured upstream. */
  async push(sessionId: string): Promise<GitOutcome<{ branch: string; upstream: string }>> {
    return remoteOps.push(this, sessionId)
  }


  /** Pulls into the current branch from its configured upstream. */
  async pull(sessionId: string, rebase = false): Promise<GitOutcome<{ branch: string; upstream: string }>> {
    return remoteOps.pull(this, sessionId, rebase)
  }


  /**
   * Publishes the current branch by setting its upstream.
   *
   * The remote is the conventional `origin` when present, otherwise the first
   * configured remote. The operation never chooses a remote interactively from
   * a background UI event; the user can open the terminal for anything unusual.
   */
  async publish(sessionId: string): Promise<GitOutcome<{ branch: string; upstream: string }>> {
    return remoteOps.publish(this, sessionId)
  }


  /** Configured remotes with their fetch and push URLs. */
  async remotes(sessionId: string): Promise<GitOutcome<{ remotes: GitRemote[] }>> {
    return remoteOps.remotes(this, sessionId)
  }


  /** Adds a remote. The URL is never logged or echoed with credentials. */
  async addRemote(sessionId: string, name: string, url: string): Promise<GitOutcome<{ name: string }>> {
    return remoteOps.addRemote(this, sessionId, name, url)
  }


  /** Fetches one named remote, optionally pruning deleted remote branches. */
  async fetchRemote(sessionId: string, remote: string, prune = false): Promise<GitOutcome<{ remote: string }>> {
    return remoteOps.fetchRemote(this, sessionId, remote, prune)
  }


  /** Removes a remote; local branches and commits are untouched. */
  async removeRemote(sessionId: string, name: string): Promise<GitOutcome<{ name: string }>> {
    return remoteOps.removeRemote(this, sessionId, name)
  }


  /** Pushes local tags to the default remote. Explicit, never automatic. */
  async pushTags(sessionId: string): Promise<GitOutcome<{ remote: string }>> {
    return remoteOps.pushTags(this, sessionId)
  }


  /** Remote-tracking branches, e.g. `origin/main`, for an upstream picker. */
  async remoteBranches(sessionId: string): Promise<GitOutcome<{ branches: string[] }>> {
    return remoteOps.remoteBranches(this, sessionId)
  }


  /** Sets the current branch's upstream to an existing remote-tracking branch. */
  async setUpstream(sessionId: string, upstream: string): Promise<GitOutcome<{ branch: string; upstream: string }>> {
    return remoteOps.setUpstream(this, sessionId, upstream)
  }


  /** Force-push guarded by the remote-tracking lease; never a bare force. */
  async forcePush(sessionId: string): Promise<GitOutcome<{ branch: string; upstream: string }>> {
    return remoteOps.forcePush(this, sessionId)
  }


  /** Fetches the default remote without changing the working tree. */
  async fetch(sessionId: string): Promise<GitOutcome<{ remote: string }>> {
    return remoteOps.fetch(this, sessionId)
  }


  /**
   * Rewrites the last commit's message. This is deliberately local; no
   * force-push is offered here, because a rewritten commit is not safe to send
   * to a shared branch without a separate decision.
   */
  async amend(sessionId: string, message?: string, options: { sign?: boolean } = {}): Promise<GitOutcome<GitCommitResult>> {
    return changeOps.amend(this, sessionId, message, options)
  }


  /**
   * Paginated History feed.
   *
   * Unlike `history()`, this returns full parent hashes, author dates and ref
   * decorations so the renderer can draw graph lanes and open a commit detail.
   * `ref` and `path` are validated before being passed to Git; the path is
   * always placed after `--` so a path that looks like a revision is inert.
   */
  async log(sessionId: string, options: {
      limit?: number
      skip?: number
      ref?: string
      allRefs?: boolean
      path?: string
    } = {}): Promise<GitOutcome<GitLogPage>> {
    return historyOps.log(this, sessionId, options)
  }


  /**
   * One commit's metadata plus the files of its first parent comparison.
   *
   * A root commit diffs against the empty tree. `rangeDiff` owns the file
   * parsing and the 5,000-file cap, so this method does not grow a second diff
   * parser.
   */
  async commitDetail(sessionId: string, oid: string, parent?: string): Promise<GitOutcome<GitCommitDetail>> {
    return historyOps.commitDetail(this, sessionId, oid, parent)
  }


  /**
   * Unified diff for one file between two revisions.
   *
   * History reuses the review renderer instead of growing a second diff view.
   * The patch is capped and binary output is reported explicitly; renames pass
   * both paths so Git can pair them.
   */
  async revisionFileDiff(sessionId: string, from: string, to: string, path: string, oldPath?: string): Promise<
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
    return historyOps.revisionFileDiff(this, sessionId, from, to, path, oldPath)
  }


  /**
   * Per-line blame for the working file, used by the editor's inline annotation.
   *
   * `--line-porcelain` is deterministic and complete per line, so no state is
   * carried between lines. Uncommitted lines are reported as such instead of
   * being attributed to the previous commit. The result is capped so a huge
   * file cannot dominate the renderer.
   */
  async blame(sessionId: string, path: string): Promise<GitOutcome<{ lines: BlameLine[]; truncated: boolean }>> {
    return historyOps.blame(this, sessionId, path)
  }


  /**
   * Reads one file at a revision, with worktree filters applied.
   *
   * The Files editor uses this as its quick-diff baseline. The size check runs
   * before content is requested so a huge blob cannot enter the renderer, and a
   * NUL byte marks a binary blob instead of pretending it is editable text.
   */
  async fileAtRevision(sessionId: string, rev: string, path: string): Promise<
    GitOutcome<{
      rev: string
      oid: string
      text: string
      binary: boolean
      tooLarge: boolean
    }>
  > {
    return historyOps.fileAtRevision(this, sessionId, rev, path)
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
  async indexFile(sessionId: string, path: string): Promise<
    GitOutcome<{
      path: string
      text: string
      binary: boolean
      tooLarge: boolean
    }>
  > {
    return historyOps.indexFile(this, sessionId, path)
  }


  /**
   * Reads the three index stages of one conflicted path.
   *
   * Stage 1 is the merge base, 2 is current/ours and 3 is incoming/theirs. Base
   * is absent for add/add conflicts. Binary and oversized sides are reported as
   * flags so the renderer falls back to the terminal instead of showing mojibake.
   */
  async conflictFile(sessionId: string, path: string): Promise<
    GitOutcome<{
      path: string
      base: { oid: string; text: string; binary: boolean; tooLarge: boolean } | null
      current: { oid: string; text: string; binary: boolean; tooLarge: boolean }
      incoming: { oid: string; text: string; binary: boolean; tooLarge: boolean }
    }>
  > {
    return changeOps.conflictFile(this, sessionId, path)
  }


  /**
   * Marks a conflicted path resolved by adding its worktree result to the index.
   *
   * This is separate from `setPathStaged`, which deliberately refuses conflicted
   * paths; the merge editor calls it only after all markers are gone.
   */
  async resolveConflict(sessionId: string, path: string): Promise<GitOutcome<{ path: string }>> {
    return changeOps.resolveConflict(this, sessionId, path)
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
  async applyPatch(sessionId: string, patch: string, path: string, mode: 'stage' | 'unstage' | 'discard'): Promise<GitOutcome<{ path: string; mode: 'stage' | 'unstage' | 'discard' }>> {
    return changeOps.applyPatch(this, sessionId, patch, path, mode)
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
    return advancedOps.stashList(this, sessionId)
  }


  /** Creates a stash. `includeUntracked` also saves files Git has not added yet. */
  async stashPush(sessionId: string, message: string, includeUntracked: boolean, keepIndex: boolean): Promise<GitOutcome<{ created: boolean }>> {
    return advancedOps.stashPush(this, sessionId, message, includeUntracked, keepIndex)
  }


  /** Unified patch for one stash, including untracked files when present. */
  async stashDiff(sessionId: string, index: number): Promise<GitOutcome<{ ref: string; patch: string; truncated: boolean }>> {
    return advancedOps.stashDiff(this, sessionId, index)
  }


  /** Applies, pops or drops one stash addressed by its list index. */
  async stashAction(sessionId: string, index: number, action: 'apply' | 'pop' | 'drop'): Promise<GitOutcome<{ ref: string; action: 'apply' | 'pop' | 'drop' }>> {
    return advancedOps.stashAction(this, sessionId, index, action)
  }


  async remoteNames(
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
  async withUpstream(
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

  async readStatus(
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

  async resolve(
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
