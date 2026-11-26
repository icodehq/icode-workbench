import type { BotRecord } from '../../shared/domain/bot'

function memoryBlock(memory: {
  lines: string[]
  omitted: number
  topics?: Array<{ name: string; text: string }>
}): string {
  if (memory.lines.length === 0 && (memory.topics?.length ?? 0) === 0) return ''
  const omitted = memory.omitted > 0 ? `\n(+${memory.omitted} more lines in MEMORY.md)` : ''
  const topicBlocks = (memory.topics ?? []).map(
    (topic) => `<memory-topic name="${topic.name}">\n${topic.text.trim()}\n</memory-topic>`
  )
  return [
    `<memory file="MEMORY.md">\n${memory.lines.join('\n')}${omitted}\n</memory>`,
    ...topicBlocks,
    ''
  ].join('\n')
}

/**
 * The instruction typed into a bot's task session.
 *
 * The task row keeps the user's original prompt; this composed text adds the
 * role, instructions and active memory. Memory is data, not instructions.
 */
export function buildBotTaskPrompt(input: {
  bot: BotRecord
  memory: {
    lines: string[]
    omitted: number
    topics?: Array<{ name: string; text: string }>
  }
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
