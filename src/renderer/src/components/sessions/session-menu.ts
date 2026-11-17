import type { SessionSummary } from '../../../../shared/schemas/ipc'
import type { PendingAction } from '../../state/workspace'
import { translate } from '../../i18n/i18n-store'

/**
 * The lifecycle plan shared by the session header menu and the sidebar row menu.
 *
 * The row menu is a fast path for any session, including one that is not open;
 * the header menu is the descriptive surface for the session on screen. Both
 * read their availability from `sessionActionState`, so a rule change cannot
 * make them disagree.
 */
export type SessionMenuEntryId =
  | 'details'
  | 'sleep'
  | 'wake'
  | 'restart'
  | 'pin'
  | 'remove'

export type SessionMenuReason =
  | 'pending'
  | 'restarting'
  | 'host-unreachable'
  | 'worktree-blocked'

export type SessionMenuEntry = {
  id: SessionMenuEntryId
  separatorBefore: boolean
  disabled: boolean
  reason?: SessionMenuReason
}

export type SessionActionState = {
  live: boolean
  sleeping: boolean
  showSleep: boolean
  showWake: boolean
  showRestart: boolean
  canSleep: boolean
  canWake: boolean
  canRestart: boolean
  canRemove: boolean
  sleepReason: SessionMenuReason | null
  wakeReason: SessionMenuReason | null
  restartReason: SessionMenuReason | null
  removeReason: SessionMenuReason | null
}

/** A missing or inconsistent checkout is not a place a terminal can start. */
export function worktreeBlocksTerminal(worktree: SessionSummary['worktree']): boolean {
  return (
    worktree !== null &&
    (worktree.status === 'missing' || worktree.status === 'inconsistent')
  )
}

export function hostUnavailable(session: SessionSummary): boolean {
  return (
    session.authority === 'unreachable' ||
    session.reason === 'host_unreachable' ||
    session.reason === 'host_unreachable_history'
  )
}

/**
 * Sleep and Restart are hidden when they cannot apply at all, and disabled only
 * while a temporary action is in flight. Remove is always offered; the
 * confirmation dialog explains what it protects.
 */
export function sessionActionState(
  session: SessionSummary,
  pending: PendingAction | null,
  allowSleep: boolean
): SessionActionState {
  const live = session.state === 'live'
  const sleeping = session.sleeping === true
  const blocked = worktreeBlocksTerminal(session.worktree)
  const unreachable = hostUnavailable(session)

  const showSleep = allowSleep && live && !sleeping
  const showWake = allowSleep && sleeping
  const showRestart = !sleeping

  const canSleep = showSleep && pending === null
  const canWake = showWake && pending === null
  const canRestart = showRestart && pending === null && !blocked && !unreachable
  const canRemove = pending === null

  return {
    live,
    sleeping,
    showSleep,
    showWake,
    showRestart,
    canSleep,
    canWake,
    canRestart,
    canRemove,
    sleepReason: showSleep && !canSleep ? 'pending' : null,
    wakeReason: showWake && !canWake ? 'pending' : null,
    restartReason: !showRestart || canRestart
      ? null
      : pending === 'restarting'
        ? 'restarting'
        : pending !== null
          ? 'pending'
          : unreachable
            ? 'host-unreachable'
            : 'worktree-blocked',
    removeReason: canRemove ? null : 'pending'
  }
}

export function worktreeIsShared(
  session: SessionSummary,
  sessions: readonly SessionSummary[]
): boolean {
  return (
    session.worktree !== null &&
    sessions.some(
      (candidate) =>
        candidate.id !== session.id && candidate.worktree?.id === session.worktree?.id
    )
  )
}

/**
 * The header menu's plan. It deliberately omits Pin: the header is about the
 * session on screen, while Pin is a sidebar arrangement action.
 *
 * `allowSleep` is a surface projection, not a session fact. Surfaces that never
 * sleep a session still show Restart on a sleeping one, disabled, exactly as
 * the old flattened props did.
 */
export function sessionHeaderMenuEntries(
  state: SessionActionState,
  allowSleep: boolean
): SessionMenuEntry[] {
  const entries: SessionMenuEntry[] = [
    { id: 'details', separatorBefore: false, disabled: false }
  ]
  if (state.showSleep) {
    entries.push({
      id: 'sleep',
      separatorBefore: false,
      disabled: !state.canSleep,
      ...(state.sleepReason === null ? {} : { reason: state.sleepReason })
    })
  }
  if (state.showWake) {
    entries.push({
      id: 'wake',
      separatorBefore: false,
      disabled: !state.canWake,
      ...(state.wakeReason === null ? {} : { reason: state.wakeReason })
    })
  }
  if (!allowSleep || !state.sleeping) {
    entries.push({
      id: 'restart',
      separatorBefore: false,
      disabled: !state.canRestart,
      ...(state.restartReason === null ? {} : { reason: state.restartReason })
    })
  }
  entries.push({
    id: 'remove',
    separatorBefore: true,
    disabled: !state.canRemove,
    ...(state.removeReason === null ? {} : { reason: state.removeReason })
  })
  return entries
}

export function sessionMenuEntries(state: SessionActionState): SessionMenuEntry[] {
  const entries: SessionMenuEntry[] = [
    { id: 'details', separatorBefore: false, disabled: false }
  ]

  if (state.showSleep) {
    entries.push({
      id: 'sleep',
      separatorBefore: false,
      disabled: !state.canSleep,
      ...(state.sleepReason === null ? {} : { reason: state.sleepReason })
    })
  }
  if (state.showWake) {
    entries.push({
      id: 'wake',
      separatorBefore: false,
      disabled: !state.canWake,
      ...(state.wakeReason === null ? {} : { reason: state.wakeReason })
    })
  }
  if (state.showRestart) {
    entries.push({
      id: 'restart',
      separatorBefore: false,
      disabled: !state.canRestart,
      ...(state.restartReason === null ? {} : { reason: state.restartReason })
    })
  }

  entries.push({ id: 'pin', separatorBefore: true, disabled: false })
  entries.push({
    id: 'remove',
    separatorBefore: true,
    disabled: !state.canRemove,
    ...(state.removeReason === null ? {} : { reason: state.removeReason })
  })

  return entries
}

export function sessionMenuReasonLabel(reason: SessionMenuReason): string {
  switch (reason) {
    case 'pending':
      return translate('session.actionPending')
    case 'restarting':
      return translate('session.restartInProgress')
    case 'host-unreachable':
      return translate('session.hostUnreachable')
    case 'worktree-blocked':
      return translate('session.worktreeBlocked')
  }
}
