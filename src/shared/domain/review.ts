/**
 * Read-only review of a session's changes.
 *
 * A review is a derived projection of `(worktree.path, base_oid)`. Nothing here
 * is persisted: the baseline is the commit the session's worktree was created
 * from, so agent commits stay visible instead of disappearing from `HEAD`.
 */

/** Maximum captured stdout for one file-diff request, headers included. */
export const REVIEW_MAX_FILE_BYTES = 2 * 1024 * 1024
/** Maximum changed-file entries returned by a list request. */
export const REVIEW_MAX_FILES = 1000
/** Diagnostic stderr kept for a failed Git read. */
export const REVIEW_MAX_STDERR_BYTES = 4096
export const REVIEW_TIMEOUT_MS = 10_000

export const REVIEW_FILE_STATUSES = ['modified', 'added', 'deleted', 'renamed'] as const
export type ReviewFileStatus = (typeof REVIEW_FILE_STATUSES)[number]

/** Staging is metadata only; there are no staged/unstaged review modes. */
export const REVIEW_AREAS = ['staged', 'unstaged', 'both', 'untracked', 'conflicted'] as const
export type ReviewArea = (typeof REVIEW_AREAS)[number]

export type ReviewFile = {
  /** Current path, relative to the worktree. */
  path: string
  /** Rename origin, or the path a deletion removed. */
  oldPath: string | null
  status: ReviewFileStatus
  area: ReviewArea
  origin: 'tracked' | 'untracked'
  /** `null` when Git cannot count lines (binary). */
  additions: number | null
  deletions: number | null
  binary: boolean
  /** Git stores a symlink as mode 120000; its "content" is the link target. */
  symlink: boolean
}

export type ReviewList = {
  sessionId: string
  baselineOid: string
  files: ReviewFile[]
  /** True when the file list exceeded `REVIEW_MAX_FILES`. */
  listTruncated: boolean
}

export type ReviewTruncation = 'bytes' | 'timeout' | null

export type ReviewDiff = {
  sessionId: string
  path: string
  oldPath: string | null
  /** File status; kept distinct from the outcome's `status` discriminant. */
  fileStatus: ReviewFileStatus
  /** Unified patch produced by Git. Empty for binary files. */
  patch: string
  /** Never render a truncated patch as complete. */
  truncated: boolean
  truncatedReason: ReviewTruncation
  binary: boolean
  symlink: boolean
  additions: number | null
  deletions: number | null
}

export const REVIEW_UNAVAILABLE_REASONS = [
  'primary-checkout',
  'worktree-missing',
  'worktree-inconsistent',
  'worktree-failed',
  'invalid-baseline'
] as const
export type ReviewUnavailableReason = (typeof REVIEW_UNAVAILABLE_REASONS)[number]

/**
 * A review request can succeed while reporting that no review is possible.
 * That is different from a transport failure, and the UI shows it inline.
 */
export type ReviewAvailability =
  | { status: 'available' }
  | {
      status: 'unavailable'
      reason: ReviewUnavailableReason
      /** Short user-facing explanation; never includes command output. */
      detail: string
    }
