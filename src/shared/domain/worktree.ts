import type { AppError } from './errors'
import type { RepoId, SessionId, WorktreeId } from './ids'
import { APP_BRANCH_PREFIX } from './app-identity'

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

/**
 * A linked checkout owned by one repository.
 *
 * The worktree is the durable entity; sessions attach to it and a worktree may
 * hold several sessions at once. Its path and branch are unique across iCode's
 * database, so two sessions can share the identity but never fork it.
 */
export type WorktreeRecord = {
  id: WorktreeId
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

/** One worktree as seen from a session attached to it. */
export type SessionWorktreeRecord = WorktreeRecord & {
  sessionId: SessionId
}

/** Renderer-facing view of a worktree (shared by every session attached to it). */
export type WorktreeSummary = {
  id: WorktreeId
  path: string
  branch: string
  baseOid: string
  state: WorktreeState
  status: WorktreeStatus
  error: AppError | null
}

/**
 * Branch ownership outlives the session row so a retained branch can only be
 * deleted through iCode when iCode created it, and only with the exact name.
 */
export const OWNED_BRANCH_KINDS = ['session', 'chain'] as const
export type OwnedBranchKind = (typeof OWNED_BRANCH_KINDS)[number]

export type OwnedBranchRecord = {
  branch: string
  repoId: RepoId
  /** Set for a branch owned by a worktree checkout. */
  worktreeId: WorktreeId | null
  /** The session that created the branch; kept as provenance, not ownership. */
  sessionId: string | null
  /** Set for a dependency-chain branch. */
  taskId: string | null
  kind: OwnedBranchKind
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

export const WORKTREE_BRANCH_PREFIX = APP_BRANCH_PREFIX

/** Session IDs already start with `ses_`, so the branch reads `icode/ses_<uuid>`. */
export function branchNameForSession(sessionId: string): string {
  return `${WORKTREE_BRANCH_PREFIX}${sessionId}`
}

export function isOwnedWorktreeBranch(branch: string, sessionId: string): boolean {
  return branch === branchNameForSession(sessionId)
}
