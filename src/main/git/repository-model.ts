/**
 * Repository-level Git facts that are not part of the hot status read.
 *
 * Branch lists, refs, worktree occupancy and an in-progress operation change
 * slowly. Keeping their parsers here lets the future repository model refs and
 * branch actions share one interpretation instead of each dialog splitting Git
 * output its own way.
 */

import type {
  GitOperationKind as SharedGitOperationKind,
  GitRemote
} from '../../shared/domain/git-workspace'

export type GitOperationKind = SharedGitOperationKind

const OPERATION_MARKERS: Record<string, GitOperationKind> = {
  MERGE_HEAD: 'merge',
  CHERRY_PICK_HEAD: 'cherry-pick',
  REVERT_HEAD: 'revert',
  'rebase-merge': 'rebase',
  'rebase-apply': 'rebase',
  BISECT_LOG: 'bisect'
}

/** Maps a `.git` marker name onto the operation a user recognises. */
export function parseOperationMarker(marker: string | null | undefined): GitOperationKind | null {
  if (!marker) return null
  return OPERATION_MARKERS[marker] ?? null
}

/**
 * Parses `git remote -v`.
 *
 * Git prints one line per direction, e.g. `origin\t<url> (fetch)`. A remote
 * without a separate push URL reuses the fetch URL.
 */
export function parseRemotes(output: string): GitRemote[] {
  const remotes = new Map<string, GitRemote>()
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/u, '')
    const match = /^(\S+)\t(.+) \((fetch|push)\)$/u.exec(line)
    if (match === null) continue
    const name = match[1]!
    const url = match[2]!
    const direction = match[3]!
    const current = remotes.get(name) ?? { name, url, pushUrl: null }
    if (direction === 'fetch') current.url = url
    else current.pushUrl = url
    remotes.set(name, current)
  }
  return [...remotes.values()]
}

export type GitSubmoduleEntry = {
  path: string
  oid: string
  /** Space = checked-out commit matches the index; `-` = not initialized. */
  state: 'clean' | 'uninitialized' | 'modified' | 'conflict'
  /** Configured branch in parentheses after the path, when present. */
  branch: string | null
}

const SUBMODULE_LINE = /^([ +\-U])([0-9a-f]{40,64}) (.+?)(?: \(([^)]*)\))?$/u

/** Parses `git submodule status` (non-recursive). */
export function parseSubmoduleStatus(output: string): GitSubmoduleEntry[] {
  const submodules: GitSubmoduleEntry[] = []
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/u, '')
    const match = SUBMODULE_LINE.exec(line)
    if (match === null) continue
    const marker = match[1]!
    const path = match[3]!.trim()
    if (path.length === 0) continue
    submodules.push({
      path,
      oid: match[2]!,
      state:
        marker === '-'
          ? 'uninitialized'
          : marker === '+'
            ? 'modified'
            : marker === 'U'
              ? 'conflict'
              : 'clean',
      branch: match[4] ?? null
    })
  }
  return submodules
}

export type GitWorktreeEntry = {
  path: string
  head: string | null
  /** Short branch name from `branch refs/heads/...`; null when detached. */
  branch: string | null
  bare: boolean
  detached: boolean
  locked: string | null
  prunable: string | null
}

/**
 * Parses `git worktree list --porcelain`.
 *
 * Records are separated by a blank line; `locked` and `prunable` may carry a
 * reason after the keyword.
 */
export function parseWorktreeList(output: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = []
  let current: GitWorktreeEntry | null = null
  const commit = (): void => {
    if (current !== null) entries.push(current)
    current = null
  }
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/u, '')
    if (line.length === 0) {
      commit()
      continue
    }
    if (line.startsWith('worktree ')) {
      commit()
      current = {
        path: line.slice('worktree '.length),
        head: null,
        branch: null,
        bare: false,
        detached: false,
        locked: null,
        prunable: null
      }
      continue
    }
    if (current === null) continue
    if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length)
    else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length)
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
    } else if (line === 'bare') current.bare = true
    else if (line === 'detached') current.detached = true
    else if (line === 'locked') current.locked = ''
    else if (line.startsWith('locked ')) current.locked = line.slice('locked '.length)
    else if (line === 'prunable') current.prunable = ''
    else if (line.startsWith('prunable ')) current.prunable = line.slice('prunable '.length)
  }
  commit()
  return entries
}
