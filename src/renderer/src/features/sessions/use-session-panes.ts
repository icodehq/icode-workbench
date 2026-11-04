import { useEffect, useMemo, useState } from 'react'
import type { SessionSummary } from '../../../../shared/schemas/ipc'
import { nextPaneKeys, paneKey } from './session-panes'

/**
 * Keeps terminal panes mounted across session and page switches.
 *
 * Call this at the application composition level. Calling it inside a page
 * would reset pane retention whenever that page unmounts.
 */
export function useSessionPanes(sessions: readonly SessionSummary[]): SessionSummary[] {
  const [mounted, setMounted] = useState<Set<string>>(new Set())

  useEffect(() => {
    setMounted((previous) => nextPaneKeys(previous, sessions))
  }, [sessions])

  return useMemo(
    () =>
      sessions.filter((session) => mounted.has(paneKey(session.id, session.incarnationId))),
    [mounted, sessions]
  )
}
