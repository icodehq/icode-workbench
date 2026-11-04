import { isActiveSessionState } from '../../../shared/domain/session'
import type { SessionSummary } from '../../../shared/schemas/ipc'

/** A pane is identified by both the durable session and its PTY incarnation. */
export function paneKey(sessionId: string, incarnationId: string | null): string {
  return `${sessionId}:${incarnationId ?? 'pending'}`
}

/**
 * Reconciles the pane keys that must stay mounted.
 *
 * A session that is starting or live keeps a pane for its current incarnation.
 * Once a session is terminal its last pane remains available for its final
 * screen. A restarted session drops the old incarnation as soon as the new one
 * is starting or live. The previous Set is returned unchanged when nothing
 * moved, which keeps the derived pane list referentially stable.
 */
export function nextPaneKeys(
  previous: Set<string>,
  sessions: readonly SessionSummary[]
): Set<string> {
  const next = new Set<string>()
  const byId = new Map(sessions.map((session) => [session.id, session]))
  for (const key of previous) {
    const separator = key.lastIndexOf(':')
    const id = key.slice(0, separator)
    const incarnation = key.slice(separator + 1)
    const current = byId.get(id)
    if (!current) continue
    if (
      current.incarnationId !== null &&
      current.incarnationId !== incarnation &&
      isActiveSessionState(current.state)
    ) {
      continue
    }
    next.add(key)
  }
  for (const session of sessions) {
    if (isActiveSessionState(session.state)) {
      next.add(paneKey(session.id, session.incarnationId))
    }
  }
  if (
    next.size === previous.size &&
    [...next].every((key) => previous.has(key))
  ) {
    return previous
  }
  return next
}
