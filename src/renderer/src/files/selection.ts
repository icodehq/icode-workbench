import type { FileEntry } from '../../../shared/domain/workspace-files'

/**
 * Selection and visible-row helpers for the Files tree.
 *
 * The tree is rendered from a flat list of visible rows, not a recursive
 * component tree: range selection and keyboard movement are index operations
 * over that list, and they must agree exactly with what the user can see.
 */

export type TreeRow = {
  entry: FileEntry
  depth: number
  parentPath: string
  /** Normally `entry.name`; a compact chain joins several folder names. */
  displayName: string
  /** Folder paths folded into one compact row; `entry.path` is the deepest. */
  compactChain?: string[]
  /** True when this row is a nested child of a file. */
  nested?: boolean
  nestedParent?: string
  /** Number of nested children under this file row. */
  nestedCount?: number
}

export type SelectionState = {
  selected: ReadonlySet<string>
  /** Shift-range origin. */
  anchor: string | null
  /** Roving tabindex / keyboard cursor. */
  focused: string | null
}

export type SelectionModifiers = {
  toggle?: boolean
  range?: boolean
}

export const EMPTY_SELECTION: SelectionState = {
  selected: new Set(),
  anchor: null,
  focused: null
}

const isGitMetadata = (path: string): boolean => path.split('/').includes('.git')

/** Depth-first visible rows, matching the expanded directory map. */
export function flattenVisibleRows(
  children: Record<string, FileEntry[]>,
  expanded: Record<string, boolean>
): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (path: string, depth: number): void => {
    for (const entry of children[path] ?? []) {
      if (isGitMetadata(entry.path)) continue
      rows.push({ entry, depth, parentPath: path, displayName: entry.name })
      if (entry.kind === 'directory' && expanded[entry.path] === true) {
        walk(entry.path, depth + 1)
      }
    }
  }
  walk('', 0)
  return rows
}

export function selectRow(
  state: SelectionState,
  rows: readonly TreeRow[],
  path: string,
  modifiers: SelectionModifiers = {}
): SelectionState {
  const index = rows.findIndex((row) => row.entry.path === path)
  if (index === -1) return state

  if (modifiers.range) {
    const anchorIndex =
      state.anchor === null
        ? index
        : rows.findIndex((row) => row.entry.path === state.anchor)
    const start = Math.min(anchorIndex === -1 ? index : anchorIndex, index)
    const end = Math.max(anchorIndex === -1 ? index : anchorIndex, index)
    const selected = new Set<string>()
    for (let cursor = start; cursor <= end; cursor += 1) {
      const row = rows[cursor]
      if (row !== undefined) selected.add(row.entry.path)
    }
    return {
      selected,
      anchor: state.anchor ?? path,
      focused: path
    }
  }

  if (modifiers.toggle) {
    const selected = new Set(state.selected)
    if (selected.has(path)) selected.delete(path)
    else selected.add(path)
    return { selected, anchor: path, focused: path }
  }

  return { selected: new Set([path]), anchor: path, focused: path }
}

export function selectAll(rows: readonly TreeRow[]): SelectionState {
  const selected = new Set(rows.map((row) => row.entry.path))
  return {
    selected,
    anchor: rows[0]?.entry.path ?? null,
    focused: rows[rows.length - 1]?.entry.path ?? null
  }
}

/** Keeps selection and focus inside the rows that still exist. */
export function pruneSelection(
  state: SelectionState,
  rows: readonly TreeRow[]
): SelectionState {
  const visible = new Set(rows.map((row) => row.entry.path))
  let changed = false
  const selected = new Set<string>()
  for (const path of state.selected) {
    if (visible.has(path)) selected.add(path)
    else changed = true
  }
  const focused =
    state.focused !== null && visible.has(state.focused)
      ? state.focused
      : (selected.values().next().value ?? rows[0]?.entry.path ?? null)
  if (focused !== state.focused) changed = true
  const anchor =
    state.anchor !== null && visible.has(state.anchor) ? state.anchor : focused
  if (anchor !== state.anchor) changed = true
  return changed ? { selected, anchor, focused } : state
}

/** Removes paths whose ancestor is also selected, preserving order. */
export function collapseSelectedPaths(paths: readonly string[]): string[] {
  const unique = [...new Set(paths)]
  const sorted = unique.sort(
    (left, right) => left.length - right.length || left.localeCompare(right)
  )
  const result: string[] = []
  for (const path of sorted) {
    if (result.some((ancestor) => path === ancestor || path.startsWith(`${ancestor}/`))) {
      continue
    }
    result.push(path)
  }
  return result
}

export type SelectionSummary = {
  total: number
  files: number
  directories: number
}

export function summarizeSelection(
  rows: readonly TreeRow[],
  selected: ReadonlySet<string>
): SelectionSummary {
  const kinds = new Map(rows.map((row) => [row.entry.path, row.entry.kind]))
  let files = 0
  let directories = 0
  for (const path of selected) {
    // A path can be selected while its parent is still loading; count it as a
    // file until the tree can prove otherwise rather than losing it.
    if (kinds.get(path) === 'directory') directories += 1
    else files += 1
  }
  return { total: files + directories, files, directories }
}
