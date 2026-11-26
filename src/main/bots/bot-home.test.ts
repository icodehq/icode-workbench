import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BotRecord } from '../../shared/domain/bot'
import { DEFAULT_ASSISTANT_SETTINGS } from '../../shared/domain/assistant'
import { botHomeFolder, ensureBotHomeSync, refreshBotHomeSync } from './bot-home'

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'icode-bot-home-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

function bot(overrides: Partial<BotRecord> = {}): BotRecord {
  return {
    id: 'bot_1',
    name: 'Scout',
    role: 'Release engineer',
    avatarColor: '#123456',
    avatarImage: null,
    avatarMascot: null,
    avatarOutfit: null,
    instructions: 'Keep releases small.',
    settings: null,
    archivedAt: null,
    pausedAt: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides
  }
}

describe('bot home files', () => {
  it('creates the home, memory and skills folders and its files', () => {
    ensureBotHomeSync({
      dataDir,
      bot: bot(),
      settings: DEFAULT_ASSISTANT_SETTINGS
    })
    const home = botHomeFolder(dataDir, 'bot_1')
    expect(existsSync(join(home, 'memory'))).toBe(true)
    expect(existsSync(join(home, 'skills'))).toBe(true)
    expect(readFileSync(join(home, 'SOUL.md'), 'utf8')).toContain('Keep releases small.')
    expect(readFileSync(join(home, 'AGENTS.md'), 'utf8')).toContain('MEMORY.md')
    expect(readFileSync(join(home, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n')
    expect(JSON.parse(readFileSync(join(home, 'bot.json'), 'utf8'))).toMatchObject({
      id: 'bot_1',
      name: 'Scout',
      harness: DEFAULT_ASSISTANT_SETTINGS.harnessPriority[0]
    })
    expect(readFileSync(join(home, 'MEMORY.md'), 'utf8')).toContain('# Memory')
  })

  it('rewrites generated files but never MEMORY.md', () => {
    ensureBotHomeSync({
      dataDir,
      bot: bot(),
      settings: DEFAULT_ASSISTANT_SETTINGS
    })
    const home = botHomeFolder(dataDir, 'bot_1')
    writeFileSync(join(home, 'MEMORY.md'), '# Memory\n\n- Kept fact\n')
    refreshBotHomeSync({
      dataDir,
      bot: bot({ name: 'Scout Two', role: 'Maintainer' }),
      settings: { ...DEFAULT_ASSISTANT_SETTINGS, harnessPriority: ['codex'] }
    })
    expect(readFileSync(join(home, 'SOUL.md'), 'utf8')).toContain('Scout Two')
    expect(JSON.parse(readFileSync(join(home, 'bot.json'), 'utf8'))).toMatchObject({
      name: 'Scout Two',
      harness: 'codex'
    })
    expect(readFileSync(join(home, 'MEMORY.md'), 'utf8')).toContain('Kept fact')
  })

  it('repairs folders that went missing and leaves existing files alone', () => {
    const home = botHomeFolder(dataDir, 'bot_1')
    refreshBotHomeSync({
      dataDir,
      bot: bot(),
      settings: DEFAULT_ASSISTANT_SETTINGS
    })
    expect(existsSync(join(home, 'MEMORY.md'))).toBe(true)
    ensureBotHomeSync({
      dataDir,
      bot: bot(),
      settings: DEFAULT_ASSISTANT_SETTINGS
    })
    expect(existsSync(join(home, 'skills'))).toBe(true)
  })
})
