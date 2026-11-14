import type { RepositoryStore } from '../persistence/repository-store'
import type { WorktreeStore } from '../persistence/worktree-store'
import type { GitWorktreeService } from '../worktrees/git-worktree-service'
import type { BranchRefSummary } from '../../shared/schemas/ipc'
import type { RepoId } from '../../shared/domain/ids'
import { makeAppError } from '../../shared/domain/errors'
import { SessionServiceError } from '../sessions/session-errors'
import { isValidBranchName } from '../../shared/domain/branch'

export type BranchServiceDeps = {
  repositories: RepositoryStore
  worktrees: WorktreeStore
  gitWorktrees: GitWorktreeService
  now?: () => number
}

/**
 * Local branch reads and the small set of branch-name checks shared by session
 * creation, task chains, and the finish dialogs. All Git runs through the
 * target-aware worktree service, never `node:fs` on a guest path.
 */
export class BranchService {
  constructor(private readonly deps: BranchServiceDeps) {}

  async listRefs(repoId: RepoId): Promise<BranchRefSummary[]> {
    const repository = this.repository(repoId)
    const target = repository.executionTarget
    const git = await this.deps.gitWorktrees.gitFor(target)
    const output = await git(
      repository.path,
      ['for-each-ref', '--format=%(refname:short)%00%(objectname)%00%(HEAD)', 'refs/heads']
    )
    const worktrees = await this.deps.gitWorktrees
      .listWorktrees(repository.path, target)
      .catch(() => [])
    const refs: BranchRefSummary[] = []
    for (const line of output.split('\n')) {
      if (line.length === 0) continue
      const [name, oid, head] = line.split('\u0000')
      if (!name || !oid) continue
      refs.push({
        name,
        oid,
        primaryHead: head?.trim() === '*',
        worktreePath:
          worktrees.find((entry) => entry.branch === name)?.path ?? null
      })
    }
    return refs.sort((left, right) => {
      if (left.primaryHead !== right.primaryHead) return left.primaryHead ? -1 : 1
      return left.name.localeCompare(right.name)
    })
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
