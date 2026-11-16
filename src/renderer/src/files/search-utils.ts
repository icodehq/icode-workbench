/**
 * Shared helpers for the Files and Search inspector panes.
 *
 * Both panes report the same worktree failures and agree on which paths are
 * plumbing, so the wording and the filters live here rather than being copied
 * into the search pane.
 */

import type { WorkspaceUnavailablePayload } from '../../../shared/icode-api'
import { translate } from '../i18n/i18n-store'

/** The worktree's Git link is plumbing, not a file to browse or edit. */
export const isGitMetadata = (path: string): boolean => path.split('/').includes('.git')

export const parsePatterns = (value: string): string[] =>
  value
    .split(/[\n,]/u)
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0)

export const unavailableText = (payload: WorkspaceUnavailablePayload): string => {
  switch (payload.reason) {
    case 'worktree-unavailable':
      return translate('files.unavailable.distro')
    case 'worktree-missing':
      return translate('files.unavailable.worktreeMissing')
    case 'primary-checkout':
      return translate('files.unavailable.primaryCheckout')
    default:
      return payload.detail
  }
}
