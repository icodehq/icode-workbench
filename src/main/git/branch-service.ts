import type { RepositoryStore } from '../persistence/repository-store'
import type { WorktreeStore } from '../persistence/worktree-store'
import type { GitWorktreeService } from '../worktrees/git-worktree-service'
import type { RemoteService } from './remote-service'
import type { BranchRefSummary } from '../../shared/schemas/ipc'
import type { RepoId } from '../../shared/domain/ids'
import { makeAppError } from '../../shared/domain/errors'
import { SessionServiceError } from '../sessions/session-errors'
import {
  isValidBranchName,
  isValidStartRef,
  startRefCandidates,
  type RemoteTrackingRef
} from '../../shared/domain/branch'

export type BranchServiceDeps = {
  repositories: RepositoryStore
  worktrees: WorktreeStore
  gitWorktrees: GitWorktreeService
  remotes: Pick<RemoteService, 'fetchTrackingRef'>
  now?: () => number
}

export type ResolvedStartRef = {
  baseRef: string
  baseOid: string
  remoteTracking: RemoteTrackingRef | null
}

/**
 * Branch reads (local and remote-tracking) and the small set of branch-name
 * checks shared by session creation, task chains, and the finish dialogs. All
 * Git runs through the target-aware worktree service, never `node:fs` on a
 * guest path.
 */
export class BranchService {
  constructor(private readonly deps: BranchServiceDeps) {}

  async listRefs(repoId: RepoId): Promise<BranchRefSummary[]> {
    const repository = this.repository(repoId)
    const target = repository.executionTarget
    const git = await this.deps.gitWorktrees.gitFor(target)
    // Full refnames, not %(refname:short): when a local `origin/foo` and a
    // remote-tracking `origin/foo` coexist, Git shortens the remote to
    // `remotes/origin/foo`. The short label is derived below instead.
    const output = await git(repository.path, [
      'for-each-ref',
      '--format=%(refname)%00%(objectname)%00%(HEAD)%00%(symref)',
      'refs/heads',
      'refs/remotes'
    ])
    const worktrees = await this.deps.gitWorktrees
      .listWorktrees(repository.path, target)
      .catch(() => [])
    const refs: BranchRefSummary[] = []
    for (const line of output.split('\n')) {
      if (line.length === 0) continue
      const [fullName, oid, head, symref] = line.split('\u0000')
      if (!fullName || !oid) continue
      // refs/remotes/<remote>/HEAD is a symbolic pointer, not a branch.
      if (symref !== undefined && symref.trim().length > 0) continue
      if (fullName.startsWith('refs/heads/')) {
        const name = fullName.slice('refs/heads/'.length)
        refs.push({
          name,
          fullName,
          kind: 'local',
          oid,
          primaryHead: head?.trim() === '*',
          worktreePath: worktrees.find((entry) => entry.branch === name)?.path ?? null
        })
      } else if (fullName.startsWith('refs/remotes/')) {
        refs.push({
          name: fullName.slice('refs/remotes/'.length),
          fullName,
          kind: 'remote',
          oid,
          primaryHead: false,
          worktreePath: null
        })
      }
    }
    return refs.sort((left, right) => {
      if (left.primaryHead !== right.primaryHead) return left.primaryHead ? -1 : 1
      if (left.kind !== right.kind) return left.kind === 'local' ? -1 : 1
      const byName = left.name.localeCompare(right.name)
      return byName !== 0 ? byName : left.fullName.localeCompare(right.fullName)
    })
  }

  /**
   * Resolves a start-from value to a commit, refreshing a remote-tracking ref
   * first when one was selected.
   *
   * Local candidates win for bare names, preserving the historical meaning of
   * a local branch literally named `origin/foo`; the UI sends full remote refs
   * for remote choices. A failed refresh falls back to the last fetched
   * tracking ref, so offline creation still works.
   */
  async resolveStartRef(
    repoId: RepoId,
    ref: string,
    options: { refreshRemote?: boolean } = {}
  ): Promise<ResolvedStartRef | null> {
    const repository = this.repository(repoId)
    const target = repository.executionTarget
    const value = ref.trim()
    if (!isValidStartRef(value)) return null
    // Only a value that can name a remote-tracking ref needs the remote list.
    const needsRemotes =
      value.startsWith('refs/remotes/') || (!value.startsWith('refs/') && value.includes('/'))
    const remoteNames = needsRemotes
      ? await this.deps.gitWorktrees.listRemotes(repository.path, target)
      : []
    for (const candidate of startRefCandidates(value, remoteNames)) {
      const remoteCandidate =
        candidate.ref.startsWith('refs/remotes/') || candidate.remoteTracking !== null
      if (!remoteCandidate) {
        const oid = await this.deps.gitWorktrees.resolveRefOid(
          repository.path,
          candidate.ref,
          target
        )
        if (oid !== null) {
          return { baseRef: value, baseOid: oid, remoteTracking: null }
        }
        continue
      }
      if (options.refreshRemote && candidate.remoteTracking !== null) {
        try {
          await this.deps.remotes.fetchTrackingRef(repoId, {
            remote: candidate.remoteTracking.remote,
            branch: candidate.remoteTracking.branch
          })
        } catch (error) {
          // Offline, auth failure or a deleted branch: the existing tracking
          // ref (when present) is still a valid snapshot.
          console.warn(
            `[branch] could not refresh ${candidate.ref}; using the existing tracking ref`,
            error
          )
        }
      }
      const oid = await this.deps.gitWorktrees.resolveRefOid(
        repository.path,
        candidate.ref,
        target
      )
      if (oid !== null) {
        return {
          baseRef: candidate.remoteTracking?.fullRef ?? candidate.ref,
          baseOid: oid,
          remoteTracking: candidate.remoteTracking
        }
      }
    }
    return null
  }

  async resolveRef(
    repoId: RepoId,
    branch: string
  ): Promise<{ name: string; oid: string } | null> {
    const repository = this.repository(repoId)
    if (!isValidBranchName(branch)) return null
    const oid = await this.deps.gitWorktrees.resolveBranchOid(
      repository.path,
      branch,
      repository.executionTarget
    )
    return oid === null ? null : { name: branch, oid }
  }

  async validateNewBranch(repoId: RepoId, branch: string): Promise<void> {
    const repository = this.repository(repoId)
    if (!isValidBranchName(branch)) {
      throw new SessionServiceError(
        makeAppError('INVALID_ARGUMENT', 'The branch name is not valid.', {
          context: { branch }
        })
      )
    }
    const checked = await this.deps.gitWorktrees.checkBranchName(
      repository.path,
      branch,
      repository.executionTarget
    )
    if (!checked.ok) {
      throw new SessionServiceError(
        makeAppError('INVALID_ARGUMENT', 'Git rejected the branch name.', {
          detail: checked.detail,
          context: { branch }
        })
      )
    }
    if (
      (await this.deps.gitWorktrees.branchExists(
        repository.path,
        branch,
        repository.executionTarget
      )) ||
      this.deps.worktrees.findBranch(branch) !== null
    ) {
      throw new SessionServiceError(
        makeAppError('BRANCH_EXISTS', 'That branch already exists.', {
          context: { branch }
        })
      )
    }
  }

  async remotes(repoId: RepoId): Promise<string[]> {
    const repository = this.repository(repoId)
    return this.deps.gitWorktrees.listRemotes(repository.path, repository.executionTarget)
  }

  /**
   * Creates a chain branch if it is missing, or verifies/records it when it
   * already exists. Runs under the repository lock so it cannot race worktree
   * creation or another chain root.
   */
  async ensureBranch(input: {
    repoId: RepoId
    branch: string
    oid: string
    ownerTaskId: string
  }): Promise<string> {
    const repository = this.repository(input.repoId)
    const target = repository.executionTarget
    return this.deps.gitWorktrees.runRepositoryExclusive(repository.path, target, async () => {
      const existing = await this.deps.gitWorktrees.resolveBranchOid(
        repository.path,
        input.branch,
        target
      )
      const owned = this.deps.worktrees.findBranch(input.branch)
      if (existing !== null) {
        if (owned && owned.kind === 'chain' && owned.taskId !== input.ownerTaskId) {
          throw new SessionServiceError(
            makeAppError('CHAIN_BRANCH_CONFLICT', 'That chain branch belongs to another chain.', {
              context: { branch: input.branch }
            })
          )
        }
        if (!owned) {
          this.deps.worktrees.insertBranch({
            branch: input.branch,
            repoId: repository.id,
            worktreeId: null,
            sessionId: null,
            taskId: input.ownerTaskId,
            kind: 'chain',
            baseOid: existing,
            createdAt: this.now()
          })
        }
        return existing
      }
      await this.deps.gitWorktrees.createBranch({
        primaryRoot: repository.path,
        branch: input.branch,
        oid: input.oid,
        target
      })
      this.deps.worktrees.insertBranch({
        branch: input.branch,
        repoId: repository.id,
        worktreeId: null,
        sessionId: null,
        taskId: input.ownerTaskId,
        kind: 'chain',
        baseOid: input.oid,
        createdAt: this.now()
      })
      return input.oid
    })
  }

  private repository(repoId: RepoId) {
    const repository = this.deps.repositories.findById(repoId)
    if (!repository) {
      throw new SessionServiceError(
        makeAppError('INVALID_ARGUMENT', 'Repository is not registered.', { context: { repoId } })
      )
    }
    return repository
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}
