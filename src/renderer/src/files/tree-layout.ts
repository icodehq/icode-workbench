import type { FileEntry } from '../../../shared/domain/workspace-files'
import type { TreeRow } from './selection'
import { sortFileEntries, type EntrySortOptions } from './sort-entries'

export type TreeLayoutOptions = {
  sort: EntrySortOptions
  compactFolders: boolean
  fileNesting: boolean
  /** Parent file paths whose nested children are collapsed. */
  collapsedNested: ReadonlySet<string>
}

const DEFAULT: TreeLayoutOptions = {
  sort: { order: 'name', direction: 'asc' },
  compactFolders: false,
  fileNesting: false,
  collapsedNested: new Set()
}

function parentOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

function nameOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? path : path.slice(index + 1)
}

/** The bounded default nesting patterns; custom patterns are Phase D. */
export function nestedNamesFor(parentName: string): string[] {
  const ts = /^(.+)\.ts$/u.exec(parentName)
  if (ts !== null) {
    const stem = ts[1] ?? ''
    return [
      `${stem}.js`,
      `${stem}.js.map`,
      `${stem}.d.ts`,
      `${stem}.test.ts`,
      `${stem}.spec.ts`
    ]
  }
  const js = /^(.+)\.js$/u.exec(parentName)
  if (js !== null) {
    const stem = js[1] ?? ''
    return [`${stem}.js.map`, `${stem}.min.js`]
  }
  if (parentName === 'package.json') {
    return ['package-lock.json', 'pnpm-lock.yaml', '.npmrc']
  }
  return []
}

type DirectoryLayout = {
  top: FileEntry[]
  nestedByParent: Map<string, FileEntry[]>
  nested: Set<string>
}

function layoutDirectory(entries: readonly FileEntry[], fileNesting: boolean): DirectoryLayout {
  if (!fileNesting) {
    return {
      top: [...entries],
      nestedByParent: new Map(),
      nested: new Set()
    }
  }
  const byName = new Map(entries.map((entry) => [entry.name, entry]))
  const assigned = new Set<string>()
  const nestedByParent = new Map<string, FileEntry[]>()
  for (const parent of entries) {
    if (parent.kind !== 'file' || assigned.has(parent.path)) continue
    const children: FileEntry[] = []
    for (const name of nestedNamesFor(parent.name)) {
      if (name === parent.name) continue
      const child = byName.get(name)
      if (child === undefined || child.kind !== 'file' || child === parent) continue
      if (assigned.has(child.path)) continue
      assigned.add(child.path)
      children.push(child)
    }
    if (children.length > 0) {
      children.sort((left, right) => left.name.localeCompare(right.name))
      nestedByParent.set(parent.path, children)
    }
  }
  return {
    top: entries.filter((entry) => !assigned.has(entry.path)),
    nestedByParent,
    nested: assigned
  }
}

/**
 * Builds the visible rows once, applying sort, compact folders and file nesting.
 *
 * `entry.path` is always the real deepest path, so selection, tabs and file
 * operations never see a synthetic path. `displayName` is the only place a
 * compact chain is joined.
 */
export function buildTreeRows(
  children: Record<string, FileEntry[]>,
  expanded: Record<string, boolean>,
  options: TreeLayoutOptions = DEFAULT
): TreeRow[] {
  const rows: TreeRow[] = []

  const walk = (path: string, depth: number): void => {
    const sorted = sortFileEntries(children[path] ?? [], options.sort)
    const layout = layoutDirectory(sorted, options.fileNesting)

    for (const entry of layout.top) {
      if (entry.kind === 'directory') {
        let current = entry
        let label = entry.name
        const chain = [entry.path]
        if (options.compactFolders) {
          // Compact only through already-loaded single-folder chains.
          for (;;) {
            const inner = children[current.path]
            if (inner === undefined || inner.length !== 1) break
            const only = inner[0]
            if (only === undefined || only.kind !== 'directory') break
            current = only
            label = `${label}/${only.name}`
            chain.push(only.path)
            if (chain.length > 64) break
          }
        }
        rows.push({
          entry: current,
          depth,
          parentPath: parentOf(chain[0] ?? entry.path),
          displayName: label,
          ...(chain.length > 1 ? { compactChain: chain } : {})
        })
        if (expanded[current.path] === true) walk(current.path, depth + 1)
        continue
      }

      const nested = layout.nestedByParent.get(entry.path) ?? []
      rows.push({
        entry,
        depth,
        parentPath: path,
        displayName: entry.name,
        ...(nested.length > 0 ? { nestedCount: nested.length } : {})
      })
      if (nested.length === 0 || options.collapsedNested.has(entry.path)) continue
      for (const child of nested) {
        rows.push({
          entry: child,
          depth: depth + 1,
          parentPath: path,
          displayName: child.name,
          nested: true,
          nestedParent: entry.path
        })
      }
    }
  }

  walk('', 0)
  return rows
}

export { nameOf as layoutNameOf }
