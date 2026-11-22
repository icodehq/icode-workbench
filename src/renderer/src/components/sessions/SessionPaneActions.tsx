import { createContext, useContext, type ReactNode } from 'react'
import type { SplitSide } from '../../state/session-split'

/**
 * Pane actions for one rendered session.
 *
 * `split-commands.ts` only registers the active session's commands, but a
 * terminal context menu can target any visible pane. This context binds the
 * actions to the pane that renders it.
 */
export type SessionPaneActions = {
  split: (side: SplitSide) => void
  close: () => void
  focus: () => void
  toggleZoom: () => void
  canSplit: boolean
  canClose: boolean
  canZoom: boolean
}

const SessionPaneActionsContext = createContext<SessionPaneActions | null>(null)

export function SessionPaneActionsProvider({
  value,
  children
}: {
  value: SessionPaneActions
  children: ReactNode
}): React.JSX.Element {
  return (
    <SessionPaneActionsContext.Provider value={value}>
      {children}
    </SessionPaneActionsContext.Provider>
  )
}

export function useSessionPaneActions(): SessionPaneActions | null {
  return useContext(SessionPaneActionsContext)
}
