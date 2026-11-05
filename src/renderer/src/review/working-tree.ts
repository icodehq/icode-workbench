import type { GitStatusEntry, GitWorkspaceStatus } from '../../../shared/domain/git-workspace'
import type { ChangeDiffScope, ChangeFileStatus } from '../../../shared/domain/changes'

/**
 * The working tree is a different projection from the session baseline.
 *
 * One path can be dirty in both the index and the working tree. Git reports
 * that as one status record with two letters, so the shared parser emits one
 * entry per area and this model keeps those rows separate. That is what makes
 * the staged diff and the unstaged diff honest.
 */

export type WorkingTreeArea = 'conflicts' | 'staged' | 'unstaged' | 'untracked'

export type WorkingTreeEntry = {
  key: string
  area: WorkingTreeArea
  entry: GitStatusEntry
  /** Undefined when the status read did not compute line stats. */
  added: number | null
  removed: number | null
}

export type WorkingTreeGroups = Record<WorkingTreeArea, WorkingTreeEntry[]>

const EMPTY_GROUPS: WorkingTreeGroups = {
  conflicts: [],
  staged: [],
  unstaged: [],
  untracked: []
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
    untracked: snapshot.untracked.map((entry) => toEntry('untracked', entry))
  }
}

/** Unique paths, not entries: a partially staged file is one uncommitted file. */
export function uncommittedFileCount(groups: WorkingTreeGroups): number {
  return new Set(
    [...groups.conflicts, ...groups.staged, ...groups.unstaged, ...groups.untracked].map(
      (entry) => entry.entry.path
    )
  ).size
}

export function diffScopeFor(area: WorkingTreeArea): ChangeDiffScope {
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
