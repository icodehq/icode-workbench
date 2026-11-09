import type { RepositorySummary } from '../../../shared/schemas/ipc'
import { translate } from '../i18n/i18n-store'

export type RepositoryPreparationView =
  | { kind: 'preparing'; label: string }
  | { kind: 'failed'; label: string; detail: string | null }
  | null

/**
 * The renderer's one interpretation of background first-commit state.
 *
 * Keeping this in one place prevents the wall, the project header and New
 * session from disagreeing about whether a project can start an isolated
 * worktree.
 */
export function repositoryPreparationView(
  repo: Pick<RepositorySummary, 'preparation'>
): RepositoryPreparationView {
  const preparation = repo.preparation ?? null
  if (preparation === null) return null
  if (preparation.state === 'preparing') {
    return { kind: 'preparing', label: translate('projects.preparation.preparing') }
  }
  if (preparation.state === 'failed') {
    return {
      kind: 'failed',
      label: translate('projects.preparation.failed'),
      detail:
        preparation.error?.message ?? translate('projects.preparation.failedDetail')
    }
  }
  return null
}

export function repositoryBlocksSessions(
  repo: Pick<RepositorySummary, 'preparation'>
): boolean {
  return repositoryPreparationView(repo) !== null
}
