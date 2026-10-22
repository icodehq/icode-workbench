import type { RepoId, WorkspaceId } from './ids'
import type { CanonicalRepositoryPath } from './paths'

export type RepositoryAvailability = 'present' | 'missing'

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
