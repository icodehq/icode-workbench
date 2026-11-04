/**
 * The Source Control primary action ladder.
 *
 * This is deliberately pure and separate from the old `working-tree.ts` helper:
 * the full VS Code surface adds operation continuation, smart commit and
 * detached/unborn states. The old helper stays until the migration removes it.
 */

import type { WorkingTreeGroups } from '../review/working-tree'

export type GitOperationState = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null
export type SmartCommitMode = 'off' | 'all' | 'tracked'

export type ScmPrimaryAction =
  | {
      kind: 'commit'
      label: string
      disabled: false
      reason: string
      /** Set when the action stages before committing. */
      stageFirst?: Exclude<SmartCommitMode, 'off'>
    }
  | {
      kind: 'continue'
      label: string
      disabled: boolean
      reason: string
      operation: Exclude<GitOperationState, null | 'bisect'>
    }
  | {
      kind: 'publish' | 'push' | 'pull' | 'sync'
      label: string
      disabled: false
      reason: string
    }
  | { kind: 'disabled'; label: string; disabled: true; reason: string }
  | { kind: 'noop'; label: string; disabled: true; reason: string }

export type ScmPrimaryActionInput = {
  groups: WorkingTreeGroups
  message: string
  hasUpstream: boolean
  ahead: number
  behind: number
  operation: GitOperationState
  smartCommit: SmartCommitMode
  /** null on an unborn branch. */
  headOid: string | null
  /** null on detached HEAD. */
  branch: string | null
}

function commitVerb(headOid: string | null, branch: string | null): string {
  if (headOid === null) return 'Create first commit'
  if (branch === null) return 'Commit on detached HEAD'
  return 'Commit'
}

export function scmPrimaryAction(input: ScmPrimaryActionInput): ScmPrimaryAction {
  const { groups } = input
  const staged = groups.staged.length
  const stageable = groups.unstaged.length + groups.untracked.length
  const hasMessage = input.message.trim().length > 0
  const verb = commitVerb(input.headOid, input.branch)

  if (input.operation !== null) {
    if (input.operation === 'bisect') {
      return {
        kind: 'disabled',
        label: 'Bisecting',
        disabled: true,
        reason: 'A bisect is in progress. Finish or reset it in the terminal.'
      }
    }
    const conflict = groups.conflicts.length > 0
    const operationLabel =
      input.operation === 'merge'
        ? 'Merge'
        : input.operation === 'rebase'
          ? 'Rebase'
          : input.operation === 'cherry-pick'
            ? 'Cherry-pick'
            : 'Revert'
    return {
      kind: 'continue',
      label: `Continue ${operationLabel}`,
      disabled: conflict,
      reason: conflict ? 'Resolve conflicts before continuing.' : `Continue the ${operationLabel.toLowerCase()}.`,
      operation: input.operation
    }
  }

  if (groups.conflicts.length > 0) {
    return {
      kind: 'disabled',
      label: 'Resolve conflicts',
      disabled: true,
      reason: 'Resolve conflicts before committing.'
    }
  }

  if (staged > 0) {
    if (!hasMessage) {
      return {
        kind: 'disabled',
        label: verb,
        disabled: true,
        reason: 'Enter a commit message.'
      }
    }
    return { kind: 'commit', label: verb, disabled: false, reason: 'Commit the staged changes.' }
  }

  if (input.smartCommit !== 'off' && stageable > 0) {
    if (!hasMessage) {
      return {
        kind: 'disabled',
        label: verb,
        disabled: true,
        reason: 'Enter a commit message.'
      }
    }
    return {
      kind: 'commit',
      label: input.smartCommit === 'all' ? 'Commit All' : 'Commit Tracked',
      disabled: false,
      reason:
        input.smartCommit === 'all'
          ? 'Stage every change and commit the index.'
          : 'Stage tracked changes and commit the index.',
      stageFirst: input.smartCommit
    }
  }

  if (input.headOid !== null && input.branch !== null && !input.hasUpstream) {
    return {
      kind: 'publish',
      label: 'Publish Branch',
      disabled: false,
      reason: 'Publish this branch and set its upstream.'
    }
  }

  if (input.hasUpstream) {
    if (input.ahead > 0 && input.behind > 0) {
      return {
        kind: 'sync',
        label: 'Sync Changes',
        disabled: false,
        reason: `Pull ${String(input.behind)} and push ${String(input.ahead)} commit(s).`
      }
    }
    if (input.ahead > 0) {
      return {
        kind: 'push',
        label: `Push ${String(input.ahead)}`,
        disabled: false,
        reason: 'Push local commits to the upstream.'
      }
    }
    if (input.behind > 0) {
      return {
        kind: 'pull',
        label: `Pull ${String(input.behind)}`,
        disabled: false,
        reason: 'Pull commits from the upstream.'
      }
    }
  }

  if (stageable > 0) {
    return {
      kind: 'disabled',
      label: 'Nothing staged',
      disabled: true,
      reason: 'Stage changes before committing.'
    }
  }

  return { kind: 'noop', label: 'Up to date', disabled: true, reason: 'Nothing to commit.' }
}
