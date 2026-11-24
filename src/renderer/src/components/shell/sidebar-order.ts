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
 *
 * The implementation lives in the workspace module so the center tab list can
 * use the same identity without importing a component.
 */
export { sessionGroupKey } from '../../workspace/workspace-key'

/** Shared row ordering, re-exported for the sidebar's existing consumers. */
export { moveRowId, orderByStoredIds, orderRowIds } from '../../lib/row-order'

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
