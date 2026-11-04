import type { WorkspaceUnavailablePayload } from '../../../shared/ade-api'

/** Shared copy for a checkout that cannot answer Git or file requests. */
export function workspaceUnavailableText(payload: WorkspaceUnavailablePayload): string {
  switch (payload.reason) {
    case 'worktree-unavailable':
      return 'This distro could not be reached, so its Git state is unavailable right now.'
    case 'worktree-missing':
      return 'The session worktree is missing.'
    case 'primary-checkout':
      return 'This session runs in the primary checkout, so it has no worktree Git state.'
    default:
      return payload.detail
  }
}
