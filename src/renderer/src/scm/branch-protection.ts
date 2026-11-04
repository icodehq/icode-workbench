/**
 * Matches a branch name against the advisory protection patterns.
 *
 * Patterns are Git-style shell globs: `main`, `release/*`, `hotfix-*`. A
 * pattern without `*` must match the whole branch. Protection is local to iCode
 * and only blocks commits made here; Git itself is never prevented from
 * operating in the terminal.
 */
export function isBranchProtected(
  branch: string | null | undefined,
  patterns: readonly string[]
): boolean {
  if (branch === null || branch === undefined || branch.length === 0) return false
  return patterns.some((pattern) => {
    const trimmed = pattern.trim()
    if (trimmed.length === 0) return false
    const source = trimmed
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
      .join('.*')
    return new RegExp(`^${source}$`, 'u').test(branch)
  })
}
