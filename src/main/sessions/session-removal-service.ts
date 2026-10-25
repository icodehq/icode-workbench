import type { Database } from '../persistence/database'
import type { SessionStore } from '../persistence/session-store'
import type { RepositoryStore } from '../persistence/repository-store'
import type { WorktreeStore } from '../persistence/worktree-store'
import type { GitWorktreeService } from '../worktrees/git-worktree-service'
import type { HostGateway } from './host-gateway'
import type {
  DiscardSessionResult,
  OwnedBranchSummary,
  RemoveBranchResult,
  RemoveSessionResult,
  SessionSummary,
  WorktreeBlocker
} from '../../shared/schemas/ipc'
import { parseRepoId, parseSessionId, type RepoId } from '../../shared/domain/ids'
import type { ExecutionTarget } from '../../shared/domain/repository'
import type { StoredSession } from '../persistence/rows'
import { makeAppError } from '../../shared/domain/errors'
import { SessionServiceError, errorFromHost } from './session-errors'
import { hostTargetFor } from '../wsl/terminal/path-a'

export type SessionRemovalDeps = {
  database: Database
  sessions: SessionStore
  repositories: RepositoryStore
  worktrees: WorktreeStore
  gitWorktrees: GitWorktreeService
  host: HostGateway
  summarise: (sessionId: string) => Promise<SessionSummary>
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

  async remove(sessionId: string): Promise<RemoveSessionResult> {
    const row = this.requireSession(sessionId)
    const summary = await this.deps.summarise(sessionId)
    const liveness = await this.liveness(sessionId, this.targetForSession(row))
    if (!liveness.ok) return { status: 'host_unavailable', error: liveness.error }
    if (liveness.live) return { status: 'blocked_live_sessions', session: summary }

    const record = this.deps.worktrees.findBySession(sessionId)
    if (record !== null) {
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
        repository.executionTarget
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
    }

    this.deps.database.transaction(() => {
      if (record !== null) this.deps.worktrees.deleteBySession(sessionId)
      this.deps.sessions.delete(row.id)
    })

    return {
      status: 'removed',
      branch: record?.branch ?? null,
      // A retained branch is the default; branch deletion is a separate action.
      branchRetained: record !== null
    }
  }

  async discard(sessionId: string, confirmBranch: string): Promise<DiscardSessionResult> {
    this.requireSession(sessionId)
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
    const liveness = await this.liveness(sessionId, this.targetForSession(this.requireSession(sessionId)))
    if (!liveness.ok) return { status: 'host_unavailable', error: liveness.error }
    if (liveness.live) return { status: 'blocked_live_sessions', session: summary }

    const owned = this.deps.worktrees.findBranch(record.branch)
    if (!owned || owned.sessionId !== sessionId) {
      throw new SessionServiceError(
        makeAppError('BRANCH_NOT_OWNED', 'That branch is not owned by this session.', {
          context: { sessionId, branch: record.branch }
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
    this.deps.database.transaction(() => {
      this.deps.worktrees.deleteBySession(sessionId)
      this.deps.sessions.delete(this.requireSession(sessionId).id)
    })
    return {
      status: 'discarded',
      branch: record.branch,
      files: inspection.dirtyFiles.slice(0, 200),
      commits: inspection.unmergedCommits ?? 0,
      branchRetained: true
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
        sessionId: branch.sessionId,
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
    target: ExecutionTarget
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
      return { kind: 'dirty', files: inspection.dirtyFiles.slice(0, 200) }
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
