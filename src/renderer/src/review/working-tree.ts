import type { GitStatusEntry, GitWorkspaceStatus } from '../../../shared/domain/git-workspace'
import type { ReviewFileStatus } from '../../../shared/domain/review'
import type { ReviewDiffScope } from '../../../shared/schemas/review'

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

export type WorkingTreeCounts = Record<WorkingTreeArea, number>

export type CommitPrimaryAction = {
  kind: 'commit' | 'stage' | 'publish' | 'push' | 'pull' | 'sync' | 'blocked' | 'noop'
  label: string
  disabled: boolean
  reason: string
}

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

export function workingTreeCounts(groups: WorkingTreeGroups): WorkingTreeCounts {
  return {
    conflicts: groups.conflicts.length,
    staged: groups.staged.length,
    unstaged: groups.unstaged.length,
    untracked: groups.untracked.length
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

export function hasWorkingTreeChanges(groups: WorkingTreeGroups): boolean {
  const counts = workingTreeCounts(groups)
  return counts.conflicts + counts.staged + counts.unstaged + counts.untracked > 0
}

export function stageableEntryCount(groups: WorkingTreeGroups): number {
  return groups.unstaged.length + groups.untracked.length
}

export function primaryCommitAction(args: {
  groups: WorkingTreeGroups
  message: string
  hasUpstream: boolean
  ahead: number
  behind: number
}): CommitPrimaryAction {
  const staged = args.groups.staged.length
  const stageable = stageableEntryCount(args.groups)
  const hasMessage = args.message.trim().length > 0

  if (args.groups.conflicts.length > 0) {
    return {
      kind: 'blocked',
      label: 'Resolve conflicts',
      disabled: true,
      reason: 'Resolve conflicts before committing.'
    }
  }
  if (staged > 0 && hasMessage) {
    return {
      kind: 'commit',
      label: `Commit ${String(staged)} file${staged === 1 ? '' : 's'}`,
      disabled: false,
      reason: 'Commit the staged changes.'
    }
  }
  if (staged > 0) {
    return {
      kind: 'commit',
      label: `Commit ${String(staged)} file${staged === 1 ? '' : 's'}`,
      disabled: true,
      reason: 'Write a commit message first.'
    }
  }
  if (stageable > 0) {
    return {
      kind: 'stage',
      label: 'Stage all',
      disabled: false,
      reason: 'Stage every uncommitted change.'
    }
  }
  if (!args.hasUpstream) {
    return {
      kind: 'publish',
      label: 'Publish branch',
      disabled: false,
      reason: 'Publish this branch to set an upstream.'
    }
  }
  if (args.ahead > 0 && args.behind > 0) {
    return {
      kind: 'sync',
      label: 'Sync',
      disabled: false,
      reason: `${String(args.ahead)} ahead · ${String(args.behind)} behind.`
    }
  }
  if (args.behind > 0) {
    return {
      kind: 'pull',
      label: `Pull ${String(args.behind)}`,
      disabled: false,
      reason: 'Fast-forward from the upstream.'
    }
  }
  if (args.ahead > 0) {
    return {
      kind: 'push',
      label: `Push ${String(args.ahead)}`,
      disabled: false,
      reason: 'Push the local commits.'
    }
  }
  return {
    kind: 'noop',
    label: 'Nothing to commit',
    disabled: true,
    reason: 'The branch is up to date.'
  }
}

export function diffScopeFor(area: WorkingTreeArea): ReviewDiffScope {
  return area === 'conflicts' ? 'conflict' : area
}

export function reviewStatusFor(entry: GitStatusEntry): ReviewFileStatus {
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
