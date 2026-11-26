import { describe, expect, it } from 'vitest'
import {
  addMemoryFact,
  applyMemoryChange,
  countMemoryLines,
  dropMemoryFact,
  editMemoryFact,
  findMemoryFact,
  forgetMemoryFact,
  isEmptyMemoryChange,
  loadedMemoryLines,
  memoryChange,
  memoryDate,
  memoryFactKeys,
  memorySourceLink,
  onlyMemoryFactsChanged,
  parseMemoryFacts,
  tagMemoryChanges,
  MEMORY_SEED_INTRO,
  MEMORY_SOURCE_SEPARATOR
} from './memory-lines'

const file = [
  '# Memory',
  '',
  MEMORY_SEED_INTRO,
  '',
  '- 2026-11-26 Prefers pnpm over npm',
  '- The owner ships on Fridays',
  '- Uses Slack · from: chat: Dana',
  ''
].join('\n')

describe('memory lines', () => {
  it('reads one fact per list line and skips headings, rules and fences', () => {
    const text = [
      '# Memory',
      '',
      '---',
      '- 2026-11-20 first',
      'plain line with words',
      '| table | row |',
      '```',
      '- not a fact in a fence',
      '```',
      '- Uses Slack · from: chat: Dana',
      ''
    ].join('\n')
    expect(parseMemoryFacts(text)).toEqual([
      { line: 3, date: '2026-11-20', text: 'first', source: null },
      { line: 4, date: null, text: 'plain line with words', source: null },
      { line: 9, date: null, text: 'Uses Slack', source: 'chat: Dana' }
    ])
  })

  it('counts and loads what a session sees', () => {
    expect(countMemoryLines('')).toBe(0)
    expect(countMemoryLines(file)).toBe(7)
    expect(loadedMemoryLines(file, 4)).toEqual({
      lines: ['# Memory', '', MEMORY_SEED_INTRO, ''],
      omitted: 3
    })
  })

  it('adds a dated fact above the first fact and keeps prose first', () => {
    expect(addMemoryFact(file, 'Wants release notes', '2026-11-27')).toBe(
      [
        '# Memory',
        '',
        MEMORY_SEED_INTRO,
        '',
        '- 2026-11-27 Wants release notes',
        '- 2026-11-26 Prefers pnpm over npm',
        '- The owner ships on Fridays',
        '- Uses Slack · from: chat: Dana',
        ''
      ].join('\n')
    )
    expect(addMemoryFact('', 'One fact', '2026-11-27')).toBe('- 2026-11-27 One fact\n')
  })

  it('tags only new facts with the writer and keeps an existing source', () => {
    const after = [
      '# Memory',
      '',
      '- 2026-11-27 Wants release notes',
      '- 2026-11-26 Prefers pnpm over npm',
      '- Uses Slack · from: chat: Dana',
      ''
    ].join('\n')
    expect(tagMemoryChanges(file, after, 'bot: Scout')).toBe(
      [
        '# Memory',
        '',
        '- 2026-11-27 Wants release notes · from: bot: Scout',
        '- 2026-11-26 Prefers pnpm over npm',
        '- Uses Slack · from: chat: Dana',
        ''
      ].join('\n')
    )
    expect(tagMemoryChanges(file, after, null)).toContain(
      '- 2026-11-27 Wants release notes\n'
    )
  })

  it('edits and forgets one fact, keeping its date and source', () => {
    const facts = parseMemoryFacts(file)
    const slack = facts[2]!
    expect(editMemoryFact(file, slack, 'Uses Slack daily')).toContain(
      `- Uses Slack daily${MEMORY_SOURCE_SEPARATOR}chat: Dana`
    )
    expect(forgetMemoryFact(file, facts[0]!)).not.toContain('Prefers pnpm')
    expect(editMemoryFact(file, facts[0]!, '')).not.toContain('Prefers pnpm')
  })

  it('finds a fact after other writes move its line', () => {
    const first = parseMemoryFacts(file)[0]!
    const moved = addMemoryFact(file, 'Newest', '2026-11-27')
    expect(findMemoryFact(moved, first)).toMatchObject({
      line: 5,
      text: 'Prefers pnpm over npm'
    })
  })

  it('drops a fact by its words, not by line number', () => {
    const dropped = dropMemoryFact(file, 'Prefers pnpm over npm')
    expect(dropped.dropped).toBe(1)
    expect(memoryFactKeys(dropped.text).has('Prefers pnpm over npm')).toBe(false)
    expect(dropMemoryFact(file, 'unrelated')).toEqual({ text: file, dropped: 0 })
  })

  it('round-trips a change, placing a fact after its anchor', () => {
    const after = [
      '# Memory',
      '',
      MEMORY_SEED_INTRO,
      '',
      '- 2026-11-26 Prefers pnpm over npm',
      '- New fact',
      '- Uses Slack · from: chat: Dana',
      ''
    ].join('\n')
    const change = memoryChange(file, after)
    expect(change.added.map((line) => line.line)).toEqual(['- New fact'])
    expect(change.removed.map((line) => line.line)).toEqual(['- The owner ships on Fridays'])
    expect(isEmptyMemoryChange(change)).toBe(false)
    expect(applyMemoryChange(file, change)).toBe(after)
  })

  it('reports whether a change kept every non-fact line', () => {
    expect(onlyMemoryFactsChanged(file, file.replace('Fridays', 'Fridays only'))).toBe(true)
    expect(onlyMemoryFactsChanged(file, file.replace('# Memory', '# Notes'))).toBe(false)
  })

  it('formats a source link and a local date', () => {
    expect(memorySourceLink('Slack, Dana <https://x.test/m>')).toEqual({
      text: 'Slack, Dana',
      url: 'https://x.test/m'
    })
    expect(memorySourceLink('bot: Scout')).toEqual({ text: 'bot: Scout', url: null })
    expect(memoryDate(new Date(2026, 10, 5))).toBe('2026-11-05')
  })
})
