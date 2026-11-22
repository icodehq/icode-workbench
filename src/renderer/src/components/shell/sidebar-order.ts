import type { SidebarOrderPayload } from '../../../../shared/schemas/sidebar-order'

/** A private drag MIME type, so external drops never masquerade as sidebar rows. */
export const SIDEBAR_ROW_DRAG_TYPE = 'application/x-icode-sidebar-row'

export type SidebarDragKind = 'project' | 'worktree' | 'session'

export type SidebarDragSource = {
  kind: SidebarDragKind
  /** Projects and worktrees group by project; sessions by checkout group. */
  groupKey: string
  id: string
}

export type SidebarDropTarget = SidebarDragSource & { after: boolean }

export type SidebarKnownRows = {
  projects: ReadonlySet<string>
  worktrees: Readonly<Record<string, ReadonlySet<string>>>
  sessions: Readonly<Record<string, ReadonlySet<string>>>
}

export const PROJECTS_GROUP_KEY = 'projects'

/**
 * Checkout groups are keyed by the checkout they belong to, not by a session:
 * the default checkout is stable per repository, and a worktree is stable by
 * path even when its branch changes.
 */
export function sessionGroupKey(repoId: string, worktreePath: string | null): string {
  return worktreePath === null ? `default:${repoId}` : `worktree:${worktreePath}`
}

/**
 * Applies a remembered order to the rows that currently exist. Remembered ids
 * that disappeared are skipped, and rows the order does not mention keep their
 * natural relative position after the remembered ones.
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

/**
 * Drops ids that no longer exist and groups that no longer have rows. The
 * renderer reconciles anyway; pruning keeps the stored document from growing
 * with every removed session or worktree.
 */
export function pruneSidebarOrder(
  order: SidebarOrderPayload,
  known: SidebarKnownRows
): SidebarOrderPayload {
  const projects = order.projects.filter((id) => known.projects.has(id))
  const worktrees: Record<string, string[]> = {}
  for (const [repoId, ids] of Object.entries(order.worktrees)) {
    const allowed = known.worktrees[repoId]
    if (allowed === undefined) continue
    const kept = ids.filter((id) => allowed.has(id))
    if (kept.length > 0) worktrees[repoId] = kept
  }
  const sessions: Record<string, string[]> = {}
  for (const [groupKey, ids] of Object.entries(order.sessions)) {
    const allowed = known.sessions[groupKey]
    if (allowed === undefined) continue
    const kept = ids.filter((id) => allowed.has(id))
    if (kept.length > 0) sessions[groupKey] = kept
  }
  return { projects, worktrees, sessions }
}
