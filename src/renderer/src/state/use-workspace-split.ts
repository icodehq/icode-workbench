import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { tabKey, type CenterTab } from '../files/open-files'
import { sessionIdFromTabKey, sessionTabKey } from '../workspace/workspace-key'
import {
  clearTabEverywhere,
  containsPane,
  createLeaf,
  displayedTabKeys,
  dropPane as dropPaneInTree,
  findPane,
  findPaneForTabKey,
  firstLeafPaneId,
  focusPane as focusPaneInTree,
  leafPaneIds,
  parseSplitState,
  reconcilePaneTabs,
  removePane,
  setPaneTabKey,
  splitAround,
  updateRatio,
  type PaneDropZone,
  type PersistedSplit,
  type SplitNode,
  type SplitSide
} from './workspace-split'

const STORAGE_PREFIX = 'icode.workspace-split.v2.'

function storageKeyFor(workspaceKey: string | null): string | null {
  return workspaceKey === null ? null : `${STORAGE_PREFIX}${workspaceKey}`
}

/** Drops a removed workspace's saved split so a re-created key starts fresh. */
export function clearWorkspaceSplit(workspaceKey: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(`${STORAGE_PREFIX}${workspaceKey}`)
  } catch {
    // A blocked storage is only a lost layout preference.
  }
}

function readStored(key: string | null): PersistedSplit | null {
  if (key === null || typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(key)
    return raw === null ? null : parseSplitState(JSON.parse(raw))
  } catch {
    return null
  }
}

function writeStored(key: string | null, value: PersistedSplit): void {
  if (key === null || typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Persistence is best-effort, like the other renderer-only stores.
  }
}

function initialState(activeKey: string | null): PersistedSplit {
  const leaf = createLeaf(activeKey)
  return { v: 2, root: leaf, focusedPaneId: leaf.paneId }
}

type Options = {
  /** Null disables persistence and treats the surface as unscoped. */
  workspaceKey: string | null
  /** The ordered worktree tab list. Pane tabs are reconciled against it. */
  tabs: readonly CenterTab[]
  /** The store's last focused tab, used to seed a new workspace split. */
  activeKey: string | null
  activeSessionId: string | null
  /** Called for any activated tab key; Sessions maps session keys to selection. */
  onActivateTabKey?: (key: string) => void
  /** Legacy session-only selection callback. */
  onSelectSession?: (sessionId: string) => void
}

export type WorkspaceSplit = {
  root: SplitNode
  focusedPaneId: string
  zoomedPaneId: string | null
  focusedTabKey: string | null
  displayedTabKeys: () => string[]
  activateTab: (key: string) => void
  activateTabInPane: (paneId: string, key: string) => void
  focusPane: (paneId: string) => void
  splitPane: (side: SplitSide) => void
  splitWithTab: (key: string, side: SplitSide) => void
  moveTabToPane: (key: string, paneId: string) => void
  placeTabInPane: (key: string, paneId: string, side: SplitSide | 'center') => void
  closePane: (paneId: string) => void
  unsplit: () => void
  toggleZoom: () => void
  focus: (direction: SplitSide) => void
  dropPane: (sourcePaneId: string, targetPaneId: string, zone: PaneDropZone) => void
  resize: (branchId: string, ratio: number) => void
  setPaneTabKey: (paneId: string, key: string | null) => void
}

/**
 * Owns one split tree per workspace.
 *
 * A pane remembers the worktree tab it shows; the tab list owns the tabs. A tab
 * is displayed in at most one pane. Splitting adds an empty pane (the picker),
 * and closing a pane's last tab collapses that pane.
 */
export function useWorkspaceSplit({
  workspaceKey,
  tabs,
  activeKey,
  activeSessionId,
  onActivateTabKey,
  onSelectSession
}: Options): WorkspaceSplit {
  const storageKey = storageKeyFor(workspaceKey)
  const [state, setState] = useState<PersistedSplit>(() => {
    return readStored(storageKey) ?? initialState(activeKey)
  })
  const [loadedKey, setLoadedKey] = useState<string | null>(storageKey)
  const [zoomedPaneId, setZoomedPaneId] = useState<string | null>(null)

  if (storageKey !== loadedKey) {
    setLoadedKey(storageKey)
    setState(readStored(storageKey) ?? initialState(activeKey))
    setZoomedPaneId(null)
  }

  const tabsKey = tabs.map((tab) => tabKey(tab)).join('\u0000')
  const validKeys = useMemo(() => {
    return new Set(tabs.map((tab) => tabKey(tab)))
    // tabsKey is the stable identity for the tab-key set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabsKey])

  // Persist layout changes; a workspace switch writes under its own key.
  useEffect(() => {
    writeStored(storageKey, state)
  }, [state, storageKey])

  // Clear pane tabs that left the worktree tab list. If the focused pane lost
  // its tab to a close, fall back to the store's next active tab instead of
  // leaving a picker beside a still-open tab.
  useEffect(() => {
    setState((current) => {
      const focusedBefore = findPane(current.root, current.focusedPaneId)
      const lostFocusedTab =
        focusedBefore !== null && focusedBefore.activeTabKey !== null
      let root = reconcilePaneTabs(current.root, validKeys)
      if (root === current.root) return current
      const focusedPaneId = containsPane(root, current.focusedPaneId)
        ? current.focusedPaneId
        : firstLeafPaneId(root)
      if (lostFocusedTab) {
        const focusedPane = findPane(root, focusedPaneId)
        const fallbackUsable =
          activeKey !== null &&
          validKeys.has(activeKey) &&
          findPaneForTabKey(root, activeKey) === null
        if (
          focusedPane !== null &&
          focusedPane.activeTabKey === null &&
          fallbackUsable
        ) {
          root = setPaneTabKey(root, focusedPaneId, activeKey)
        }
      }
      return { ...current, root, focusedPaneId }
    })
  }, [activeKey, validKeys])

  // Selecting a session from the sidebar shows it in the focused pane.
  const previousSession = useRef(activeSessionId)
  useEffect(() => {
    if (activeSessionId === null) {
      previousSession.current = null
      return
    }
    const key = sessionTabKey(activeSessionId)
    // A new session becomes active before syncSessions adds its tab. Wait for
    // the tab instead of consuming the selection and never showing it.
    if (!validKeys.has(key)) return
    const changed = previousSession.current !== activeSessionId
    previousSession.current = activeSessionId
    if (!changed) return
    setState((current) => {
      const existing = findPaneForTabKey(current.root, key)
      if (existing !== null) {
        return existing.paneId === current.focusedPaneId
          ? current
          : { ...current, focusedPaneId: existing.paneId }
      }
      const root = setPaneTabKey(
        clearTabEverywhere(current.root, key, current.focusedPaneId),
        current.focusedPaneId,
        key
      )
      return { ...current, root }
    })
  }, [activeSessionId, validKeys])

  useEffect(() => {
    if (zoomedPaneId !== null && !containsPane(state.root, zoomedPaneId)) {
      setZoomedPaneId(null)
    }
  }, [state.root, zoomedPaneId])

  const selectForTab = useCallback(
    (key: string) => {
      if (onActivateTabKey !== undefined) {
        onActivateTabKey(key)
        return
      }
      const sessionId = sessionIdFromTabKey(key)
      if (sessionId !== null && sessionId !== activeSessionId) {
        onSelectSession?.(sessionId)
      }
    },
    [activeSessionId, onActivateTabKey, onSelectSession]
  )

  const focusedPane = findPane(state.root, state.focusedPaneId)
  const focusedTabKey = focusedPane?.activeTabKey ?? null

  // A fallback or close can change the focused tab without going through
  // activateTab; keep the active session in step with the terminal on screen.
  const previousFocusedTab = useRef(focusedTabKey)
  useEffect(() => {
    if (focusedTabKey === previousFocusedTab.current) return
    previousFocusedTab.current = focusedTabKey
    if (focusedTabKey !== null) selectForTab(focusedTabKey)
  }, [focusedTabKey, selectForTab])

  const activateTabInPane = useCallback(
    (paneId: string, key: string) => {
      // Surfaces can add a tab and place it in the same handler, before the
      // new tab reaches `tabs`; reconciliation clears a genuinely bad key.
      selectForTab(key)
      setState((current) => {
        if (!containsPane(current.root, paneId)) return current
        const root = setPaneTabKey(
          clearTabEverywhere(current.root, key, paneId),
          paneId,
          key
        )
        return { ...current, root, focusedPaneId: paneId }
      })
    },
    [selectForTab]
  )

  const activateTab = useCallback(
    (key: string) => {
      // Do not gate this on `validKeys`: surfaces open a tab in the store and
      // activate it in the same handler, before the new tab reaches this hook.
      // Reconciliation clears the pane if the key is genuinely not a tab.
      selectForTab(key)
      setState((current) => {
        const existing = findPaneForTabKey(current.root, key)
        if (existing !== null) {
          return existing.paneId === current.focusedPaneId
            ? current
            : { ...current, focusedPaneId: existing.paneId }
        }
        const root = setPaneTabKey(
          clearTabEverywhere(current.root, key, current.focusedPaneId),
          current.focusedPaneId,
          key
        )
        return { ...current, root }
      })
    },
    [selectForTab, validKeys]
  )

  const focusPane = useCallback(
    (paneId: string) => {
      setState((current) => {
        if (!containsPane(current.root, paneId) || current.focusedPaneId === paneId) {
          return current
        }
        return { ...current, focusedPaneId: paneId }
      })
      const pane = findPane(state.root, paneId)
      if (pane?.activeTabKey !== null && pane?.activeTabKey !== undefined) {
        selectForTab(pane.activeTabKey)
      }
    },
    [selectForTab, state.root]
  )

  const setPaneTab = useCallback(
    (paneId: string, key: string | null) => {
      if (key !== null) {
        if (!validKeys.has(key)) return
        selectForTab(key)
      }
      setState((current) => {
        if (!containsPane(current.root, paneId)) return current
        const root =
          key === null
            ? setPaneTabKey(current.root, paneId, null)
            : setPaneTabKey(clearTabEverywhere(current.root, key, paneId), paneId, key)
        return { ...current, root, focusedPaneId: paneId }
      })
    },
    [selectForTab, validKeys]
  )

  const splitPane = useCallback((side: SplitSide) => {
    const newLeaf = createLeaf(null)
    setState((current) => ({
      ...current,
      root: splitAround(current.root, current.focusedPaneId, side, newLeaf),
      focusedPaneId: newLeaf.paneId
    }))
    setZoomedPaneId(null)
  }, [])

  const splitWithTab = useCallback(
    (key: string, side: SplitSide) => {
      if (!validKeys.has(key)) return
      selectForTab(key)
      const newLeaf = createLeaf(key)
      setState((current) => ({
        ...current,
        root: splitAround(
          clearTabEverywhere(current.root, key, newLeaf.paneId),
          current.focusedPaneId,
          side,
          newLeaf
        ),
        focusedPaneId: newLeaf.paneId
      }))
      setZoomedPaneId(null)
    },
    [selectForTab, validKeys]
  )

  const moveTabToPane = useCallback(
    (key: string, paneId: string) => {
      activateTabInPane(paneId, key)
    },
    [activateTabInPane]
  )

  /** A tab dropped on a pane's center moves there; an edge splits the pane. */
  const placeTabInPane = useCallback(
    (key: string, paneId: string, side: SplitSide | 'center') => {
      selectForTab(key)
      setState((current) => {
        if (!containsPane(current.root, paneId)) return current
        if (side === 'center') {
          const root = setPaneTabKey(
            clearTabEverywhere(current.root, key, paneId),
            paneId,
            key
          )
          return { ...current, root, focusedPaneId: paneId }
        }
        const leaf = createLeaf(key)
        const root = splitAround(
          clearTabEverywhere(current.root, key, leaf.paneId),
          paneId,
          side,
          leaf
        )
        return { ...current, root, focusedPaneId: leaf.paneId }
      })
      setZoomedPaneId(null)
    },
    [selectForTab]
  )

  const closePane = useCallback((paneId: string) => {
    setState((current) => {
      if (!containsPane(current.root, paneId)) return current
      const without = removePane(current.root, paneId)
      if (without === null) {
        const leaf = createLeaf(null)
        return { v: 2, root: leaf, focusedPaneId: leaf.paneId }
      }
      if (!containsPane(without, current.focusedPaneId)) {
        return { ...current, root: without, focusedPaneId: firstLeafPaneId(without) }
      }
      return { ...current, root: without }
    })
  }, [])

  const unsplit = useCallback(() => {
    setState((current) => {
      const pane = findPane(current.root, current.focusedPaneId)
      const leaf = createLeaf(pane?.activeTabKey ?? null, current.focusedPaneId)
      return { v: 2, root: leaf, focusedPaneId: leaf.paneId }
    })
    setZoomedPaneId(null)
  }, [])

  const toggleZoom = useCallback(() => {
    setZoomedPaneId((current) => {
      if (current !== null) return null
      return state.root.kind === 'split' ? state.focusedPaneId : null
    })
  }, [state.root, state.focusedPaneId])

  const focus = useCallback(
    (direction: SplitSide) => {
      const target = focusPaneInTree(state.root, state.focusedPaneId, direction)
      if (target !== null) focusPane(target)
    },
    [focusPane, state.root, state.focusedPaneId]
  )

  const dropPane = useCallback(
    (sourcePaneId: string, targetPaneId: string, zone: PaneDropZone) => {
      setState((current) => {
        const root = dropPaneInTree(current.root, sourcePaneId, targetPaneId, zone)
        const focusedPaneId = containsPane(root, current.focusedPaneId)
          ? current.focusedPaneId
          : containsPane(root, targetPaneId)
            ? targetPaneId
            : firstLeafPaneId(root)
        return { ...current, root, focusedPaneId }
      })
    },
    []
  )

  const resize = useCallback((branchId: string, ratio: number) => {
    setState((current) => {
      const root = updateRatio(current.root, branchId, ratio)
      return root === current.root ? current : { ...current, root }
    })
  }, [])

  return {
    root: state.root,
    focusedPaneId: state.focusedPaneId,
    zoomedPaneId,
    focusedTabKey,
    displayedTabKeys: () => displayedTabKeys(state.root),
    activateTab,
    activateTabInPane,
    focusPane,
    splitPane,
    splitWithTab,
    moveTabToPane,
    placeTabInPane,
    closePane,
    unsplit,
    toggleZoom,
    focus,
    dropPane,
    resize,
    setPaneTabKey: setPaneTab
  }
}

/** Pane ids in layout order; exposed for tests and callers that render the tree. */
export function paneIds(root: SplitNode): string[] {
  return leafPaneIds(root)
}
