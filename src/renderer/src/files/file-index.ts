import { translate } from '../i18n/i18n-store'
import type { FilesListingPayload } from '../../../shared/icode-api'
import { callApi, errorNotice } from '../lib/api'
import type { Notice } from '../state/workspace'

export const MAX_INDEXED_FILES = 5000
const CACHE_MS = 30_000
const SKIP = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  'build',
  '.next',
  'target',
  '__pycache__',
  '.venv'
])

type IndexResult = { files: string[]; note: string | null }
const cache = new Map<string, { at: number; result: IndexResult }>()

/** `.git` is a directory at a checkout root but a file inside a worktree. */
export function shouldSkipIndexEntry(name: string, path: string): boolean {
  return SKIP.has(name) || path.split('/').includes('.git')
}

/**
 * Walks one worktree and returns the file paths the palettes search.
 *
 * The walk is bounded and sequential: a palette is a navigation aid, not a
 * reason to open thousands of directory handles at once. Results are cached for
 * a short window because opening the command palette and QuickOpen in succession
 * should not walk the same checkout twice; a file created after the snapshot may
 * need one refresh before it appears, which is why the TTL is deliberately short.
 */
export async function getWorktreeFileIndex(
  sessionId: string,
  notify: (notice: Notice) => void
): Promise<IndexResult> {
  const hit = cache.get(sessionId)
  if (hit !== undefined && Date.now() - hit.at < CACHE_MS) return hit.result

  const files: string[] = []
  let note: string | null = null

  const walk = async (path: string): Promise<boolean> => {
    const result = await callApi<FilesListingPayload>(window.icode.files.list({ sessionId, path }))
    if (!result.ok) {
      notify(errorNotice(result.error))
      note = translate('fileIndex.unreadable')
      return false
    }
    const value = result.value
    if (value.status === 'unavailable') {
      note =
        value.reason === 'worktree-unavailable'
          ? translate('fileIndex.distro')
          : value.detail
      return false
    }
    for (const entry of value.entries) {
      if (files.length >= MAX_INDEXED_FILES) {
        note = translate('fileIndex.firstFiles', { count: MAX_INDEXED_FILES })
        return false
      }
      // A worktree's `.git` is a *file* pointing at the gitdir, so the
      // directory-only skip below is not enough to keep it out of search.
      if (shouldSkipIndexEntry(entry.name, entry.path)) continue
      if (entry.kind === 'file') {
        files.push(entry.path)
      } else {
        const ok = await walk(entry.path)
        if (!ok) return false
      }
    }
    return true
  }

  await walk('')
  const result = { files, note }
  cache.set(sessionId, { at: Date.now(), result })
  return result
}

/** A mutation can invalidate a path that the palette would otherwise offer. */
export function clearWorktreeFileIndex(sessionId?: string): void {
  if (sessionId === undefined) cache.clear()
  else cache.delete(sessionId)
}
