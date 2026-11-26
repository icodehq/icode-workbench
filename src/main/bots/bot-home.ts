/**
 * A bot's home folder: what it is (SOUL.md), what it remembers (MEMORY.md and
 * memory/), and the files that point its agent at both. iCode writes the
 * generated files, so an edit to one is replaced on the next write.
 *
 * Adapted from an MIT-licensed reference implementation (Copyright (c) 2026
 * Lovecast Inc.); see NOTICE.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BotRecord } from '../../shared/domain/bot'
import type { AssistantSettings } from '../../shared/domain/assistant'
import { MEMORY_SEED } from '../memory/memory-service'
import { replaceTextFileSync } from './bot-home-write'

export const BOT_HOME_FOLDER = 'bots'

export function botHomeFolder(dataDir: string, botId: string): string {
  return join(dataDir, BOT_HOME_FOLDER, botId)
}

function soulText(bot: BotRecord): string {
  const instructions = bot.instructions.trim()
  return [
    `# ${bot.name}`,
    '',
    bot.role,
    '',
    instructions.length > 0
      ? instructions
      : 'Tell me what you are working on; I will keep the thread and the work moving.',
    ''
  ].join('\n')
}

function agentsText(bot: BotRecord): string {
  return [
    `# ${bot.name}`,
    '',
    `You are ${bot.name}, a bot that runs in iCode. This folder is your home.`,
    '',
    '- SOUL.md says who you are and how you work.',
    '- MEMORY.md is your memory: one line per fact, details in memory/<topic>.md.',
    '- skills/ holds skills this bot owns.',
    '',
    'iCode writes SOUL.md, AGENTS.md, CLAUDE.md and bot.json from bot settings; edits to them are replaced.',
    ''
  ].join('\n')
}

function botJsonText(bot: BotRecord, settings: AssistantSettings): string {
  return `${JSON.stringify(
    {
      id: bot.id,
      name: bot.name,
      role: bot.role,
      harness: settings.harnessPriority[0] ?? null,
      target: settings.target,
      opencodeAgent: settings.opencodeAgent,
      pausedAt: bot.pausedAt,
      archivedAt: bot.archivedAt
    },
    null,
    2
  )}\n`
}

function generatedFiles(bot: BotRecord, settings: AssistantSettings): Array<{ path: string; text: string }> {
  return [
    { path: 'SOUL.md', text: soulText(bot) },
    { path: 'AGENTS.md', text: agentsText(bot) },
    { path: 'CLAUDE.md', text: '@AGENTS.md\n' },
    { path: 'bot.json', text: botJsonText(bot, settings) }
  ]
}

/**
 * Creates the folders and seed files a bot needs, then rewrites the generated
 * ones only when their content changed. An existing MEMORY.md is never touched.
 */
export function ensureBotHomeSync(input: {
  dataDir: string
  bot: BotRecord
  settings: AssistantSettings
}): void {
  const home = botHomeFolder(input.dataDir, input.bot.id)
  mkdirSync(join(home, 'memory'), { recursive: true })
  mkdirSync(join(home, 'skills'), { recursive: true })
  if (!existsSync(join(home, 'MEMORY.md'))) {
    replaceTextFileSync(join(home, 'MEMORY.md'), MEMORY_SEED)
  }
  for (const file of generatedFiles(input.bot, input.settings)) {
    const path = join(home, file.path)
    const current = existsSync(path) ? readFileSync(path, 'utf8') : null
    if (current !== file.text) replaceTextFileSync(path, file.text)
  }
}

/** Rewrites the generated files after a rename, role, agent or pause change. */
export function refreshBotHomeSync(input: {
  dataDir: string
  bot: BotRecord
  settings: AssistantSettings
}): void {
  const home = botHomeFolder(input.dataDir, input.bot.id)
  if (!existsSync(home)) {
    ensureBotHomeSync(input)
    return
  }
  for (const file of generatedFiles(input.bot, input.settings)) {
    const path = join(home, file.path)
    const current = existsSync(path) ? readFileSync(path, 'utf8') : null
    if (current !== file.text) replaceTextFileSync(path, file.text)
  }
}
