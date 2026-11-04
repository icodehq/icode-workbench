import { statSync } from 'node:fs'
import { basename } from 'node:path'
import { DatabaseError, type Database } from '../persistence/database'
import type { RepositoryStore, RepositoryWithWorkspace } from '../persistence/repository-store'
import type { SessionStore, DeletionSessionSummary } from '../persistence/session-store'
import type { UiStateStore } from '../persistence/ui-state-store'
import { makeAppError } from '../../shared/domain/errors'
import { RepositoryPathError } from './repository-path'
import { newRepoId, newWorkspaceId, parseRepoId, type RepoId } from '../../shared/domain/ids'
import { toCanonicalRepositoryPath } from '../../shared/domain/paths'
import {
  LOCAL_EXECUTION_TARGET,
  type ExecutionTarget,
  type RepositoryAvailability,
  type RepositoryRecord,
  type WorkspaceRecord
} from '../../shared/domain/repository'
import type { TargetValidator } from '../wsl/repository-target'

export type RepositoryServiceDeps = {
  database: Database
  repositories: RepositoryStore
  sessions: SessionStore
  uiState: UiStateStore
  /**
   * Target-aware resolver. For a WSL target it runs entirely in the distro; a
   * local target is routed to the unchanged local implementation.
   */
  resolveRoot: (path: string, target: ExecutionTarget) => Promise<{
    root: string
    currentBranch: string | null
    commonDir?: string
    registeredVia?: string | null
  }>
  now: () => number
  pathStatus: (path: string) => 'present' | 'missing'
  /**
   * Target-aware existence check.
   *
   * Optional so every existing local-only caller and test keeps its behaviour:
   * absent means "this build only knows about this machine".
   */
  hostFsFor?: (target: ExecutionTarget) => Promise<{ isDirectory(path: string): Promise<boolean> }>
  /**
   * Required, not optional: a missing validator would silently accept any WSL
   * target, which is exactly the failure this boundary exists to prevent. Local
   * targets pass through without any OS call.
   */
  validateTarget: TargetValidator
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
  /** Last known state per remote project, refreshed on demand. */
  private readonly targetAvailability = new Map<RepoId, RepositoryAvailability>()
  private hostFs: RepositoryServiceDeps['hostFsFor']

  constructor(private readonly deps: RepositoryServiceDeps) {
    this.hostFs = deps.hostFsFor
  }

  /**
   * Late binding for the target-aware filesystem.
   *
   * The persistence layer is created before the worktree service it must ask, so
   * the composition root hands it over once instead of duplicating a router here.
   */
  useHostFs(hostFs: NonNullable<RepositoryServiceDeps['hostFsFor']>): void {
    this.hostFs = hostFs
  }

  /**
   * Registration accepts a path, but only the resolver may canonicalize it.
   * An already-registered canonical path returns the existing record.
   *
   * The target is validated first, and the *canonical* target is what gets
   * stored and deduplicated against. Validating first also reports the honest
   * cause: when a WSL distro is gone, that — not the guest path it made
   * unresolvable — is what the user needs to fix.
   */
  async addRepository(
    inputPath: string,
    requestedTarget: ExecutionTarget = LOCAL_EXECUTION_TARGET,
    options: { targetAlreadyValidated?: boolean } = {}
  ): Promise<AddRepositoryOutcome> {
    /*
     * Onboarding has just validated the target (and resolved the folder) before
     * calling this. Re-running `wsl.exe --list` here is a full distro discovery
     * on the Add-project critical path; the optional flag is limited to callers
     * that can prove the target already passed the same validator.
     */
    const executionTarget = options.targetAlreadyValidated
      ? requestedTarget
      : await this.deps.validateTarget(requestedTarget)
    // Why the canonical target: it carries the proven registration id, which the
    // resolver needs to address the right distro, and which is what gets stored.
    const resolved = await this.deps.resolveRoot(inputPath, executionTarget)
    const root = toCanonicalRepositoryPath(resolved.root)
    const commonDir = resolved.commonDir ?? null
    // Why: a linked worktree resolves to the same common Git dir as its primary
    // checkout. Registering it must not create a second repository record.
    // Why scoped by target: the same canonical path legitimately names a
    // different repository on another execution target, so an unscoped lookup
    // would fold two distinct registrations into one.
    let existing =
      this.deps.repositories.findByPath(root, executionTarget) ??
      (commonDir === null
        ? null
        : this.deps.repositories.findByCommonDir(commonDir, executionTarget))

    if (
      existing === null &&
      executionTarget.kind === 'wsl' &&
      executionTarget.distroId !== null
    ) {
      existing = this.adoptLegacyWslRow(root, commonDir, executionTarget)
    }
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
      // A distro path must not be stat'ed locally. Registration already proved
      // the root through the target's own resolver, so it is present by proof.
      availability: executionTarget.kind === 'local' ? this.deps.pathStatus(root) : 'present',
      gitCommonDir: commonDir,
      executionTarget
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

  /**
   * Registers a folder whose Git repository was **just created** at `root`.
   *
   * The general path resolves the root through the target's Git, which is
   * correct for arbitrary checkouts and linked worktrees but costs several guest
   * commands. After `git init` in an empty folder those answers are already
   * known: the root is the folder, the common dir is its `.git`, and there is no
   * branch until the first commit. This keeps that proof in one narrowly named
   * method instead of weakening the general resolver.
   */
  async addInitializedRepository(
    rootInput: string,
    requestedTarget: ExecutionTarget = LOCAL_EXECUTION_TARGET,
    options: { targetAlreadyValidated?: boolean } = {}
  ): Promise<AddRepositoryOutcome> {
    const executionTarget = options.targetAlreadyValidated
      ? requestedTarget
      : await this.deps.validateTarget(requestedTarget)
    const root = toCanonicalRepositoryPath(rootInput)
    const separator =
      executionTarget.kind === 'local' && process.platform === 'win32' ? '\\' : '/'
    const commonDir = `${root.replace(/[\\/]+$/u, '')}${separator}.git`
    const existing =
      this.deps.repositories.findByPath(root, executionTarget) ??
      this.deps.repositories.findByCommonDir(commonDir, executionTarget)
    if (existing) {
      this.ensureWorkspace(existing)
      return {
        repository: existing,
        created: false,
        registeredViaLinkedWorktree: null
      }
    }

    /*
     * A pre-v3 WSL row cannot be found by the registration-scoped lookup. Keep
     * the same adoption/refusal rule as the general path; a fast registration
     * must not create a second row for the same checkout.
     */
    if (executionTarget.kind === 'wsl' && executionTarget.distroId !== null) {
      const legacy = this.deps.repositories.findLegacyWslByNameAndPath(
        executionTarget.distro,
        root
      )
      if (legacy !== null) {
        if (legacy.gitCommonDir === null || legacy.gitCommonDir !== commonDir) {
          throw new RepositoryPathError(
            makeAppError(
              'WSL_LEGACY_REGISTRATION_UNRESOLVED',
              'A repository is already registered for that WSL folder without a distro id.',
              {
                detail:
                  'iCode cannot prove the existing registration and this distro are the same installation, so it will not rebind it. Remove that repository and add it again.',
                context: { path: root, distro: executionTarget.distro }
              }
            )
          )
        }
        this.deps.repositories.adoptRegistrationId(legacy.id, executionTarget.distroId)
        this.ensureWorkspace(legacy)
        return {
          repository: legacy,
          created: false,
          registeredViaLinkedWorktree: null
        }
      }
    }

    const now = this.deps.now()
    const repository: RepositoryRecord = {
      id: newRepoId(),
      path: root,
      displayName: displayNameFor(root),
      addedAt: now,
      lastOpenedAt: now,
      currentBranch: null,
      availability:
        executionTarget.kind === 'local' ? this.deps.pathStatus(root) : 'present',
      gitCommonDir: commonDir,
      executionTarget
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
      registeredViaLinkedWorktree: null
    }
  }

  /**
   * Re-asks every remote target whether its project is still there.
   *
   * Separate from `listRepositories` because this is async and only a distro
   * needs it. A distro that does not answer leaves the stored value untouched
   * and is reported as `unknown` for this read — never written as `missing`.
   */
  async refreshTargetAvailability(): Promise<void> {
    const hostFsFor = this.hostFs
    if (!hostFsFor) return
    const remote = this.deps.repositories.list().filter((repository) => repository.executionTarget.kind !== 'local')
    await Promise.all(
      remote.map(async (repository) => {
        try {
          const fs = await hostFsFor(repository.executionTarget)
          const exists = await fs.isDirectory(repository.path)
          const next: RepositoryAvailability = exists ? 'present' : 'missing'
          this.targetAvailability.set(repository.id, next)
          if (next !== repository.availability) {
            this.deps.database.transaction(() => {
              this.deps.repositories.updateAvailability(repository.id, next)
            })
          }
        } catch {
          // No answer is not "missing": keep the stored value and mark unknown.
          this.targetAvailability.set(repository.id, 'unknown')
        }
      })
    )
  }

  listRepositories(options: { refreshPaths?: boolean } = {}): RepositoryWithWorkspace[] {
    const repositories = this.deps.repositories.list()
    if (options.refreshPaths === false) {
      return repositories.map((repository) => this.attachWorkspace(repository))
    }
    const changed = repositories.filter((repository) => {
      // A guest path is not a path this process can stat, so a local check would
      // declare a healthy WSL project missing. Remote rows are refreshed by
      // `refreshTargetAvailability` instead.
      if (repository.executionTarget.kind !== 'local') return false
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
    return this.deps.repositories
      .list()
      .map((repository) => this.withDerivedAvailability(repository))
      .map((repository) => this.attachWorkspace(repository))
  }

  /**
   * Applies the per-read state for a remote project without writing it.
   *
   * `unknown` is deliberately not persisted: it describes this read, not the
   * project.
   */
  private withDerivedAvailability(repository: RepositoryRecord): RepositoryRecord {
    if (repository.executionTarget.kind === 'local') return repository
    const derived = this.targetAvailability.get(repository.id)
    if (derived === undefined || derived === repository.availability) return repository
    return { ...repository, availability: derived }
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

  private adoptLegacyWslRow(
    root: string,
    commonDir: string | null,
    target: Extract<ExecutionTarget, { kind: 'wsl' }>
  ): RepositoryRecord | null {
    const legacy = this.deps.repositories.findLegacyWslByNameAndPath(target.distro, root)
    if (legacy === null) return null

    const sameRepository =
      legacy.gitCommonDir !== null && commonDir !== null && legacy.gitCommonDir === commonDir
    if (!sameRepository) {
      throw new RepositoryPathError(
        makeAppError(
          'WSL_LEGACY_REGISTRATION_UNRESOLVED',
          'A repository is already registered for that WSL folder without a distro id.',
          {
            detail:
              'iCode cannot prove the existing registration and this distro are the same installation, so it will not rebind it. Remove that repository and add it again.',
            context: { path: root, distro: target.distro }
          }
        )
      )
    }
    this.deps.repositories.adoptRegistrationId(legacy.id, target.distroId!)
    return this.deps.repositories.findById(legacy.id)
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
      // row means the database was edited outside iCode.
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
