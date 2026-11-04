/**
 * Worktree-scoped Git state for the Git panel.
 *
 * Read-only status plus the three change-management operations a developer
 * actually uses while reviewing an Agent's work: stage, unstage and commit. The
 * baseline and review semantics are untouched — this is a different projection
 * of the same checkout.
 */

/** One path reported by `git status --porcelain=v1 -z`. */
export type GitStatusEntry = {
  path: string
  /** Rename origin, when Git reports one. */
  oldPath: string | null
  /** Two-letter porcelain code, e.g. ` M`, `M `, `??`, `A `. */
  code: string
  /** Human-readable area derived from the code. */
  area: 'staged' | 'unstaged' | 'untracked' | 'conflicted'
  /** Human-readable status word for display. */
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'unmerged' | 'untracked'
  /**
   * Line counts for this entry's area. Undefined when the status read did not
   * compute them; null for binary files.
   */
  added?: number | null
  removed?: number | null
  /** True when Git reports the path as binary. */
  binary?: boolean
}

export type GitWorkspaceStatus = {
  branch: string | null
  /** Commit the checkout's HEAD points at; null on an unborn branch. */
  headOid: string | null
  /** Configured upstream, e.g. `origin/main`, or null. */
  upstream: string | null
  ahead: number
  behind: number
  staged: GitStatusEntry[]
  unstaged: GitStatusEntry[]
  untracked: GitStatusEntry[]
  conflicted: GitStatusEntry[]
  /** True when the worktree has no changes at all. */
  clean: boolean
  /**
   * Unique paths Git reported. Optional so older callers and fixtures remain
   * valid; the v2 reader always sets it.
   */
  statusLength?: number
  /** True when the read stopped at the status limit. */
  didHitLimit?: boolean
  /** Opaque stamp for the status content, used to reject stale destructive work. */
  revision?: string
}

export type GitCommitResult = {
  /** Short OID of the commit Git created. */
  oid: string
  /** Subject line Git recorded. */
  subject: string
  /** How many paths the commit included. */
  files: number
}

/** One selected row in a batch Git operation. */
export type GitPathTarget = {
  path: string
  area: GitStatusEntry['area']
  oldPath?: string | null
  status?: GitStatusEntry['status']
}

export type GitPathOutcome = {
  path: string
  area: GitStatusEntry['area']
  status: 'applied' | 'skipped' | 'failed'
  reason?: string
}

/** An in-progress multi-step Git operation, as a UI label rather than a marker. */
export type GitOperationKind = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect'

/** One coalesced worktree change pushed from main to an active Changes panel. */
export type GitStatusWatchEvent = {
  sessionId: string
  /** Monotonic per session; increases for every coalesced change. */
  revision: number
  /** Worktree-relative paths, capped; empty for a Git-metadata-only change. */
  changedPaths: string[]
  overflow: boolean
  /** Index, HEAD, refs or an operation marker changed. */
  metadataChanged: boolean
  /** Set when the watcher failed after it reported success. */
  failed?: boolean
}

/** Why a session's live watch is not available. */
export type GitWatchUnavailableReason = 'unsupported-target' | 'watch-failed' | 'cancelled'

/** A local tag and the object it points at. */
export type GitTag = {
  name: string
  oid: string
}

/** A configured Git remote from `git remote -v`. */
export type GitRemote = {
  name: string
  url: string
  pushUrl: string | null
}

/** Git's well-known empty-tree object, used to diff a root commit. */
export const GIT_EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** One file in a `from..to` diff, used by history and commit review. */
export type GitRangeFile = {
  path: string
  oldPath: string | null
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied'
  additions: number | null
  deletions: number | null
  binary: boolean
}

/** One commit in the paginated History graph. */
export type GitLogEntry = {
  oid: string
  shortOid: string
  /** Full parent hashes, newest first; the graph uses these to assign lanes. */
  parents: string[]
  subject: string
  author: string
  authorEmail: string
  /** Unix seconds from the author date. */
  authoredAt: number
  /** Decorations such as `HEAD -> main`, `origin/main` or `tag: v1`. */
  refs: string[]
}

export type GitLogPage = {
  branch: string | null
  headOid: string | null
  /** Upstream ref such as `origin/main`, or null. */
  upstream: string | null
  /** Commits on HEAD that are not upstream. */
  ahead: number
  /** Commits on upstream that are not in HEAD. */
  behind: number
  commits: GitLogEntry[]
  hasMore: boolean
  /** Offset to pass as `skip` for the next page. */
  nextSkip: number
}

/** One commit plus the files of a chosen parent comparison. */
export type GitCommitDetail = {
  oid: string
  shortOid: string
  parents: string[]
  subject: string
  body: string
  author: string
  authorEmail: string
  authoredAt: number
  /** null for a root commit, which is diffed against the empty tree. */
  parentOid: string | null
  files: GitRangeFile[]
  additions: number
  deletions: number
  truncated: boolean
}

/** Per-path result of a batch stage, unstage or discard. */
export type GitBatchResult = {
  outcomes: GitPathOutcome[]
  applied: string[]
  skipped: string[]
  failed: string[]
}

export type GitUnavailableReason =
  | 'primary-checkout'
  | 'worktree-missing'
  | 'worktree-unavailable'
  | 'not-a-repository'
  | 'nothing-to-commit'
  | 'commit-failed'
  | 'git-failed'

/** Maps a porcelain XY code onto the area a reviewer thinks in. */
export function areaForCode(code: string): GitStatusEntry['area'] {
  if (code === '??') return 'untracked'
  if (code === '!!') return 'untracked'
  const [index, worktree] = [code[0] ?? ' ', code[1] ?? ' ']
  if (index === 'U' || worktree === 'U' || code === 'AA' || code === 'DD') return 'conflicted'
  if (index !== ' ' && index !== '?') return 'staged'
  return 'unstaged'
}

/** Maps a porcelain XY code onto a display word. */
export function statusForCode(code: string): GitStatusEntry['status'] {
  if (code === '??') return 'untracked'
  const letters = `${code[0] ?? ' '}${code[1] ?? ' '}`
  if (letters.includes('U') || letters === 'AA' || letters === 'DD') return 'unmerged'
  if (letters.includes('R')) return 'renamed'
  if (letters.includes('C')) return 'copied'
  if (letters.includes('A')) return 'added'
  if (letters.includes('D')) return 'deleted'
  return 'modified'
}

/**
 * Parses `git status --porcelain=v1 -z`.
 *
 * Rename and copy entries consume a second NUL-separated field, so a naive
 * split drops the path that follows and shifts every later entry.
 */
export function parsePorcelainZ(output: string): GitStatusEntry[] {
  const parts = output.split('\u0000')
  const entries: GitStatusEntry[] = []
  for (let index = 0; index < parts.length; index += 1) {
    const raw = parts[index]
    if (!raw || raw.length < 4) continue
    const code = raw.slice(0, 2)
    const path = raw.slice(3)
    const indexStatus = code[0] ?? ' '
    const worktreeStatus = code[1] ?? ' '
    const renamed = indexStatus === 'R' || indexStatus === 'C'
    const oldPath = renamed ? (parts[index + 1] ?? null) : null
    if (renamed) index += 1
    if (!path) continue

    // A path can be dirty in both the index and the working tree. Emit one
    // entry per area so the UI can show the two diffs and line counts without
    // pretending the working-tree edit is part of the staged one.
    if (code === '??' || code === '!!') {
      entries.push({ path, oldPath: null, code, area: 'untracked', status: 'untracked' })
      continue
    }
    if (areaForCode(code) === 'conflicted') {
      entries.push({ path, oldPath, code, area: 'conflicted', status: statusForCode(code) })
      continue
    }
    if (indexStatus !== ' ' && indexStatus !== '?') {
      const stagedCode = `${indexStatus} `
      entries.push({
        path,
        oldPath,
        code: stagedCode,
        area: 'staged',
        status: statusForCode(stagedCode)
      })
    }
    if (worktreeStatus !== ' ' && worktreeStatus !== '?') {
      const unstagedCode = ` ${worktreeStatus}`
      entries.push({
        path,
        oldPath: null,
        code: unstagedCode,
        area: 'unstaged',
        status: statusForCode(unstagedCode)
      })
    }
  }
  return entries
}

/**
 * Parses `git rev-list --left-right --count upstream...HEAD`.
 *
 * The left number counts commits reachable from the upstream but not HEAD
 * (behind); the right counts HEAD but not the upstream (ahead). Naming the
 * fields by their meaning rather than by output order is what keeps the header
 * from showing the two numbers backwards.
 */
export function parseAheadBehind(output: string): { ahead: number; behind: number } {
  const [left, right] = output.trim().split(/\s+/u)
  const behind = Number.parseInt(left ?? '', 10)
  const ahead = Number.parseInt(right ?? '', 10)
  return {
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0
  }
}
