import type { ChangeFileStatus, ChangeDiffScope } from '../../../shared/domain/changes'
import { diffScopeFor, reviewStatusFor, type WorkingTreeEntry } from '../review/working-tree'

export type ChangeDiffInput = {
  sessionId: string
  path: string
  oldPath: string | null
  scope: ChangeDiffScope
  status: ChangeFileStatus
  binary: boolean
  symlink: null
  additions: number | null
  deletions: number | null
}

/** The `git.changeDiff` input for a working-tree row, or null for committed. */
export function changeDiffInputFor(
  sessionId: string,
  entry: WorkingTreeEntry
): ChangeDiffInput | null {
  const scope = diffScopeFor(entry.area)
  if (scope === null) return null
  return {
    sessionId,
    path: entry.entry.path,
    oldPath: entry.entry.oldPath,
    scope,
    status: reviewStatusFor(entry.entry),
    binary: entry.entry.binary ?? false,
    symlink: null,
    additions: entry.added,
    deletions: entry.removed
  }
}
