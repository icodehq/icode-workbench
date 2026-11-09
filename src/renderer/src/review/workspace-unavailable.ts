import { translate } from '../i18n/i18n-store'
import type { WorkspaceUnavailablePayload } from '../../../shared/icode-api'

/** Shared copy for a checkout that cannot answer Git or file requests. */
export function workspaceUnavailableText(payload: WorkspaceUnavailablePayload): string {
  switch (payload.reason) {
    case 'worktree-unavailable':
      return translate('review.distroUnavailable')
    case 'worktree-missing':
      return translate('review.worktreeMissing')
    case 'primary-checkout':
      return translate('review.primaryCheckoutGit')
    default:
      return payload.detail
  }
}
