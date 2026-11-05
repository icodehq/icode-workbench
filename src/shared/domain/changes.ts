/**
 * Read-only change projections of a session's checkout.
 *
 * A change list is derived from `(worktree.path, base_oid)` and never persisted:
 * the baseline is the commit the session's worktree was created from, so agent
 * commits stay visible instead of disappearing from `HEAD`. A working-tree diff
 * is a separate projection of the same checkout: staged, unstaged, untracked or
 * conflicted.
 */

/** Maximum captured stdout for one file-diff request, headers included. */
export const CHANGE_MAX_FILE_BYTES = 2 * 1024 * 1024
/** Maximum changed-file entries returned by a list request. */
export const CHANGE_MAX_FILES = 1000
/** Diagnostic stderr kept for a failed Git read. */
export const CHANGE_MAX_STDERR_BYTES = 4096
export const CHANGE_READ_TIMEOUT_MS = 10_000

export const CHANGE_FILE_STATUSES = ['modified', 'added', 'deleted', 'renamed'] as const
export type ChangeFileStatus = (typeof CHANGE_FILE_STATUSES)[number]

/** Staging is metadata only; there are no staged/unstaged listing modes. */
export const CHANGE_AREAS = ['staged', 'unstaged', 'both', 'untracked', 'conflicted'] as const
export type ChangeArea = (typeof CHANGE_AREAS)[number]

/** One side of the index that a working-tree diff can describe. */
export const CHANGE_DIFF_SCOPES = ['staged', 'unstaged', 'untracked', 'conflict'] as const
export type ChangeDiffScope = (typeof CHANGE_DIFF_SCOPES)[number]

export type ChangeFile = {
  /** Current path, relative to the worktree. */
  path: string
  /** Rename origin, or the path a deletion removed. */
  oldPath: string | null
  status: ChangeFileStatus
  area: ChangeArea
  origin: 'tracked' | 'untracked'
  /** `null` when Git cannot count lines (binary). */
  additions: number | null
  deletions: number | null
  binary: boolean
  /**
   * Git stores a symlink as mode 120000; its "content" is the link target.
   *
   * `null` means the check could not be completed (for example a distro that is
   * unreachable). It is deliberately not `false`: claiming "not a symlink" when
   * nobody asked the right filesystem is the misreport this field must avoid.
   */
  symlink: boolean | null
}

export type ChangeList = {
  sessionId: string
  baselineOid: string
  files: ChangeFile[]
  /** True when the file list exceeded `CHANGE_MAX_FILES`. */
  listTruncated: boolean
}

export type ChangeTruncation = 'bytes' | 'timeout' | null

export type ChangeDiff = {
  sessionId: string
  path: string
  oldPath: string | null
  /** File status; kept distinct from the outcome's `status` discriminant. */
  fileStatus: ChangeFileStatus
  /** Unified patch produced by Git. Empty for binary files. */
  patch: string
  /** Never render a truncated patch as complete. */
  truncated: boolean
  truncatedReason: ChangeTruncation
  binary: boolean
  symlink: boolean | null
  additions: number | null
  deletions: number | null
}

export type ChangeUnavailableReason =
  | 'primary-checkout'
  | 'worktree-missing'
  | 'worktree-inconsistent'
  | 'worktree-failed'
  | 'invalid-baseline'

/** A change request can succeed while reporting that no changes are visible. */
export type ChangeUnavailable = {
  status: 'unavailable'
  reason: ChangeUnavailableReason
  /** Short user-facing explanation; never includes command output. */
  detail: string
}

export type ChangeDiffOutcome = ({ status: 'available' } & ChangeDiff) | ChangeUnavailable
export type ChangeListOutcome = ({ status: 'available' } & ChangeList) | ChangeUnavailable
