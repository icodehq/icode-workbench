import type { Database } from '../persistence/database'

export type BotAutomation = {
  id: string
  botId: string
  name: string
  prompt: string
  intervalMinutes: number
  enabled: boolean
  lastRunAt: number | null
  nextRunAt: number
  createdAt: number
  updatedAt: number
}

type BotAutomationRow = {
  id: string
  bot_id: string
  name: string
  prompt: string
  interval_minutes: number
  enabled: number
  last_run_at: number | null
  next_run_at: number
  created_at: number
  updated_at: number
}

const COLUMNS = `id, bot_id, name, prompt, interval_minutes, enabled,
  last_run_at, next_run_at, created_at, updated_at`

function fromRow(row: BotAutomationRow): BotAutomation {
  return {
    id: row.id,
    botId: row.bot_id,
    name: row.name,
    prompt: row.prompt,
    intervalMinutes: Number(row.interval_minutes),
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at === null ? null : Number(row.last_run_at),
    nextRunAt: Number(row.next_run_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  }
}

export class BotAutomationStore {
  constructor(private readonly db: Database) {}

  insert(automation: BotAutomation): BotAutomation {
    this.db.raw
      .prepare(
        `INSERT INTO bot_automations (${COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        automation.id,
        automation.botId,
        automation.name,
        automation.prompt,
        automation.intervalMinutes,
        automation.enabled ? 1 : 0,
        automation.lastRunAt,
        automation.nextRunAt,
        automation.createdAt,
        automation.updatedAt
      )
    return this.findById(automation.id)!
  }

  findById(id: string): BotAutomation | null {
    const row = this.db.raw
      .prepare(`SELECT ${COLUMNS} FROM bot_automations WHERE id = ?`)
      .get(id) as BotAutomationRow | undefined
    return row ? fromRow(row) : null
  }

  listForBot(botId: string): BotAutomation[] {
    return (
      this.db.raw
        .prepare(
          `SELECT ${COLUMNS} FROM bot_automations
           WHERE bot_id = ? ORDER BY created_at ASC, id ASC`
        )
        .all(botId) as BotAutomationRow[]
    ).map(fromRow)
  }

  due(now: number, limit = 10): BotAutomation[] {
    return (
      this.db.raw
        .prepare(
          `SELECT ${COLUMNS} FROM bot_automations
           WHERE enabled = 1 AND next_run_at <= ?
           ORDER BY next_run_at ASC, id ASC LIMIT ?`
        )
        .all(now, limit) as BotAutomationRow[]
    ).map(fromRow)
  }

  update(
    id: string,
    input: {
      name?: string
      prompt?: string
      intervalMinutes?: number
      enabled?: boolean
      lastRunAt?: number | null
      nextRunAt?: number
      updatedAt: number
    }
  ): BotAutomation | null {
    const current = this.findById(id)
    if (current === null) return null
    this.db.raw
      .prepare(
        `UPDATE bot_automations
         SET name = ?, prompt = ?, interval_minutes = ?, enabled = ?,
             last_run_at = ?, next_run_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.name ?? current.name,
        input.prompt ?? current.prompt,
        input.intervalMinutes ?? current.intervalMinutes,
        (input.enabled ?? current.enabled) ? 1 : 0,
        input.lastRunAt === undefined ? current.lastRunAt : input.lastRunAt,
        input.nextRunAt ?? current.nextRunAt,
        input.updatedAt,
        id
      )
    return this.findById(id)
  }

  remove(id: string): boolean {
    const result = this.db.raw.prepare(`DELETE FROM bot_automations WHERE id = ?`).run(id)
    return Number(result.changes) === 1
  }

  removeForBot(botId: string): void {
    this.db.raw.prepare(`DELETE FROM bot_automations WHERE bot_id = ?`).run(botId)
  }
}
