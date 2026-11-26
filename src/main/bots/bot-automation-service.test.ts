import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTempRoot, openTempDatabase } from '../persistence/persistence-test-fixtures'
import { BotStore } from '../persistence/bot-store'
import type { BotRecord } from '../../shared/domain/bot'
import { BotAutomationStore } from './bot-automation-store'
import { BotAutomationService } from './bot-automation-service'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function bot(id: string, pausedAt: number | null = null): BotRecord {
  return {
    id,
    name: id,
    role: 'engineer',
    avatarColor: '#123456',
    avatarImage: null,
    avatarMascot: null,
    avatarOutfit: null,
    instructions: '',
    settings: null,
    archivedAt: null,
    pausedAt,
    createdAt: 1_000,
    updatedAt: 1_000
  }
}

function fixture(): {
  service: BotAutomationService
  deliver: ReturnType<typeof vi.fn>
  advance: (ms: number) => void
} {
  const root = makeTempRoot()
  cleanups.push(() => root.cleanup())
  const db = openTempDatabase(root)
  cleanups.push(() => db.close())
  const bots = new BotStore(db)
  bots.insert(bot('bot_a'))
  bots.insert(bot('bot_b', 1_000))
  let now = 1_000_000
  const deliver = vi.fn(async () => undefined)
  let sequence = 0
  const service = new BotAutomationService({
    store: new BotAutomationStore(db),
    botInfo: (botId) => {
      const found = bots.findById(botId)
      return found === null
        ? null
        : { id: found.id, paused: found.pausedAt !== null, archived: found.archivedAt !== null }
    },
    deliver,
    now: () => now,
    newId: (prefix) => `${prefix}_${++sequence}`,
    onError: () => undefined
  })
  return {
    service,
    deliver,
    advance: (ms) => {
      now += ms
    }
  }
}

describe('BotAutomationService', () => {
  it('runs a due automation once and schedules the next run', async () => {
    const { service, deliver, advance } = fixture()
    const automation = service.create({
      botId: 'bot_a',
      name: 'Morning check',
      prompt: 'Review the queue.',
      intervalMinutes: 1
    })
    expect(service.list('bot_a')).toHaveLength(1)
    await service.tick()
    expect(deliver).not.toHaveBeenCalled()
    advance(60_000)
    await service.tick()
    expect(deliver).toHaveBeenCalledWith('bot_a', 'Review the queue.')
    const [after] = service.list('bot_a')
    expect(after).toMatchObject({ id: automation.id, lastRunAt: 1_060_000 })
    expect(after!.nextRunAt).toBe(1_120_000)
    await service.tick()
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('leaves a paused bot alone and retries a busy one in a minute', async () => {
    const { service, deliver, advance } = fixture()
    service.create({
      botId: 'bot_b',
      name: 'Paused',
      prompt: 'Never',
      intervalMinutes: 1
    })
    advance(60_000)
    await service.tick()
    expect(deliver).not.toHaveBeenCalled()

    const busy = Object.assign(new Error('busy'), { code: 'ASSISTANT_BUSY' })
    deliver.mockRejectedValueOnce(busy)
    service.create({
      botId: 'bot_a',
      name: 'Busy',
      prompt: 'Try again',
      intervalMinutes: 1
    })
    advance(60_000)
    await service.tick()
    const [automation] = service.list('bot_a')
    expect(automation!.nextRunAt).toBe(1_180_000)
  })

  it('updates, disables and removes an automation', () => {
    const { service } = fixture()
    const automation = service.create({
      botId: 'bot_a',
      name: 'Check',
      prompt: 'Look',
      intervalMinutes: 30
    })
    expect(
      service.update(automation.id, { intervalMinutes: 60, enabled: false })
    ).toMatchObject({ intervalMinutes: 60, enabled: false })
    expect(service.remove(automation.id)).toBe(true)
    expect(service.list('bot_a')).toEqual([])
    expect(() =>
      service.create({ botId: 'bot_a', name: '', prompt: 'x', intervalMinutes: 1 })
    ).toThrow()
  })
})
