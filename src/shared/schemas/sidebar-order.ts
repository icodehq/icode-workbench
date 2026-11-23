import { z } from 'zod'

/**
 * The user's manual order for the workspace sidebar. Rows are reconciled
 * against the rows that currently exist, so a remembered order may hold ids
 * that have since been removed; the renderer prunes before saving.
 *
 * Projects share one order. Worktrees are ordered within their project, keyed
 * by repository id; sessions are ordered within their checkout group, keyed by
 * `default:<repoId>` or `worktree:<path>`. A group only exists while it has
 * rows, so its entry is dropped when the last row goes away.
 */
const rowIdSchema = z.string().min(1).max(4096)
const groupKeySchema = z.string().min(1).max(4200)
const repoKeySchema = z.string().min(1).max(128)

/** Caps keep a corrupt or hostile payload from growing the database without bound. */
export const SIDEBAR_ORDER_MAX_PROJECTS = 2_000
export const SIDEBAR_ORDER_MAX_GROUPS = 5_000
export const SIDEBAR_ORDER_MAX_ROWS_PER_GROUP = 5_000

export const sidebarOrderPayloadSchema = z.strictObject({
  projects: z.array(rowIdSchema).max(SIDEBAR_ORDER_MAX_PROJECTS),
  worktrees: z.record(repoKeySchema, z.array(rowIdSchema).max(SIDEBAR_ORDER_MAX_ROWS_PER_GROUP)),
  sessions: z.record(groupKeySchema, z.array(rowIdSchema).max(SIDEBAR_ORDER_MAX_ROWS_PER_GROUP))
})

export type SidebarOrderPayload = z.infer<typeof sidebarOrderPayloadSchema>

export type SidebarOrderScope = 'projects' | 'worktrees' | 'sessions'

export function emptySidebarOrder(): SidebarOrderPayload {
  return { projects: [], worktrees: {}, sessions: {} }
}

function uniqueIds(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const id of ids) {
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result
}

function uniqueGroups(
  groups: Readonly<Record<string, readonly string[]>>,
  maxGroups: number
): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  for (const [key, ids] of Object.entries(groups)) {
    if (Object.keys(result).length >= maxGroups) break
    if (key.length === 0) continue
    result[key] = uniqueIds(ids)
  }
  return result
}

/**
 * Deduplicates every list and applies the same caps the schema enforces. Both
 * sides of the IPC boundary call this so a valid payload is also a compact one.
 */
export function sanitizeSidebarOrder(order: SidebarOrderPayload): SidebarOrderPayload {
  return {
    projects: uniqueIds(order.projects).slice(0, SIDEBAR_ORDER_MAX_PROJECTS),
    worktrees: uniqueGroups(order.worktrees, SIDEBAR_ORDER_MAX_GROUPS),
    sessions: uniqueGroups(order.sessions, SIDEBAR_ORDER_MAX_GROUPS)
  }
}
