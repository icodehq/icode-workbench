import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTempRoot, openTempDatabase } from '../persistence/persistence-test-fixtures'
import { BotStore } from '../persistence/bot-store'
import type { BotRecord } from '../../shared/domain/bot'
import { PeerMailStore } from './peer-mail-store'
import { PeerMailError, PeerMailService, type PeerMailBot } from './peer-mail-service'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function fixture(
  deliver: (botId: string, prompt: string) => Promise<{ answer: string | null }> = async () => ({
    answer: null
  })
): {
  store: PeerMailStore
  service: PeerMailService
  deliver: ReturnType<typeof vi.fn>
} {
  const root = makeTempRoot()
  cleanups.push(() => root.cleanup())
  const db = openTempDatabase(root)
  cleanups.push(() => db.close())
  const store = new PeerMailStore(db)
  const botStore = new BotStore(db)
  const botRow = (id: string, name: string, pausedAt: number | null): BotRecord => ({
    id,
    name,
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
  })
  botStore.insert(botRow('bot_a', 'Backend', null))
  botStore.insert(botRow('bot_b', 'Reviewer', null))
  botStore.insert(botRow('bot_c', 'Paused', 1_000))
  const bots = new Map<string, PeerMailBot>([
    ['bot_a', { id: 'bot_a', name: 'Backend', paused: false, archived: false }],
    ['bot_b', { id: 'bot_b', name: 'Reviewer', paused: false, archived: false }],
    ['bot_c', { id: 'bot_c', name: 'Paused', paused: true, archived: false }]
  ])
  const run = vi.fn(deliver)
  let sequence = 0
  const service = new PeerMailService({
    store,
    botInfo: (botId) => bots.get(botId) ?? null,
    findBotByName: (name) =>
      [...bots.values()].find(
        (bot) => bot.name.toLowerCase() === name.trim().toLowerCase()
      ) ?? null,
    deliver: (botId, prompt) => run(botId, prompt),
    now: () => 1_000,
    newId: (prefix) => `${prefix}_${++sequence}`,
    autoDrain: false
  })
  return { store, service, deliver: run }
}

describe('PeerMailService', () => {
  it('delivers mail to a named bot and returns its answer once', async () => {
    const { store, service, deliver } = fixture(async (botId) => ({
      answer: botId === 'bot_b' ? 'The API is ready.' : null
    }))
    const mail = service.send({ fromBotId: 'bot_a', to: 'Reviewer', body: 'Is the API ready?' })
    expect(mail).toMatchObject({ toBotId: 'bot_b', status: 'queued', depth: 0 })
    await service.drain('bot_b')
    expect(deliver).toHaveBeenCalledWith(
      'bot_b',
      expect.stringContaining('[Bot mail from Backend]')
    )
    expect(store.findById(mail.id)?.status).toBe('delivered')

    const [answer] = store.queuedFor('bot_a')
    expect(answer).toMatchObject({ fromBotId: 'bot_b', toBotId: 'bot_a', depth: 1 })
    await service.drain('bot_a')
    expect(deliver).toHaveBeenCalledWith(
      'bot_a',
      expect.stringContaining('[Bot mail answer from Reviewer]')
    )
    expect(store.queuedFor('bot_a')).toEqual([])
    expect(store.queuedFor('bot_b')).toEqual([])
  })

  it('keeps mail queued while the recipient is mid-turn', async () => {
    const busy = Object.assign(new Error('busy'), { code: 'ASSISTANT_BUSY' })
    const { store, service } = fixture(async () => {
      throw busy
    })
    const mail = service.send({ fromBotId: 'bot_a', to: 'bot_b', body: 'Ping' })
    await service.drain('bot_b')
    expect(store.findById(mail.id)?.status).toBe('queued')
    expect(store.recipientsWithQueued()).toEqual(['bot_b'])
  })

  it('refuses a self mail, a paused bot and an unknown name', () => {
    const { service } = fixture()
    expect(() =>
      service.send({ fromBotId: 'bot_a', to: 'bot_a', body: 'Hi' })
    ).toThrow(PeerMailError)
    expect(() =>
      service.send({ fromBotId: 'bot_a', to: 'Paused', body: 'Hi' })
    ).toThrow(PeerMailError)
    expect(() =>
      service.send({ fromBotId: 'bot_a', to: 'Nobody', body: 'Hi' })
    ).toThrow(PeerMailError)
  })
})
