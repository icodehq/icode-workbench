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
}

export type GitCommitResult = {
  /** Short OID of the commit Git created. */
  oid: string
  /** Subject line Git recorded. */
  subject: string
  /** How many paths the commit included. */
  files: number
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
    const renamed = code.includes('R') || code.includes('C')
    const oldPath = renamed ? parts[index + 1] ?? null : null
    if (renamed) index += 1
    if (!path) continue
    entries.push({ path, oldPath, code, area: areaForCode(code), status: statusForCode(code) })
  }
  return entries
}

/** Parses the two integers from `git rev-list --left-right --count a...b`. */
export function parseAheadBehind(output: string): { ahead: number; behind: number } {
  const [left, right] = output.trim().split(/\s+/u)
  const ahead = Number.parseInt(left ?? '', 10)
  const behind = Number.parseInt(right ?? '', 10)
  return {
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0
  }
}
