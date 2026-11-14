/**
 * Session tabs keep a browser-like order that is independent of the session
 * store. A remembered order may be stale (sessions are removed, added, or
 * hidden), so it is always reconciled against the IDs that currently exist.
 */
export function orderSessionTabIds(
  available: readonly string[],
  order: readonly string[]
): string[] {
  const present = new Set(available)
  const seen = new Set<string>()
  const result: string[] = []
  for (const id of order) {
    if (!present.has(id) || seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  for (const id of available) {
    if (seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result
}

/**
 * Moves a dragged tab so it takes the target's slot: dropping onto a tab to
 * the right inserts after it, dropping onto a tab to the left inserts before
 * it. Unknown IDs leave the order untouched.
 */
export function moveSessionTab(
  ids: readonly string[],
  sourceId: string,
  targetId: string
): string[] {
  const from = ids.indexOf(sourceId)
  const to = ids.indexOf(targetId)
  if (from < 0 || to < 0 || from === to) return [...ids]
  const next = ids.filter((id) => id !== sourceId)
  const targetIndex = next.indexOf(targetId)
  next.splice(from < to ? targetIndex + 1 : targetIndex, 0, sourceId)
  return next
}
