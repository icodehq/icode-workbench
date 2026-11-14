import type { Database } from '../persistence/database'
import type { RepositoryStore } from '../persistence/repository-store'
import type { WorktreeStore } from '../persistence/worktree-store'
import type { MergeStore } from '../persistence/merge-store'
import type { TaskStore } from '../tasks/task-store'
import type { GitWorktreeService } from '../worktrees/git-worktree-service'
import type { GitWorkspaceService } from '../git/git-workspace-service'
import type { SessionId } from '../../shared/domain/ids'
import type { ExecutionTarget } from '../../shared/domain/repository'
import type { AppError } from '../../shared/domain/errors'
import type { MergeOutcome, MergeRecord } from '../../shared/domain/merge'
import { makeAppError } from '../../shared/domain/errors'
import { classifyRemoteFailure } from '../git/remote-failure'
import { SessionServiceError } from '../sessions/session-errors'
import { samePathResolved } from '../worktrees/worktree-status'

export type MergeStartInput = {
  sessionId: string
  targetBranch: string
  commitMessage?: string
  pushRemote?: string
}

export type MergeServiceDeps = {
  database: Database
  repositories: RepositoryStore
  worktrees: WorktreeStore
  merges: MergeStore
  tasks?: TaskStore
  gitWorktrees: GitWorktreeService
  gitWorkspace: GitWorkspaceService
  now: () => number
  newId: () => string
  onChanged: () => void
  /** Test seam: observes the moment immediately before a target fast-forward. */
  beforeFastForward?: () => Promise<void>
}

type TargetMode = 'primary-checkout' | 'ref-update'

/**
 * The local merge loop shared by direct and task sessions.
 *
 * The source worktree is updated from the target first; conflicts are resolved
 * there with the existing MergeEditor. Once the target is an ancestor of the
 * source, the target is fast-forwarded with a compare-and-swap (or a clean
 * primary checkout). The target is never force-updated and a failed optional
 * push never undoes a completed merge.
 */
export class MergeService {
  constructor(private readonly deps: MergeServiceDeps) {}

  async start(input: MergeStartInput): Promise<MergeOutcome> {
    const worktree = this.deps.worktrees.findBySession(input.sessionId)
    if (!worktree) {
      throw fail('INVALID_ARGUMENT', 'That session has no worktree to merge.')
    }
    const repository = this.deps.repositories.findById(worktree.repoId)
    if (!repository) {
      throw fail('INVALID_ARGUMENT', 'Repository is not registered.')
    }
    const target = repository.executionTarget
    const git = await this.deps.gitWorktrees.gitFor(target)

    if (input.targetBranch === worktree.branch) {
      throw fail('INVALID_ARGUMENT', 'Choose a different target branch.')
    }
    const task = this.deps.tasks?.findBySessionId(input.sessionId as SessionId) ?? null
    if (task?.chainBranch && input.targetBranch !== task.chainBranch) {
      const dependents =
        this.deps.tasks?.relationsFor([task.id]).dependents.get(task.id) ?? []
      if (dependents.length > 0) {
        throw fail(
          'CHAIN_BRANCH_MISMATCH',
          'A task with dependents must merge into its chain branch.',
          { branch: task.chainBranch }
        )
      }
    }
    const targetOid = await this.deps.gitWorktrees.resolveBranchOid(
      repository.path,
      input.targetBranch,
      target
    )
    if (targetOid === null) {
      throw fail('START_REF_NOT_FOUND', 'The target branch does not exist.', {
        branch: input.targetBranch
      })
    }

    const inspection = await this.deps.gitWorktrees.inspect({
      primaryRoot: repository.path,
      path: worktree.path,
      branch: worktree.branch,
      target
    })
    if (!inspection.pathExists) {
      throw fail('WORKTREE_MISSING', 'The session checkout is missing.')
    }
    if (!inspection.registered) {
      throw fail('WORKTREE_INCONSISTENT', 'The session checkout is not registered with Git.')
    }
    const liveBranch = (
      await git(worktree.path, ['rev-parse', '--abbrev-ref', 'HEAD'])
    ).trim()
    if (liveBranch === 'HEAD' || liveBranch !== worktree.branch) {
      throw fail('WORKTREE_INCONSISTENT', 'The session checkout is not on its recorded branch.')
    }

    const sourceState = await this.deps.gitWorktrees.inspectRepository(worktree.path, target)
    if (sourceState.inProgressOperation !== null) {
      throw fail('GIT_OPERATION_IN_PROGRESS', 'Finish the Git operation in this checkout first.')
    }

    const dirty = (await this.deps.gitWorktrees.statusPorcelain(worktree.path, target)).trim()
    const commitMessage = input.commitMessage?.trim() ?? ''
    if (dirty.length > 0 && commitMessage.length === 0) {
      throw fail('INVALID_ARGUMENT', 'A merge message is required to commit pending changes.')
    }

    const mode = await this.targetMode(repository.path, input.targetBranch, target)
    try {
      await git(worktree.path, ['var', 'GIT_AUTHOR_IDENT'])
    } catch {
      throw fail('GIT_IDENTITY_MISSING', 'Set a Git author name and email before merging.')
    }

    const sourceOidBefore = (await git(worktree.path, ['rev-parse', 'HEAD'])).trim()
    const claim = this.deps.merges.claim({
      id: this.deps.newId(),
      repoId: repository.id,
      sessionId: input.sessionId,
      worktreeId: worktree.id,
      taskId: task?.id ?? null,
      sourceBranch: worktree.branch,
      targetBranch: input.targetBranch,
      sourceOidBefore,
      targetOidBefore: targetOid,
      now: this.deps.now()
    })
    if (claim.kind !== 'claimed') {
      if (claim.kind === 'repo-removing') {
        throw new SessionServiceError(
          makeAppError(
            'REPOSITORY_REMOVING',
            'This project is still being cleaned up. Try again in a moment.',
            {
              messageKey: 'errors.REPOSITORY_REMOVING',
              context: { repoId: repository.id }
            }
          )
        )
      }
      if (claim.kind === 'worktree-busy') {
        throw fail(
          'MERGE_IN_PROGRESS',
          'Another session in this worktree is already merging.'
        )
      }
      throw claim.kind === 'session-busy'
        ? fail('MERGE_IN_PROGRESS', 'A merge is already active for this session.')
        : fail('MERGE_TARGET_BUSY', 'Another merge is already active for that target branch.')
    }

    const record = claim.record
    try {
      const commitOid =
        dirty.length === 0
          ? null
          : await this.commitPending(git, worktree.path, commitMessage, target)
      const updated = await this.updateSourceFromTarget(
        git,
        worktree.path,
        input.targetBranch,
        target
      )
      if (updated.status === 'conflicted') {
        return this.markConflicted(record, updated.files)
      }
      return await this.finish(
        record,
        repository.path,
        worktree.path,
        input.targetBranch,
        target,
        mode,
        commitOid,
        input.pushRemote ?? null
      )
    } catch (error) {
      const appError = toAppError(error)
      this.deps.merges.markFailed(record.id, appError, this.deps.now())
      throw new SessionServiceError(appError)
    }
  }

  async continueMerge(sessionId: string): Promise<MergeOutcome> {
    const record = this.deps.merges.findActiveForSession(sessionId)
    if (record === null || record.state !== 'conflicted') {
      throw fail('MERGE_IN_PROGRESS', 'There is no conflicted merge to continue.')
    }
    const worktree = this.deps.worktrees.findBySession(sessionId)
    const repository = worktree ? this.deps.repositories.findById(worktree.repoId) : null
    if (!worktree || !repository) {
      throw fail('WORKTREE_MISSING', 'The session checkout is missing.')
    }
    const target = repository.executionTarget
    const git = await this.deps.gitWorktrees.gitFor(target)
    const continued = await this.deps.gitWorkspace.continueOperation(sessionId)
    if (continued.status !== 'ok') {
      throw fail('GIT_CONFLICT', continued.detail ?? 'The merge could not continue.')
    }
    try {
      const updated = await this.updateSourceFromTarget(
        git,
        worktree.path,
        record.targetBranch,
        target
      )
      if (updated.status === 'conflicted') {
        return this.markConflicted(record, updated.files)
      }
      const mode = await this.targetMode(repository.path, record.targetBranch, target)
      return await this.finish(
        record,
        repository.path,
        worktree.path,
        record.targetBranch,
        target,
        mode,
        record.commitOid,
        record.pushRemote
      )
    } catch (error) {
      const appError = toAppError(error)
      this.deps.merges.markFailed(record.id, appError, this.deps.now())
      throw new SessionServiceError(appError)
    }
  }

  async abort(sessionId: string): Promise<MergeRecord> {
    const record = this.deps.merges.findActiveForSession(sessionId)
    if (record === null) {
      throw fail('MERGE_IN_PROGRESS', 'There is no active merge to abort.')
    }
    const aborted = await this.deps.gitWorkspace.abortOperation(sessionId)
    if (aborted.status !== 'ok') {
      const worktree = this.deps.worktrees.findBySession(sessionId)
      const repository = worktree ? this.deps.repositories.findById(worktree.repoId) : null
      let noOperation = false
      if (worktree && repository) {
        try {
          const state = await this.deps.gitWorktrees.inspectRepository(
            worktree.path,
            repository.executionTarget
          )
          noOperation = state.inProgressOperation === null
        } catch {
          noOperation = false
        }
      }
      // A stale conflicted record (for example after the old generic Continue
      // path) has no Git operation left to abort. Settle the record so it stops
      // blocking the session and target.
      if (!noOperation) {
        throw fail('GIT_CONFLICT', aborted.detail ?? 'The merge could not be aborted.')
      }
    }
    const now = this.deps.now()
    this.deps.merges.markAborted(record.id, now)
    this.deps.onChanged()
    return this.deps.merges.latestForSession(sessionId) ?? record
  }

  state(sessionId: string): MergeRecord | null {
    return this.deps.merges.latestForSession(sessionId)
  }

  /**
   * Called at boot before the task dispatcher recovers. A process that died
   * with a conflict marker is recoverable; one that died before Git wrote the
   * marker is interrupted, not merged.
   */
  async reconcileInterrupted(): Promise<{ interrupted: number; conflicted: number }> {
    let interrupted = 0
    let conflicted = 0
    for (const record of this.deps.merges.listActive()) {
      const worktree = this.deps.worktrees.findBySession(record.sessionId)
      const repository = worktree ? this.deps.repositories.findById(worktree.repoId) : null
      // A tombstoned repository is owned by the removal worker; reconciling its
      // merge here would race the abort/stage path.
      if (repository?.removingAt != null) continue
      if (!worktree || !repository) {
        this.deps.merges.markInterrupted(record.id, this.deps.now())
        interrupted += 1
        continue
      }
      const target = repository.executionTarget
      const git = await this.deps.gitWorktrees.gitFor(target)
      let state: Awaited<ReturnType<GitWorktreeService['inspectRepository']>>
      try {
        state = await this.deps.gitWorktrees.inspectRepository(worktree.path, target)
      } catch {
        // A temporarily unreachable worktree must not turn a live merge into a
        // stale one. Leave the record alone and report it as unresolved.
        conflicted += 1
        continue
      }
      if (state.inProgressOperation === null) {
        this.deps.merges.markInterrupted(record.id, this.deps.now())
        interrupted += 1
        continue
      }
      const files = await conflictFiles(git, worktree.path)
      this.deps.merges.markConflicted(record.id, files, this.deps.now())
      conflicted += 1
    }
    return { interrupted, conflicted }
  }

  private async commitPending(
    git: (cwd: string, args: string[], timeoutMs?: number) => Promise<string>,
    worktreePath: string,
    message: string,
    target: ExecutionTarget
  ): Promise<string> {
    return this.deps.gitWorkspace.queue.runExclusive(worktreePath, async () => {
      await git(worktreePath, ['add', '-A'])
      await git(worktreePath, ['commit', '-m', message])
      const after = (await this.deps.gitWorktrees.statusPorcelain(worktreePath, target)).trim()
      if (after.length > 0) {
        throw fail('WORKTREE_DIRTY', 'The checkout changed while the merge was being prepared.')
      }
      return (await git(worktreePath, ['rev-parse', 'HEAD'])).trim()
    })
  }

  private async updateSourceFromTarget(
    git: (cwd: string, args: string[], timeoutMs?: number) => Promise<string>,
    worktreePath: string,
    targetBranch: string,
    target: ExecutionTarget
  ): Promise<{ status: 'ok' } | { status: 'conflicted'; files: string[] }> {
    return this.deps.gitWorkspace.queue.runExclusive(worktreePath, async () => {
      const targetOid = await this.deps.gitWorktrees.resolveBranchOid(
        worktreePath,
        targetBranch,
        target
      )
      if (targetOid === null) {
        throw fail('START_REF_NOT_FOUND', 'The target branch no longer exists.')
      }
      const sourceOid = (await git(worktreePath, ['rev-parse', 'HEAD'])).trim()
      if (await this.deps.gitWorktrees.isAncestor(worktreePath, targetOid, sourceOid, target)) {
        return { status: 'ok' as const }
      }
      try {
        await git(worktreePath, ['-c', 'core.editor=true', 'merge', '--no-edit', targetOid])
        return { status: 'ok' as const }
      } catch {
        const state = await this.deps.gitWorktrees.inspectRepository(worktreePath, target)
        if (state.inProgressOperation === null) {
          throw fail('GIT_CONFLICT', 'Git refused to update the session branch from the target.')
        }
        return { status: 'conflicted' as const, files: await conflictFiles(git, worktreePath) }
      }
    })
  }

  private async finish(
    record: MergeRecord,
    repositoryPath: string,
    worktreePath: string,
    targetBranch: string,
    target: ExecutionTarget,
    initialMode: TargetMode,
    commitOid: string | null,
    pushRemote: string | null
  ): Promise<MergeOutcome> {
    let mode = initialMode
    const worktreeGit = await this.deps.gitWorktrees.gitFor(target)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const sourceOid = (await worktreeGit(worktreePath, ['rev-parse', 'HEAD'])).trim()
      const targetOidNow = await this.deps.gitWorktrees.resolveBranchOid(
        repositoryPath,
        targetBranch,
        target
      )
      if (targetOidNow === null) {
        throw fail('START_REF_NOT_FOUND', 'The target branch no longer exists.')
      }
      if (
        !(await this.deps.gitWorktrees.isAncestor(
          worktreePath,
          targetOidNow,
          sourceOid,
          target
        ))
      ) {
        const updated = await this.updateSourceFromTarget(
          worktreeGit,
          worktreePath,
          targetBranch,
          target
        )
        if (updated.status === 'conflicted') {
          return this.markConflicted(record, updated.files)
        }
        continue
      }

      if (mode === 'primary-checkout') {
        const primaryGit = await this.deps.gitWorktrees.gitFor(target)
        const branch = (
          await primaryGit(repositoryPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
        ).trim()
        if (branch !== targetBranch) {
          mode = 'ref-update'
        } else {
          const status = (
            await this.deps.gitWorktrees.statusPorcelain(repositoryPath, target)
          ).trim()
          if (status.length > 0) {
            throw fail('WORKTREE_DIRTY', 'The primary checkout has uncommitted changes.')
          }
          await this.deps.gitWorktrees.runRepositoryExclusive(
            repositoryPath,
            target,
            async () => {
              const current = await this.deps.gitWorktrees.resolveBranchOid(
                repositoryPath,
                targetBranch,
                target
              )
              if (current !== targetOidNow) {
                throw fail('MERGE_TARGET_MOVED', 'The target branch moved during the merge.')
              }
              await this.deps.beforeFastForward?.()
              await primaryGit(repositoryPath, ['merge', '--ff-only', sourceOid])
            }
          )
          return await this.complete(
            record,
            targetBranch,
            target,
            sourceOid,
            targetOidNow,
            commitOid,
            pushRemote,
            repositoryPath
          )
        }
      }

      const moved = await this.deps.gitWorktrees.fastForwardRef({
        primaryRoot: repositoryPath,
        ref: `refs/heads/${targetBranch}`,
        to: sourceOid,
        expected: targetOidNow,
        target
      })
      if (moved === 'updated') {
        return await this.complete(
          record,
          targetBranch,
          target,
          sourceOid,
          targetOidNow,
          commitOid,
          pushRemote,
          repositoryPath
        )
      }
    }
    throw fail('MERGE_TARGET_MOVED', 'The target branch kept moving. Try again.')
  }

  private async complete(
    record: MergeRecord,
    targetBranch: string,
    target: ExecutionTarget,
    resultOid: string,
    reviewBaseOid: string,
    commitOid: string | null,
    pushRemote: string | null,
    repositoryPath: string
  ): Promise<MergeOutcome> {
    const now = this.deps.now()
    let pushedAt: number | null = null
    let pushError: AppError | null = null
    if (pushRemote !== null) {
      try {
        const git = await this.deps.gitWorktrees.gitFor(target)
        await git(repositoryPath, [
          'push',
          pushRemote,
          `refs/heads/${targetBranch}:refs/heads/${targetBranch}`
        ])
        pushedAt = now
      } catch (error) {
        pushError = classifyRemoteFailure({
          error,
          operation: 'push',
          target,
          fallback: 'The target branch could not be pushed.',
          // Merge keeps its historical non-auth code for persisted records.
          nonAuthCode: 'INTERNAL'
        })
      }
    }
    this.deps.database.transaction(() => {
      this.deps.merges.markMerged(
        record.id,
        {
          resultOid,
          targetOidAfter: resultOid,
          reviewBaseOid,
          commitOid,
          pushRemote,
          pushedAt,
          pushError
        },
        now
      )
      this.deps.worktrees.updateBase(record.sessionId, targetBranch, reviewBaseOid, now)
    })
    this.deps.onChanged()
    const latest = this.deps.merges.latestForSession(record.sessionId) ?? record
    return { status: 'merged', record: latest }
  }

  private markConflicted(record: MergeRecord, files: readonly string[]): MergeOutcome {
    this.deps.merges.markConflicted(record.id, files, this.deps.now())
    this.deps.onChanged()
    const latest = this.deps.merges.latestForSession(record.sessionId) ?? record
    return { status: 'conflicted', record: latest }
  }

  private async targetMode(
    repositoryPath: string,
    targetBranch: string,
    target: ExecutionTarget
  ): Promise<TargetMode> {
    const worktrees = await this.deps.gitWorktrees.listWorktrees(repositoryPath, target)
    const entry = worktrees.find((candidate) => candidate.branch === targetBranch)
    if (!entry) return 'ref-update'
    const platform = target.kind === 'wsl' ? 'linux' : process.platform
    if (!samePathResolved(entry.path, repositoryPath, platform)) {
      throw fail('GIT_BRANCH_IN_USE', 'That target branch is checked out in another worktree.', {
        path: entry.path
      })
    }
    const git = await this.deps.gitWorktrees.gitFor(target)
    const branch = (await git(repositoryPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    if (branch !== targetBranch) return 'ref-update'
    const status = (await this.deps.gitWorktrees.statusPorcelain(repositoryPath, target)).trim()
    if (status.length > 0) {
      throw fail('WORKTREE_DIRTY', 'The primary checkout has uncommitted changes.')
    }
    return 'primary-checkout'
  }
}

async function conflictFiles(
  git: (cwd: string, args: string[], timeoutMs?: number) => Promise<string>,
  worktreePath: string
): Promise<string[]> {
  const output = await git(worktreePath, ['diff', '--name-only', '--diff-filter=U']).catch(
    () => ''
  )
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function toAppError(error: unknown): AppError {
  if (error instanceof SessionServiceError) return error.appError
  if (error !== null && typeof error === 'object' && 'appError' in error) {
    return (error as { appError: AppError }).appError
  }
  return makeAppError('INTERNAL', 'The merge failed.', {
    detail: error instanceof Error ? error.message : String(error)
  })
}

function fail(
  code: AppError['code'],
  message: string,
  context?: Record<string, string>
): SessionServiceError {
  return new SessionServiceError(makeAppError(code, message, context ? { context } : {}))
}
