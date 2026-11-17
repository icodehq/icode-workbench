import type { FileEntry } from '../../../shared/domain/workspace-files'
import { isExcluded } from '../../../shared/domain/glob'
import { isGitMetadata } from './search-utils'

/** Applies `.git`/exclude/.gitignore visibility to every loaded directory. */
export function visibleTreeChildren(
  children: Record<string, FileEntry[]>,
  exclude: readonly string[],
  respectGitIgnore: boolean,
  ignoredByDirectory: Record<string, ReadonlySet<string>>
): Record<string, FileEntry[]> {
  const result: Record<string, FileEntry[]> = {}
  for (const [directory, entries] of Object.entries(children)) {
    const ignored = respectGitIgnore ? ignoredByDirectory[directory] : undefined
    result[directory] = entries.filter((entry) => {
      if (isGitMetadata(entry.path)) return false
      if (ignored?.has(entry.path) === true) return false
      return !isExcluded(entry.path, entry.kind === 'directory', exclude)
    })
  }
  return result
}
