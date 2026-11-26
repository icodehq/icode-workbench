import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTempRoot, openTempDatabase } from '../persistence/persistence-test-fixtures'
import { BotMemoryStore } from '../persistence/bot-memory-store'
import { BotStore } from '../persistence/bot-store'
import { MemoryService } from './memory-service'
import { migrateLegacyMemory } from './legacy-memory-migration'
import type { BotRecord } from '../../shared/domain/bot'
import type { MemoryEntry } from '../../shared/domain/memory'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function fixture(): { bots: BotStore; legacy: BotMemoryStore; files: MemoryService } {
  const root = makeTempRoot()
  cleanups.push(() => root.cleanup())
  const db = openTempDatabase(root)
  cleanups.push(() => db.close())
  const dataDir = mkdtempSync(join(tmpdir(), 'icode-memory-migration-'))
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }))
  return {
    bots: new BotStore(db),
    legacy: new BotMemoryStore(db),
    files: new MemoryService({ dataDir, now: () => Date.UTC(2026, 10, 26) })
  }
}

function bot(id: string): BotRecord {
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
    pausedAt: null,
    createdAt: 1_000,
    updatedAt: 1_000
  }
}

function entry(
  botId: string,
  key: string,
  value: string,
  updatedAt: number,
  status: MemoryEntry['status'] = 'active'
): MemoryEntry {
  return {
    id: `mem_${key}`,
    scope: 'bot',
    botId,
    repoId: null,
    teamId: null,
    proposedByBotId: null,
    key,
    value,
    status,
    sourceTaskId: null,
    createdAt: updatedAt,
    updatedAt
  }
}

describe('legacy memory migration', () => {
  it('writes each bot’s active memory newest first into MEMORY.md', async () => {
    const { bots, legacy, files } = fixture()
    bots.insert(bot('scout'))
    legacy.insert(entry('scout', 'old', 'Older fact', 1_000))
    legacy.insert(entry('scout', 'new', 'Newer fact', 2_000))
    legacy.insert(entry('scout', 'draft', 'Never approved', 3_000, 'proposed'))

    expect(await migrateLegacyMemory({ bots, legacy, files, now: () => 5_000 })).toBe(1)
    const read = await files.read('scout')
    expect(read.facts.map((fact) => fact.text)).toEqual([
      'new: Newer fact',
      'old: Older fact'
    ])
    expect(read.text).toContain('· from: iCode memory')
    expect(read.text).not.toContain('Never approved')
  })

  it('leaves a bot with its own file alone and is idempotent', async () => {
    const { bots, legacy, files } = fixture()
    bots.insert(bot('scout'))
    legacy.insert(entry('scout', 'fact', 'Value', 1_000))
    await files.add('scout', 'Owner fact', { kind: 'owner' })
    const before = (await files.read('scout')).text
    expect(await migrateLegacyMemory({ bots, legacy, files, now: () => 5_000 })).toBe(0)
    expect((await files.read('scout')).text).toBe(before)
  })
})
