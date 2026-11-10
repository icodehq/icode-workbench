import type { RepositoryStore } from '../persistence/repository-store'
import type { TaskStore } from '../tasks/task-store'
import type { GitWorktreeService } from '../worktrees/git-worktree-service'
import type { BranchService } from '../git/branch-service'
import type { ExecutionTarget } from '../../shared/domain/repository'
import type { TaskRecord } from '../../shared/domain/task'
import { makeAppError } from '../../shared/domain/errors'
import { SessionServiceError } from '../sessions/session-errors'

export type TaskBase = { baseRef: string | null; baseOid: string }

export type ChainServiceDeps = {
  repositories: RepositoryStore
  tasks: TaskStore
  gitWorktrees: GitWorktreeService
  branches: BranchService
}

/**
 * Resolves the commit a task's worktree starts from.
 *
 * A chain root creates the shared branch lazily, from its `startFrom` (or the
 * primary HEAD). A dependent must never start from a missing chain branch; that
 * would silently drop the blockers' work, so it fails instead.
 */
export class ChainService {
  constructor(private readonly deps: ChainServiceDeps) {}

  async resolveTaskBase(task: TaskRecord): Promise<TaskBase> {
    const repository = this.deps.repositories.findById(task.repoId)
    if (!repository) {
      throw new SessionServiceError(
        makeAppError('INVALID_ARGUMENT', 'Repository is not registered.', {
          context: { repoId: task.repoId }
        })
      )
    }
    const target = repository.executionTarget
    if (task.chainBranch !== null) {
      const tip = await this.deps.gitWorktrees.resolveBranchOid(
        repository.path,
        task.chainBranch,
        target
      )
      if (tip !== null) return { baseRef: task.chainBranch, baseOid: tip }
      const blockers = this.deps.tasks.dependenciesOf(task.id)
      if (blockers.length > 0) {
        throw new SessionServiceError(
          makeAppError('CHAIN_BRANCH_MISSING', 'The chain branch is missing.', {
            context: { branch: task.chainBranch }
          })
        )
      }
      const base = await this.resolveStart(repository.path, task.startFrom, target)
      const created = await this.deps.branches.ensureBranch({
        repoId: task.repoId,
        branch: task.chainBranch,
        oid: base.baseOid,
        ownerTaskId: task.id
      })
      return { baseRef: task.chainBranch, baseOid: created }
    }
    return this.resolveStart(repository.path, task.startFrom, target)
  }

  private async resolveStart(
    repositoryPath: string,
    startFrom: string | null,
    target: ExecutionTarget
  ): Promise<TaskBase> {
    if (startFrom !== null) {
      const oid = await this.deps.gitWorktrees.resolveBranchOid(
        repositoryPath,
        startFrom,
        target
      )
      if (oid === null) {
        throw new SessionServiceError(
          makeAppError('START_REF_NOT_FOUND', 'The start-from branch does not exist.', {
            context: { branch: startFrom }
          })
        )
      }
      return { baseRef: startFrom, baseOid: oid }
    }
    const state = await this.deps.gitWorktrees.inspectRepository(repositoryPath, target)
    if (state.unborn || state.headOid === null) {
      throw new SessionServiceError(
        makeAppError('UNBORN_REPOSITORY', 'This repository has no commit yet.', {
          detail: 'Create an initial commit before starting a task.'
        })
      )
    }
    return { baseRef: state.headRef, baseOid: state.headOid }
  }
}
