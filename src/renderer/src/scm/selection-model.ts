/**
 * Selection for the Source Control sidebar.
 *
 * Keys are `area:path`, not paths: one file can appear in Staged Changes and
 * Changes at the same time, and selecting the staged row must not select the
 * working-tree row. The model is pure so row identity, range selection and
 * selection transfer after stage/unstage are testable without React.
 */

import type { WorkingTreeEntry, WorkingTreeGroups } from '../review/working-tree'

export type ScmSelection = {
  selected: ReadonlySet<string>
  anchor: string | null
}

export const EMPTY_SELECTION: ScmSelection = { selected: new Set(), anchor: null }

export function selectionKey(entry: Pick<WorkingTreeEntry, 'area' | 'entry'>): string {
  return `${entry.area}:${entry.entry.path}`
}

export function keyPath(key: string): string {
  const separator = key.indexOf(':')
  return separator === -1 ? key : key.slice(separator + 1)
}

export function keyArea(key: string): string {
  const separator = key.indexOf(':')
  return separator === -1 ? '' : key.slice(0, separator)
}

export function selectOnly(key: string): ScmSelection {
  return { selected: new Set([key]), anchor: key }
}

export function toggleSelection(selection: ScmSelection, key: string): ScmSelection {
  const selected = new Set(selection.selected)
  if (selected.has(key)) selected.delete(key)
  else selected.add(key)
  return { selected, anchor: selected.has(key) ? key : null }
}

/**
 * Shift-click selects the visible range, inclusive. If the anchor is no longer
 * visible (it was staged, filtered or filtered out), fall back to the target.
 */
export function selectRange(
  selection: ScmSelection,
  visibleKeys: readonly string[],
  target: string
): ScmSelection {
  const anchor = selection.anchor
  const targetIndex = visibleKeys.indexOf(target)
  if (targetIndex === -1) return selection
  const anchorIndex = anchor === null ? -1 : visibleKeys.indexOf(anchor)
  if (anchorIndex === -1) return selectOnly(target)
  const start = Math.min(anchorIndex, targetIndex)
  const end = Math.max(anchorIndex, targetIndex)
  const selected = new Set(visibleKeys.slice(start, end + 1))
  return { selected, anchor: null }
}

export function selectAll(visibleKeys: readonly string[]): ScmSelection {
  return {
    selected: new Set(visibleKeys),
    anchor: visibleKeys.length > 0 ? visibleKeys[visibleKeys.length - 1]! : null
  }
}

export function clearSelection(): ScmSelection {
  return EMPTY_SELECTION
}

/** Drop rows that are no longer present, without disturbing the anchor if it survives. */
export function pruneSelection(
  selection: ScmSelection,
  availableKeys: ReadonlySet<string>
): ScmSelection {
  let changed = false
  const selected = new Set<string>()
  for (const key of selection.selected) {
    if (availableKeys.has(key)) selected.add(key)
    else changed = true
  }
  const anchor =
    selection.anchor !== null && availableKeys.has(selection.anchor) ? selection.anchor : null
  if (!changed && anchor === selection.anchor) return selection
  return { selected, anchor }
}

export type SelectionTransfer = {
  selection: ScmSelection
  /** Paths whose selected row disappeared; selection follows them to a new area. */
  followed: string[]
  /** Paths whose selected row disappeared and had no destination. */
  dropped: string[]
}

/**
 * Follows selected paths across a stage/unstage snapshot.
 *
 * When a row moves from `unstaged:src/a` to `staged:src/a`, the path is kept
 * selected in its destination area. A path selected in the *other* area is not
 * moved: a partially staged file has two independent rows.
 */
export function transferSelection(
  selection: ScmSelection,
  before: readonly WorkingTreeEntry[],
  after: readonly WorkingTreeEntry[],
  affectedPaths: ReadonlySet<string> = new Set(before.map((entry) => entry.entry.path))
): SelectionTransfer {
  const beforeByKey = new Map(before.map((entry) => [selectionKey(entry), entry]))
  const afterByPath = new Map<string, string[]>()
  for (const entry of after) {
    const path = entry.entry.path
    const keys = afterByPath.get(path) ?? []
    keys.push(selectionKey(entry))
    afterByPath.set(path, keys)
  }
  const selected = new Set<string>()
  const followed: string[] = []
  const dropped: string[] = []
  const remaining = new Set(after.map(selectionKey))

  for (const key of selection.selected) {
    if (remaining.has(key)) {
      selected.add(key)
      continue
    }
    const path = keyPath(key)
    const beforeEntry = beforeByKey.get(key)
    if (beforeEntry === undefined || !affectedPaths.has(path)) {
      dropped.push(path)
      continue
    }
    const destinations = afterByPath.get(path)
    if (!destinations || destinations.length === 0) {
      dropped.push(path)
      continue
    }
    // Keep the area when possible; otherwise take the first destination.
    const sameArea = destinations.find((candidate) => keyArea(candidate) === beforeEntry.area)
    const next = sameArea ?? destinations[0]!
    selected.add(next)
    followed.push(path)
  }

  const anchor = selection.anchor === null ? null : selection.anchor
  const nextAnchor =
    anchor === null ? null : selected.has(anchor) ? anchor : selected.values().next().value ?? null
  if (selected.size === 0 && selection.selected.size === 0) return { selection, followed, dropped }
  return { selection: { selected, anchor: nextAnchor }, followed, dropped }
}

export function selectedEntries(
  selection: ScmSelection,
  groups: WorkingTreeGroups
): WorkingTreeEntry[] {
  return allEntries(groups).filter((entry) => selection.selected.has(selectionKey(entry)))
}

export function allEntries(groups: WorkingTreeGroups): WorkingTreeEntry[] {
  return [...groups.conflicts, ...groups.staged, ...groups.unstaged, ...groups.untracked]
}

export type SelectionActions = {
  stageable: WorkingTreeEntry[]
  unstageable: WorkingTreeEntry[]
  discardable: WorkingTreeEntry[]
}

export function selectionActions(
  selection: ScmSelection,
  groups: WorkingTreeGroups
): SelectionActions {
  const entries = selectedEntries(selection, groups)
  return {
    stageable: entries.filter((entry) => entry.area === 'unstaged' || entry.area === 'untracked'),
    unstageable: entries.filter((entry) => entry.area === 'staged'),
    discardable: entries.filter((entry) => entry.area !== 'conflicts')
  }
}
