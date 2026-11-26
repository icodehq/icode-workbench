import type { BotStore } from '../persistence/bot-store'
import type { BotMemoryStore } from '../persistence/bot-memory-store'
import { memoryDate } from '../../shared/domain/memory-lines'
import type { MemoryService } from './memory-service'

/**
 * Moves a bot's active bot-scoped memory from the database into its MEMORY.md.
 *
 * One-way and idempotent: a bot that already has a file is left alone. Project
 * and group scopes have no counterpart in the file model and stay in the
 * database untouched; only the bot's own memory enters its prompts now.
 */
export async function migrateLegacyMemory(input: {
  bots: BotStore
  legacy: BotMemoryStore
  files: MemoryService
  now: () => number
}): Promise<number> {
  let migrated = 0
  for (const bot of input.bots.list()) {
    if (input.files.hasMemory(bot.id)) continue
    const entries = input.legacy.list(
      { scope: 'bot', botId: bot.id },
      { status: 'active', limit: 500 }
    )
    if (entries.length === 0) continue
    const facts = entries.map((entry) => ({
      text: `${entry.key}: ${entry.value}`,
      date: memoryDate(new Date(entry.updatedAt || input.now())),
      source: 'iCode memory'
    }))
    if (await input.files.importFacts(bot.id, facts)) migrated += 1
  }
  return migrated
}
