import type { WorkspaceState } from './workspace'

export type HostStatus = 'reachable' | 'unreachable' | 'unknown'

/**
 * Host truth is derived from reconcile answers, not from the local app process.
 *
 * Any session that says the host is unreachable wins: showing "reachable"
 * because another session still has a cached host state would hide the outage
 * the user is trying to recover from.
 */
export function hostStatus(state: WorkspaceState): HostStatus {
  if (
    state.sessions.some(
      (session) =>
        session.authority === 'unreachable' ||
        session.reason === 'host_unreachable' ||
        session.reason === 'host_unreachable_history'
    )
  ) {
    return 'unreachable'
  }
  if (state.sessions.some((session) => session.authority === 'host')) return 'reachable'
  return 'unknown'
}

export function hostLabel(status: HostStatus): string {
  if (status === 'reachable') return 'Host reachable'
  if (status === 'unreachable') return 'Host unreachable'
  return 'Host status unknown'
}
