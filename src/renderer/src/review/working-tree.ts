import type { GitRangeFile, GitStatusEntry, GitWorkspaceStatus } from '../../../shared/domain/git-workspace'
import type { ChangeDiffScope, ChangeFileStatus } from '../../../shared/domain/changes'

/**
 * The working tree is a different projection from the session baseline.
 *
 * One path can be dirty in both the index and the working tree. Git reports
 * that as one status record with two letters, so the shared parser emits one
 * entry per area and this model keeps those rows separate. That is what makes
 * the staged diff and the unstaged diff honest.
 *
 * `committed` is the read-only slice between the session baseline and HEAD. It
 * is not a Git status area; it exists so one sidebar can answer both "what is
 * uncommitted" and "what did this session already commit".
 */

export type WorkingTreeArea = 'conflicts' | 'staged' | 'unstaged' | 'untracked' | 'committed'
/** Areas that can be staged, unstaged or discarded. */
export type WorkingTreeUncommittedArea = Exclude<WorkingTreeArea, 'committed'>

export function isUncommittedArea(area: WorkingTreeArea): area is WorkingTreeUncommittedArea {
  return area !== 'committed'
}

export type WorkingTreeEntry = {
  key: string
  area: WorkingTreeArea
  entry: GitStatusEntry
  /** Undefined when the status read did not compute line stats. */
  added: number | null
  removed: number | null
  /** Present only for `committed` rows; the diff reads `base..HEAD` from it. */
  range?: GitRangeFile
}

export type WorkingTreeGroups = Record<WorkingTreeArea, WorkingTreeEntry[]>

const EMPTY_GROUPS: WorkingTreeGroups = {
  conflicts: [],
  staged: [],
  unstaged: [],
  untracked: [],
  committed: []
}

function toEntry(area: WorkingTreeArea, entry: GitStatusEntry): WorkingTreeEntry {
  return {
    key: `${area}:${entry.path}`,
    area,
    entry,
    added: entry.added ?? null,
    removed: entry.removed ?? null
  }
}

export function workingTreeGroups(snapshot: GitWorkspaceStatus | null): WorkingTreeGroups {
  if (snapshot === null) return EMPTY_GROUPS
  return {
    conflicts: snapshot.conflicted.map((entry) => toEntry('conflicts', entry)),
    staged: snapshot.staged.map((entry) => toEntry('staged', entry)),
    unstaged: snapshot.unstaged.map((entry) => toEntry('unstaged', entry)),
    untracked: snapshot.untracked.map((entry) => toEntry('untracked', entry)),
    committed: []
  }
}

/** Read-only rows for the session's `base..HEAD` slice. */
export function committedTreeEntries(files: readonly GitRangeFile[]): WorkingTreeEntry[] {
  return files.map((file) => ({
    key: `committed:${file.path}`,
    area: 'committed',
    entry: {
      path: file.path,
      oldPath: file.oldPath,
      code: file.status.slice(0, 1).toUpperCase(),
      // Status is the only area-valued field on GitStatusEntry, and committed
      // rows never cross the staging/batch path. The row's own `area` is the
      // authority for actions.
      area: 'staged',
      status: file.status,
      added: file.additions,
      removed: file.deletions,
      binary: file.binary
    },
    added: file.additions,
    removed: file.deletions,
    range: file
  }))
}

/** Unique paths, not entries: a partially staged file is one uncommitted file. */
export function uncommittedFileCount(groups: WorkingTreeGroups): number {
  return new Set(
    [...groups.conflicts, ...groups.staged, ...groups.unstaged, ...groups.untracked].map(
      (entry) => entry.entry.path
    )
  ).size
}

/** `null` means the row is committed work and has no working-tree scope. */
export function diffScopeFor(area: WorkingTreeArea): ChangeDiffScope | null {
  if (area === 'committed') return null
  return area === 'conflicts' ? 'conflict' : area
}

export function reviewStatusFor(entry: GitStatusEntry): ChangeFileStatus {
  switch (entry.status) {
    case 'added':
    case 'untracked':
      return 'added'
    case 'deleted':
      return 'deleted'
    case 'renamed':
    case 'copied':
      return 'renamed'
    default:
      return 'modified'
  }
}
