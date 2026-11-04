import type { AppError } from './errors'
import type { RepoId, WorkspaceId } from './ids'
import type { CanonicalRepositoryPath } from './paths'

/**
 * Whether the project's files can be seen right now.
 *
 * `unknown` exists because "cannot tell" is a real answer: a distro that is
 * temporarily unreachable says nothing about whether the checkout exists, and
 * reporting it as `missing` invites the user to re-add a healthy project.
 * Only `present` and `missing` are ever persisted; `unknown` is derived per read.
 */
export type RepositoryAvailability = 'present' | 'missing' | 'unknown'

/**
 * Where a repository's files live.
 *
 * The target belongs to the repository, not to a session: every worktree and
 * session derives it through `repo_id`, so two repositories that spell the same
 * path differently cannot be confused about which machine owns them.
 *
 * `distroId` is the WSL registration identity (the Lxss GUID), never a running
 * instance. A running instance is identified by the guest boot id, which changes
 * on every distro restart and therefore belongs to the live Host record, not to
 * a persisted repository row. When the registration id cannot be read, it is
 * `null` and `distro` becomes the only identity available — callers must treat
 * that as a weaker match, not as a stable id.
 */
export type WslExecutionTarget = {
  kind: 'wsl'
  /** Registration name as `wsl -l -v` reports it. */
  distro: string
  /** Lxss registration GUID; null when it could not be read. */
  distroId: string | null
}

export type ExecutionTarget = { kind: 'local' } | WslExecutionTarget

/** The target every pre-v3 row migrates to, and the default for new rows. */
export const LOCAL_EXECUTION_TARGET: ExecutionTarget = { kind: 'local' }

/** Local is the only target whose paths are canonicalized by this machine. */
export function isLocalTarget(target: ExecutionTarget): boolean {
  return target.kind === 'local'
}

/**
 * The potentially long part of adding a folder: creating its first commit.
 *
 * Registration is deliberately separate from this state. A project is real and
 * usable for browsing as soon as its row exists; only isolated sessions need
 * the baseline. Keeping preparation out of the Add request is what lets the
 * dialog close before Git has staged a large tree.
 */
export type RepositoryPreparationState = 'preparing' | 'ready' | 'failed'

export type RepositoryPreparation = {
  state: RepositoryPreparationState
  startedAt: number
  finishedAt: number | null
  /** Files actually committed; null until preparation finishes successfully. */
  committedFiles: number | null
  /** Dependency/cache folders intentionally left out of the first commit. */
  skippedFolders: string[]
  error: AppError | null
}

export type RepositoryRecord = {
  id: RepoId
  path: CanonicalRepositoryPath
  displayName: string
  addedAt: number
  lastOpenedAt: number
  currentBranch: string | null
  availability: RepositoryAvailability
  /** Canonical common Git directory; null for rows written before schema v2. */
  gitCommonDir: string | null
  /** Defaults to local for rows written before schema v3. */
  executionTarget: ExecutionTarget
  /** Null for an ordinary registered repository with a baseline commit. */
  preparation?: RepositoryPreparation | null
}

/**
 * Whether worktree-backed sessions must wait for preparation.
 *
 * A failed preparation is also blocked: starting a worktree without a baseline
 * cannot succeed, and the UI should offer the explicit retry instead.
 */
export function repositoryPreparationBlocksSessions(
  preparation: RepositoryPreparation | null | undefined
): boolean {
  return preparation?.state === 'preparing' || preparation?.state === 'failed'
}

export type WorkspaceKind = 'primary-checkout'

/**
 * MVP scope: exactly one primary checkout per repository. No worktree rows.
 */
export type WorkspaceRecord = {
  id: WorkspaceId
  repoId: RepoId
  path: CanonicalRepositoryPath
  kind: WorkspaceKind
  createdAt: number
}

export const PRIMARY_CHECKOUT: WorkspaceKind = 'primary-checkout'

export function isRepositoryUsable(repo: RepositoryRecord): boolean {
  return repo.availability === 'present'
}

export function assertWorkspaceMatchesRepository(
  workspace: WorkspaceRecord,
  repo: RepositoryRecord
): void {
  if (workspace.repoId !== repo.id) {
    throw new Error('Workspace does not belong to the repository')
  }
}
