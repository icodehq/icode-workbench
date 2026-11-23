/**
 * Pure ignore rules shared by the main process, the watcher child, and tests.
 *
 * The main services keep a delivery-time check as a last line of defence; the
 * child applies the same rules while deciding what to watch. Keeping one
 * implementation is what makes "generated directory at any depth" true for both
 * backends instead of only for the one the tests happened to exercise.
 */

import { FILES_SKIP_DIRECTORIES } from './workspace-files'
import { GENERATED_IGNORE_PATTERNS } from './generated-ignore'

export const FILES_WATCH_SKIP_DIRECTORIES: readonly string[] = FILES_SKIP_DIRECTORIES
export const GIT_WATCH_SKIP_DIRECTORIES: readonly string[] = GENERATED_IGNORE_PATTERNS.map(
  (pattern) => pattern.replace(/\/$/u, '')
)

const FILES_SKIP = new Set<string>(FILES_WATCH_SKIP_DIRECTORIES)
const GIT_SKIP = new Set<string>(GIT_WATCH_SKIP_DIRECTORIES)

export function isInsideWatchRoot(parent: string, candidate: string): boolean {
  const normalizedParent = parent.replace(/[\\/]+$/u, '')
  return (
    candidate === normalizedParent ||
    candidate.startsWith(`${normalizedParent}/`) ||
    candidate.startsWith(`${normalizedParent}\\`)
  )
}

/** True when a path must not wake the Files pane. */
export function shouldIgnoreFilesWatchPath(path: string, worktreePath: string): boolean {
  const normalized = path.replace(/\\/gu, '/')
  const worktree = worktreePath.replace(/\\/gu, '/')
  // Chokidar asks about ancestors while walking to the root. Ignoring one would
  // skip the whole tree, so ancestors are never ignored.
  if (!isInsideWatchRoot(worktree, normalized)) return false
  if (normalized === worktree) return false

  const relativePath = normalized.slice(worktree.length).replace(/^\/+/u, '')
  const segments = relativePath.split('/')
  /*
   * A dependency directory can sit below a package directory
   * (`client/node_modules` in a monorepo), not only at the checkout root.
   * Checking only the first segment made chokidar walk and watch every
   * dependency file; a 35k-file checkout then created 37k native watchers and
   * stalled the main process long enough for Windows to report AppHang.
   */
  if (segments.some((segment) => FILES_SKIP.has(segment))) return true
  const name = segments[segments.length - 1] ?? ''
  if (name.endsWith('.swp') || name.endsWith('.tmp')) return true
  // Both backends stage writes beside the target; those files are an
  // implementation detail, not user content.
  if (segments.some((segment) => segment.includes('.icode-write-'))) return true
  return false
}

export type WatchIgnoreTarget = { worktreePath: string; gitDir: string }

/** True when a path must not wake the Source Control watcher. */
export function shouldIgnoreWatchPath(path: string, target: WatchIgnoreTarget): boolean {
  const normalized = path.replace(/\\/gu, '/')
  const worktree = target.worktreePath.replace(/\\/gu, '/')
  const gitDir = target.gitDir.replace(/\\/gu, '/')

  // The Git directory is checked first: a primary worktree's `.git` lives
  // inside the worktree, but index/HEAD/operation markers there are exactly the
  // metadata changes the watcher must see.
  if (isInsideWatchRoot(gitDir, normalized)) {
    const relativePath = normalized.slice(gitDir.length).replace(/^\/+/u, '')
    const first = relativePath.split('/')[0] ?? ''
    // Objects and reflogs are large and do not affect a status snapshot.
    if (first === 'objects' || first === 'logs' || first === 'lfs') return true
    if (relativePath.endsWith('.lock') || relativePath.endsWith('.tmp')) return true
    if (relativePath.startsWith('next-index-') || relativePath.startsWith('watchman-')) return true
    return false
  }
  if (isInsideWatchRoot(`${worktree}/.git`, normalized)) return true
  if (isInsideWatchRoot(worktree, normalized)) {
    const relativePath = normalized.slice(worktree.length).replace(/^\/+/u, '')
    /*
     * Skip generated directories at any depth, not only the checkout root.
     * A monorepo keeps `client/node_modules` below a package directory, and
     * missing it made the watcher walk every dependency file.
     */
    const segments = relativePath.split('/')
    if (segments.some((segment) => GIT_SKIP.has(segment))) return true
    if (relativePath.endsWith('.swp') || relativePath.endsWith('.tmp')) return true
    return false
  }
  // An ancestor of a root (or any unrelated path) must not be ignored: the
  // walk visits parents first, and ignoring one would skip the entire tree.
  return false
}
