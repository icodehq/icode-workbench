import type { Database } from '../persistence/database'
import type { SessionStore } from '../persistence/session-store'
import type { RepositoryStore } from '../persistence/repository-store'
import type { WorktreeStore } from '../persistence/worktree-store'
import type { GitWorktreeService } from '../worktrees/git-worktree-service'
import type { HostGateway } from './host-gateway'
import type {
  DiscardSessionResult,
  DiscardWorktreeResult,
  OwnedBranchSummary,
  RemoveBranchResult,
  RemoveSessionResult,
  RemoveWorktreeResult,
  SessionSummary,
  WorktreeBlocker
} from '../../shared/schemas/ipc'
import {
  parseRepoId,
  parseSessionId,
  parseWorktreeId,
  type RepoId,
  type SessionId,
  type WorktreeId
} from '../../shared/domain/ids'
import type { ExecutionTarget } from '../../shared/domain/repository'
import type { StoredSession } from '../persistence/rows'
import type { AppError } from '../../shared/domain/errors'
import { makeAppError } from '../../shared/domain/errors'
import type { SessionWorktreeRecord, WorktreeRecord } from '../../shared/domain/worktree'
import { samePathResolved } from '../worktrees/worktree-status'
import { SessionServiceError, errorFromHost } from './session-errors'
import { hostTargetFor } from '../wsl/terminal/path-a'
import type { WorkspaceTrustService } from '../harness/trust/workspace-trust'

export type SessionRemovalOptions = {
  stopIfLive?: boolean
  /**
   * Delete the session's owned branch once its checkout is gone.
   *
   * Only meaningful for a session that solely owns its worktree. Removal
   * re-verifies readiness before stopping the PTY, and branch deletion is
   * attempted only after the checkout has been removed.
   */
  deleteBranch?: boolean
}

export type WorktreeRemovalOptions = {
  /** Delete the worktree's owned branch once its checkout is gone. */
  deleteBranch?: boolean
}

export type SessionRemovalDeps = {
  database: Database
  sessions: SessionStore
  repositories: RepositoryStore
  worktrees: WorktreeStore
  gitWorktrees: GitWorktreeService
  host: HostGateway
  workspaceTrust?: Pick<WorkspaceTrustService, 'remove'>
  summarise: (sessionId: string) => Promise<SessionSummary>
  /** Active tasks that still share a chain branch; deleting it would strand them. */
  activeTasksOnChain?: (repoId: RepoId, branch: string) => number
  /** Active tasks still running in this checkout; removing it would strand them. */
  activeTasksInWorktree?: (worktreePath: string) => number
}

type Liveness = { ok: true; live: boolean } | { ok: false; error: ReturnType<typeof errorFromHost> }

/**
 * Destructive session and worktree operations.
 *
 * Every call re-reads Host liveness, Git registration, path identity, branch
 * ownership and working-tree status. If any of them cannot be verified the
 * operation fails closed: nothing is deleted, pruned, or deregistered.
 */
export class SessionRemovalService {
  constructor(private readonly deps: SessionRemovalDeps) {}

  /**
   * The original repository's execution target.
   *
   * Cleanup must run where the checkout lives. Resolving it from the persisted
   * worktree row's repository — not from a path string — is what keeps a guest
   * path out of local Git and out of `node:fs`.
   */
  /**
   * The host that owns a session's PTY, from persisted rows only.
   *
   * A **Path A** terminal (shell harness on a WSL repository) runs on the desktop
   * Host. Asking the distro's managed Host about it reported a live terminal as
   * gone, which let removal delete the row and orphan the `wsl.exe` behind it.
   */
  private targetForSession(row: StoredSession): ExecutionTarget {
    const workspace = this.deps.repositories.findWorkspaceById(row.workspaceId)
    const repository = workspace === null ? null : this.deps.repositories.findById(workspace.repoId)
    if (!repository) {
      throw new SessionServiceError(
        makeAppError('DB_CORRUPT', 'Session repository is missing.', {
          context: { sessionId: row.id }
        })
      )
    }
    return hostTargetFor(row.harness, repository.executionTarget)
  }

  private targetFor(repoId: string): ExecutionTarget {
    const repository = this.deps.repositories.findById(repoId as RepoId)
    if (!repository) {
      throw new SessionServiceError(
        makeAppError('DB_CORRUPT', 'Session repository is missing.', {
          context: { repoId }
        })
      )
    }
    return repository.executionTarget
  }

  async remove(
    sessionId: string,
    options: SessionRemovalOptions = {}
  ): Promise<RemoveSessionResult> {
    const row = this.requireSession(sessionId)
    const target = this.targetForSession(row)
    const liveness = await this.liveness(sessionId, target)
    if (!liveness.ok) return { status: 'host_unavailable', error: liveness.error }
    if (liveness.live && options.stopIfLive !== true) {
      return { status: 'blocked_live_sessions', session: await this.deps.summarise(sessionId) }
    }
    const record = this.deps.worktrees.findBySession(sessionId)
    const deleteBranch = options.deleteBranch === true
    if (deleteBranch) {
      /*
       * Branch deletion is a second destructive act. Verify it before the PTY
       * is stopped or any Git command runs, so a refusal leaves everything —
       * including a live terminal — untouched.
       */
      if (record === null) {
        throw new SessionServiceError(
          makeAppError('INVALID_ARGUMENT', 'This session has no isolated worktree branch to delete.', {
            context: { sessionId }
          })
        )
      }
      await this.assertBranchDeletable(record)
    }
    if (liveness.live) await this.stopForRemoval(sessionId, target)
    // Build the summary only after any stop: the cleanup decision must describe
    // the process as it is now, not the stale live state. This also avoids a
    // second full Host/Git reconciliation on the normal stop-and-remove path.
    const summary = await this.deps.summarise(sessionId)

    if (record !== null) {
      /*
       * A shared checkout is not this session's to remove. Detach only: the
       * other sessions keep running in the same directory, on the same branch,
       * and no Git worktree command is issued. `assertBranchDeletable` has
       * already refused a requested branch deletion in this case.
       */
      if (this.deps.worktrees.sessionCountForWorktree(record.id) > 1) {
        this.deps.database.transaction(() => {
          this.deps.worktrees.unlinkSession(sessionId)
          this.deps.sessions.delete(row.id)
        })
        return { status: 'removed', branch: null, branchRetained: true }
      }
      const repository = this.deps.repositories.findById(record.repoId)
      if (!repository) {
        return {
          status: 'blocked_worktree',
          session: summary,
          blocker: { kind: 'inconsistent', detail: 'The session repository is no longer registered.' }
        }
      }
      const blocker = await this.worktreeBlocker(
        record.path,
        record.branch,
        repository.path,
        record.state,
        repository.executionTarget,
        deleteBranch
      )
      if (blocker !== null) {
        return { status: 'blocked_worktree', session: summary, blocker }
      }
      const target = this.targetFor(record.repoId)
      try {
        const hostFs = await this.deps.gitWorktrees.hostFsFor(target)
        if (await hostFs.exists(record.path)) {
          await this.deps.gitWorktrees.remove({
            primaryRoot: repository.path,
            path: record.path,
            force: false,
            target
          })
        }
      } catch (error) {
        return {
          status: 'blocked_worktree',
          session: summary,
          blocker: {
            kind: 'dirty',
            detail: error instanceof SessionServiceError ? error.appError.message : String(error)
          }
        }
      }
      await this.deps.workspaceTrust
        ?.remove({
          harness: row.harness,
          target: repository.executionTarget,
          worktreePath: record.path
        })
        .catch(() => undefined)
    }

    const deleted = deleteBranch && record !== null ? await this.deleteOwnedBranch(record) : null
    const branchDeleted = deleted?.branchDeleted === true

    this.deps.database.transaction(() => {
      if (record !== null) {
        this.deps.worktrees.unlinkSession(sessionId)
        // Last session out: the checkout goes with it, as it did before shared
        // worktrees existed. A retained branch still guards the work.
        this.deps.worktrees.deleteWorktree(record.id)
        if (branchDeleted) this.deps.worktrees.deleteBranch(record.branch)
      }
      this.deps.sessions.delete(row.id)
    })

    return {
      status: 'removed',
      branch: record?.branch ?? null,
      // A retained branch is the default; branch deletion needs the opt-in.
      branchRetained: record !== null && !branchDeleted,
      ...(deleted?.branchDeleteError !== undefined
        ? { branchDeleteError: deleted.branchDeleteError }
        : {})
    }
  }

  async discard(
    sessionId: string,
    confirmBranch: string,
    options: { deleteBranch?: boolean } = {}
  ): Promise<DiscardSessionResult> {
    const row = this.requireSession(sessionId)
    const summary = await this.deps.summarise(sessionId)
    const record = this.deps.worktrees.findBySession(sessionId)
    if (!record) {
      throw new SessionServiceError(
        makeAppError('INVALID_ARGUMENT', 'This session has no isolated worktree to discard.', {
          context: { sessionId }
        })
      )
    }
    if (confirmBranch !== record.branch) {
      throw new SessionServiceError(
        makeAppError('INVALID_ARGUMENT', 'Type the exact branch name to confirm discard.', {
          context: { sessionId, branch: record.branch }
        })
      )
    }
    /*
     * Discard is a destructive worktree action, so it is only permitted when
     * this session is the checkout's sole user. A shared checkout can still be
     * removed deliberately after its other sessions are gone.
     */
    if (this.deps.worktrees.sessionCountForWorktree(record.id) > 1) {
      throw new SessionServiceError(
        makeAppError(
          'INVALID_ARGUMENT',
          'Another session is still using this worktree, so it was not discarded.',
          { context: { sessionId, worktreeId: record.id, branch: record.branch } }
        )
      )
    }
    const liveness = await this.liveness(sessionId, this.targetForSession(this.requireSession(sessionId)))
    if (!liveness.ok) return { status: 'host_unavailable', error: liveness.error }
    if (liveness.live) return { status: 'blocked_live_sessions', session: summary }

    const deleteBranch = options.deleteBranch === true
    if (deleteBranch) await this.assertBranchDeletable(record)

    const owned = this.deps.worktrees.findBranch(record.branch)
    if (!owned || owned.worktreeId !== record.id) {
      throw new SessionServiceError(
        makeAppError('BRANCH_NOT_OWNED', 'That branch is not owned by this worktree.', {
          context: { sessionId, worktreeId: record.id, branch: record.branch }
        })
      )
    }
    const repository = this.deps.repositories.findById(record.repoId)
    if (!repository) {
      return {
        status: 'blocked_worktree',
        session: summary,
        blocker: { kind: 'inconsistent', detail: 'The session repository is no longer registered.' }
      }
    }
    const discardTarget = repository.executionTarget
    const inspection = await this.deps.gitWorktrees.inspect({
      primaryRoot: repository.path,
      path: record.path,
      branch: record.branch,
      target: discardTarget
    })
    // Missing or unregistered worktrees are never implicitly pruned, even by
    // discard: the directory may hold work that must be recovered first.
    if (!inspection.pathExists) {
      return {
        status: 'blocked_worktree',
        session: summary,
        blocker: { kind: 'missing', detail: record.path }
      }
    }
    if (!inspection.registered) {
      return {
        status: 'blocked_worktree',
        session: summary,
        blocker: { kind: 'inconsistent', detail: 'The worktree directory is not registered with Git.' }
      }
    }
    try {
      await this.deps.gitWorktrees.remove({
        primaryRoot: repository.path,
        path: record.path,
        force: true,
        target: discardTarget
      })
    } catch (error) {
      throw new SessionServiceError(
        makeAppError('WORKTREE_DIRTY', 'The worktree could not be discarded.', {
          detail: error instanceof Error ? error.message : String(error)
        })
      )
    }
    await this.deps.workspaceTrust
      ?.remove({
        harness: row.harness,
        target: discardTarget,
        worktreePath: record.path
      })
      .catch(() => undefined)
    const deleted = deleteBranch ? await this.deleteOwnedBranch(record) : null
    const branchDeleted = deleted?.branchDeleted === true
    this.deps.database.transaction(() => {
      this.deps.worktrees.unlinkSession(sessionId)
      this.deps.worktrees.deleteWorktree(record.id)
      if (branchDeleted) this.deps.worktrees.deleteBranch(record.branch)
      this.deps.sessions.delete(this.requireSession(sessionId).id)
    })
    return {
      status: 'discarded',
      branch: record.branch,
      files: inspection.dirtyFiles.slice(0, 200),
      commits: inspection.unmergedCommits ?? 0,
      branchRetained: !branchDeleted,
      ...(deleted?.branchDeleteError !== undefined
        ? { branchDeleteError: deleted.branchDeleteError }
        : {})
    }
  }

  /**
   * Removes a checkout with every session attached to it.
   *
   * This is the worktree-first counterpart to `remove`: the checkout is the
   * unit the user picked, so live sessions are stopped rather than blocking the
   * action. The same fail-closed Git checks apply — a dirty, unmerged, missing
   * or inconsistent checkout returns a blocker and nothing is deleted.
   */
  async removeWorktree(
    worktreeIdInput: string,
    options: WorktreeRemovalOptions = {}
  ): Promise<RemoveWorktreeResult> {
    const worktreeId = this.parseWorktreeId(worktreeIdInput)
    const record = this.requireWorktree(worktreeIdInput, worktreeId)
    const repository = this.requireRepository(record)
    const sessionIds = this.deps.worktrees.sessionIdsForWorktree(worktreeId)
    this.assertNoActiveTaskInWorktree(record.path)
    const deleteBranch = options.deleteBranch === true
    if (deleteBranch) await this.assertWorktreeBranchDeletable(record)
    const hostFailure = await this.stopSessionsForWorktreeRemoval(sessionIds)
    if (hostFailure !== null) return hostFailure
    const blocker = await this.worktreeBlocker(
      record.path,
      record.branch,
      repository.path,
      record.state,
      repository.executionTarget,
      deleteBranch
    )
    if (blocker !== null) return { status: 'blocked_worktree', sessionIds, blocker }
    const removalBlocker = await this.removeCheckout(record, repository)
    if (removalBlocker !== null) {
      return { status: 'blocked_worktree', sessionIds, blocker: removalBlocker }
    }
    await this.removeWorkspaceTrustForSessions(sessionIds, record.path)
    const deleted = deleteBranch ? await this.deleteOwnedBranch(record) : null
    const branchDeleted = deleted?.branchDeleted === true
    this.deps.database.transaction(() => {
      for (const sessionId of sessionIds) {
        this.deps.worktrees.unlinkSession(sessionId)
        this.deps.sessions.delete(sessionId)
      }
      this.deps.worktrees.deleteWorktree(record.id)
      if (branchDeleted) this.deps.worktrees.deleteBranch(record.branch)
    })
    return {
      status: 'removed',
      sessionIds,
      branch: record.branch,
      branchRetained: !branchDeleted,
      ...(deleted?.branchDeleteError !== undefined
        ? { branchDeleteError: deleted.branchDeleteError }
        : {})
    }
  }

  /**
   * Destructive worktree removal for a checkout that cannot pass the ordinary
   * checks. The exact branch name is the guard; uncommitted files are lost.
   */
  async discardWorktree(
    worktreeIdInput: string,
    confirmBranch: string,
    options: WorktreeRemovalOptions = {}
  ): Promise<DiscardWorktreeResult> {
    const worktreeId = this.parseWorktreeId(worktreeIdInput)
    const record = this.requireWorktree(worktreeIdInput, worktreeId)
    const repository = this.requireRepository(record)
    if (confirmBranch !== record.branch) {
      throw new SessionServiceError(
        makeAppError('INVALID_ARGUMENT', 'Type the exact branch name to confirm discard.', {
          context: { worktreeId: record.id, branch: record.branch }
        })
      )
    }
    const sessionIds = this.deps.worktrees.sessionIdsForWorktree(worktreeId)
    this.assertNoActiveTaskInWorktree(record.path)
    const deleteBranch = options.deleteBranch === true
    if (deleteBranch) await this.assertWorktreeBranchDeletable(record)
    const hostFailure = await this.stopSessionsForWorktreeRemoval(sessionIds)
    if (hostFailure !== null) return hostFailure
    const inspection = await this.deps.gitWorktrees
      .inspect({
        primaryRoot: repository.path,
        path: record.path,
        branch: record.branch,
        target: repository.executionTarget
      })
      .catch(() => null)
    if (inspection === null) {
      return {
        status: 'blocked_worktree',
        sessionIds,
        blocker: { kind: 'inconsistent', detail: 'The worktree could not be inspected.' }
      }
    }
    if (!inspection.pathExists) {
      return {
        status: 'blocked_worktree',
        sessionIds,
        blocker: { kind: 'missing', detail: record.path }
      }
    }
    if (!inspection.registered) {
      return {
        status: 'blocked_worktree',
        sessionIds,
        blocker: {
          kind: 'inconsistent',
          detail: 'The worktree directory is not registered with Git.'
        }
      }
    }
    try {
      await this.deps.gitWorktrees.remove({
        primaryRoot: repository.path,
        path: record.path,
        force: true,
        target: repository.executionTarget
      })
    } catch (error) {
      throw new SessionServiceError(
        makeAppError('WORKTREE_DIRTY', 'The worktree could not be discarded.', {
          detail: error instanceof Error ? error.message : String(error)
        })
      )
    }
    await this.removeWorkspaceTrustForSessions(sessionIds, record.path)
    const deleted = deleteBranch ? await this.deleteOwnedBranch(record) : null
    const branchDeleted = deleted?.branchDeleted === true
    this.deps.database.transaction(() => {
      for (const sessionId of sessionIds) {
        this.deps.worktrees.unlinkSession(sessionId)
        this.deps.sessions.delete(sessionId)
      }
      this.deps.worktrees.deleteWorktree(record.id)
      if (branchDeleted) this.deps.worktrees.deleteBranch(record.branch)
    })
    return {
      status: 'discarded',
      sessionIds,
      branch: record.branch,
      files: inspection.dirtyFiles.slice(0, 200),
      commits: inspection.unmergedCommits ?? 0,
      branchRetained: !branchDeleted,
      ...(deleted?.branchDeleteError !== undefined
        ? { branchDeleteError: deleted.branchDeleteError }
        : {})
    }
  }

  private parseWorktreeId(value: string): WorktreeId {
    const parsed = parseWorktreeId(value)
    if (!parsed) {
      throw new SessionServiceError(
        makeAppError('INVALID_ARGUMENT', 'Invalid worktree ID.', { context: { worktreeId: value } })
      )
    }
    return parsed
  }

  private requireWorktree(value: string, worktreeId: WorktreeId): WorktreeRecord {
    const record = this.deps.worktrees.findById(worktreeId)
    if (!record) {
      throw new SessionServiceError(
        makeAppError('INVALID_ARGUMENT', 'That worktree is not registered.', {
          context: { worktreeId: value }
        })
      )
    }
    return record
  }

  private requireRepository(record: WorktreeRecord): {
    path: string
    executionTarget: ExecutionTarget
  } {
    const repository = this.deps.repositories.findById(record.repoId)
    if (!repository) {
      throw new SessionServiceError(
        makeAppError('DB_CORRUPT', 'The worktree repository is missing.', {
          context: { repoId: record.repoId }
        })
      )
    }
    return repository
  }

  private assertNoActiveTaskInWorktree(worktreePath: string): void {
    const activeTasks = this.deps.activeTasksInWorktree?.(worktreePath) ?? 0
    if (activeTasks > 0) {
      throw new SessionServiceError(
        makeAppError('GIT_BRANCH_IN_USE', 'Tasks are still using this worktree.', {
          detail: `Finish or cancel ${String(activeTasks)} active task(s) before removing it.`,
          context: { worktreePath }
        })
      )
    }
  }

  /**
   * Stops every live session that shares the checkout. Returns a
   * `host_unavailable` result instead of throwing so the caller can answer
   * before any Git command runs.
   */
  private async stopSessionsForWorktreeRemoval(
    sessionIds: readonly SessionId[]
  ): Promise<{ status: 'host_unavailable'; error: AppError } | null> {
    for (const sessionId of sessionIds) {
      const row = this.deps.sessions.findById(sessionId)
      if (!row) continue
      const target = this.targetForSession(row)
      const liveness = await this.liveness(sessionId, target)
      if (!liveness.ok) return { status: 'host_unavailable', error: liveness.error }
      if (liveness.live) await this.stopForRemoval(sessionId, target)
    }
    return null
  }

  /** Removes the checkout itself; a Git refusal is reported as a dirty blocker. */
  private async removeCheckout(
    record: WorktreeRecord,
    repository: { path: string; executionTarget: ExecutionTarget }
  ): Promise<WorktreeBlocker | null> {
    try {
      const hostFs = await this.deps.gitWorktrees.hostFsFor(repository.executionTarget)
      if (await hostFs.exists(record.path)) {
        await this.deps.gitWorktrees.remove({
          primaryRoot: repository.path,
          path: record.path,
          force: false,
          target: repository.executionTarget
        })
      }
      return null
    } catch (error) {
      return {
        kind: 'dirty',
        detail: error instanceof SessionServiceError ? error.appError.message : String(error)
      }
    }
  }

  private async removeWorkspaceTrustForSessions(
    sessionIds: readonly SessionId[],
    worktreePath: string
  ): Promise<void> {
    for (const sessionId of sessionIds) {
      const row = this.deps.sessions.findById(sessionId)
      if (!row) continue
      await this.deps.workspaceTrust
        ?.remove({
          harness: row.harness,
          target: this.targetForSession(row),
          worktreePath
        })
        .catch(() => undefined)
    }
  }

  /**
   * Branch deletion for a whole-worktree removal.
   *
   * Unlike the session-level guard, sharing the checkout with other sessions is
   * not a refusal: every session attached to it leaves in the same operation.
   */
  private async assertWorktreeBranchDeletable(record: WorktreeRecord): Promise<void> {
    const owned = this.deps.worktrees.findBranch(record.branch)
    if (!owned || owned.worktreeId !== record.id) {
      throw new SessionServiceError(
        makeAppError('BRANCH_NOT_OWNED', 'That branch is not owned by this worktree.', {
          context: { worktreeId: record.id, branch: record.branch }
        })
      )
    }
    const activeTasks = this.deps.activeTasksOnChain?.(record.repoId, record.branch) ?? 0
    if (activeTasks > 0) {
      throw new SessionServiceError(
        makeAppError('GIT_BRANCH_IN_USE', 'This chain branch is still used by active tasks.', {
          detail: `Finish or cancel ${String(activeTasks)} active task(s) on this chain before deleting the branch.`,
          context: { branch: record.branch }
        })
      )
    }
    const repository = this.deps.repositories.findById(record.repoId)
    if (!repository) {
      throw new SessionServiceError(
        makeAppError('DB_CORRUPT', 'The worktree repository is missing.', {
          context: { repoId: record.repoId }
        })
      )
    }
    const registered = await this.deps.gitWorktrees
      .listWorktrees(repository.path, repository.executionTarget)
      .catch(() => null)
    if (registered === null) {
      throw new SessionServiceError(
        makeAppError('INTERNAL', 'Git worktrees could not be inspected; nothing was deleted.')
      )
    }
    const inUse = registered.find(
      (entry) => entry.branch === record.branch && !samePathResolved(entry.path, record.path)
    )
    if (inUse) {
      throw new SessionServiceError(
        makeAppError('GIT_BRANCH_IN_USE', 'Another worktree still uses this branch.', {
          detail: `The branch is checked out at ${inUse.path}.`,
          context: { branch: record.branch, path: inUse.path }
        })
      )
    }
  }

  async listBranches(repoIdInput: string): Promise<OwnedBranchSummary[]> {
    const repoId = parseRepoId(repoIdInput)
    if (!repoId) {
      throw new SessionServiceError(makeAppError('INVALID_ARGUMENT', 'Invalid repository ID.'))
    }
    const repository = this.deps.repositories.findById(repoId)
    if (!repository) {
      throw new SessionServiceError(
        makeAppError('INVALID_ARGUMENT', 'Repository is not registered.', { context: { repoId } })
      )
    }
    const target = repository.executionTarget
    const registered = await this.deps.gitWorktrees
      .listWorktrees(repository.path, target)
      .catch(() => [])
    const owned = this.deps.worktrees.listBranches(repoId)
    const summaries: OwnedBranchSummary[] = []
    for (const branch of owned) {
      summaries.push({
        branch: branch.branch,
        repoId: branch.repoId,
        worktreeId: branch.worktreeId,
        sessionId: branch.sessionId,
        taskId: branch.taskId,
        kind: branch.kind,
        baseOid: branch.baseOid,
        createdAt: branch.createdAt,
        exists: await this.deps.gitWorktrees.branchExists(repository.path, branch.branch, target),
        unmergedCommits: await this.deps.gitWorktrees
          .countUnmerged(repository.path, branch.branch, target)
          .catch(() => null),
        worktreePath: registered.find((entry) => entry.branch === branch.branch)?.path ?? null
      })
    }
    return summaries
  }

  async removeBranch(
    repoIdInput: string,
    branch: string,
    confirmBranch?: string
  ): Promise<RemoveBranchResult> {
    const repoId = parseRepoId(repoIdInput)
    if (!repoId) {
      throw new SessionServiceError(makeAppError('INVALID_ARGUMENT', 'Invalid repository ID.'))
    }
    const repository = this.deps.repositories.findById(repoId)
    if (!repository) {
      throw new SessionServiceError(
        makeAppError('INVALID_ARGUMENT', 'Repository is not registered.', { context: { repoId } })
      )
    }
    const owned = this.deps.worktrees.findBranch(branch)
    if (!owned || owned.repoId !== repository.id) {
      return { status: 'not_owned', branch }
    }
    const activeTasks = this.deps.activeTasksOnChain?.(repoId, branch) ?? 0
    if (activeTasks > 0) {
      throw new SessionServiceError(
        makeAppError('GIT_BRANCH_IN_USE', 'This chain branch is still used by active tasks.', {
          detail: `Finish or cancel ${String(activeTasks)} active task(s) on this chain before deleting the branch.`,
          context: { branch }
        })
      )
    }
    const target = repository.executionTarget
    const registered = await this.deps.gitWorktrees
      .listWorktrees(repository.path, target)
      .catch(() => null)
    if (registered === null) {
      throw new SessionServiceError(
        makeAppError('INTERNAL', 'Git worktrees could not be inspected; nothing was deleted.')
      )
    }
    const inUse = registered.find((entry) => entry.branch === branch)
    if (inUse) {
      return { status: 'blocked_worktree', branch, path: inUse.path }
    }
    const commits = await this.deps.gitWorktrees
      .countUnmerged(repository.path, branch, target)
      .catch(() => null)
    if (commits === null) {
      throw new SessionServiceError(
        makeAppError('INTERNAL', 'Unmerged commits could not be verified; nothing was deleted.', {
          context: { branch }
        })
      )
    }
    if (commits > 0 && confirmBranch !== branch) {
      return { status: 'confirmation_required', branch, commits }
    }
    await this.deps.gitWorktrees.deleteBranch({
      target,
      primaryRoot: repository.path,
      branch,
      force: commits > 0
    })
    this.deps.worktrees.deleteBranch(branch)
    return { status: 'removed', branch }
  }

  /**
   * Fail-closed preflight for deleting a session's branch as part of removal.
   *
   * Runs before a live PTY is stopped and before any Git mutation. A branch is
   * not this session's to delete when another session shares the checkout, an
   * active task chain still starts from it, or another registered worktree has
   * it checked out (Git itself refuses to delete a checked-out branch).
   */
  private async assertBranchDeletable(record: SessionWorktreeRecord): Promise<void> {
    // Only branches iCode recorded for this checkout may be deleted.
    const owned = this.deps.worktrees.findBranch(record.branch)
    if (!owned || owned.worktreeId !== record.id) {
      throw new SessionServiceError(
        makeAppError('BRANCH_NOT_OWNED', 'That branch is not owned by this worktree.', {
          context: { worktreeId: record.id, branch: record.branch }
        })
      )
    }
    if (this.deps.worktrees.sessionCountForWorktree(record.id) > 1) {
      throw new SessionServiceError(
        makeAppError(
          'INVALID_ARGUMENT',
          'Another session still uses this checkout, so its branch was not deleted.',
          { context: { worktreeId: record.id, branch: record.branch } }
        )
      )
    }
    const repository = this.deps.repositories.findById(record.repoId)
    if (!repository) {
      throw new SessionServiceError(
        makeAppError('DB_CORRUPT', 'Session repository is missing.', {
          context: { repoId: record.repoId }
        })
      )
    }
    const activeTasks = this.deps.activeTasksOnChain?.(record.repoId, record.branch) ?? 0
    if (activeTasks > 0) {
      throw new SessionServiceError(
        makeAppError('GIT_BRANCH_IN_USE', 'This chain branch is still used by active tasks.', {
          detail: `Finish or cancel ${String(activeTasks)} active task(s) on this chain before deleting the branch.`,
          context: { branch: record.branch }
        })
      )
    }
    const registered = await this.deps.gitWorktrees
      .listWorktrees(repository.path, repository.executionTarget)
      .catch(() => null)
    if (registered === null) {
      throw new SessionServiceError(
        makeAppError('INTERNAL', 'Git worktrees could not be inspected; nothing was deleted.')
      )
    }
    const inUse = registered.find(
      (entry) => entry.branch === record.branch && !samePathResolved(entry.path, record.path)
    )
    if (inUse) {
      throw new SessionServiceError(
        makeAppError('GIT_BRANCH_IN_USE', 'Another worktree still uses this branch.', {
          detail: `The branch is checked out at ${inUse.path}.`,
          context: { branch: record.branch, path: inUse.path }
        })
      )
    }
  }

  /**
   * Deletes the owned branch after its checkout is gone.
   *
   * A failure is reported, not thrown: by now the checkout and session are
   * already being removed, so failing the whole call would leave a session row
   * pointing at a missing directory. The branch ownership row then stays with
   * the branch, so Project maintenance can finish the deletion later.
   */
  private async deleteOwnedBranch(
    record: Pick<SessionWorktreeRecord, 'repoId' | 'branch'>
  ): Promise<{ branchDeleted: boolean; branchDeleteError?: AppError }> {
    const repository = this.deps.repositories.findById(record.repoId)
    if (!repository) {
      return {
        branchDeleted: false,
        branchDeleteError: makeAppError(
          'DB_CORRUPT',
          'The session repository is no longer registered.',
          { context: { repoId: record.repoId } }
        )
      }
    }
    try {
      const exists = await this.deps.gitWorktrees.branchExists(
        repository.path,
        record.branch,
        repository.executionTarget
      )
      if (exists) {
        await this.deps.gitWorktrees.deleteBranch({
          target: repository.executionTarget,
          primaryRoot: repository.path,
          branch: record.branch,
          // The user explicitly opted in and the warning named the commits.
          force: true
        })
      }
      return { branchDeleted: true }
    } catch (error) {
      return {
        branchDeleted: false,
        branchDeleteError:
          error instanceof SessionServiceError
            ? error.appError
            : makeAppError('INTERNAL', 'The branch could not be deleted.', {
                detail: error instanceof Error ? error.message : String(error)
              })
      }
    }
  }

  private async worktreeBlocker(
    path: string,
    branch: string,
    primaryRoot: string,
    state: 'creating' | 'created' | 'ready' | 'failed',
    /**
     * The repository's execution target, which decides *where* to look.
     *
     * Without it every probe ran against this machine. For a WSL repository that
     * meant `statSync` on a guest path, which is always absent on Windows — so a
     * live, registered worktree was reported `missing` and the session could be
     * neither removed nor discarded. The lookups below must name the target; the
     * eventual deletion already did.
     */
    target: ExecutionTarget,
    /**
     * When the branch is being deleted too, an unverified commit count cannot
     * be reported to the user. Fail closed instead of hiding lost commits.
     */
    deleteBranch = false
  ): Promise<WorktreeBlocker | null> {
    const inspection = await this.deps.gitWorktrees
      .inspect({ primaryRoot, path, branch, target })
      .catch(() => null)
    if (inspection === null) {
      return { kind: 'inconsistent', detail: 'The worktree could not be inspected.' }
    }
    if (!inspection.pathExists) {
      // A failed creation that produced neither a directory nor a branch has
      // nothing to protect; refusing would strand the session row forever.
      if (state === 'failed') {
        const branchExists = await this.deps.gitWorktrees
          .branchExists(primaryRoot, branch, target)
          .catch(() => true)
        if (!branchExists) return null
      }
      return { kind: 'missing', detail: path }
    }
    if (!inspection.registered) {
      return { kind: 'inconsistent', detail: 'The worktree directory is not registered with Git.' }
    }
    if (inspection.dirtyFiles.length > 0) {
      /*
       * Removing the checkout already needs the dirty-file warning. With the
       * branch going too, the same dialog must also name commits that only the
       * branch keeps reachable.
       */
      if (deleteBranch && inspection.unmergedCommits === null) {
        return { kind: 'inconsistent', detail: 'Unmerged commits could not be verified.' }
      }
      return {
        kind: 'dirty',
        files: inspection.dirtyFiles.slice(0, 200),
        ...(deleteBranch && (inspection.unmergedCommits ?? 0) > 0
          ? { commits: inspection.unmergedCommits ?? 0 }
          : {})
      }
    }
    if (inspection.unmergedCommits === null) {
      return { kind: 'inconsistent', detail: 'Unmerged commits could not be verified.' }
    }
    if (inspection.unmergedCommits > 0) {
      return { kind: 'unmerged', commits: inspection.unmergedCommits }
    }
    return null
  }

  /**
   * Host liveness for one session, asked of the host that owns it.
   *
   * Without the target this always queried the local Host, so a WSL session read
   * as "not live" (or, worse, as a local process with the same id). Measured
   * during W7: removal refused with "could not verify" for a live guest session.
   */
  /**
   * Stops the PTY as part of Remove. This is deliberately not a separate user
   * concept: the user asked to remove the session, and the UI says it will stop
   * the process first. Every destructive worktree check still runs afterwards.
   */
  private async stopForRemoval(sessionId: string, target: ExecutionTarget): Promise<void> {
    try {
      await this.deps.host.kill(sessionId, target)
    } catch (error) {
      const appError = errorFromHost(error, 'The running session could not be stopped for removal.')
      if (appError.code !== 'SESSION_NOT_FOUND') throw new SessionServiceError(appError)
    }

    // The Host confirms exit asynchronously; under WSLg or a loaded machine a
    // kill can take several seconds to surface in listSessions.
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      try {
        const list = await this.deps.host.listSessions(target)
        const entry = list.sessions.find((item) => item.sessionId === sessionId)
        if (!entry || (entry.status !== 'live' && entry.status !== 'starting')) return
      } catch (error) {
        throw new SessionServiceError(
          errorFromHost(error, 'Could not confirm the session stopped for removal.')
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new SessionServiceError(
      makeAppError('INTERNAL', 'The running session did not stop in time.', {
        detail: 'Removal was refused so no worktree is deleted while its PTY still runs.',
        context: { sessionId }
      })
    )
  }

  private async liveness(sessionId: string, target: ExecutionTarget): Promise<Liveness> {
    try {
      const list = await this.deps.host.listSessions(target)
      const entry = list.sessions.find((item) => item.sessionId === sessionId)
      return {
        ok: true,
        live: entry !== undefined && (entry.status === 'live' || entry.status === 'starting')
      }
    } catch (error) {
      return { ok: false, error: errorFromHost(error, 'Could not verify whether the session is live.') }
    }
  }

  private requireSession(sessionId: string): StoredSession {
    const parsed = parseSessionId(sessionId)
    if (!parsed) {
      throw new SessionServiceError(
        makeAppError('INVALID_ARGUMENT', 'Invalid session ID.', { context: { sessionId } })
      )
    }
    const row = this.deps.sessions.findById(parsed)
    if (!row) {
      throw new SessionServiceError(
        makeAppError('SESSION_NOT_FOUND', 'Session is not registered.', { context: { sessionId } })
      )
    }
    return row
  }
}
