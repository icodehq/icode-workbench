import { harnessLabel, type HarnessId } from '../../../shared/domain/harness'
import type { ActivityState, ActivitySummary } from '../../../shared/domain/activity'
import type { SessionLifecycleState } from '../../../shared/domain/session'
import type { SessionSummary } from '../../../shared/schemas/ipc'
import type { PendingAction } from '../state/workspace'

export function harnessName(id: HarnessId): string {
  return harnessLabel(id)
}

export function sessionStateLabel(
  state: SessionLifecycleState,
  pending: PendingAction | null
): string {
  if (pending === 'stopping') return 'Stopping…'
  if (pending === 'restarting') return 'Restarting…'
  switch (state) {
    case 'starting':
      return 'Starting'
    case 'live':
      return 'Live'
    case 'exited':
      return 'Exited'
    case 'failed':
      return 'Failed'
    case 'unavailable':
      return 'Unavailable'
  }
}

export function stateDotClass(state: SessionLifecycleState, pending: PendingAction | null): string {
  if (pending !== null || state === 'starting') return 'bg-amber-400 animate-pulse'
  switch (state) {
    case 'live':
      return 'bg-emerald-400'
    case 'exited':
      return 'bg-neutral-500'
    case 'failed':
      return 'bg-red-400'
    case 'unavailable':
      return 'bg-amber-400'
    default:
      return 'bg-neutral-500'
  }
}

export function stateTextClass(state: SessionLifecycleState): string {
  switch (state) {
    case 'live':
      return 'text-emerald-400'
    case 'failed':
      return 'text-red-400'
    case 'starting':
    case 'unavailable':
      return 'text-amber-400'
    default:
      return 'text-muted-foreground'
  }
}

/** Wording comes from reconciliation, never from optimistic UI assumptions. */
export function authorityNote(session: SessionSummary): string {
  switch (session.reason) {
    case 'host_live':
      return 'Live process confirmed by the terminal host.'
    case 'host_starting':
      return 'The terminal host is starting this process.'
    case 'host_exited':
      return 'Exit confirmed by the terminal host.'
    case 'host_failed':
      return 'Failure confirmed by the terminal host.'
    case 'session_not_known':
      return 'The host is reachable but no longer owns this session.'
    case 'history_only':
      return 'Historical record only; the host is not running this session.'
    case 'host_unreachable':
      return 'The terminal host is unreachable; the process state is unknown.'
    case 'host_unreachable_history':
      return 'Historical record; the terminal host is unreachable.'
  }
}

export function shortId(value: string | null): string {
  return value === null ? '—' : value.slice(0, 10)
}


/**
 * Activity wording. `unknown` is deliberately neutral: it means ADE has no
 * evidence, not that the agent is idle or that the user misconfigured Claude.
 */
export function activityLabel(activity: ActivitySummary): string {
  switch (activity.state) {
    case 'working':
      return activity.toolName ? `Working · ${activity.toolName}` : 'Working'
    case 'waiting':
      return activity.toolName && activity.toolName !== 'Bash' ? `Needs you · ${activity.toolName}` : 'Needs you'
    case 'idle':
      return activity.outcome === 'failed' ? 'Done · failed' : 'Done'
    case 'unknown':
      return 'Activity unknown'
  }
}

/** Short form for the sidebar, where space is limited. */
export function activitySuffix(activity: ActivitySummary | null): string | null {
  if (!activity || activity.state === 'unknown') return null
  switch (activity.state) {
    case 'working':
      return activity.toolName ? `Working · ${activity.toolName}` : 'Working'
    case 'waiting':
      return 'Needs you'
    case 'idle':
      return activity.outcome === 'failed' ? 'Done · failed' : 'Done'
    default:
      return null
  }
}

export function activityTone(activity: ActivitySummary | null): string {
  if (!activity) return 'text-muted-foreground'
  switch (activity.state) {
    case 'working':
      return 'text-sky-400'
    case 'waiting':
      return 'text-amber-400'
    case 'idle':
      return activity.outcome === 'failed' ? 'text-red-400' : 'text-emerald-400'
    default:
      return 'text-muted-foreground'
  }
}

export function activityDotClass(activity: ActivitySummary | null): string {
  if (!activity) return 'bg-neutral-500'
  switch (activity.state) {
    case 'working':
      return 'bg-sky-400 animate-pulse'
    case 'waiting':
      return 'bg-amber-400 animate-pulse'
    case 'idle':
      return activity.outcome === 'failed' ? 'bg-red-400' : 'bg-emerald-400'
    default:
      return 'bg-neutral-500'
  }
}

export function activityTooltip(activity: ActivitySummary | null): string {
  if (!activity || activity.state === 'unknown') {
    return 'This harness does not report agent activity to ADE.'
  }
  if (activity.state === 'idle' && activity.unread) return 'Finished — not viewed yet'
  if (activity.state === 'waiting') return 'The agent is waiting for you'
  if (activity.state === 'working') return 'The agent is working'
  return 'The agent is idle'
}

export function isKnownActivity(activity: ActivitySummary | null): activity is ActivitySummary {
  return activity !== null && activity.state !== 'unknown'
}

export type { ActivityState }
