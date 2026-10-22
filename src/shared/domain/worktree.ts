import type { AppError } from './errors'
import type { RepoId, SessionId } from './ids'

/**
 * Durable state of a session worktree. `missing` and `inconsistent` are
 * derived from the filesystem and the Host, never persisted: persisting them
 * would go stale and could invite automatic cleanup of valuable work.
 */
export const WORKTREE_STATES = ['creating', 'created', 'ready', 'failed'] as const
export type WorktreeState = (typeof WORKTREE_STATES)[number]

export const WORKTREE_STATUSES = [
  'creating',
  'incomplete',
  'ready-to-start',
  'active',
  'missing',
  'inconsistent',
  'failed'
] as const
export type WorktreeStatus = (typeof WORKTREE_STATUSES)[number]

export type SessionWorktreeRecord = {
  sessionId: SessionId
  repoId: RepoId
  path: string
  branch: string
  baseRef: string | null
  baseOid: string
  state: WorktreeState
  error: AppError | null
  createdAt: number
  updatedAt: number
}

/** Renderer-facing view of a session worktree. */
export type WorktreeSummary = {
  path: string
  branch: string
  baseOid: string
  state: WorktreeState
  status: WorktreeStatus
  error: AppError | null
}

/**
 * Branch ownership outlives the session row so a retained branch can only be
 * deleted through ADE when ADE created it, and only with the exact name.
 */
export type OwnedBranchRecord = {
  branch: string
  repoId: RepoId
  sessionId: string
  baseOid: string
  createdAt: number
}

export type OwnedBranchSummary = OwnedBranchRecord & {
  exists: boolean
  /** `null` when it cannot be computed (missing HEAD, Git failure). */
  unmergedCommits: number | null
  worktreePath: string | null
}

export type WorktreeInspection = {
  pathExists: boolean
  registered: boolean
  headOid: string | null
  dirtyFiles: string[]
  unmergedCommits: number | null
}

export type RepositoryGitState = {
  headOid: string | null
  headRef: string | null
  unborn: boolean
  inProgressOperation: string | null
}

export const WORKTREE_BRANCH_PREFIX = 'ade/'

/** Session IDs already start with `ses_`, so the branch reads `ade/ses_<uuid>`. */
export function branchNameForSession(sessionId: string): string {
  return `${WORKTREE_BRANCH_PREFIX}${sessionId}`
}

export function isOwnedWorktreeBranch(branch: string, sessionId: string): boolean {
  return branch === branchNameForSession(sessionId)
}
