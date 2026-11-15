/**
 * The split view is a recursive tree of sessions.
 *
 * A branch records the axis it divides, the share given to its first child and
 * whether the user has pinned that ratio. A leaf is one session. The four split
 * directions are encoded as an axis plus a child slot, so a layout that nests
 * both axes needs no special nodes: splitting a leaf replaces it with a branch.
 */

export type SplitDirection = 'horizontal' | 'vertical'
export type SplitSide = 'left' | 'right' | 'up' | 'down'
export type SplitSlot = 'first' | 'second'
export type PaneDropZone = 'left' | 'right' | 'top' | 'bottom' | 'center'

export type SplitLeaf = {
  kind: 'leaf'
  sessionId: string
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

let branchSequence = 0

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

/** Whether a session belongs to the tree. */
export function containsSession(node: SplitNode | null, sessionId: string): boolean {
  if (node === null) return false
  if (node.kind === 'leaf') return node.sessionId === sessionId
  return containsSession(node.first, sessionId) || containsSession(node.second, sessionId)
}

/** The leaves in layout order. */
export function leafSessionIds(node: SplitNode | null): string[] {
  if (node === null) return []
  if (node.kind === 'leaf') return [node.sessionId]
  return [...leafSessionIds(node.first), ...leafSessionIds(node.second)]
}

export function firstLeafSessionId(node: SplitNode): string {
  return node.kind === 'leaf' ? node.sessionId : firstLeafSessionId(node.first)
}

/**
 * Segments along an axis: same-direction branches flatten into their children,
 * while leaves and cross-axis branches count as one segment.
 */
export function segmentCount(node: SplitNode, direction: SplitDirection): number {
  if (node.kind === 'leaf') return 1
  if (node.direction !== direction) return 1
  return segmentCount(node.first, direction) + segmentCount(node.second, direction)
}

/**
 * Rebalances every branch the user has not pinned. A pinned divider keeps its
 * share; its children still equalize inside that share.
 */
export function equalized(node: SplitNode): SplitNode {
  if (node.kind === 'leaf') return node
  const first = equalized(node.first)
  const second = equalized(node.second)
  const ratio = node.pinned
    ? node.ratio
    : clampedRatio(
        segmentCount(first, node.direction) /
          (segmentCount(first, node.direction) + segmentCount(second, node.direction))
      )
  if (first === node.first && second === node.second && ratio === node.ratio) return node
  return { ...node, ratio, first, second }
}

/** Builds the first tree: the active session plus the new pane. */
export function splitPair(
  activeSessionId: string,
  side: SplitSide,
  newSessionId: string
): SplitBranch {
  const active: SplitNode = { kind: 'leaf', sessionId: activeSessionId }
  const added: SplitNode = { kind: 'leaf', sessionId: newSessionId }
  return slotForSide(side) === 'first'
    ? branch(directionForSide(side), 0.5, added, active)
    : branch(directionForSide(side), 0.5, active, added)
}

/**
 * Places a tab beside the focused pane. A tab already in the tree is detached
 * first, so the action moves that pane instead of duplicating its leaf.
 */
export function placeSession(
  root: SplitNode | null,
  activeSessionId: string,
  side: SplitSide,
  sessionId: string
): SplitNode | null {
  let base = root
  if (base !== null && containsSession(base, sessionId)) {
    base = removeLeaf(base, sessionId)
  }
  if (base === null) return equalized(splitPair(activeSessionId, side, sessionId))
  if (!containsSession(base, activeSessionId)) return root
  return equalized(splitAround(base, activeSessionId, side, sessionId))
}

/** Replaces the target leaf with a branch holding the target and a new session. */
export function splitAround(
  node: SplitNode,
  targetSessionId: string,
  side: SplitSide,
  newSessionId: string
): SplitNode {
  if (node.kind === 'leaf') {
    if (node.sessionId !== targetSessionId) return node
    const added: SplitNode = { kind: 'leaf', sessionId: newSessionId }
    return slotForSide(side) === 'first'
      ? branch(directionForSide(side), 0.5, added, node)
      : branch(directionForSide(side), 0.5, node, added)
  }
  const first = splitAround(node.first, targetSessionId, side, newSessionId)
  const second = splitAround(node.second, targetSessionId, side, newSessionId)
  if (first === node.first && second === node.second) return node
  return { ...node, first, second }
}

/**
 * Removes a leaf. Its parent collapses into the surviving sibling; when the
 * last leaf goes the tree disappears.
 */
export function removeLeaf(node: SplitNode | null, sessionId: string): SplitNode | null {
  if (node === null) return null
  if (node.kind === 'leaf') return node.sessionId === sessionId ? null : node
  const first = removeLeaf(node.first, sessionId)
  const second = removeLeaf(node.second, sessionId)
  if (first === null) return second
  if (second === null) return first
  if (first === node.first && second === node.second) return node
  return { ...node, first, second }
}

function exchanged(node: SplitNode, a: string, b: string): SplitNode {
  if (node.kind === 'leaf') {
    if (node.sessionId === a) return { ...node, sessionId: b }
    if (node.sessionId === b) return { ...node, sessionId: a }
    return node
  }
  const first = exchanged(node.first, a, b)
  const second = exchanged(node.second, a, b)
  if (first === node.first && second === node.second) return node
  return { ...node, first, second }
}

/** Exchanges two leaves, leaving the tree's shape and every ratio untouched. */
export function swapLeaves(node: SplitNode, a: string, b: string): SplitNode {
  if (a === b || !containsSession(node, a) || !containsSession(node, b)) return node
  return exchanged(node, a, b)
}

/** The centred share of a pane that swaps instead of re-splitting. */
const DROP_CENTER_FRACTION = 0.4

/** Maps a point in a pane to the edge half or centre that received the drop. */
export function dropZoneAt(x: number, y: number, width: number, height: number): PaneDropZone {
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

const DROP_SIDE: Record<Exclude<PaneDropZone, 'center'>, SplitSide> = {
  left: 'left',
  right: 'right',
  top: 'up',
  bottom: 'down'
}

/**
 * Applies a pane drag. A centre drop swaps the two leaves; an edge drop removes
 * the dragged leaf and re-splits the target on that edge.
 */
export function dropPane(
  root: SplitNode,
  sourceId: string,
  targetId: string,
  zone: PaneDropZone
): SplitNode | null {
  if (sourceId === targetId) return root
  if (!containsSession(root, sourceId) || !containsSession(root, targetId)) return root
  if (zone === 'center') return swapLeaves(root, sourceId, targetId)
  const base = removeLeaf(root, sourceId)
  if (base === null || !containsSession(base, targetId)) return root
  return equalized(splitAround(base, targetId, DROP_SIDE[zone], sourceId))
}

/** Sets one divider ratio and pins it. */
export function updateRatio(node: SplitNode, branchId: string, ratio: number): SplitNode {
  if (node.kind === 'leaf') return node
  if (node.id === branchId) {
    const clamped = clampedRatio(ratio)
    if (clamped === node.ratio && node.pinned) return node
    return { ...node, ratio: clamped, pinned: true }
  }
  const first = updateRatio(node.first, branchId, ratio)
  const second = updateRatio(node.second, branchId, ratio)
  if (first === node.first && second === node.second) return node
  return { ...node, first, second }
}

/** Drops leaves whose sessions are no longer visible, collapsing their parents. */
export function pruneLeaves(
  node: SplitNode | null,
  visible: ReadonlySet<string>
): SplitNode | null {
  if (node === null) return null
  if (node.kind === 'leaf') return visible.has(node.sessionId) ? node : null
  const first = pruneLeaves(node.first, visible)
  const second = pruneLeaves(node.second, visible)
  if (first === null) return second
  if (second === null) return first
  if (first === node.first && second === node.second) return node
  return { ...node, first, second }
}

/** Replaces a leaf's session without changing the layout. */
export function replaceLeaf(
  node: SplitNode,
  targetSessionId: string,
  sessionId: string
): SplitNode {
  if (node.kind === 'leaf') {
    return node.sessionId === targetSessionId ? { ...node, sessionId } : node
  }
  const first = replaceLeaf(node.first, targetSessionId, sessionId)
  const second = replaceLeaf(node.second, targetSessionId, sessionId)
  if (first === node.first && second === node.second) return node
  return { ...node, first, second }
}

/** The group that contains a session, or null when it is not split. */
export function groupOf(
  groups: readonly SplitNode[],
  sessionId: string | null
): SplitNode | null {
  if (sessionId === null) return null
  return groups.find((group) => containsSession(group, sessionId)) ?? null
}

export function groupedSessionIds(groups: readonly SplitNode[]): Set<string> {
  const ids = new Set<string>()
  for (const group of groups) {
    for (const id of leafSessionIds(group)) ids.add(id)
  }
  return ids
}

/** Drops invisible leaves and dissolves groups without two panes left. */
export function pruneGroups(groups: SplitNode[], visibleIds: readonly string[]): SplitNode[] {
  const visible = new Set(visibleIds)
  const seen = new Set<string>()
  const next: SplitNode[] = []
  for (const group of groups) {
    const pruned = pruneLeaves(group, visible)
    if (pruned === null || pruned.kind !== 'split') continue
    const ids = leafSessionIds(pruned)
    if (ids.length < 2 || ids.some((id) => seen.has(id))) continue
    ids.forEach((id) => seen.add(id))
    next.push(equalized(pruned))
  }
  if (next.length === groups.length && next.every((group, index) => group === groups[index])) {
    return groups
  }
  return next
}

export function removeSessionFromGroups(
  groups: SplitNode[],
  sessionId: string
): SplitNode[] {
  const index = groups.findIndex((group) => containsSession(group, sessionId))
  if (index < 0) return groups
  const group = groups[index]
  if (group === undefined) return groups
  const next = [...groups]
  const removed = removeLeaf(group, sessionId)
  if (removed === null || removed.kind !== 'split') next.splice(index, 1)
  else next[index] = equalized(removed)
  return next
}

/**
 * Places a session beside an anchor. A session already in another group moves
 * out of it; a group that falls to one pane dissolves.
 */
export function placeInGroups(
  groups: SplitNode[],
  anchorId: string,
  side: SplitSide,
  sessionId: string
): SplitNode[] {
  if (anchorId === sessionId) return groups
  const without = removeSessionFromGroups(groups, sessionId)
  const anchorIndex = without.findIndex((group) => containsSession(group, anchorId))
  const anchor = without[anchorIndex]
  if (anchor === undefined) {
    return [...without, equalized(splitPair(anchorId, side, sessionId))]
  }
  const next = [...without]
  next[anchorIndex] = equalized(splitAround(anchor, anchorId, side, sessionId))
  return next
}

/** Opens a group beside the active session, or closes the group it belongs to. */
export function toggleGroupForActive(
  groups: SplitNode[],
  activeId: string | null,
  visibleIds: readonly string[]
): SplitNode[] {
  const grouped = groupOf(groups, activeId)
  if (grouped !== null) return groups.filter((group) => group !== grouped)
  if (activeId === null || !visibleIds.includes(activeId)) return groups
  const used = groupedSessionIds(groups)
  const next = visibleIds.find((id) => id !== activeId && !used.has(id))
  if (next === undefined) return groups
  return [...groups, equalized(splitPair(activeId, 'right', next))]
}

export function updateGroupRatio(
  groups: SplitNode[],
  branchId: string,
  ratio: number
): SplitNode[] {
  let changed = false
  const next = groups.map((group) => {
    const updated = updateRatio(group, branchId, ratio)
    if (updated !== group) changed = true
    return updated
  })
  return changed ? next : groups
}

export function swapInGroups(groups: SplitNode[], a: string, b: string): SplitNode[] {
  const index = groups.findIndex(
    (group) => containsSession(group, a) && containsSession(group, b)
  )
  if (index < 0) return groups
  const group = groups[index]
  if (group === undefined) return groups
  const updated = swapLeaves(group, a, b)
  if (updated === group) return groups
  const next = [...groups]
  next[index] = updated
  return next
}

export function dropInGroups(
  groups: SplitNode[],
  sourceId: string,
  targetId: string,
  zone: PaneDropZone
): SplitNode[] {
  const index = groups.findIndex(
    (group) => containsSession(group, sourceId) && containsSession(group, targetId)
  )
  if (index < 0) return groups
  const group = groups[index]
  if (group === undefined) return groups
  const updated = dropPane(group, sourceId, targetId, zone)
  if (updated === group) return groups
  const next = [...groups]
  if (updated === null || updated.kind !== 'split') next.splice(index, 1)
  else next[index] = updated
  return next
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Validates a persisted tree. Anything malformed is discarded rather than
 * partially restored; live-session pruning happens separately after loading.
 */
export function parseSplitTree(value: unknown): SplitNode | null {
  if (!record(value)) return null
  if (value.kind === 'leaf') {
    return typeof value.sessionId === 'string' && value.sessionId.length > 0
      ? { kind: 'leaf', sessionId: value.sessionId }
      : null
  }
  if (value.kind !== 'split') return null
  if (typeof value.id !== 'string' || value.id.length === 0) return null
  if (value.direction !== 'horizontal' && value.direction !== 'vertical') return null
  if (typeof value.ratio !== 'number' || !Number.isFinite(value.ratio)) return null
  if (typeof value.pinned !== 'boolean') return null
  const first = parseSplitTree(value.first)
  const second = parseSplitTree(value.second)
  if (first === null || second === null) return null
  const ids = [...leafSessionIds(first), ...leafSessionIds(second)]
  if (new Set(ids).size !== ids.length) return null
  return {
    kind: 'split',
    id: value.id,
    direction: value.direction === 'horizontal' ? 'horizontal' : 'vertical',
    ratio: clampedRatio(value.ratio),
    pinned: value.pinned,
    first,
    second
  }
}

/** Validates persisted groups. A single legacy tree is read as one group. */
export function parseSplitGroups(value: unknown): SplitNode[] {
  const candidates = Array.isArray(value) ? value : [value]
  const groups: SplitNode[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const parsed = parseSplitTree(candidate)
    if (parsed === null || parsed.kind !== 'split') continue
    const ids = leafSessionIds(parsed)
    if (ids.length < 2 || ids.some((id) => seen.has(id))) continue
    ids.forEach((id) => seen.add(id))
    groups.push(parsed)
  }
  return groups
}

export type SplitRect = {
  sessionId: string
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
      rects.push({ sessionId: current.sessionId, x, y, width, height })
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

/** The nearest leaf in a direction, weighted towards panes that line up. */
export function focusSession(
  root: SplitNode,
  fromSessionId: string,
  direction: SplitSide
): string | null {
  const rects = layoutSplit(root)
  const from = rects.find((rect) => rect.sessionId === fromSessionId)
  if (from === undefined) return null
  const fromX = from.x + from.width / 2
  const fromY = from.y + from.height / 2
  const horizontal = direction === 'left' || direction === 'right'
  let best: { sessionId: string; score: number } | null = null
  for (const rect of rects) {
    if (rect.sessionId === fromSessionId) continue
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
    if (best === null || score < best.score) best = { sessionId: rect.sessionId, score }
  }
  return best?.sessionId ?? null
}
