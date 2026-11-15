import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  containsSession,
  dropInGroups,
  focusSession,
  groupOf,
  groupedSessionIds,
  parseSplitGroups,
  placeInGroups,
  pruneGroups,
  swapInGroups,
  toggleGroupForActive,
  updateGroupRatio,
  type PaneDropZone,
  type SplitNode,
  type SplitSide
} from './session-split'

type Options = {
  activeSessionId: string | null
  visibleSessionIds: readonly string[]
  onSelectSession: (sessionId: string) => void
  /** Renderer-local persistence key; null disables persistence. */
  storageKey?: string | null
}

export type SessionSplit = {
  /** The group containing the active session; null shows a single pane. */
  root: SplitNode | null
  groupedSessionIds: ReadonlySet<string>
  zoomedSessionId: string | null
  toggle: () => void
  splitOn: (side: SplitSide, sessionId: string) => void
  expectNewSession: (anchorId: string, side: SplitSide) => void
  cancelNewSession: () => void
  focus: (direction: SplitSide) => void
  toggleZoom: () => void
  swapWithFocused: (sessionId: string) => void
  dropPane: (sourceId: string, targetId: string, zone: PaneDropZone) => void
  close: () => void
  resize: (branchId: string, ratio: number) => void
}

function readStoredGroups(key: string | null): SplitNode[] {
  if (key === null || typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(key)
    return raw === null ? [] : parseSplitGroups(JSON.parse(raw))
  } catch {
    return []
  }
}

function writeStoredGroups(key: string | null, groups: SplitNode[]): void {
  if (key === null || typeof window === 'undefined') return
  try {
    if (groups.length === 0) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, JSON.stringify(groups))
  } catch {
    // Persistence is best-effort, like the other renderer-only stores.
  }
}

/**
 * Owns the project's split groups.
 *
 * Each group is an independent tree. The active session determines which group
 * is visible; selecting a session in another group switches layouts, and a
 * session outside every group opens as a single pane while the other groups
 * stay saved. A split action builds around the focused pane and moves a tab
 * out of any group it already belonged to.
 */
export function useSessionSplit({
  activeSessionId,
  visibleSessionIds,
  onSelectSession,
  storageKey = null
}: Options): SessionSplit {
  const key = storageKey ?? null
  const [groups, setGroups] = useState<SplitNode[]>(() => readStoredGroups(key))
  const [loadedKey, setLoadedKey] = useState<string | null>(key)
  const [zoomedSessionId, setZoomedSessionId] = useState<string | null>(null)
  const pendingNewSession = useRef<{
    anchorId: string
    side: SplitSide
    known: Set<string>
  } | null>(null)
  const root = groupOf(groups, activeSessionId)

  // Switching repositories switches persistence keys. Adjusting state during
  // the render keeps the previous groups from being written under the new key.
  if (key !== loadedKey) {
    setLoadedKey(key)
    setGroups(readStoredGroups(key))
    setZoomedSessionId(null)
    pendingNewSession.current = null
  }

  useLayoutEffect(() => {
    // Before the first session arrives, keep the persisted groups untouched.
    if (activeSessionId === null && visibleSessionIds.length === 0) return
    const pending = pendingNewSession.current
    const arrivedId =
      pending !== null &&
      activeSessionId !== null &&
      !pending.known.has(activeSessionId) &&
      visibleSessionIds.includes(activeSessionId)
        ? activeSessionId
        : null
    if (pending !== null && arrivedId !== null) {
      pendingNewSession.current = null
      const anchorId = pending.anchorId
      const side = pending.side
      setGroups((current) =>
        placeInGroups(pruneGroups(current, visibleSessionIds), anchorId, side, arrivedId)
      )
      return
    }
    setGroups((current) => pruneGroups(current, visibleSessionIds))
  }, [activeSessionId, visibleSessionIds, loadedKey])

  useEffect(() => {
    setZoomedSessionId(null)
  }, [activeSessionId])

  useEffect(() => {
    if (zoomedSessionId === null) return
    if (root === null || !containsSession(root, zoomedSessionId)) {
      setZoomedSessionId(null)
    }
  }, [root, zoomedSessionId])

  useEffect(() => {
    writeStoredGroups(key, groups)
  }, [groups, key])

  const toggle = useCallback(() => {
    setGroups((current) => toggleGroupForActive(current, activeSessionId, visibleSessionIds))
  }, [activeSessionId, visibleSessionIds])

  const splitOnSession = useCallback(
    (side: SplitSide, sessionId: string) => {
      const target = activeSessionId
      if (target === null || target === sessionId) return
      if (!visibleSessionIds.includes(target) || !visibleSessionIds.includes(sessionId)) return
      setGroups((current) => placeInGroups(current, target, side, sessionId))
    },
    [activeSessionId, visibleSessionIds]
  )

  const expectNewSession = useCallback(
    (anchorId: string, side: SplitSide) => {
      pendingNewSession.current = {
        anchorId,
        side,
        known: new Set(visibleSessionIds)
      }
    },
    [visibleSessionIds]
  )

  const cancelNewSession = useCallback(() => {
    pendingNewSession.current = null
  }, [])

  const focus = useCallback(
    (direction: SplitSide) => {
      if (root === null || root.kind !== 'split' || activeSessionId === null) return
      const target = focusSession(root, activeSessionId, direction)
      if (target !== null && target !== activeSessionId) onSelectSession(target)
    },
    [root, activeSessionId, onSelectSession]
  )

  const toggleZoom = useCallback(() => {
    setZoomedSessionId((current) => {
      if (current !== null) return null
      if (root === null || root.kind !== 'split' || activeSessionId === null) return null
      return containsSession(root, activeSessionId) ? activeSessionId : null
    })
  }, [root, activeSessionId])

  const swapWithFocused = useCallback(
    (sessionId: string) => {
      const target = activeSessionId
      if (target === null || target === sessionId) return
      setGroups((current) => swapInGroups(current, target, sessionId))
    },
    [activeSessionId]
  )

  const dropPane = useCallback(
    (sourceId: string, targetId: string, zone: PaneDropZone) => {
      setGroups((current) => dropInGroups(current, sourceId, targetId, zone))
    },
    []
  )

  const close = useCallback(() => {
    setGroups((current) => {
      const activeGroup = groupOf(current, activeSessionId)
      return activeGroup === null ? current : current.filter((group) => group !== activeGroup)
    })
  }, [activeSessionId])

  const resize = useCallback((branchId: string, ratio: number) => {
    setGroups((current) => updateGroupRatio(current, branchId, ratio))
  }, [])

  const grouped = useMemo(() => groupedSessionIds(groups), [groups])
  const zoomed =
    zoomedSessionId !== null &&
    root !== null &&
    containsSession(root, zoomedSessionId)
      ? zoomedSessionId
      : null

  return {
    root,
    groupedSessionIds: grouped,
    zoomedSessionId: zoomed,
    toggle,
    splitOn: splitOnSession,
    expectNewSession,
    cancelNewSession,
    focus,
    toggleZoom,
    swapWithFocused,
    dropPane,
    close,
    resize
  }
}
