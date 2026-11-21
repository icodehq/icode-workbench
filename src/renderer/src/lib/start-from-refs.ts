import type { BranchRefKind } from '../../../shared/domain/branch'
import type { BranchRefSummary } from '../../../shared/schemas/ipc'

export type StartFromGroup = {
  kind: BranchRefKind
  refs: BranchRefSummary[]
}

/**
 * The Start-from picker shows local branches first, then remote-tracking
 * branches. Empty groups are omitted so a repository without remotes renders
 * exactly as it did before.
 */
export function groupStartFromRefs(
  refs: readonly BranchRefSummary[]
): StartFromGroup[] {
  const local = refs.filter((ref) => ref.kind === 'local')
  const remote = refs.filter((ref) => ref.kind === 'remote')
  const groups: StartFromGroup[] = []
  if (local.length > 0) groups.push({ kind: 'local', refs: local })
  if (remote.length > 0) groups.push({ kind: 'remote', refs: remote })
  return groups
}

/**
 * Local options submit their short name (the historical wire format); remote
 * options submit the full ref, which disambiguates a local branch that shares
 * the display name.
 */
export function startFromValue(ref: BranchRefSummary): string {
  return ref.kind === 'local' ? ref.name : ref.fullName
}

export function startFromGroupLabelKey(
  kind: BranchRefKind
): 'common.localBranches' | 'common.remoteBranches' {
  return kind === 'local' ? 'common.localBranches' : 'common.remoteBranches'
}
