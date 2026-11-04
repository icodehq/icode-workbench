import type { AppError } from './errors'
import type { HarnessId } from './harness'
import type { PtyIncarnationId, SessionId, WorkspaceId } from './ids'

/** Host-owned truth. `unavailable` is not a process state. */
export const HOST_SESSION_STATUSES = ['starting', 'live', 'exited', 'failed'] as const
export type HostSessionStatus = (typeof HOST_SESSION_STATUSES)[number]

/** Renderer-facing lifecycle after host reconciliation. */
export const SESSION_LIFECYCLE_STATES = [
  'starting',
  'live',
  'exited',
  'failed',
  'unavailable'
] as const
export type SessionLifecycleState = (typeof SESSION_LIFECYCLE_STATES)[number]

/**
 * Historical record only. None of these fields prove a process is alive; the
 * host must confirm liveness on every startup and reconnect.
 */
export type PersistedSessionObservation = {
  lastObservedState: SessionLifecycleState
  lastObservedExitCode: number | null
  lastObservedError: AppError | null
  lastObservedIncarnationId: PtyIncarnationId | null
  lastObservedAt: number
}

export type SessionRecord = PersistedSessionObservation & {
  id: SessionId
  workspaceId: WorkspaceId
  harness: HarnessId
  title: string
  createdAt: number
  lastActiveAt: number
}

export type HostSessionSnapshot = {
  status: HostSessionStatus
  incarnationId: PtyIncarnationId
  ptyPid: number
  exitCode: number | null
  /** A termination iCode asked for is an exit, not a failure. */
  stopRequested?: boolean
}

/**
 * `session: null` means the host answered and does not know this session,
 * which is different from being unable to ask.
 */
export type HostObservation =
  | { reachable: false }
  | { reachable: true; session: HostSessionSnapshot | null }

export type LifecycleAuthority = 'host' | 'persisted' | 'unreachable'

export type ReconciliationReason =
  | 'host_starting'
  | 'host_live'
  | 'host_exited'
  | 'host_failed'
  | 'session_not_known'
  | 'history_only'
  | 'host_unreachable'
  | 'host_unreachable_history'

export type ReconciledSessionState = {
  state: SessionLifecycleState
  authority: LifecycleAuthority
  reason: ReconciliationReason
  /** Only present when the host is authoritative for a live process. */
  incarnationId: PtyIncarnationId | null
  exitCode: number | null
  error: AppError | null
}

export function isActiveSessionState(state: SessionLifecycleState): boolean {
  return state === 'starting' || state === 'live'
}

export function isTerminalSessionState(state: SessionLifecycleState): boolean {
  return state === 'exited' || state === 'failed'
}

/**
 * Truth table from the approved plan. A persisted "live" value is never
 * returned as authoritative; host loss yields `unavailable`, not `exited`.
 */
export function reconcileSessionState(
  persisted: PersistedSessionObservation,
  host: HostObservation
): ReconciledSessionState {
  if (host.reachable) {
    const session = host.session
    if (session) {
      if (session.status === 'live' || session.status === 'starting') {
        return {
          state: session.status,
          authority: 'host',
          reason: session.status === 'live' ? 'host_live' : 'host_starting',
          incarnationId: session.incarnationId,
          exitCode: session.exitCode,
          error: null
        }
      }
      if (session.status === 'failed') {
        return {
          state: 'failed',
          authority: 'host',
          reason: 'host_failed',
          incarnationId: session.incarnationId,
          exitCode: session.exitCode,
          error: persisted.lastObservedError
        }
      }
      const cleanExit = session.exitCode === 0 || session.stopRequested === true
      return {
        state: cleanExit ? 'exited' : 'failed',
        authority: 'host',
        reason: cleanExit ? 'host_exited' : 'host_failed',
        incarnationId: session.incarnationId,
        exitCode: session.exitCode,
        error: persisted.lastObservedError
      }
    }

    if (isActiveSessionState(persisted.lastObservedState)) {
      return {
        state: 'unavailable',
        authority: 'host',
        reason: 'session_not_known',
        incarnationId: null,
        exitCode: null,
        error: null
      }
    }
    return {
      state: persisted.lastObservedState,
      authority: 'persisted',
      reason: 'history_only',
      incarnationId: null,
      exitCode: persisted.lastObservedExitCode,
      error: persisted.lastObservedError
    }
  }

  if (isActiveSessionState(persisted.lastObservedState)) {
    return {
      state: 'unavailable',
      authority: 'unreachable',
      reason: 'host_unreachable',
      incarnationId: null,
      exitCode: null,
      error: null
    }
  }
  return {
    state: persisted.lastObservedState,
    authority: 'persisted',
    reason: 'host_unreachable_history',
    incarnationId: null,
    exitCode: persisted.lastObservedExitCode,
    error: persisted.lastObservedError
  }
}

/** Writes and resizes require host-confirmed liveness for this incarnation. */
export function canAcceptTerminalInput(reconciled: ReconciledSessionState): boolean {
  return reconciled.state === 'live' && reconciled.authority === 'host' && reconciled.incarnationId !== null
}

export function assertNewPtyIncarnation(
  previous: PtyIncarnationId | null,
  next: PtyIncarnationId
): void {
  if (previous !== null && previous === next) {
    throw new Error('A restarted PTY must use a new incarnation ID')
  }
}

export const MAX_SESSION_TITLE_LENGTH = 120

export function normalizeSessionTitle(input: string, fallback = 'Untitled session'): string {
  const clean = (value: string): string =>
    value
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_SESSION_TITLE_LENGTH)

  const normalized = clean(input)
  if (normalized.length > 0) return normalized
  const normalizedFallback = clean(fallback)
  return normalizedFallback.length > 0 ? normalizedFallback : 'Untitled session'
}
