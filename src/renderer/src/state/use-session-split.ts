import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import {
  clampSplitRatio,
  paneSide,
  reconcileSplit,
  splitOn,
  swapPanes,
  toggleSplit,
  type PaneSide,
  type SplitLayout
} from './session-split'

type Options = {
  activeSessionId: string | null
  visibleSessionIds: readonly string[]
  onSelectSession: (sessionId: string) => void
}

export type SessionSplit = {
  layout: SplitLayout | null
  ratio: number
  activeSide: PaneSide | null
  toggle: () => void
  splitOn: (side: PaneSide, sessionId: string) => void
  swap: () => void
  close: () => void
  resize: (ratio: number) => void
}

/**
 * Owns the two-pane split layout for the sessions surface.
 *
 * Selection is external state, so the hook observes it: the selected tab may
 * move between panes but never reorders them, and a tab from outside the pair
 * opens in the pane that held the previous selection. The hook only asks the
 * caller to select a session when a split action would otherwise hide the
 * active one.
 */
export function useSessionSplit({
  activeSessionId,
  visibleSessionIds,
  onSelectSession
}: Options): SessionSplit {
  const [layout, setLayout] = useState<SplitLayout | null>(null)
  const [ratio, setRatio] = useState(0.5)
  const previousActiveId = useRef<string | null>(null)

  useLayoutEffect(() => {
    setLayout((current) =>
      reconcileSplit(current, activeSessionId, previousActiveId.current, visibleSessionIds)
    )
    previousActiveId.current = activeSessionId
  }, [activeSessionId, visibleSessionIds])

  const toggle = useCallback(() => {
    setLayout((current) => toggleSplit(current, activeSessionId, visibleSessionIds))
  }, [activeSessionId, visibleSessionIds])

  const splitOnSession = useCallback(
    (side: PaneSide, sessionId: string) => {
      const action = splitOn(layout, side, sessionId, activeSessionId, visibleSessionIds)
      setLayout(action.layout)
      if (action.select !== null && action.select !== activeSessionId) {
        onSelectSession(action.select)
      }
    },
    [activeSessionId, layout, onSelectSession, visibleSessionIds]
  )

  const swap = useCallback(() => {
    setLayout((current) => swapPanes(current))
  }, [])

  const close = useCallback(() => {
    setLayout(null)
  }, [])

  const resize = useCallback((next: number) => {
    setRatio(clampSplitRatio(next))
  }, [])

  return {
    layout,
    ratio,
    activeSide: paneSide(layout, activeSessionId),
    toggle,
    splitOn: splitOnSession,
    swap,
    close,
    resize
  }
}
