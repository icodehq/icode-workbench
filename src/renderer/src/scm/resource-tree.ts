/**
 * Sidebar row model for Source Control.
 *
 * The same entries can be rendered as a flat list or a directory tree. Rows are
 * pure data so filtering, sorting, folder compaction, collapse and keyboard
 * range selection can be tested without React or the DOM.
 */

import type { WorkingTreeEntry, WorkingTreeGroups } from '../review/working-tree'
import { selectionKey } from './selection-model'

export type ScmViewMode = 'list' | 'tree'
export type ScmSortKey = 'name' | 'path' | 'status'
export type UntrackedMode = 'mixed' | 'separate' | 'hidden'

export type ScmGroupId = 'conflicts' | 'staged' | 'unstaged' | 'untracked'

export type ScmGroup = {
  id: ScmGroupId
  label: string
  entries: WorkingTreeEntry[]
}

export type ScmFolderRow = {
  kind: 'folder'
  id: string
  group: ScmGroupId
  path: string
  label: string
  depth: number
  collapsed: boolean
  resourceKeys: string[]
}

export type ScmResourceRow = {
  kind: 'resource'
  id: string
  group: ScmGroupId
  entry: WorkingTreeEntry
  depth: number
}

export type ScmGroupRow = {
  kind: 'group'
  id: ScmGroupId
  label: string
  count: number
  collapsed: boolean
  depth: 0
}

export type ScmRow = ScmGroupRow | ScmFolderRow | ScmResourceRow

export type ScmTreeOptions = {
  mode: ScmViewMode
  sort: ScmSortKey
  query: string
  untrackedMode: UntrackedMode
  compactFolders: boolean
  collapsed: ReadonlySet<string>
}

export const DEFAULT_SCM_TREE_OPTIONS: ScmTreeOptions = {
  mode: 'list',
  sort: 'path',
  query: '',
  untrackedMode: 'separate',
  compactFolders: true,
  collapsed: new Set()
}

const GROUP_ORDER: ScmGroupId[] = ['conflicts', 'staged', 'unstaged', 'untracked']

export const GROUP_LABELS: Record<ScmGroupId, string> = {
  conflicts: 'Merge Changes',
  staged: 'Staged Changes',
  unstaged: 'Changes',
  untracked: 'Untracked Files'
}

function pathName(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? path : path.slice(index + 1)
}

function sortEntries(entries: WorkingTreeEntry[], sort: ScmSortKey): WorkingTreeEntry[] {
  const sorted = [...entries]
  sorted.sort((left, right) => {
    if (sort === 'name' || sort === 'path') {
      const leftValue =
        sort === 'name' ? pathName(left.entry.path) : left.entry.path
      const rightValue =
        sort === 'name' ? pathName(right.entry.path) : right.entry.path
      const name = leftValue.localeCompare(rightValue)
      return name !== 0 ? name : left.entry.path.localeCompare(right.entry.path)
    }
    const status = left.entry.status.localeCompare(right.entry.status)
    return status !== 0 ? status : left.entry.path.localeCompare(right.entry.path)
  })
  return sorted
}

function matches(entry: WorkingTreeEntry, query: string): boolean {
  if (query.length === 0) return true
  return entry.entry.path.toLowerCase().includes(query)
}

export function scmGroups(
  groups: WorkingTreeGroups,
  options: Pick<ScmTreeOptions, 'query' | 'untrackedMode'>
): ScmGroup[] {
  const query = options.query.trim().toLowerCase()
  const byId: Record<ScmGroupId, WorkingTreeEntry[]> = {
    conflicts: groups.conflicts.filter((entry) => matches(entry, query)),
    staged: groups.staged.filter((entry) => matches(entry, query)),
    unstaged: groups.unstaged.filter((entry) => matches(entry, query)),
    untracked: groups.untracked.filter((entry) => matches(entry, query))
  }
  if (options.untrackedMode === 'hidden') byId.untracked = []
  if (options.untrackedMode === 'mixed') {
    byId.unstaged = [...byId.unstaged, ...byId.untracked]
    byId.untracked = []
  }
  return GROUP_ORDER.filter((id) => byId[id].length > 0).map((id) => ({
    id,
    label: GROUP_LABELS[id],
    entries: byId[id]
  }))
}

type DirNode = {
  name: string
  path: string
  folders: Map<string, DirNode>
  entries: WorkingTreeEntry[]
}

function buildTree(entries: WorkingTreeEntry[]): DirNode {
  const root: DirNode = { name: '', path: '', folders: new Map(), entries: [] }
  for (const entry of entries) {
    const segments = entry.entry.path.split('/')
    let node = root
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index]!
      const path = segments.slice(0, index + 1).join('/')
      let child = node.folders.get(name)
      if (!child) {
        child = { name, path, folders: new Map(), entries: [] }
        node.folders.set(name, child)
      }
      node = child
    }
    node.entries.push(entry)
  }
  return root
}

/**
 * Collapses a single-child folder chain, like VS Code's compact folders:
 * `src/auth/` becomes one folder row when every level has no resources.
 */
function compactNodes(nodes: DirNode[]): DirNode[] {
  const compact = (node: DirNode): DirNode => {
    let current = node
    while (current.entries.length === 0 && current.folders.size === 1) {
      const only = [...current.folders.values()][0]!
      current = {
        name: `${current.name}/${only.name}`,
        path: only.path,
        folders: only.folders,
        entries: only.entries
      }
    }
    return {
      ...current,
      folders: new Map([...current.folders.entries()].map(([name, child]) => [name, compact(child)]))
    }
  }
  return nodes.map(compact)
}

function pushTreeRows(
  rows: ScmRow[],
  node: DirNode,
  group: ScmGroupId,
  depth: number,
  collapsed: ReadonlySet<string>
): void {
  const folders = [...node.folders.values()].sort((left, right) => left.path.localeCompare(right.path))
  for (const folder of folders) {
    const id = `folder:${group}:${folder.path}`
    const resourceKeys = collectKeys(folder).sort()
    const isCollapsed = collapsed.has(id)
    rows.push({
      kind: 'folder',
      id,
      group,
      path: folder.path,
      label: folder.name,
      depth,
      collapsed: isCollapsed,
      resourceKeys
    })
    if (!isCollapsed) pushTreeRows(rows, folder, group, depth + 1, collapsed)
  }
  const entries = [...node.entries].sort((left, right) => left.entry.path.localeCompare(right.entry.path))
  for (const entry of entries) {
    rows.push({
      kind: 'resource',
      id: selectionKey(entry),
      group,
      entry,
      depth
    })
  }
}

function collectKeys(node: DirNode): string[] {
  const keys = node.entries.map(selectionKey)
  for (const child of node.folders.values()) keys.push(...collectKeys(child))
  return keys
}

export function scmRows(groups: WorkingTreeGroups, options: ScmTreeOptions): ScmRow[] {
  const rows: ScmRow[] = []
  for (const group of scmGroups(groups, options)) {
    const groupCollapsed = options.collapsed.has(group.id)
    rows.push({
      kind: 'group',
      id: group.id,
      label: group.label,
      count: group.entries.length,
      collapsed: groupCollapsed,
      depth: 0
    })
    if (groupCollapsed) continue
    const sorted = sortEntries(group.entries, options.sort)
    if (options.mode === 'list') {
      for (const entry of sorted) {
        rows.push({
          kind: 'resource',
          id: selectionKey(entry),
          group: group.id,
          entry,
          depth: 1
        })
      }
      continue
    }
    const tree = buildTree(sorted)
    const folders = options.compactFolders ? compactNodes([...tree.folders.values()]) : [...tree.folders.values()]
    const synthetic: DirNode = { name: '', path: '', folders: new Map(folders.map((node) => [node.name, node])), entries: tree.entries }
    pushTreeRows(rows, synthetic, group.id, 1, options.collapsed)
  }
  return rows
}

/** Keys in visible row order, for shift ranges, Ctrl+A and roving focus. */
export function visibleResourceKeys(rows: readonly ScmRow[]): string[] {
  return rows.filter((row): row is ScmResourceRow => row.kind === 'resource').map((row) => row.id)
}

/** Every resource key in a folder, including collapsed descendants. */
export function folderKeys(rows: readonly ScmRow[], folderId: string): string[] {
  const folder = rows.find((row): row is ScmFolderRow => row.kind === 'folder' && row.id === folderId)
  return folder?.resourceKeys ?? []
}

export function toggleCollapsed(collapsed: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(collapsed)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

export function groupCollapsed(collapsed: ReadonlySet<string>, group: ScmGroupId): boolean {
  return collapsed.has(group)
}
