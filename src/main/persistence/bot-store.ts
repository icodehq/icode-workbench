import type { Database } from './database'
import type { AssistantSettings } from '../../shared/domain/assistant'
import { DEFAULT_ASSISTANT_SETTINGS } from '../../shared/domain/assistant'
import type { BotRecord } from '../../shared/domain/bot'
import { assistantSettingsSchema } from '../../shared/schemas/assistant'

const BOT_COLUMNS = `id, name, role, avatar_color, avatar_image, avatar_mascot, avatar_outfit, instructions, settings_json,
  archived_at, paused_at, created_at, updated_at`

type BotRow = {
  id: string
  name: string
  role: string
  avatar_color: string
  avatar_image: string | null
  avatar_mascot: string | null
  avatar_outfit: string | null
  instructions: string
  settings_json: string | null
  archived_at: number | null
  paused_at: number | null
  created_at: number
  updated_at: number
}

function requireString(value: unknown, column: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`iCode bot row has an invalid ${column}.`)
  }
  return value
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function nullableInteger(value: unknown, column: string): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`iCode bot row has an invalid ${column}.`)
  }
  return value
}

function parseSettings(value: unknown): AssistantSettings | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new Error('iCode bot row has invalid settings JSON.')
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('iCode bot row has malformed settings JSON.')
  }
  const result = assistantSettingsSchema.safeParse(parsed)
  if (!result.success) throw new Error('iCode bot row has unsupported settings.')
  return result.data
}

function botFromRow(row: BotRow): BotRecord {
  return {
    id: requireString(row.id, 'bots.id'),
    name: requireString(row.name, 'bots.name'),
    role: requireString(row.role, 'bots.role'),
    avatarColor: requireString(row.avatar_color, 'bots.avatar_color'),
    avatarImage: nullableString(row.avatar_image),
    avatarMascot: nullableString(row.avatar_mascot),
    avatarOutfit: nullableString(row.avatar_outfit),
    instructions: typeof row.instructions === 'string' ? row.instructions : '',
    settings: parseSettings(row.settings_json),
    archivedAt: nullableInteger(row.archived_at, 'bots.archived_at'),
    pausedAt: nullableInteger(row.paused_at, 'bots.paused_at'),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  }
}

export type BotPatch = {
  name?: string
  role?: string
  avatarColor?: string
  avatarImage?: string | null
  avatarMascot?: string | null
  avatarOutfit?: string | null
  instructions?: string
  settings?: AssistantSettings | null
  archivedAt?: number | null
  pausedAt?: number | null
}

/**
 * Persistent bot profiles.
 *
 * A bot's chat lives in assistant_threads (linked by bot_id); this store owns
 * only identity, instructions and per-bot settings.
 */
export class BotStore {
  constructor(private readonly db: Database) {}

  insert(bot: BotRecord): BotRecord {
    this.db.raw
      .prepare(
        `INSERT INTO bots (
           id, name, role, avatar_color, avatar_image, avatar_mascot, avatar_outfit, instructions, settings_json,
           archived_at, paused_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        bot.id,
        bot.name,
        bot.role,
        bot.avatarColor,
        bot.avatarImage,
        bot.avatarMascot,
        bot.avatarOutfit,
        bot.instructions,
        bot.settings === null ? null : JSON.stringify(bot.settings),
        bot.archivedAt,
        bot.pausedAt,
        bot.createdAt,
        bot.updatedAt
      )
    return this.findById(bot.id)!
  }

  findById(id: string): BotRecord | null {
    const row = this.db.raw
      .prepare(`SELECT ${BOT_COLUMNS} FROM bots WHERE id = ?`)
      .get(id) as BotRow | undefined
    return row ? botFromRow(row) : null
  }

  findByName(name: string): BotRecord | null {
    const row = this.db.raw
      .prepare(
        `SELECT ${BOT_COLUMNS} FROM bots
         WHERE name COLLATE NOCASE = ? AND archived_at IS NULL`
      )
      .get(name) as BotRow | undefined
    return row ? botFromRow(row) : null
  }

  list(options: { includeArchived?: boolean } = {}): BotRecord[] {
    const rows = (
      options.includeArchived === true
        ? this.db.raw.prepare(`SELECT ${BOT_COLUMNS} FROM bots ORDER BY created_at ASC`).all()
        : this.db.raw
            .prepare(`SELECT ${BOT_COLUMNS} FROM bots WHERE archived_at IS NULL ORDER BY created_at ASC`)
            .all()
    ) as BotRow[]
    return rows.map(botFromRow)
  }

  update(id: string, patch: BotPatch, now: number): BotRecord | null {
    const sets: string[] = []
    const params: Array<string | number | null> = []
    const assign = (column: string, value: string | number | null): void => {
      sets.push(`${column} = ?`)
      params.push(value)
    }
    if (patch.name !== undefined) assign('name', patch.name)
    if (patch.role !== undefined) assign('role', patch.role)
    if (patch.avatarColor !== undefined) assign('avatar_color', patch.avatarColor)
    if (patch.avatarImage !== undefined) assign('avatar_image', patch.avatarImage)
    if (patch.avatarMascot !== undefined) assign('avatar_mascot', patch.avatarMascot)
    if (patch.avatarOutfit !== undefined) assign('avatar_outfit', patch.avatarOutfit)
    if (patch.instructions !== undefined) assign('instructions', patch.instructions)
    if (patch.settings !== undefined) {
      assign('settings_json', patch.settings === null ? null : JSON.stringify(patch.settings))
    }
    if (patch.archivedAt !== undefined) assign('archived_at', patch.archivedAt)
    if (patch.pausedAt !== undefined) assign('paused_at', patch.pausedAt)
    if (sets.length === 0) return this.findById(id)
    assign('updated_at', now)
    this.db.raw
      .prepare(`UPDATE bots SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params, id)
    return this.findById(id)
  }

  archive(id: string, now: number): boolean {
    const result = this.db.raw
      .prepare(`UPDATE bots SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL`)
      .run(now, now, id)
    return Number(result.changes) === 1
  }

  getSettings(botId: string, fallback: AssistantSettings = DEFAULT_ASSISTANT_SETTINGS): AssistantSettings {
    const bot = this.findById(botId)
    return bot?.settings ?? fallback
  }

  saveSettings(botId: string, settings: AssistantSettings, now: number): AssistantSettings {
    const updated = this.db.raw
      .prepare(`UPDATE bots SET settings_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(settings), now, botId)
    if (Number(updated.changes) === 0) throw new Error('That bot no longer exists.')
    return settings
  }
}
