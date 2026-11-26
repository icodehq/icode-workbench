import { afterEach, describe, expect, it } from 'vitest'
import { makeTempRoot, openTempDatabase } from './persistence-test-fixtures'
import { BotStore } from './bot-store'
import { GroupStore } from './group-store'
import { BotMemoryStore } from './bot-memory-store'
import type { BotRecord } from '../../shared/domain/bot'
import type { MemoryEntry } from '../../shared/domain/memory'
import { DEFAULT_ASSISTANT_SETTINGS } from '../../shared/domain/assistant'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function fixture(): {
  bots: BotStore
  groups: GroupStore
  memory: BotMemoryStore
} {
  const root = makeTempRoot()
  cleanups.push(() => root.cleanup())
  const db = openTempDatabase(root)
  cleanups.push(() => db.close())
  return {
    bots: new BotStore(db),
    groups: new GroupStore(db),
    memory: new BotMemoryStore(db)
  }
}

function bot(id = 'backend', name = 'Backend'): BotRecord {
  return {
    id,
    name,
    role: 'Backend engineer',
    avatarColor: '#123456',
    avatarImage: null,
    avatarMascot: null,
    avatarOutfit: null,
    instructions: 'Keep handlers small.',
    settings: null,
    archivedAt: null,
    pausedAt: null,
    createdAt: 1_000,
    updatedAt: 1_000
  }
}

function memoryEntry(input: Partial<MemoryEntry> & Pick<MemoryEntry, 'id' | 'key'>): MemoryEntry {
  return {
    id: input.id,
    scope: input.scope ?? 'bot',
    botId: input.botId === undefined ? 'backend' : input.botId,
    repoId: input.repoId ?? null,
    teamId: input.teamId ?? null,
    proposedByBotId: input.proposedByBotId ?? 'backend',
    key: input.key,
    value: input.value ?? 'Use the middleware pattern.',
    status: input.status ?? 'active',
    sourceTaskId: input.sourceTaskId ?? null,
    createdAt: input.createdAt ?? 1_000,
    updatedAt: input.updatedAt ?? 1_000
  }
}

describe('bot store', () => {
  it('stores profiles and resolves per-bot settings with a fallback', () => {
    const { bots } = fixture()
    const stored = bots.insert(bot())
    expect(stored.name).toBe('Backend')
    expect(bots.findById('backend')?.role).toBe('Backend engineer')
    expect(bots.findByName('backend')?.id).toBe('backend')

    const fallback = DEFAULT_ASSISTANT_SETTINGS
    expect(bots.getSettings('backend', fallback)).toBe(fallback)

    const updated = bots.update('backend', { name: 'Backend 2', instructions: 'New' }, 2_000)
    expect(updated?.name).toBe('Backend 2')
    expect(updated?.instructions).toBe('New')

    expect(bots.archive('backend', 3_000)).toBe(true)
    expect(bots.list().map((entry) => entry.id)).toEqual(['mira'])
    expect(bots.list({ includeArchived: true })).toHaveLength(2)
  })

  it('keeps bot names unique case-insensitively', () => {
    const { bots } = fixture()
    bots.insert(bot('backend', 'Backend'))
    expect(() => bots.insert(bot('backend2', 'backend'))).toThrow()
  })
})

describe('bot memory store', () => {
  it('lists only active memories and approves a proposal by replacing the active row', () => {
    const { bots, memory } = fixture()
    bots.insert(bot())
    memory.insert(memoryEntry({ id: 'mem_1', key: 'style' }))
    expect(memory.list({ scope: 'bot', botId: 'backend' })).toHaveLength(1)
    expect(memory.find({ scope: 'bot', botId: 'backend' }, 'style')?.value).toContain('middleware')

    const proposed = memory.insert(
      memoryEntry({
        id: 'mem_2',
        key: 'style',
        value: 'Prefer a small helper.',
        status: 'proposed'
      })
    )
    expect(memory.list({ scope: 'bot', botId: 'backend' })).toHaveLength(1)
    expect(memory.list({ scope: 'bot', botId: 'backend' }, { status: 'proposed' })).toHaveLength(1)

    const approved = memory.approve(proposed.id, 2_000)
    expect(approved?.status).toBe('active')
    expect(memory.findById('mem_1')?.status).toBe('archived')
    expect(memory.list({ scope: 'bot', botId: 'backend' })).toEqual([
      expect.objectContaining({ id: 'mem_2', value: 'Prefer a small helper.' })
    ])
  })

  it('enforces one active row per key while letting proposals coexist', () => {
    const { bots, memory } = fixture()
    bots.insert(bot())
    memory.insert(memoryEntry({ id: 'mem_1', key: 'style' }))
    expect(() => memory.insert(memoryEntry({ id: 'mem_2', key: 'style' }))).toThrow()
    memory.insert(memoryEntry({ id: 'mem_3', key: 'style', status: 'proposed' }))
    expect(memory.list({ scope: 'bot', botId: 'backend' }, { status: 'proposed' })).toHaveLength(1)
  })

  it('supports shared group memory', () => {
    const { bots, groups, memory } = fixture()
    bots.insert(bot())
    groups.insertGroup({
      id: 'group_1',
      name: 'iCode',
      revision: 1,
      defaultBotId: null,
      replyMode: { kind: 'mentions' },
      archivedAt: null,
      mutedAt: null,
      createdAt: 1_000,
      updatedAt: 1_000
    })
    memory.insert(
      memoryEntry({
        id: 'mem_team',
        scope: 'team',
        botId: null,
        teamId: 'group_1',
        key: 'branching',
        value: 'Use feat/<name>.'
      })
    )
    expect(memory.list({ scope: 'team', teamId: 'group_1' })).toEqual([
      expect.objectContaining({ key: 'branching' })
    ])
  })
})
