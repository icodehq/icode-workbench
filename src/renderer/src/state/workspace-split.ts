/**
 * The split view is a recursive tree of panes.
 *
 * A pane is a display slot, not a session. Each leaf remembers the key of the
 * worktree tab it shows. A tab is displayed in at most one pane; tabs belong to
 * the workspace tab list, and splitting creates an empty pane the user fills
 * from the tab picker.
 */

export type SplitDirection = 'horizontal' | 'vertical'
export type SplitSide = 'left' | 'right' | 'up' | 'down'
export type SplitSlot = 'first' | 'second'
export type PaneDropZone = 'left' | 'right' | 'top' | 'bottom' | 'center'

export type SplitLeaf = {
  kind: 'leaf'
  paneId: string
  /** The worktree tab key this pane shows; null is the empty pane. */
  activeTabKey: string | null
}

export type SplitBranch = {
  kind: 'split'
  id: string
  /** Horizontal branches place children side by side; vertical ones stack them. */
  direction: SplitDirection
  /** Share of the branch's span given to the first child. */
  ratio: number
  /** A divider the user moved keeps its ratio while siblings are added. */
  pinned: boolean
  first: SplitNode
  second: SplitNode
}

export type SplitNode = SplitLeaf | SplitBranch

export const SPLIT_MIN_RATIO = 0.15
export const SPLIT_MAX_RATIO = 0.85

let paneSequence = 0
let branchSequence = 0

export function nextPaneId(): string {
  paneSequence += 1
  return `pane-${Date.now().toString(36)}-${paneSequence}`
}

function nextBranchId(): string {
  branchSequence += 1
  return `split-${Date.now().toString(36)}-${branchSequence}`
}

/** The axis a side splits along. Left/right are side-by-side branches. */
export function directionForSide(side: SplitSide): SplitDirection {
  return side === 'left' || side === 'right' ? 'horizontal' : 'vertical'
}

/** Left/up insert the new pane before the target; right/down insert it after. */
export function slotForSide(side: SplitSide): SplitSlot {
  return side === 'left' || side === 'up' ? 'first' : 'second'
}

export function clampedRatio(ratio: number): number {
  return Math.min(SPLIT_MAX_RATIO, Math.max(SPLIT_MIN_RATIO, ratio))
}

function branch(
  direction: SplitDirection,
  ratio: number,
  first: SplitNode,
  second: SplitNode,
  pinned = false
): SplitBranch {
  return {
    kind: 'split',
    id: nextBranchId(),
    direction,
    ratio: clampedRatio(ratio),
    pinned,
    first,
    second
  }
}

export function createLeaf(activeTabKey: string | null = null, paneId = nextPaneId()): SplitLeaf {
  return { kind: 'leaf', paneId, activeTabKey }
}

/** Whether a pane belongs to the tree. */
export function containsPane(node: SplitNode | null, paneId: string): boolean {
  if (node === null) return false
  if (node.kind === 'leaf') return node.paneId === paneId
  return containsPane(node.first, paneId) || containsPane(node.second, paneId)
}

/** Every pane id, in layout order. */
export function leafPaneIds(node: SplitNode | null): string[] {
  if (node === null) return []
  if (node.kind === 'leaf') return [node.paneId]
  return [...leafPaneIds(node.first), ...leafPaneIds(node.second)]
}

export function firstLeafPaneId(node: SplitNode): string {
  return node.kind === 'leaf' ? node.paneId : firstLeafPaneId(node.first)
}

export function findPane(node: SplitNode | null, paneId: string): SplitLeaf | null {
  if (node === null) return null
  if (node.kind === 'leaf') return node.paneId === paneId ? node : null
  return findPane(node.first, paneId) ?? findPane(node.second, paneId)
}

/** The pane currently displaying a tab key, or null. */
export function findPaneForTabKey(node: SplitNode | null, key: string): SplitLeaf | null {
  if (node === null) return null
  if (node.kind === 'leaf') return node.activeTabKey === key ? node : null
  return findPaneForTabKey(node.first, key) ?? findPaneForTabKey(node.second, key)
}

/** Every tab key currently displayed, in layout order. */
export function displayedTabKeys(node: SplitNode | null): string[] {
  if (node === null) return []
  if (node.kind === 'leaf') return node.activeTabKey === null ? [] : [node.activeTabKey]
  return [...displayedTabKeys(node.first), ...displayedTabKeys(node.second)]
}

/** Replaces one leaf with a branch around it, preserving pane ids. */
export function splitAround(
  node: SplitNode,
  targetPaneId: string,
  side: SplitSide,
  newLeaf: SplitLeaf
): SplitNode {
  if (node.kind === 'leaf') {
    if (node.paneId !== targetPaneId) return node
    const inserted =
      slotForSide(side) === 'first'
        ? branch(directionForSide(side), 0.5, newLeaf, node)
        : branch(directionForSide(side), 0.5, node, newLeaf)
    return inserted
  }
  if (!containsPane(node.first, targetPaneId) && !containsPane(node.second, targetPaneId)) {
    return node
  }
  if (containsPane(node.first, targetPaneId)) {
    return { ...node, first: splitAround(node.first, targetPaneId, side, newLeaf) }
  }
  return { ...node, second: splitAround(node.second, targetPaneId, side, newLeaf) }
}

/** Removes a pane; a branch that loses one child collapses into the other. */
export function removePane(node: SplitNode | null, paneId: string): SplitNode | null {
  if (node === null) return null
  if (node.kind === 'leaf') return node.paneId === paneId ? null : node
  if (containsPane(node.first, paneId)) {
    const first = removePane(node.first, paneId)
    return first === null ? node.second : { ...node, first }
  }
  if (containsPane(node.second, paneId)) {
    const second = removePane(node.second, paneId)
    return second === null ? node.first : { ...node, second }
  }
  return node
}

/** Exchanges the tabs shown by two panes without moving the panes themselves. */
export function swapPaneContents(
  node: SplitNode,
  firstPaneId: string,
  secondPaneId: string
): SplitNode {
  if (node.kind === 'leaf' || firstPaneId === secondPaneId) return node
  const first = findPane(node, firstPaneId)
  const second = findPane(node, secondPaneId)
  if (first === null || second === null) return node
  const cleared = setPaneTabKey(
    setPaneTabKey(node, firstPaneId, null),
    secondPaneId,
    null
  )
  return setPaneTabKey(
    setPaneTabKey(cleared, firstPaneId, second.activeTabKey),
    secondPaneId,
    first.activeTabKey
  )
}

/** Sets one pane's tab. Clears the same key from any other pane first. */
export function setPaneTabKey(
  node: SplitNode,
  paneId: string,
  activeTabKey: string | null
): SplitNode {
  if (node.kind === 'leaf') {
    return node.paneId === paneId ? { ...node, activeTabKey } : node
  }
  return {
    ...node,
    first: setPaneTabKey(node.first, paneId, activeTabKey),
    second: setPaneTabKey(node.second, paneId, activeTabKey)
  }
}

export function clearTabEverywhere(node: SplitNode, key: string, exceptPaneId: string): SplitNode {
  if (node.kind === 'leaf') {
    return node.paneId !== exceptPaneId && node.activeTabKey === key
      ? { ...node, activeTabKey: null }
      : node
  }
  return {
    ...node,
    first: clearTabEverywhere(node.first, key, exceptPaneId),
    second: clearTabEverywhere(node.second, key, exceptPaneId)
  }
}

/** Clears pane tabs that are no longer in the worktree tab list. */
export function reconcilePaneTabs(node: SplitNode, validKeys: ReadonlySet<string>): SplitNode {
  if (node.kind === 'leaf') {
    return node.activeTabKey !== null && !validKeys.has(node.activeTabKey)
      ? { ...node, activeTabKey: null }
      : node
  }
  return {
    ...node,
    first: reconcilePaneTabs(node.first, validKeys),
    second: reconcilePaneTabs(node.second, validKeys)
  }
}

/**
 * Drops a pane onto another. Center swaps the two tabs; an edge takes the
 * source tab, removes the source pane and splits the target with it.
 */
const DROP_SIDE: Record<Exclude<PaneDropZone, 'center'>, SplitSide> = {
  left: 'left',
  right: 'right',
  top: 'up',
  bottom: 'down'
}

export function dropPane(
  node: SplitNode,
  sourcePaneId: string,
  targetPaneId: string,
  zone: PaneDropZone
): SplitNode {
  if (sourcePaneId === targetPaneId) return node
  if (zone === 'center') return swapPaneContents(node, sourcePaneId, targetPaneId)
  const source = findPane(node, sourcePaneId)
  if (source === null) return node
  const without = removePane(node, sourcePaneId)
  if (without === null || !containsPane(without, targetPaneId)) return without ?? node
  return splitAround(
    without,
    targetPaneId,
    DROP_SIDE[zone],
    createLeaf(source.activeTabKey, sourcePaneId)
  )
}

export function updateRatio(node: SplitNode, branchId: string, ratio: number): SplitNode {
  if (node.kind === 'leaf') return node
  if (node.id === branchId) return { ...node, ratio: clampedRatio(ratio), pinned: true }
  return {
    ...node,
    first: updateRatio(node.first, branchId, ratio),
    second: updateRatio(node.second, branchId, ratio)
  }
}

export type SplitRect = {
  paneId: string
  activeTabKey: string | null
  x: number
  y: number
  width: number
  height: number
}

/** Normalized pane rectangles, ignoring divider thickness. */
export function layoutSplit(node: SplitNode): SplitRect[] {
  const rects: SplitRect[] = []
  const visit = (
    current: SplitNode,
    x: number,
    y: number,
    width: number,
    height: number
  ): void => {
    if (current.kind === 'leaf') {
      rects.push({
        paneId: current.paneId,
        activeTabKey: current.activeTabKey,
        x,
        y,
        width,
        height
      })
      return
    }
    if (current.direction === 'horizontal') {
      const firstWidth = width * current.ratio
      visit(current.first, x, y, firstWidth, height)
      visit(current.second, x + firstWidth, y, width - firstWidth, height)
      return
    }
    const firstHeight = height * current.ratio
    visit(current.first, x, y, width, firstHeight)
    visit(current.second, x, y + firstHeight, width, height - firstHeight)
  }
  visit(node, 0, 0, 1, 1)
  return rects
}

/** The nearest pane in a direction, weighted towards panes that line up. */
export function focusPane(
  root: SplitNode,
  fromPaneId: string,
  direction: SplitSide
): string | null {
  const rects = layoutSplit(root)
  const from = rects.find((rect) => rect.paneId === fromPaneId)
  if (from === undefined) return null
  const fromX = from.x + from.width / 2
  const fromY = from.y + from.height / 2
  const horizontal = direction === 'left' || direction === 'right'
  let best: { paneId: string; score: number } | null = null
  for (const rect of rects) {
    if (rect.paneId === fromPaneId) continue
    const x = rect.x + rect.width / 2
    const y = rect.y + rect.height / 2
    const ahead =
      direction === 'left'
        ? x < fromX
        : direction === 'right'
          ? x > fromX
          : direction === 'up'
            ? y < fromY
            : y > fromY
    if (!ahead) continue
    const primary =
      direction === 'left'
        ? fromX - x
        : direction === 'right'
          ? x - fromX
          : direction === 'up'
            ? fromY - y
            : y - fromY
    const perpendicular = horizontal ? Math.abs(y - fromY) : Math.abs(x - fromX)
    const score = primary + perpendicular * 2
    if (best === null || score < best.score) best = { paneId: rect.paneId, score }
  }
  return best?.paneId ?? null
}

const DROP_CENTER_FRACTION = 0.4

/** Maps a point in a pane to the edge or centre that received the drop. */
export function dropZoneAt(
  x: number,
  y: number,
  width: number,
  height: number
): PaneDropZone {
  if (width <= 0 || height <= 0) return 'center'
  const half = DROP_CENTER_FRACTION / 2
  const nx = x / width
  const ny = y / height
  if (nx >= 0.5 - half && nx <= 0.5 + half && ny >= 0.5 - half && ny <= 0.5 + half) {
    return 'center'
  }
  let zone: PaneDropZone = 'left'
  let distance = x
  if (width - x < distance) {
    zone = 'right'
    distance = width - x
  }
  if (y < distance) {
    zone = 'top'
    distance = y
  }
  if (height - y < distance) {
    zone = 'bottom'
  }
  return zone
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export type PersistedSplit = {
  v: 2
  root: SplitNode
  focusedPaneId: string
}

/** Validates a persisted workspace split. Malformed trees are discarded whole. */
export function parseSplitState(value: unknown): PersistedSplit | null {
  if (!record(value) || value.v !== 2) return null
  const root = parseSplitNode(value.root)
  if (root === null) return null
  const paneIds = leafPaneIds(root)
  const tabKeys = displayedTabKeys(root)
  if (new Set(paneIds).size !== paneIds.length) return null
  if (new Set(tabKeys).size !== tabKeys.length) return null
  const focusedPaneId =
    typeof value.focusedPaneId === 'string' && paneIds.includes(value.focusedPaneId)
      ? value.focusedPaneId
      : firstLeafPaneId(root)
  return { v: 2, root, focusedPaneId }
}

function parseSplitNode(value: unknown): SplitNode | null {
  if (!record(value)) return null
  if (value.kind === 'leaf') {
    if (typeof value.paneId !== 'string' || value.paneId.length === 0) return null
    if (value.activeTabKey !== null && typeof value.activeTabKey !== 'string') return null
    return {
      kind: 'leaf',
      paneId: value.paneId,
      activeTabKey: value.activeTabKey ?? null
    }
  }
  if (value.kind !== 'split') return null
  if (typeof value.id !== 'string' || value.id.length === 0) return null
  if (value.direction !== 'horizontal' && value.direction !== 'vertical') return null
  if (typeof value.ratio !== 'number' || !Number.isFinite(value.ratio)) return null
  if (typeof value.pinned !== 'boolean') return null
  const first = parseSplitNode(value.first)
  const second = parseSplitNode(value.second)
  if (first === null || second === null) return null
  return {
    kind: 'split',
    id: value.id,
    direction: value.direction,
    ratio: clampedRatio(value.ratio),
    pinned: value.pinned,
    first,
    second
  }
}
