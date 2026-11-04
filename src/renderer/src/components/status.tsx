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
  if (pending === 'sleeping') return 'Sleeping…'
  if (pending === 'waking') return 'Waking…'
  if (pending === 'removing') return 'Removing…'
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

/** Sleep is durable intent layered over an exited process. */
export function sessionStateLabelFor(
  session: SessionSummary,
  pending: PendingAction | null
): string {
  if (pending !== null) return sessionStateLabel(session.state, pending)
  return session.sleeping === true ? 'Sleeping' : sessionStateLabel(session.state, null)
}

export function sessionStatePillClass(
  session: SessionSummary,
  pending: PendingAction | null
): string {
  if (pending === null && session.sleeping === true) {
    return 'border-info/40 bg-info-weak text-info'
  }
  return statePillClass(session.state, pending)
}

export function sessionStateDotClass(
  session: SessionSummary,
  pending: PendingAction | null
): string {
  if (pending === null && session.sleeping === true) return 'bg-info'
  return stateDotClass(session.state, pending)
}

export function stateDotClass(state: SessionLifecycleState, pending: PendingAction | null): string {
  if (pending !== null || state === 'starting') return 'bg-signal animate-pulse'
  switch (state) {
    case 'live':
      return 'bg-add'
    case 'exited':
      return 'bg-muted-foreground'
    case 'failed':
      return 'bg-destructive'
    case 'unavailable':
      return 'bg-signal'
    default:
      return 'bg-muted-foreground'
  }
}

export function stateTextClass(state: SessionLifecycleState): string {
  switch (state) {
    case 'live':
      return 'text-add'
    case 'failed':
      return 'text-destructive'
    case 'starting':
    case 'unavailable':
      return 'text-signal'
    default:
      return 'text-muted-foreground'
  }
}

/** The prototype's rounded status pill: border + weak fill + text. */
export function statePillClass(
  state: SessionLifecycleState,
  pending: PendingAction | null
): string {
  if (pending !== null || state === 'starting') {
    return 'border-signal-line bg-signal-weak text-signal'
  }
  switch (state) {
    case 'live':
      return 'border-add/50 bg-add-weak text-add'
    case 'failed':
      return 'border-destructive/50 bg-destructive/10 text-destructive'
    case 'unavailable':
      return 'border-signal-line bg-signal-weak text-signal'
    default:
      return 'border-border text-muted-foreground'
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
 * Activity wording. `unknown` is deliberately neutral: it means iCode has no
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
      return 'text-info'
    case 'waiting':
      return 'text-signal'
    case 'idle':
      return activity.outcome === 'failed' ? 'text-destructive' : 'text-add'
    default:
      return 'text-muted-foreground'
  }
}

export function activityDotClass(activity: ActivitySummary | null): string {
  if (!activity) return 'bg-muted-foreground'
  switch (activity.state) {
    case 'working':
      return 'bg-info animate-pulse'
    case 'waiting':
      return 'bg-signal animate-pulse'
    case 'idle':
      return activity.outcome === 'failed' ? 'bg-destructive' : 'bg-add'
    default:
      return 'bg-muted-foreground'
  }
}

export function activityTooltip(activity: ActivitySummary | null): string {
  if (!activity || activity.state === 'unknown') {
    return 'This harness does not report agent activity to iCode.'
  }
  if (activity.state === 'idle' && activity.unread) return 'Finished — not viewed yet'
  if (activity.state === 'waiting') return 'The agent is waiting for you'
  if (activity.state === 'working') return 'The agent is working'
  return 'The agent is idle'
}

export function isKnownActivity(activity: ActivitySummary | null): activity is ActivitySummary {
  return activity !== null && activity.state !== 'unknown'
}

/**
 * Activity wording for Details, where there is room to explain the absence.
 *
 * Claude Code reports activity only when a turn starts. Other harnesses never
 * report it, so "unknown" would suggest a failure where there is none.
 */
export function activityDetailsLabel(
  activity: ActivitySummary | null,
  harness: HarnessId
): string {
  if (!isKnownActivity(activity)) {
    return harness === 'claude' ? 'No activity yet' : 'Not reported by this harness'
  }
  return activityLabel(activity)
}

export function activityDetailsHint(
  activity: ActivitySummary | null,
  harness: HarnessId
): string {
  if (isKnownActivity(activity)) return activityTooltip(activity)
  return harness === 'claude'
    ? 'Claude Code reports activity when it starts a turn.'
    : `${harnessName(harness)} does not report agent activity to iCode.`
}

export type { ActivityState }
