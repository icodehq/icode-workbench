/**
 * The Source Control primary action ladder.
 *
 * This is deliberately pure and separate from the old `working-tree.ts` helper:
 * the full VS Code surface adds operation continuation, smart commit and
 * detached/unborn states. The old helper stays until the migration removes it.
 */

import { translate } from '../i18n/i18n-store'
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
  if (headOid === null) return translate('scm.primary.createFirstCommit')
  if (branch === null) return translate('scm.primary.commitDetached')
  return translate('scm.primary.commit')
}

function operationLabel(operation: Exclude<GitOperationState, null | 'bisect'>): string {
  switch (operation) {
    case 'merge':
      return translate('scm.operation.merge')
    case 'rebase':
      return translate('scm.operation.rebase')
    case 'cherry-pick':
      return translate('scm.operation.cherryPick')
    case 'revert':
      return translate('scm.operation.revert')
  }
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
        label: translate('scm.primary.bisecting'),
        disabled: true,
        reason: translate('scm.primary.bisectReason')
      }
    }
    const conflict = groups.conflicts.length > 0
    const operation = operationLabel(input.operation)
    return {
      kind: 'continue',
      label: translate('scm.primary.continue', { operation }),
      disabled: conflict,
      reason: conflict
        ? translate('scm.primary.resolveBeforeContinue')
        : translate('scm.primary.continueThe', { operation }),
      operation: input.operation
    }
  }

  if (groups.conflicts.length > 0) {
    return {
      kind: 'disabled',
      label: translate('scm.primary.resolveConflicts'),
      disabled: true,
      reason: translate('scm.primary.resolveBeforeCommit')
    }
  }

  if (staged > 0) {
    if (!hasMessage) {
      return {
        kind: 'disabled',
        label: verb,
        disabled: true,
        reason: translate('scm.primary.enterMessage')
      }
    }
    return { kind: 'commit', label: verb, disabled: false, reason: translate('scm.primary.commitStaged') }
  }

  if (input.smartCommit !== 'off' && stageable > 0) {
    if (!hasMessage) {
      return {
        kind: 'disabled',
        label: verb,
        disabled: true,
        reason: translate('scm.primary.enterMessage')
      }
    }
    return {
      kind: 'commit',
      label:
        input.smartCommit === 'all'
          ? translate('scm.primary.commitAll')
          : translate('scm.primary.commitTracked'),
      disabled: false,
      reason:
        input.smartCommit === 'all'
          ? translate('scm.primary.commitAllReason')
          : translate('scm.primary.commitTrackedReason'),
      stageFirst: input.smartCommit
    }
  }

  if (input.headOid !== null && input.branch !== null && !input.hasUpstream) {
    return {
      kind: 'publish',
      label: translate('scm.primary.publishBranch'),
      disabled: false,
      reason: translate('scm.primary.publishReason')
    }
  }

  if (input.hasUpstream) {
    if (input.ahead > 0 && input.behind > 0) {
      return {
        kind: 'sync',
        label: translate('scm.primary.sync'),
        disabled: false,
        reason: translate('scm.primary.syncReason', {
          behind: input.behind,
          ahead: input.ahead
        })
      }
    }
    if (input.ahead > 0) {
      return {
        kind: 'push',
        label: translate('scm.primary.push', { count: input.ahead }),
        disabled: false,
        reason: translate('scm.primary.pushReason')
      }
    }
    if (input.behind > 0) {
      return {
        kind: 'pull',
        label: translate('scm.primary.pull', { count: input.behind }),
        disabled: false,
        reason: translate('scm.primary.pullReason')
      }
    }
  }

  if (stageable > 0) {
    return {
      kind: 'disabled',
      label: translate('scm.primary.nothingStaged'),
      disabled: true,
      reason: translate('scm.primary.stageBeforeCommit')
    }
  }

  return { kind: 'noop', label: translate('scm.primary.upToDate'), disabled: true, reason: translate('scm.primary.nothingToCommit') }
}
