import type { BotRecord } from '../../shared/domain/bot'
import type { MemoryEntry } from '../../shared/domain/memory'

function memoryBlock(entries: MemoryEntry[]): string {
  if (entries.length === 0) return ''
  const lines = entries.map((entry) => `- [${entry.scope}] ${entry.key}: ${entry.value}`)
  return `<memory>\n${lines.join('\n')}\n</memory>\n`
}

/**
 * The instruction typed into a bot's task session.
 *
 * The task row keeps the user's original prompt; this composed text adds the
 * role, instructions and active memory. Memory is data, not instructions.
 */
export function buildBotTaskPrompt(input: {
  bot: BotRecord
  memory: MemoryEntry[]
  prompt: string
  acceptanceCriteria?: string | null
}): string {
  const bot = input.bot
  const criteria = input.acceptanceCriteria?.trim()
  return [
    `<bot name="${bot.name}" role="${bot.role}">`,
    bot.instructions.trim().length > 0 ? bot.instructions.trim() : '',
    '</bot>',
    memoryBlock(input.memory),
    '<task>',
    input.prompt,
    '</task>',
    criteria === undefined || criteria.length === 0
      ? ''
      : `<acceptance-criteria>\n${criteria}\n</acceptance-criteria>`,
    '<review-contract>',
    'When you finish, summarize what changed, how you tested it, and the risks.',
    'Do not merge, push, or accept the result yourself. A human reviews the diff.',
    '</review-contract>'
  ]
    .filter((part) => part.length > 0)
    .join('\n\n')
}
