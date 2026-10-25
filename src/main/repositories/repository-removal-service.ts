import { existsSync } from 'node:fs'
import type { RepositoryService } from './repository-service'
import type { SessionStore } from '../persistence/session-store'
import type { WorktreeStore } from '../persistence/worktree-store'
import type { GitWorktreeService } from '../worktrees/git-worktree-service'
import type { RepositoryStore } from '../persistence/repository-store'
import type { HostGateway } from '../sessions/host-gateway'
import type { AppError } from '../../shared/domain/errors'
import { makeAppError } from '../../shared/domain/errors'
import type { RepoId } from '../../shared/domain/ids'
import { parseRepoId } from '../../shared/domain/ids'
import type { RemoveRepositoryResult, SessionSummary } from '../../shared/schemas/ipc'
import type { HostSessionStatus } from '../../shared/domain/session'
import { HostRequestError } from '../host/host-client'
import { SessionServiceError, errorFromHost } from '../sessions/session-service'

const LIVE: ReadonlySet<HostSessionStatus> = new Set<HostSessionStatus>(['live', 'starting'])

export type RepositoryRemovalDeps = {
  repositories: RepositoryStore
  sessions: SessionStore
  repositoryService: RepositoryService
  host: HostGateway
  worktrees: WorktreeStore
  gitWorktrees: GitWorktreeService
  summarise: (repoId: RepoId) => Promise<SessionSummary[]>
}

/**
 * Repository removal must never silently discard live work. The database is not
 * allowed to answer that question; the host is, and an unreachable host blocks.
 */
export class RepositoryRemovalService {
  constructor(private readonly deps: RepositoryRemovalDeps) {}

  async remove(
    repoIdInput: string,
    options: { acknowledgeDependentSessions?: boolean } = {}
  ): Promise<RemoveRepositoryResult> {
    const repoId = parseRepoId(repoIdInput)
    if (!repoId) {
      throw new SessionServiceError(
        makeAppError('INVALID_ARGUMENT', 'Invalid repository ID.', {
          context: { repoId: repoIdInput }
        })
      )
    }

    const impact = this.deps.repositoryService.describeDeletion(repoId)
    if (!impact) {
      throw new SessionServiceError(
        makeAppError('INVALID_ARGUMENT', 'Repository is not registered.', {
          context: { repoId }
        })
      )
    }

    if (impact.sessions.length === 0) {
      const outcome = this.deps.repositoryService.removeRepository(repoId, {
        acknowledgeDependentSessions: false
      })
      if (outcome.status !== 'deleted') {
        throw new SessionServiceError(
          makeAppError('INTERNAL', 'Repository removal did not complete.')
        )
      }
      return { status: 'removed' }
    }

    let hostSessions: Map<string, HostSessionStatus>
    try {
      // The repository's own host: a WSL repository's sessions live in its distro.
      const repository = this.deps.repositories.findById(repoId)
      const list = await this.deps.host.listSessions(repository?.executionTarget)
      hostSessions = new Map(list.sessions.map((entry) => [entry.sessionId, entry.status]))
    } catch (error) {
      return {
        status: 'host_unavailable',
        error: this.hostUnavailable(error)
      }
    }

    const summaries = await this.deps.summarise(repoId)
    const live = summaries.filter((session) => {
      const status = hostSessions.get(session.id)
      return status !== undefined && LIVE.has(status)
    })
    if (live.length > 0) {
      return { status: 'blocked_live_sessions', sessions: live }
    }

    // Each worktree is evaluated on its own. A single dirty, unmerged, missing
    // or unverifiable checkout blocks the whole removal: repository deletion
    // must never cascade through protected work.
    const blockers: Array<{
      session: SessionSummary
      blocker: {
        kind: 'dirty' | 'unmerged' | 'missing' | 'inconsistent'
        files?: string[]
        commits?: number
        detail?: string
      }
    }> = []
    const removable: Array<{ path: string; branch: string }> = []
    for (const session of summaries) {
      const record = this.deps.worktrees.findBySession(session.id)
      if (!record) continue
      const inspection = await this.deps.gitWorktrees
        .inspect({ primaryRoot: impact.repository.path, path: record.path, branch: record.branch })
        .catch(() => null)
      if (inspection === null) {
        blockers.push({ session, blocker: { kind: 'inconsistent', detail: 'The worktree could not be inspected.' } })
      } else if (!inspection.pathExists) {
        const branchExists =
          record.state === 'failed'
            ? await this.deps.gitWorktrees.branchExists(impact.repository.path, record.branch).catch(() => true)
            : true
        if (branchExists) {
          blockers.push({ session, blocker: { kind: 'missing', detail: record.path } })
        }
      } else if (!inspection.registered) {
        blockers.push({
          session,
          blocker: { kind: 'inconsistent', detail: 'The worktree directory is not registered with Git.' }
        })
      } else if (inspection.dirtyFiles.length > 0) {
        blockers.push({
          session,
          blocker: { kind: 'dirty', files: inspection.dirtyFiles.slice(0, 200) }
        })
      } else if (inspection.unmergedCommits === null) {
        blockers.push({
          session,
          blocker: { kind: 'inconsistent', detail: 'Unmerged commits could not be verified.' }
        })
      } else if (inspection.unmergedCommits > 0) {
        blockers.push({ session, blocker: { kind: 'unmerged', commits: inspection.unmergedCommits } })
      } else {
        removable.push({ path: record.path, branch: record.branch })
      }
    }
    if (blockers.length > 0) {
      return { status: 'blocked_worktree_changes', blockers }
    }

    // Unknown-to-host or terminal sessions are not live. They are still durable
    // records, so deleting them requires explicit acknowledgement.
    if (options.acknowledgeDependentSessions !== true) {
      return { status: 'confirmation_required', sessions: summaries }
    }

    // Branches are retained: removal deletes the checkout only.
    for (const worktree of removable) {
      if (!existsSync(worktree.path)) continue
      await this.deps.gitWorktrees.remove({
        primaryRoot: impact.repository.path,
        path: worktree.path,
        force: false
      })
    }

    const outcome = this.deps.repositoryService.removeRepository(repoId, {
      acknowledgeDependentSessions: true
    })
    if (outcome.status !== 'deleted') {
      throw new SessionServiceError(
        makeAppError('INTERNAL', 'Repository removal did not complete.')
      )
    }
    return { status: 'removed' }
  }

  private hostUnavailable(error: unknown): AppError {
    if (error instanceof SessionServiceError) return error.appError
    if (error instanceof HostRequestError) {
      return errorFromHost(error, 'The terminal host is not reachable.')
    }
    return makeAppError('HOST_UNREACHABLE', 'The terminal host is not reachable.', {
      detail: error instanceof Error ? error.message : String(error)
    })
  }
}
