/**
 * The split view is an explicit pair of sessions.
 *
 * Pane order is state, not a consequence of which session is active: a tab can
 * be split to either side, moved between panes, or swapped without changing the
 * selected tab. The active session always belongs to one of the two panes, but
 * it may sit on either side.
 */

export type PaneSide = 'left' | 'right'

export type SplitLayout = {
  left: string
  right: string
}

/** A split action may need to activate a session when it replaces its pane. */
export type SplitAction = {
  layout: SplitLayout | null
  select: string | null
}

export const SPLIT_MIN_RATIO = 0.2
export const SPLIT_MAX_RATIO = 0.8

/** The side a session occupies, or null when it is not in the pair. */
export function paneSide(
  layout: SplitLayout | null,
  sessionId: string | null
): PaneSide | null {
  if (layout === null || sessionId === null) return null
  if (layout.left === sessionId) return 'left'
  if (layout.right === sessionId) return 'right'
  return null
}

/**
 * Opens the first other visible session in the right pane, or closes the split.
 * This is the toolbar toggle's action.
 */
export function toggleSplit(
  layout: SplitLayout | null,
  activeId: string | null,
  visibleIds: readonly string[]
): SplitLayout | null {
  if (layout !== null) return null
  if (activeId === null || !visibleIds.includes(activeId)) return null
  const next = visibleIds.find((id) => id !== activeId)
  return next === undefined ? null : { left: activeId, right: next }
}

/**
 * Places a tab into the requested pane.
 *
 * With no split, the active session takes the other pane, so the clicked tab
 * lands where it was asked for. An open split moves the tab when it already
 * belongs to the pair; otherwise the tab replaces the requested pane.
 * Replacing the pane that holds the active session returns that session in
 * `select`, so the caller can keep the active session visible.
 */
export function splitOn(
  layout: SplitLayout | null,
  side: PaneSide,
  sessionId: string,
  activeId: string | null,
  visibleIds: readonly string[]
): SplitAction {
  if (!visibleIds.includes(sessionId)) return { layout, select: null }
  if (layout === null) {
    if (activeId === null || activeId === sessionId || !visibleIds.includes(activeId)) {
      return { layout, select: null }
    }
    const pair =
      side === 'left'
        ? { left: sessionId, right: activeId }
        : { left: activeId, right: sessionId }
    return { layout: pair, select: null }
  }
  if (paneSide(layout, sessionId) === side) return { layout, select: null }
  if (paneSide(layout, sessionId) !== null) {
    return { layout: { left: layout.right, right: layout.left }, select: null }
  }
  const replacedActive = activeId === layout[side]
  const next =
    side === 'left'
      ? { left: sessionId, right: layout.right }
      : { left: layout.left, right: sessionId }
  return { layout: next, select: replacedActive ? sessionId : null }
}

/** Exchanges the two panes. The active session stays selected. */
export function swapPanes(layout: SplitLayout | null): SplitLayout | null {
  return layout === null ? null : { left: layout.right, right: layout.left }
}

/**
 * Reconciles the pair with the selected tab and the visible tabs.
 *
 * Selecting a tab that is already in the pair changes nothing, so the panes
 * never reorder behind the user's back. A tab from outside the pair takes the
 * place of the previously active session, which is the pane the user was last
 * in. A session that disappears from the visible tabs collapses the split.
 */
export function reconcileSplit(
  layout: SplitLayout | null,
  activeId: string | null,
  previousActiveId: string | null,
  visibleIds: readonly string[]
): SplitLayout | null {
  if (layout === null || activeId === null) return null
  if (!visibleIds.includes(layout.left) || !visibleIds.includes(layout.right)) return null
  if (activeId === layout.left || activeId === layout.right) return layout
  if (!visibleIds.includes(activeId)) return layout
  return paneSide(layout, previousActiveId) === 'right'
    ? { left: layout.left, right: activeId }
    : { left: activeId, right: layout.right }
}

/** Keeps the divider's left-pane share within the usable range. */
export function clampSplitRatio(ratio: number): number {
  return Math.min(SPLIT_MAX_RATIO, Math.max(SPLIT_MIN_RATIO, ratio))
}
