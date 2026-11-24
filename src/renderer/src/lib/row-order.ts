/**
 * Pure row ordering shared by the sidebar and the worktree tab bar.
 *
 * Both surfaces reconcile a remembered order against the rows that currently
 * exist; keeping the algorithm here prevents the two from drifting.
 */

export function orderByStoredIds<T>(
  items: readonly T[],
  order: readonly string[],
  key: (item: T) => string
): T[] {
  const byId = new Map(items.map((item) => [key(item), item]))
  const seen = new Set<string>()
  const result: T[] = []
  for (const id of order) {
    if (seen.has(id)) continue
    const item = byId.get(id)
    if (item === undefined) continue
    seen.add(id)
    result.push(item)
  }
  for (const item of items) {
    const id = key(item)
    if (seen.has(id)) continue
    seen.add(id)
    result.push(item)
  }
  return result
}

export function orderRowIds(available: readonly string[], order: readonly string[]): string[] {
  return orderByStoredIds(available, order, (id) => id)
}

/** Moves `sourceId` into the target's slot, before or after it. */
export function moveRowId(
  ids: readonly string[],
  sourceId: string,
  targetId: string,
  after: boolean
): string[] {
  const from = ids.indexOf(sourceId)
  const to = ids.indexOf(targetId)
  if (from < 0 || to < 0 || from === to) return [...ids]
  const next = ids.filter((id) => id !== sourceId)
  const targetIndex = next.indexOf(targetId)
  next.splice(after ? targetIndex + 1 : targetIndex, 0, sourceId)
  return next
}
