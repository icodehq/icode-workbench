import { statSync } from 'node:fs'
import { basename } from 'node:path'
import { DatabaseError, type Database } from '../persistence/database'
import type { RepositoryStore, RepositoryWithWorkspace } from '../persistence/repository-store'
import type { SessionStore, DeletionSessionSummary } from '../persistence/session-store'
import type { UiStateStore } from '../persistence/ui-state-store'
import { makeAppError } from '../../shared/domain/errors'
import { newRepoId, newWorkspaceId, parseRepoId, type RepoId } from '../../shared/domain/ids'
import { toCanonicalRepositoryPath } from '../../shared/domain/paths'
import type { RepositoryRecord, WorkspaceRecord } from '../../shared/domain/repository'

export type RepositoryServiceDeps = {
  database: Database
  repositories: RepositoryStore
  sessions: SessionStore
  uiState: UiStateStore
  resolveRoot: (path: string) => Promise<{
    root: string
    currentBranch: string | null
    commonDir?: string
    registeredVia?: string | null
  }>
  now: () => number
  pathStatus: (path: string) => 'present' | 'missing'
}

export type AddRepositoryOutcome = {
  repository: RepositoryRecord
  created: boolean
  /** Set when a linked worktree path resolved to an already-registered repository. */
  registeredViaLinkedWorktree: string | null
}

export type DeletionImpact = {
  repository: RepositoryRecord
  workspace: WorkspaceRecord | null
  sessions: DeletionSessionSummary[]
  /** Persistence cannot decide safety: Work 5 must check host liveness. */
  requiresHostLivenessCheck: true
}

export type DeletionOutcome =
  | { status: 'deleted'; repoId: RepoId; deletedSessions: number }
  | { status: 'not_found'; repoId: RepoId }
  | { status: 'confirmation_required'; impact: DeletionImpact }

export function defaultPathStatus(path: string): 'present' | 'missing' {
  try {
    return statSync(path).isDirectory() ? 'present' : 'missing'
  } catch {
    return 'missing'
  }
}

function displayNameFor(root: string): string {
  const name = basename(root).trim()
  return name.length > 0 ? name : root
}

export class RepositoryService {
  constructor(private readonly deps: RepositoryServiceDeps) {}

  /**
   * Registration accepts a path, but only the resolver may canonicalize it.
   * An already-registered canonical path returns the existing record.
   */
  async addRepository(inputPath: string): Promise<AddRepositoryOutcome> {
    const resolved = await this.deps.resolveRoot(inputPath)
    const root = toCanonicalRepositoryPath(resolved.root)
    const commonDir = resolved.commonDir ?? null
    // Why: a linked worktree resolves to the same common Git dir as its primary
    // checkout. Registering it must not create a second repository record.
    const existing =
      this.deps.repositories.findByPath(root) ??
      (commonDir === null ? null : this.deps.repositories.findByCommonDir(commonDir))
    if (existing) {
      this.ensureWorkspace(existing)
      if (commonDir !== null && existing.gitCommonDir !== commonDir) {
        this.deps.repositories.updateCommonDir(existing.id, commonDir)
      }
      return {
        repository: existing,
        created: false,
        registeredViaLinkedWorktree: resolved.registeredVia ?? null
      }
    }

    const now = this.deps.now()
    const repository: RepositoryRecord = {
      id: newRepoId(),
      path: root,
      displayName: displayNameFor(root),
      addedAt: now,
      lastOpenedAt: now,
      currentBranch: resolved.currentBranch,
      availability: this.deps.pathStatus(root),
      gitCommonDir: commonDir
    }
    const workspace: WorkspaceRecord = {
      id: newWorkspaceId(),
      repoId: repository.id,
      path: root,
      kind: 'primary-checkout',
      createdAt: now
    }

    this.deps.database.transaction(() => {
      this.deps.repositories.insert(repository)
      this.deps.repositories.insertWorkspace(workspace)
    })

    this.deps.uiState.setActiveRepository(repository.id)
    return {
      repository,
      created: true,
      registeredViaLinkedWorktree: resolved.registeredVia ?? null
    }
  }

  listRepositories(options: { refreshPaths?: boolean } = {}): RepositoryWithWorkspace[] {
    const repositories = this.deps.repositories.list()
    if (options.refreshPaths === false) {
      return repositories.map((repository) => this.attachWorkspace(repository))
    }
    const changed = repositories.filter((repository) => {
      const next = this.deps.pathStatus(repository.path)
      return next !== repository.availability
    })
    if (changed.length > 0) {
      this.deps.database.transaction(() => {
        for (const repository of changed) {
          this.deps.repositories.updateAvailability(
            repository.id,
            this.deps.pathStatus(repository.path)
          )
        }
      })
    }
    return this.deps.repositories.list().map((repository) => this.attachWorkspace(repository))
  }

  getRepository(id: string): RepositoryWithWorkspace | null {
    const repoId = parseRepoId(id)
    if (!repoId) return null
    const repository = this.deps.repositories.findById(repoId)
    return repository ? this.attachWorkspace(repository) : null
  }

  refreshAvailability(id: string): RepositoryRecord | null {
    const repoId = parseRepoId(id)
    if (!repoId) return null
    const repository = this.deps.repositories.findById(repoId)
    if (!repository) return null
    const next = this.deps.pathStatus(repository.path)
    if (next !== repository.availability) {
      this.deps.database.transaction(() => {
        this.deps.repositories.updateAvailability(repoId, next)
      })
    }
    return { ...repository, availability: next }
  }

  markOpened(id: RepoId): void {
    this.deps.database.transaction(() => {
      this.deps.repositories.touchLastOpened(id, this.deps.now())
    })
    this.deps.uiState.setActiveRepository(id)
  }

  /** Informational only. Live-session safety is a Work 5 host concern. */
  describeDeletion(id: string): DeletionImpact | null {
    const repoId = parseRepoId(id)
    if (!repoId) return null
    const repository = this.deps.repositories.findById(repoId)
    if (!repository) return null
    const workspace = this.deps.repositories.workspaceForRepo(repoId)
    const sessions = this.deps.sessions.listForRepo(repoId).map<DeletionSessionSummary>((row) => ({
      id: row.id,
      harness: row.harness,
      title: row.title,
      lastObservedState: row.observation.lastObservedState,
      lastObservedIncarnationId: row.observation.lastObservedIncarnationId,
      lastObservedAt: row.observation.lastObservedAt
    }))
    return { repository, workspace, sessions, requiresHostLivenessCheck: true }
  }

  /**
   * Narrow persistence contract: removing a repository cascades its workspaces
   * and session rows. Callers must acknowledge stored sessions; Work 5 must also
   * reconcile them with the host before calling this.
   */
  removeRepository(
    id: string,
    options: { acknowledgeDependentSessions: boolean }
  ): DeletionOutcome {
    const repoId = parseRepoId(id)
    if (!repoId) {
      throw new DatabaseError(
        makeAppError('INVALID_ARGUMENT', 'Invalid repository ID.', { context: { id } })
      )
    }
    const impact = this.describeDeletion(repoId)
    if (!impact) return { status: 'not_found', repoId }
    if (impact.sessions.length > 0 && !options.acknowledgeDependentSessions) {
      return { status: 'confirmation_required', impact }
    }
    const activeRepo = this.deps.uiState.getActiveRepository()
    const activeSession = this.deps.uiState.getActiveSession()
    const activeSessionDeleted =
      activeSession !== null && impact.sessions.some((session) => session.id === activeSession)
    const deleted = this.deps.database.transaction(() => {
      const changes = this.deps.repositories.delete(repoId)
      if (activeRepo === repoId) this.deps.uiState.setActiveRepository(null)
      if (activeSessionDeleted) this.deps.uiState.setActiveSession(null)
      return changes
    })
    if (deleted === 0) return { status: 'not_found', repoId }
    return {
      status: 'deleted',
      repoId,
      deletedSessions: impact.sessions.length
    }
  }

  private ensureWorkspace(repository: RepositoryRecord): void {
    if (this.deps.repositories.workspaceForRepo(repository.id)) return
    const now = this.deps.now()
    const workspace: WorkspaceRecord = {
      id: newWorkspaceId(),
      repoId: repository.id,
      path: repository.path,
      kind: 'primary-checkout',
      createdAt: now
    }
    this.deps.database.transaction(() => {
      this.deps.repositories.insertWorkspace(workspace)
    })
  }

  private attachWorkspace(repository: RepositoryRecord): RepositoryWithWorkspace {
    const workspace = this.deps.repositories.workspaceForRepo(repository.id)
    if (!workspace) {
      // The one-primary-checkout invariant is enforced by the schema; a missing
      // row means the database was edited outside ADE.
      throw new DatabaseError(
        makeAppError('DB_CORRUPT', 'Repository is missing its primary checkout.', {
          context: { repoId: repository.id }
        })
      )
    }
    return { repository, workspace }
  }
}

export function createRepositoryService(deps: RepositoryServiceDeps): RepositoryService {
  return new RepositoryService(deps)
}

export type { RepositoryStore, SessionStore, UiStateStore }
