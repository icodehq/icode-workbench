import {
  FILES_SKIP_DIRECTORIES,
  FILES_WATCH_MAX_ROOTS,
  normalizeRelativePath,
  parentPath
} from '../../../shared/domain/workspace-files'

const SKIP = new Set<string>(FILES_SKIP_DIRECTORIES)

/**
 * The directories whose direct children the Files pane can currently show.
 *
 * The checkout root is always included. Expanded folders are included, and so
 * is the parent of every open tab: a tab's file can change while its folder is
 * collapsed, and the pane must still notice. Paths the pane never lists (skip
 * directories), absolute paths, and traversal segments are dropped, then the
 * set is deduped, sorted for stable IPC, and capped.
 */
export function deriveWatchRoots(input: {
  expanded: Record<string, boolean>
  tabPaths: readonly string[]
}): string[] {
  const roots = new Set<string>([''])
  const add = (raw: string): void => {
    const normalized = normalizeRelativePath(raw)
    if (normalized === null) return
    if (normalized !== '' && normalized.split('/').some((segment) => SKIP.has(segment))) {
      return
    }
    roots.add(normalized)
  }

  for (const [path, open] of Object.entries(input.expanded)) {
    if (open) add(path)
  }
  for (const tabPath of input.tabPaths) {
    add(parentPath(tabPath))
  }

  return [...roots].sort().slice(0, FILES_WATCH_MAX_ROOTS)
}
