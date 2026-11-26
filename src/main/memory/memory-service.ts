/**
 * A bot's MEMORY.md, its topic files and the history of every change to them.
 *
 * The file is the source of truth: one fact per line, written whole under a
 * per-bot queue so two turns cannot lose each other's line. History lives
 * outside the bot's home so a write by the bot cannot rewrite the record.
 *
 * Adapted from an MIT-licensed reference implementation (Copyright (c) 2026
 * Lovecast Inc.); see NOTICE.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  addMemoryFact,
  applyMemoryChange,
  countMemoryLines,
  editMemoryFact,
  findMemoryFact,
  forgetMemoryFact,
  formatMemoryFactLine,
  isEmptyMemoryChange,
  loadedMemoryLines,
  memoryChange,
  memoryDate,
  parseMemoryFacts,
  tagMemoryChanges,
  type MemoryChange,
  type MemoryFact
} from '../../shared/domain/memory-lines'
import { runKeyedSerializedOperation } from '../../shared/concurrency/keyed-serialized-operation'

export const MEMORY_FILE = 'MEMORY.md'
export const MEMORY_TOPICS_DIR = 'memory'
export const MEMORY_SEED =
  '# Memory\n\nOne line per fact, newest first. Longer notes go in memory/<topic>.md.\n'

/** At most this many rows a bot, newest kept. */
export const MEMORY_HISTORY_ROWS = 1_000
export const MEMORY_HISTORY_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

export type MemoryAuthor =
  | { kind: 'owner' }
  | { kind: 'bot'; botId: string; name: string }
  | { kind: 'undo'; of: string }
  | { kind: 'tidy-up' }

export type MemoryHistoryRow = {
  id: string
  at: number
  by: MemoryAuthor
  change: MemoryChange
  undoable: boolean
}

export type MemoryTopic = { name: string; lines: number }

export type MemoryRead = {
  text: string
  facts: MemoryFact[]
  topics: MemoryTopic[]
  /** Lines past the index cap a session does not load. */
  omitted: number
}

/** What a turn loads: the MEMORY.md index plus topic notes within one budget. */
export type MemoryPrompt = {
  lines: string[]
  omitted: number
  topics: Array<{ name: string; text: string }>
}

/** Topic text a prompt carries, the same budget a tidy-up reads. */
export const MEMORY_PROMPT_TOPIC_CHARS = 12_000
const MEMORY_PROMPT_TOPIC_FILE_CHARS = 3_000

/** Oldest facts past this many move to memory/archive.md during a tidy-up. */
export const MEMORY_TIDY_KEEP = 200
const ARCHIVE_FILE = 'archive.md'
const ARCHIVE_KEEP_LINES = 1_000

export type MemoryServiceDeps = {
  /** iCode's user-data folder. */
  dataDir: string
  now?: () => number
  newId?: (prefix: string) => string
}

/** A file is replaced whole or not at all: a crash mid-write leaves the old one. */
async function replaceFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, text, 'utf8')
  await rename(temp, path)
}

/**
 * Writes a new bot's seeded memory before its first turn, synchronously because
 * bot creation is one IPC call. An existing file is never touched.
 */
export function seedBotMemorySync(input: {
  dataDir: string
  botId: string
  text: string
  date?: string
}): void {
  const home = join(input.dataDir, 'bots', input.botId)
  const file = join(home, MEMORY_FILE)
  if (existsSync(file)) return
  let text = MEMORY_SEED
  const date = input.date ?? memoryDate(new Date())
  for (const line of input.text.split(/\r?\n/)) {
    const fact = line.trim().replace(/^[-*]\s+/, '')
    if (fact.length > 0) text = addMemoryFact(text, fact, date)
  }
  mkdirSync(join(home, MEMORY_TOPICS_DIR), { recursive: true })
  writeFileSync(file, text, { encoding: 'utf8', flag: 'wx' })
}

export class MemoryService {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly now: () => number
  private readonly newId: (prefix: string) => string
  private gate: Promise<void> = Promise.resolve()

  constructor(private readonly deps: MemoryServiceDeps) {
    this.now = deps.now ?? Date.now
    this.newId = deps.newId ?? ((prefix) => `${prefix}_${globalThis.crypto.randomUUID()}`)
  }

  home(botId: string): string {
    return join(this.deps.dataDir, 'bots', botId)
  }

  file(botId: string): string {
    return join(this.home(botId), MEMORY_FILE)
  }

  private historyFile(botId: string): string {
    return join(this.deps.dataDir, 'bot-memory-history', `${encodeURIComponent(botId)}.json`)
  }

  /** Holds every read until a one-time startup migration has run. */
  useMigration(task: Promise<unknown>): void {
    this.gate = task.then(
      () => undefined,
      () => undefined
    )
  }

  /** Creates the home and its MEMORY.md when missing; never overwrites an existing file. */
  async ensure(botId: string): Promise<string> {
    await this.gate
    return runKeyedSerializedOperation(this.queues, botId, () => this.ensureUnlocked(botId))
  }

  async read(botId: string): Promise<MemoryRead> {
    const text = await this.ensure(botId)
    const topics = await this.topics(botId)
    const loaded = loadedMemoryLines(text)
    return {
      text,
      facts: parseMemoryFacts(text),
      topics,
      omitted: loaded.omitted
    }
  }

  /** The lines a prompt loads, with the cap the session loader uses. */
  async promptLines(botId: string): Promise<{ lines: string[]; omitted: number }> {
    return loadedMemoryLines(await this.ensure(botId))
  }

  /**
   * What one turn loads: MEMORY.md's first lines and the topic notes, oldest
   * budget first, so a long memory still fits a prompt.
   */
  async promptMemory(botId: string): Promise<MemoryPrompt> {
    const loaded = loadedMemoryLines(await this.ensure(botId))
    let budget = MEMORY_PROMPT_TOPIC_CHARS
    const topics: MemoryPrompt['topics'] = []
    for (const topic of await this.topics(botId)) {
      if (budget <= 0) break
      const text = await this.readTopic(botId, topic.name)
      if (text === null || text.trim().length === 0) continue
      const clipped = text.slice(0, Math.min(MEMORY_PROMPT_TOPIC_FILE_CHARS, budget))
      budget -= clipped.length
      topics.push({ name: topic.name, text: clipped })
    }
    if (budget > 0) {
      const today = new Date(this.now())
      const previous = new Date(today.getFullYear(), today.getMonth() - 1, 1)
      const journal = [
        await this.readJournal(botId, memoryDate(previous).slice(0, 7)),
        await this.readJournal(botId, memoryDate(today).slice(0, 7))
      ]
        .filter((text) => text.trim().length > 0)
        .join('\n')
      if (journal.trim().length > 0) {
        const clipped = journal.slice(0, budget)
        budget -= clipped.length
        topics.push({ name: 'journal', text: clipped })
      }
    }
    if (budget > 0) {
      for (const skill of await this.skills(botId)) {
        if (budget <= 0) break
        const clipped = skill.text.slice(0, Math.min(MEMORY_PROMPT_TOPIC_FILE_CHARS, budget))
        budget -= clipped.length
        topics.push({ name: `skill:${skill.name}`, text: clipped })
      }
    }
    return { ...loaded, topics }
  }

  /** The SKILL.md of each folder under skills/, in name order. */
  private async skills(botId: string): Promise<Array<{ name: string; text: string }>> {
    const dir = join(this.home(botId), 'skills')
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return []
    }
    const skills: Array<{ name: string; text: string }> = []
    for (const name of names.filter((entry) => /^[a-z0-9][a-z0-9-]*$/.test(entry)).sort()) {
      try {
        const text = await readFile(join(dir, name, 'SKILL.md'), 'utf8')
        if (text.trim().length > 0) skills.push({ name, text })
      } catch {
        // A folder without a readable SKILL.md is not a skill.
      }
    }
    return skills
  }

  async topics(botId: string): Promise<MemoryTopic[]> {
    const dir = join(this.home(botId), MEMORY_TOPICS_DIR)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return []
    }
    const topics: MemoryTopic[] = []
    for (const name of names.filter((entry) => entry.endsWith('.md')).sort()) {
      try {
        const text = await readFile(join(dir, name), 'utf8')
        topics.push({ name: name.slice(0, -'.md'.length), lines: countMemoryLines(text) })
      } catch {
        // A topic that vanished between readdir and read is not one.
      }
    }
    return topics
  }

  async readTopic(botId: string, name: string): Promise<string | null> {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return null
    try {
      return await readFile(join(this.home(botId), MEMORY_TOPICS_DIR, `${name}.md`), 'utf8')
    } catch {
      return null
    }
  }

  /** Whether the bot's home already holds a MEMORY.md. */
  hasMemory(botId: string): boolean {
    return existsSync(this.file(botId))
  }

  /**
   * Writes facts into a bot that has no MEMORY.md yet; used once for memory kept
   * in the database by an earlier release. Facts arrive newest first, the order
   * the file keeps. An existing file is never touched.
   */
  async importFacts(
    botId: string,
    facts: Array<{ text: string; date: string; source: string | null }>
  ): Promise<boolean> {
    return runKeyedSerializedOperation(this.queues, botId, async () => {
      await mkdir(join(this.home(botId), MEMORY_TOPICS_DIR), { recursive: true })
      if (existsSync(this.file(botId))) return false
      const lines = facts.map((fact) =>
        formatMemoryFactLine(fact.text, fact.date, fact.source)
      )
      const text =
        lines.length === 0 ? MEMORY_SEED : `${MEMORY_SEED}\n${lines.join('\n')}\n`
      await replaceFile(this.file(botId), text)
      return true
    })
  }

  /**
   * Whether a tidy-up moved this fact out of MEMORY.md in the last two weeks.
   * A bot that repeats one from stale context is keeping the tidy-up's decision;
   * the owner can always add it again by hand.
   */
  async tidiedOut(botId: string, text: string): Promise<boolean> {
    const wanted = normalizeFact(text)
    const since = this.now() - 14 * DAY_MS
    const rows = await this.history(botId)
    return rows.some(
      (row) =>
        row.by.kind === 'tidy-up' &&
        row.at >= since &&
        row.change.removed.some(
          ({ line }) =>
            normalizeFact(parseMemoryFacts(line)[0]?.text ?? line) === wanted
        )
    )
  }

  /** Adds one fact above the first fact, dated today, marked with who wrote it. */
  async add(botId: string, text: string, by: MemoryAuthor): Promise<MemoryFact | null> {
    return runKeyedSerializedOperation(this.queues, botId, async () => {
      const before = await this.ensureUnlocked(botId)
      const after = tagMemoryChanges(
        before,
        addMemoryFact(before, text, memoryDate(new Date(this.now()))),
        labelFor(by)
      )
      const change = memoryChange(before, after)
      if (isEmptyMemoryChange(change)) return null
      await replaceFile(this.file(botId), after)
      await this.record(botId, by, change)
      return parseMemoryFacts(after).find((fact) => fact.text === normalizeFact(text)) ?? null
    })
  }

  /** Rewrites one fact; an empty text forgets it. The owner's edits carry no source mark. */
  async edit(botId: string, fact: MemoryFact, text: string): Promise<boolean> {
    return runKeyedSerializedOperation(this.queues, botId, async () => {
      const before = await this.ensureUnlocked(botId)
      const found = findMemoryFact(before, fact)
      if (found === undefined) return false
      const after = tagMemoryChanges(before, editMemoryFact(before, found, text), null)
      const change = memoryChange(before, after)
      if (isEmptyMemoryChange(change)) return false
      await replaceFile(this.file(botId), after)
      await this.record(botId, { kind: 'owner' }, change)
      return true
    })
  }

  async forget(botId: string, fact: MemoryFact): Promise<boolean> {
    return runKeyedSerializedOperation(this.queues, botId, async () => {
      const before = await this.ensureUnlocked(botId)
      const found = findMemoryFact(before, fact)
      if (found === undefined) return false
      const after = forgetMemoryFact(before, found)
      const change = memoryChange(before, after)
      if (isEmptyMemoryChange(change)) return false
      await replaceFile(this.file(botId), after)
      await this.record(botId, { kind: 'owner' }, change)
      return true
    })
  }

  async history(botId: string): Promise<MemoryHistoryRow[]> {
    return runKeyedSerializedOperation(this.queues, `history:${botId}`, async () => {
      const rows = await this.readHistory(botId)
      const kept = rows.filter((row) => row.at >= this.now() - MEMORY_HISTORY_DAYS * DAY_MS)
      const trimmed = kept.slice(0, MEMORY_HISTORY_ROWS)
      if (trimmed.length !== rows.length) {
        await this.writeHistory(botId, trimmed)
      }
      return trimmed
    })
  }

  /** Puts back what the row changed; a row can be undone once. */
  async undo(botId: string, rowId: string): Promise<boolean> {
    return runKeyedSerializedOperation(this.queues, botId, async () => {
      const rows = await this.readHistory(botId)
      const row = rows.find((entry) => entry.id === rowId)
      if (row === undefined || !row.undoable) return false
      if (rows.some((entry) => entry.by.kind === 'undo' && entry.by.of === rowId)) return false
      const before = await this.ensureUnlocked(botId)
      const after = applyMemoryChange(before, {
        added: row.change.removed,
        removed: row.change.added
      })
      if (before === after) return false
      await replaceFile(this.file(botId), after)
      await this.record(botId, { kind: 'undo', of: rowId }, memoryChange(before, after))
      return true
    })
  }

  /**
   * Keeps MEMORY.md at its index cap by moving the oldest facts, byte for byte,
   * into memory/archive.md. The move is one history row, so Undo puts the lines
   * back where they were.
   */
  async tidyUp(botId: string): Promise<number> {
    return runKeyedSerializedOperation(this.queues, botId, async () => {
      const before = await this.ensureUnlocked(botId)
      const facts = parseMemoryFacts(before)
      if (facts.length <= MEMORY_TIDY_KEEP) return 0
      const moved = facts.slice(MEMORY_TIDY_KEEP)
      const dropped = new Set(moved.map((fact) => fact.line))
      const lines = before.split(/\r?\n/)
      const after = lines
        .filter((_line, index) => !dropped.has(index))
        .join(before.includes('\r\n') ? '\r\n' : '\n')
      await this.appendArchive(botId, moved.map((fact) => lines[fact.line] ?? ''))
      const change = memoryChange(before, after)
      if (isEmptyMemoryChange(change)) return 0
      await replaceFile(this.file(botId), after)
      await this.record(botId, { kind: 'tidy-up' }, change)
      return moved.length
    })
  }

  private async appendArchive(botId: string, moved: string[]): Promise<void> {
    const path = join(this.home(botId), MEMORY_TOPICS_DIR, ARCHIVE_FILE)
    let before = ''
    try {
      before = await readFile(path, 'utf8')
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    const have = new Set(before.split(/\r?\n/))
    const fresh = moved.map((line) => line.trimEnd()).filter(
      (line) => line.trim().length > 0 && !have.has(line)
    )
    if (fresh.length === 0) return
    const header = before.trim().length === 0 ? '# Archive\n' : `${before.trimEnd()}\n`
    const all = `${header}${fresh.join('\n')}\n`.split(/\r?\n/)
    // The archive keeps its newest lines; the file itself is the long-term copy.
    const kept = all.length > ARCHIVE_KEEP_LINES
      ? [all[0] ?? '# Archive', '', ...all.slice(-ARCHIVE_KEEP_LINES)]
      : all
    await replaceFile(path, kept.join('\n'))
  }

  /**
   * One dated line in memory/journal/YYYY-MM.md when a piece of work closes.
   * The date and key make the write idempotent, so a queue pass that sees the
   * same close twice adds nothing.
   */
  async appendJournal(
    botId: string,
    entry: { key: string; status: string; title: string; at?: number }
  ): Promise<boolean> {
    const at = entry.at ?? this.now()
    const date = memoryDate(new Date(at))
    const month = date.slice(0, 7)
    const line = `- ${date} | ${entry.key} | ${entry.status} | ${entry.title.replace(/\s+/g, ' ').trim()}`
    return runKeyedSerializedOperation(this.queues, `journal:${botId}`, async () => {
      const path = join(this.home(botId), MEMORY_TOPICS_DIR, 'journal', `${month}.md`)
      let before = ''
      try {
        before = await readFile(path, 'utf8')
      } catch (error) {
        if (!isMissing(error)) throw error
      }
      const key = `${date} | ${entry.key}`
      if (
        before
          .split(/\r?\n/)
          .some(
            (existing) =>
              (existing.split(' | ').slice(0, 2).join(' | ').replace(/^- /, '') === key)
          )
      ) {
        return false
      }
      const header = before.trim().length === 0 ? `# Journal ${month}\n` : `${before.trimEnd()}\n`
      await replaceFile(path, `${header}${line}\n`)
      return true
    })
  }

  /** The journal lines of one month, newest last; empty when there is no file. */
  async readJournal(botId: string, month: string): Promise<string> {
    if (!/^\d{4}-\d{2}$/.test(month)) return ''
    try {
      return await readFile(
        join(this.home(botId), MEMORY_TOPICS_DIR, 'journal', `${month}.md`),
        'utf8'
      )
    } catch {
      return ''
    }
  }

  async remove(botId: string): Promise<void> {
    await runKeyedSerializedOperation(this.queues, botId, async () => {
      await rm(this.home(botId), { recursive: true, force: true })
      await rm(this.historyFile(botId), { force: true })
    })
  }

  private async ensureUnlocked(botId: string): Promise<string> {
    await mkdir(join(this.home(botId), MEMORY_TOPICS_DIR), { recursive: true })
    try {
      return await readFile(this.file(botId), 'utf8')
    } catch (error) {
      if (!isMissing(error)) throw error
      // A lost file is rebuilt from its change history before falling back to a seed.
      const salvaged = await this.salvageUnlocked(botId)
      await replaceFile(this.file(botId), salvaged)
      return salvaged
    }
  }

  /** Replays every recorded change over a fresh seed, oldest first. */
  private async salvageUnlocked(botId: string): Promise<string> {
    const rows = (await this.readHistory(botId)).slice().reverse()
    let text = MEMORY_SEED
    for (const row of rows) {
      text = applyMemoryChange(text, row.change)
    }
    return text
  }

  private async record(botId: string, by: MemoryAuthor, change: MemoryChange): Promise<void> {
    const row: MemoryHistoryRow = {
      id: this.newId('memhist'),
      at: this.now(),
      by,
      change,
      undoable: true
    }
    await runKeyedSerializedOperation(this.queues, `history:${botId}`, async () => {
      const rows = await this.readHistory(botId)
      const kept = rows.filter((entry) => entry.at >= this.now() - MEMORY_HISTORY_DAYS * DAY_MS)
      await this.writeHistory(botId, [row, ...kept].slice(0, MEMORY_HISTORY_ROWS))
    })
  }

  private async readHistory(botId: string): Promise<MemoryHistoryRow[]> {
    try {
      const text = await readFile(this.historyFile(botId), 'utf8')
      const parsed: unknown = JSON.parse(text)
      if (!Array.isArray(parsed)) return []
      return parsed.filter(isHistoryRow)
    } catch {
      return []
    }
  }

  private async writeHistory(botId: string, rows: MemoryHistoryRow[]): Promise<void> {
    await replaceFile(this.historyFile(botId), JSON.stringify(rows))
  }
}

function labelFor(by: MemoryAuthor): string | null {
  return by.kind === 'bot' ? `bot: ${by.name}` : null
}

function normalizeFact(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isHistoryRow(value: unknown): value is MemoryHistoryRow {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Partial<MemoryHistoryRow>
  const by = row.by as { kind?: unknown } | undefined
  return (
    typeof row.id === 'string' &&
    typeof row.at === 'number' &&
    typeof row.undoable === 'boolean' &&
    (by?.kind === 'owner' ||
      by?.kind === 'bot' ||
      by?.kind === 'undo' ||
      by?.kind === 'tidy-up') &&
    typeof row.change === 'object' &&
    row.change !== null &&
    Array.isArray(row.change.added) &&
    Array.isArray(row.change.removed)
  )
}
