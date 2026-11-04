/**
 * Tree/flat model for the files changed by one History commit.
 *
 * VS Code's SCM History view can present a commit's changes as a flat list or
 * as a compact file tree. The same data feeds both modes here; folders are
 * derived only from file paths, so renamed files appear at their new path.
 */

import type { GitRangeFile } from '../../../shared/domain/git-workspace'

export type CommitFileTreeNode =
  | { kind: 'folder'; path: string; name: string; children: CommitFileTreeNode[] }
  | { kind: 'file'; file: GitRangeFile }

export type CommitFileRow =
  | { kind: 'folder'; path: string; name: string; depth: number; collapsed: boolean }
  | { kind: 'file'; file: GitRangeFile; depth: number }

function baseName(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? path : path.slice(index + 1)
}

function nodePath(node: CommitFileTreeNode): string {
  return node.kind === 'folder' ? node.path : node.file.path
}

/** Builds a folder tree; folders sort before files at every level. */
export function buildCommitFileTree(files: GitRangeFile[]): CommitFileTreeNode[] {
  const roots: CommitFileTreeNode[] = []
  const folders = new Map<string, Extract<CommitFileTreeNode, { kind: 'folder' }>>()

  const folderFor = (path: string): Extract<CommitFileTreeNode, { kind: 'folder' }> => {
    const existing = folders.get(path)
    if (existing) return existing
    const slash = path.lastIndexOf('/')
    const node: Extract<CommitFileTreeNode, { kind: 'folder' }> = {
      kind: 'folder',
      path,
      name: slash === -1 ? path : path.slice(slash + 1),
      children: []
    }
    folders.set(path, node)
    const parentPath = slash === -1 ? '' : path.slice(0, slash)
    const siblings = parentPath.length === 0 ? roots : folderFor(parentPath).children
    siblings.push(node)
    return node
  }

  const seen = new Set<string>()
  for (const file of files) {
    if (file.path.length === 0 || seen.has(file.path)) continue
    seen.add(file.path)
    const slash = file.path.lastIndexOf('/')
    const parentPath = slash === -1 ? '' : file.path.slice(0, slash)
    const siblings = parentPath.length === 0 ? roots : folderFor(parentPath).children
    siblings.push({ kind: 'file', file })
  }

  const sortNodes = (nodes: CommitFileTreeNode[]): void => {
    nodes.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1
      const leftName = left.kind === 'folder' ? left.name : baseName(left.file.path)
      const rightName = right.kind === 'folder' ? right.name : baseName(right.file.path)
      const byName = leftName.localeCompare(rightName)
      return byName !== 0 ? byName : nodePath(left).localeCompare(nodePath(right))
    })
    for (const node of nodes) {
      if (node.kind === 'folder') sortNodes(node.children)
    }
  }
  sortNodes(roots)
  return roots
}

/**
 * Flattens the tree for rendering. Collapsed folders omit their children but
 * stay in the row list so keyboard/selection state can address them.
 */
export function flattenCommitFileTree(
  nodes: CommitFileTreeNode[],
  collapsed: ReadonlySet<string>,
  depth = 0
): CommitFileRow[] {
  const rows: CommitFileRow[] = []
  for (const node of nodes) {
    if (node.kind === 'folder') {
      const isCollapsed = collapsed.has(node.path)
      rows.push({
        kind: 'folder',
        path: node.path,
        name: node.name,
        depth,
        collapsed: isCollapsed
      })
      if (!isCollapsed) {
        rows.push(...flattenCommitFileTree(node.children, collapsed, depth + 1))
      }
    } else {
      rows.push({ kind: 'file', file: node.file, depth })
    }
  }
  return rows
}
