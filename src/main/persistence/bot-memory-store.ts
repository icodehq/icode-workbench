import type { Database } from './database'
import type {
  MemoryEntry,
  MemoryScope,
  MemoryStatus,
  MemoryTarget
} from '../../shared/domain/memory'

const MEMORY_COLUMNS = `id, scope, bot_id, repo_id, team_id, proposed_by_bot_id,
  key, value, status, source_task_id, created_at, updated_at`

type MemoryRow = {
  id: string
  scope: string
  bot_id: string | null
  repo_id: string | null
  team_id: string | null
  proposed_by_bot_id: string | null
  key: string
  value: string
  status: string
  source_task_id: string | null
  created_at: number
  updated_at: number
}

function requireString(value: unknown, column: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`iCode bot memory row has an invalid ${column}.`)
  }
  return value
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function memoryFromRow(row: MemoryRow): MemoryEntry {
  return {
    id: requireString(row.id, 'bot_memory.id'),
    scope: row.scope as MemoryScope,
    botId: nullableString(row.bot_id),
    repoId: nullableString(row.repo_id),
    teamId: nullableString(row.team_id),
    proposedByBotId: nullableString(row.proposed_by_bot_id),
    key: requireString(row.key, 'bot_memory.key'),
    value: requireString(row.value, 'bot_memory.value'),
    status: row.status as MemoryStatus,
    sourceTaskId: nullableString(row.source_task_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  }
}

function targetWhere(target: MemoryTarget): { sql: string; params: string[] } {
  switch (target.scope) {
    case 'bot':
      return { sql: `scope = 'bot' AND bot_id = ?`, params: [target.botId] }
    case 'project':
      return { sql: `scope = 'project' AND repo_id = ?`, params: [target.repoId] }
    case 'team':
      return { sql: `scope = 'team' AND team_id = ?`, params: [target.teamId] }
  }
}

/**
 * Scoped bot memory from before MEMORY.md.
 *
 * No longer injected into prompts or shown in Settings: bot memory now lives in
 * each bot's MEMORY.md. This store is kept to move active bot-scoped rows into
 * that file once (`legacy-memory-migration.ts`); project and group rows remain
 * readable here as history.
 */
export class BotMemoryStore {
  constructor(private readonly db: Database) {}

  list(
    target: MemoryTarget,
    options: { status?: MemoryStatus; limit?: number } = {}
  ): MemoryEntry[] {
    const where = targetWhere(target)
    const status = options.status ?? 'active'
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500))
    const rows = this.db.raw
      .prepare(
        `SELECT ${MEMORY_COLUMNS} FROM bot_memory
         WHERE ${where.sql} AND status = ?
         ORDER BY updated_at DESC, key ASC LIMIT ?`
      )
      .all(...where.params, status, limit) as MemoryRow[]
    return rows.map(memoryFromRow)
  }

  find(target: MemoryTarget, key: string, status: MemoryStatus = 'active'): MemoryEntry | null {
    const where = targetWhere(target)
    const row = this.db.raw
      .prepare(
        `SELECT ${MEMORY_COLUMNS} FROM bot_memory
         WHERE ${where.sql} AND key = ? AND status = ?
         ORDER BY updated_at DESC LIMIT 1`
      )
      .get(...where.params, key, status) as MemoryRow | undefined
    return row ? memoryFromRow(row) : null
  }

  findById(id: string): MemoryEntry | null {
    const row = this.db.raw
      .prepare(`SELECT ${MEMORY_COLUMNS} FROM bot_memory WHERE id = ?`)
      .get(id) as MemoryRow | undefined
    return row ? memoryFromRow(row) : null
  }

  insert(entry: MemoryEntry): MemoryEntry {
    this.db.raw
      .prepare(
        `INSERT INTO bot_memory (
           id, scope, bot_id, repo_id, team_id, proposed_by_bot_id,
           key, value, status, source_task_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.id,
        entry.scope,
        entry.botId,
        entry.repoId,
        entry.teamId,
        entry.proposedByBotId,
        entry.key,
        entry.value,
        entry.status,
        entry.sourceTaskId,
        entry.createdAt,
        entry.updatedAt
      )
    return this.findById(entry.id)!
  }

  updateValue(id: string, value: string, now: number): boolean {
    const result = this.db.raw
      .prepare(`UPDATE bot_memory SET value = ?, updated_at = ? WHERE id = ?`)
      .run(value, now, id)
    return Number(result.changes) === 1
  }

  setStatus(id: string, status: MemoryStatus, now: number): boolean {
    const result = this.db.raw
      .prepare(`UPDATE bot_memory SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, now, id)
    return Number(result.changes) === 1
  }

  /**
   * Approves a proposed entry after archiving the active entry it replaces.
   *
   * The partial unique index allows one active row per scope/key; the archive
   * and the approval run in one transaction so a failed approval cannot leave
   * the key with no active memory.
   */
  approve(id: string, now: number): MemoryEntry | null {
    const entry = this.findById(id)
    if (entry === null) return null
    const target: MemoryTarget =
      entry.scope === 'bot'
        ? { scope: 'bot', botId: entry.botId! }
        : entry.scope === 'project'
          ? { scope: 'project', repoId: entry.repoId! }
          : { scope: 'team', teamId: entry.teamId! }
    this.db.transaction(() => {
      const where = targetWhere(target)
      this.db.raw
        .prepare(
          `UPDATE bot_memory SET status = 'archived', updated_at = ?
           WHERE ${where.sql} AND key = ? AND status = 'active' AND id <> ?`
        )
        .run(now, ...where.params, entry.key, id)
      this.db.raw
        .prepare(
          `UPDATE bot_memory SET status = 'active', updated_at = ? WHERE id = ?`
        )
        .run(now, id)
    })
    return this.findById(id)
  }

  remove(id: string): boolean {
    const result = this.db.raw.prepare(`DELETE FROM bot_memory WHERE id = ?`).run(id)
    return Number(result.changes) === 1
  }
}
