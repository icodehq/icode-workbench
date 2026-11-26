import { afterEach, describe, expect, it } from 'vitest'
import { makeTempRoot, openTempDatabase } from '../persistence/persistence-test-fixtures'
import { AssistantStore } from '../persistence/assistant-store'
import { BotStore } from '../persistence/bot-store'
import { GroupStore } from '../persistence/group-store'
import { BotMemoryStore } from '../persistence/bot-memory-store'
import { TaskStore } from '../tasks/task-store'
import { BotService } from './bot-service'
import type { Database } from '../persistence/database'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function fixture(): {
  db: Database
  assistants: AssistantStore
  bots: BotStore
  groups: GroupStore
  memory: BotMemoryStore
  service: BotService
} {
  const root = makeTempRoot()
  cleanups.push(() => root.cleanup())
  const db = openTempDatabase(root)
  cleanups.push(() => db.close())
  const assistants = new AssistantStore(db)
  const bots = new BotStore(db)
  const groups = new GroupStore(db)
  const memory = new BotMemoryStore(db)
  const tasks = new TaskStore(db)
  let sequence = 0
  const service = new BotService({
    database: db,
    assistants,
    bots,
    groups,
    memory,
    tasks,
    newId: (prefix) => `${prefix}_${String(++sequence)}`,
    now: () => 1_000
  })
  return { db, assistants, bots, groups, memory, service }
}

describe('bot service', () => {
  it('creates a bot with a durable thread, welcome and settings', () => {
    const { assistants, bots, service } = fixture()
    const bot = service.createBot({
      name: 'Backend',
      role: 'Backend engineer',
      instructions: 'Keep handlers small.',
      harness: 'claude'
    })
    expect(bot.name).toBe('Backend')
    expect(bot.settings?.personaName).toBe('Backend')
    expect(bot.settings?.harnessPriority[0]).toBe('claude')
    const thread = assistants.findThreadByBotId(bot.id)
    expect(thread?.kind).toBe('bot')
    expect(thread?.title).toBe('Backend')
    expect(assistants.listMessages(thread!.id)).toEqual([
      expect.objectContaining({ kind: 'welcome', body: expect.stringContaining('Backend') })
    ])
    expect(assistants.unreadCount(thread!.id)).toBe(0)
    expect(service.listSummaries().map((summary) => summary.id)).toContain(bot.id)
    expect(bots.findByName('Backend')?.id).toBe(bot.id)
  })

  it('keeps the built-in assistant out of the owner-facing roster', () => {
    const { service } = fixture()
    expect(service.getBot('mira')).not.toBeNull()
    expect(service.listSummaries().map((summary) => summary.id)).not.toContain('mira')
  })

  it('does not reserve the assistant display name for the built-in profile', () => {
    const { service } = fixture()
    const bot = service.createBot({ name: 'Assistant', role: 'Reviewer' })
    expect(bot.name).toBe('Assistant')
    expect(() => service.createBot({ name: 'assistant', role: 'Another' })).toThrow()
  })

  it('keeps bot names unique and updates the thread title on rename', () => {
    const { assistants, service } = fixture()
    const bot = service.createBot({ name: 'Backend', role: 'Backend engineer' })
    expect(() => service.createBot({ name: 'backend', role: 'Another' })).toThrow()
    service.updateBot({ botId: bot.id, name: 'API' })
    expect(assistants.findThreadByBotId(bot.id)?.title).toBe('API')
    expect(service.settingsFor(bot.id).personaName).toBe('API')
  })

  it('keeps the global persona in sync when the default Chief is renamed', () => {
    const { service } = fixture()
    service.updateBot({ botId: 'mira', name: 'Chief' })
    expect(service.getBot('mira')?.name).toBe('Chief')
    expect(service.settingsFor('mira').personaName).toBe('Chief')
  })

  it('syncs a settings rename back to the bot and thread', () => {
    const { assistants, bots, service } = fixture()
    const bot = service.createBot({ name: 'Backend', role: 'Backend engineer' })
    service.saveSettings(bot.id, {
      ...service.settingsFor(bot.id),
      personaName: 'API'
    })
    expect(bots.findById(bot.id)?.name).toBe('API')
    expect(assistants.findThreadByBotId(bot.id)?.title).toBe('API')
  })

  it('archives a bot and removes it from the active list', () => {
    const { bots, service } = fixture()
    const bot = service.createBot({ name: 'Backend', role: 'Backend engineer' })
    expect(service.archiveBot(bot.id)).toBe(true)
    expect(bots.list().map((entry) => entry.id)).not.toContain(bot.id)
  })
})
