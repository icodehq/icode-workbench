import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryService, MEMORY_SEED } from './memory-service'

let dataDir: string
let service: MemoryService
let now: number
let counter: number

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'icode-memory-'))
  now = Date.UTC(2026, 10, 26)
  counter = 0
  service = new MemoryService({
    dataDir,
    now: () => now,
    newId: (prefix) => `${prefix}_${++counter}`
  })
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('MemoryService', () => {
  it('seeds MEMORY.md once and reads its facts', async () => {
    expect(await service.ensure('bot_1')).toBe(MEMORY_SEED)
    expect(readFileSync(service.file('bot_1'), 'utf8')).toBe(MEMORY_SEED)
    writeFileSync(service.file('bot_1'), '# Memory\n\n- One fact\n- Two facts\n')
    expect(await service.ensure('bot_1')).toContain('- Two facts')
    const read = await service.read('bot_1')
    expect(read.facts.map((fact) => fact.text)).toEqual(['One fact', 'Two facts'])
    expect(read.omitted).toBe(0)
  })

  it('dates and marks a bot fact, lists it in history, and undoes it', async () => {
    const fact = await service.add('bot_1', 'Prefers pnpm', {
      kind: 'bot',
      botId: 'bot_1',
      name: 'Scout'
    })
    expect(fact).toMatchObject({ date: '2026-11-26', text: 'Prefers pnpm', source: 'bot: Scout' })
    const read = await service.read('bot_1')
    expect(read.text).toContain('- 2026-11-26 Prefers pnpm · from: bot: Scout')
    const [row] = await service.history('bot_1')
    expect(row).toMatchObject({ by: { kind: 'bot', name: 'Scout' }, undoable: true })
    expect(row!.change.added).toHaveLength(1)

    expect(await service.undo('bot_1', row!.id)).toBe(true)
    expect(await service.read('bot_1')).toMatchObject({ facts: [] })
    expect(await service.undo('bot_1', row!.id)).toBe(false)
    const rows = await service.history('bot_1')
    expect(rows[0]).toMatchObject({ by: { kind: 'undo', of: row!.id } })
  })

  it('adds concurrent facts without losing a line', async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_value, index) =>
        service.add('bot_1', `Fact ${index}`, { kind: 'owner' })
      )
    )
    const read = await service.read('bot_1')
    expect(read.facts).toHaveLength(12)
    expect(new Set(read.facts.map((fact) => fact.text)).size).toBe(12)
    expect((await service.history('bot_1')).length).toBe(12)
  })

  it('edits and forgets one owner fact without touching its neighbours', async () => {
    await service.add('bot_1', 'First', { kind: 'owner' })
    await service.add('bot_1', 'Second', { kind: 'owner' })
    const facts = (await service.read('bot_1')).facts
    const second = facts.find((fact) => fact.text === 'Second')!
    expect(await service.edit('bot_1', second, 'Second, reworded')).toBe(true)
    const edited = (await service.read('bot_1')).facts
    expect(edited.map((fact) => fact.text)).toEqual(['Second, reworded', 'First'])
    expect(await service.forget('bot_1', edited[0]!)).toBe(true)
    expect((await service.read('bot_1')).facts.map((fact) => fact.text)).toEqual(['First'])
  })

  it('lists topic files and caps the lines a prompt loads', async () => {
    const topics = join(service.home('bot_1'), 'memory')
    mkdirSync(topics, { recursive: true })
    writeFileSync(join(topics, 'release.md'), '# Release\n\n- Ships Fridays\n')
    expect(await service.topics('bot_1')).toEqual([{ name: 'release', lines: 3 }])
    expect(await service.readTopic('bot_1', 'release')).toContain('Ships Fridays')
    expect(await service.readTopic('bot_1', '../secret')).toBeNull()

    writeFileSync(
      service.file('bot_1'),
      `# Memory\n${Array.from({ length: 205 }, (_value, index) => `- Fact ${index}`).join('\n')}\n`
    )
    const loaded = await service.promptLines('bot_1')
    expect(loaded.lines).toHaveLength(200)
    expect(loaded.omitted).toBe(6)
    const prompt = await service.promptMemory('bot_1')
    expect(prompt.topics).toEqual([
      { name: 'release', text: '# Release\n\n- Ships Fridays\n' }
    ])
  })

  it('rebuilds a lost MEMORY.md from its history', async () => {
    await service.add('bot_1', 'First fact', { kind: 'owner' })
    await service.add('bot_1', 'Second fact', { kind: 'owner' })
    const second = (await service.read('bot_1')).facts.find(
      (fact) => fact.text === 'Second fact'
    )!
    await service.forget('bot_1', second)
    rmSync(service.file('bot_1'))
    const read = await service.read('bot_1')
    expect(read.facts.map((fact) => fact.text)).toEqual(['First fact'])
    expect(read.text).toContain('# Memory')
  })

  it('tidy-up files the oldest facts in the archive, and Undo restores them', async () => {
    await service.ensure('bot_1')
    writeFileSync(
      service.file('bot_1'),
      `# Memory\n${Array.from({ length: 205 }, (_value, index) => `- Fact ${String(index).padStart(3, '0')}`).join('\n')}\n`
    )
    expect(await service.tidyUp('bot_1')).toBe(5)
    const read = await service.read('bot_1')
    expect(read.facts).toHaveLength(200)
    expect(read.facts.at(-1)?.text).toBe('Fact 199')
    const archive = readFileSync(join(service.home('bot_1'), 'memory', 'archive.md'), 'utf8')
    expect(archive).toContain('- Fact 200')
    expect(archive).toContain('- Fact 204')
    const row = (await service.history('bot_1'))[0]!
    expect(row.by).toEqual({ kind: 'tidy-up' })
    expect(await service.tidiedOut('bot_1', 'Fact 200')).toBe(true)
    expect(await service.tidiedOut('bot_1', 'Fact 000')).toBe(false)
    expect(await service.undo('bot_1', row.id)).toBe(true)
    expect((await service.read('bot_1')).facts).toHaveLength(205)
  })

  it('journals a close once under its month', async () => {
    expect(
      await service.appendJournal('bot_1', {
        key: 'task:task_1',
        status: 'done',
        title: 'Ship the release'
      })
    ).toBe(true)
    expect(
      await service.appendJournal('bot_1', {
        key: 'task:task_1',
        status: 'done',
        title: 'Ship the release'
      })
    ).toBe(false)
    const journal = await service.readJournal('bot_1', '2026-11')
    expect(journal).toContain('# Journal 2026-11')
    expect(journal).toContain('- 2026-11-26 | task:task_1 | done | Ship the release')
    expect(await service.readJournal('bot_1', '../etc')).toBe('')
  })

  it('removes a bot home and its history', async () => {
    await service.add('bot_1', 'Something', { kind: 'owner' })
    await service.remove('bot_1')
    expect(await service.ensure('bot_1')).toBe(MEMORY_SEED)
    expect(await service.history('bot_1')).toEqual([])
  })
})
