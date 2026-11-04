/**
 * Scores a fuzzy subsequence match, higher is better; null means no match.
 *
 * Deliberately the classic filename behaviour: characters must appear in order,
 * a contiguous run at a path-segment start scores best, and the basename counts
 * double so "panl" finds `components/FilesPanel.tsx` rather than a longer path
 * that happens to contain the letters.
 */
export function fuzzyScore(candidate: string, query: string): number | null {
  if (query.length === 0) return 0
  const haystack = candidate.toLowerCase()
  const needle = query.toLowerCase()

  let score = 0
  let cursor = 0
  let lastMatch = -2
  for (const character of needle) {
    const found = haystack.indexOf(character, cursor)
    if (found === -1) return null
    const contiguous = found === lastMatch + 1
    const atSegmentStart = found === 0 || haystack[found - 1] === '/'
    const inBasename = found >= haystack.lastIndexOf('/') + 1
    score += 1
    if (contiguous) score += 4
    if (atSegmentStart) score += 6
    if (inBasename) score += 3
    lastMatch = found
    cursor = found + 1
  }
  // Prefer shorter paths when the match quality ties.
  return score - Math.min(candidate.length, 200) / 100
}
