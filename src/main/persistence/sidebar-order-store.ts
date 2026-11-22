import type { Database } from './database'
import {
  emptySidebarOrder,
  sanitizeSidebarOrder,
  sidebarOrderPayloadSchema,
  type SidebarOrderPayload
} from '../../shared/schemas/sidebar-order'

/**
 * The sidebar order is one small document, not a row per item: it is read once
 * at startup and written after a drag. A single row keeps the write atomic and
 * leaves no orphan rows when projects, worktrees, or sessions disappear.
 */
const ROW_ID = 1

export class SidebarOrderStore {
  constructor(private readonly db: Database) {}

  get(): SidebarOrderPayload {
    const row = this.db.raw
      .prepare('SELECT document FROM sidebar_order WHERE id = ?')
      .get(ROW_ID) as { document?: unknown } | undefined
    if (typeof row?.document !== 'string') return emptySidebarOrder()
    try {
      const parsed = sidebarOrderPayloadSchema.safeParse(JSON.parse(row.document))
      return parsed.success ? sanitizeSidebarOrder(parsed.data) : emptySidebarOrder()
    } catch {
      // A corrupt document is only a lost preference; never fail startup for it.
      return emptySidebarOrder()
    }
  }

  set(order: SidebarOrderPayload, now = Date.now()): SidebarOrderPayload {
    const clean = sanitizeSidebarOrder(order)
    this.db.raw
      .prepare(
        `INSERT INTO sidebar_order (id, document, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET document = excluded.document, updated_at = excluded.updated_at`
      )
      .run(ROW_ID, JSON.stringify(clean), now)
    return clean
  }
}
