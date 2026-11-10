import type { GitOperationKind } from '../../../shared/domain/git-workspace'
import { ACTIVE_MERGE_STATES } from '../../../shared/domain/merge'
import type { BranchRefSummary, MergeRecordPayload } from '../../../shared/schemas/ipc'

/** A merge request raised by a task's "Accept & merge" action. */
export type ScmMergeRequest = {
  target: string | null
  lockTarget: boolean
  nonce: number
}

export type MergeTargetOption = {
  name: string
  oid: string
  primaryHead: boolean
  /** Checked out in another linked worktree; the backend would refuse it. */
  disabled: boolean
  /** UI label helper: the target is checked out in a non-primary worktree. */
  inUse: boolean
  /** UI label helper: the target already points at this worktree's HEAD. */
  upToDate: boolean
}

export type MergeTargetReason = '' | 'loading' | 'no-target' | 'missing-target'

export type MergeTargetResolution = {
  options: MergeTargetOption[]
  target: string | null
  targetOid: string | null
  locked: boolean
  loading: boolean
  reason: MergeTargetReason
  alreadyComplete: boolean
}

export type ResolveMergeTargetsInput = {
  refs: readonly BranchRefSummary[]
  sourceBranch: string | null
  headOid: string | null
  hint: string | null
  lockHint: boolean
  loading: boolean
  record: MergeRecordPayload | null
}

export function isActiveMergeRecord(
  record: MergeRecordPayload | null
): record is MergeRecordPayload & { state: 'running' | 'conflicted' } {
  return record !== null && (ACTIVE_MERGE_STATES as readonly string[]).includes(record.state)
}

/**
 * Resolves the default merge target and the selectable target list.
 *
 * The primary checkout is allowed even though it has a worktree path; the
 * backend fast-forwards a clean primary checkout and refuses a dirty one. Only
 * a branch checked out in another linked worktree is disabled here.
 */
export function resolveMergeTargets(input: ResolveMergeTargetsInput): MergeTargetResolution {
  const sourceBranch = input.sourceBranch
  const hint = input.hint !== null && input.hint !== sourceBranch ? input.hint : null
  const options: MergeTargetOption[] = input.refs
    .filter((ref) => ref.name !== sourceBranch)
    .map((ref) => {
      const inUse = ref.worktreePath !== null && !ref.primaryHead
      return {
        name: ref.name,
        oid: ref.oid,
        primaryHead: ref.primaryHead,
        disabled: inUse,
        inUse,
        upToDate: input.headOid !== null && ref.oid === input.headOid
      }
    })

  const locked = hint !== null && input.lockHint
  const hinted = hint === null ? null : options.find((option) => option.name === hint)

  let target: string | null
  let targetOid: string | null
  let reason: MergeTargetReason

  if (hint !== null) {
    target = hint
    targetOid = hinted?.oid ?? null
    reason = targetOid === null ? 'missing-target' : ''
  } else {
    const preferred =
      options.find((option) => option.primaryHead && !option.disabled) ??
      options.find((option) => !option.disabled) ??
      null
    target = preferred?.name ?? null
    targetOid = preferred?.oid ?? null
    reason =
      target !== null ? '' : input.loading ? 'loading' : 'no-target'
  }

  const recordComplete =
    input.record !== null &&
    input.record.state === 'merged' &&
    input.record.targetBranch === target &&
    input.record.resultOid === input.headOid
  const tipComplete = targetOid !== null && targetOid === input.headOid && !locked

  return {
    options,
    target,
    targetOid,
    locked,
    loading: input.loading,
    reason,
    alreadyComplete: recordComplete || tipComplete
  }
}

export type MergeOperationRoute = 'merge' | 'blocked' | 'git' | 'none'

/**
 * Decides whether the SCM Continue/Abort controls belong to the merge service
 * or to the generic Git operation path.
 *
 * A conflicted merge record with no Git operation cannot be continued, but it
 * can still be aborted, which settles the record.
 */
export function mergeOperationRoute(input: {
  record: MergeRecordPayload | null
  operation: GitOperationKind | null
  action: 'continue' | 'abort'
}): MergeOperationRoute {
  if (isActiveMergeRecord(input.record)) {
    if (input.action === 'abort') return 'merge'
    if (input.record.state === 'conflicted' && input.operation === 'merge') return 'merge'
    return 'blocked'
  }
  return input.operation === null ? 'none' : 'git'
}
