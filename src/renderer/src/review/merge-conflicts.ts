/**
 * Parses Git conflict markers into addressable blocks.
 *
 * Offsets point into the original text so the merge editor can replace one
 * block without reformatting the rest of the file. Sections are sliced by
 * offset, not rebuilt from lines, so CRLF and a missing trailing newline
 * survive untouched.
 */
export type ConflictBlock = {
  /** 0-based position in the file's block list. */
  id: number
  /** Character offset of the `<<<<<<<` line. */
  start: number
  /** Character offset just after the `>>>>>>>` line's newline. */
  end: number
  /** 1-based line of `<<<<<<<`. */
  startLine: number
  /** 1-based line of `>>>>>>>`. */
  endLine: number
  currentLabel: string
  baseLabel: string | null
  incomingLabel: string
  current: string
  base: string | null
  incoming: string
  /** The exact marker text, used by Reset and tests. */
  marker: string
}

export type MergeChoice = 'current' | 'incoming' | 'both'

type LineRecord = { text: string; start: number; end: number; line: number }

const OPEN = /^<{7,}(?: (.*))?$/u
const BASE = /^\|{7,}(?: (.*))?$/u
const SEPARATOR = /^={7,}$/u
const CLOSE = /^>{7,}(?: (.*))?$/u

function records(text: string): LineRecord[] {
  const result: LineRecord[] = []
  let offset = 0
  let line = 1
  while (offset <= text.length) {
    const newline = text.indexOf('\n', offset)
    if (newline === -1) {
      if (offset < text.length) {
        result.push({ text: text.slice(offset), start: offset, end: text.length, line })
      }
      break
    }
    result.push({ text: text.slice(offset, newline), start: offset, end: newline + 1, line })
    offset = newline + 1
    line += 1
  }
  return result
}

function markerText(record: LineRecord): string {
  return record.text.endsWith('\r') ? record.text.slice(0, -1) : record.text
}

export function parseConflictBlocks(text: string): ConflictBlock[] {
  const lines = records(text)
  const blocks: ConflictBlock[] = []
  let state: 'outside' | 'current' | 'base' | 'incoming' = 'outside'
  let start = 0
  let startLine = 0
  let sectionStart = 0
  let currentLabel = ''
  let baseLabel: string | null = null
  let incomingLabel = ''
  let current = ''
  let base: string | null = null

  for (const record of lines) {
    const line = markerText(record)
    if (state === 'outside') {
      const open = OPEN.exec(line)
      if (open !== null) {
        state = 'current'
        start = record.start
        startLine = record.line
        sectionStart = record.end
        currentLabel = open[1] ?? 'CURRENT'
        baseLabel = null
        incomingLabel = ''
      }
      continue
    }
    if (state === 'current') {
      const baseMarker = BASE.exec(line)
      if (baseMarker !== null) {
        current = text.slice(sectionStart, record.start)
        baseLabel = baseMarker[1] ?? 'BASE'
        sectionStart = record.end
        state = 'base'
        continue
      }
      if (SEPARATOR.test(line)) {
        current = text.slice(sectionStart, record.start)
        base = null
        sectionStart = record.end
        state = 'incoming'
        continue
      }
      if (OPEN.test(line) || CLOSE.test(line)) {
        state = 'outside'
      }
      continue
    }
    if (state === 'base') {
      if (SEPARATOR.test(line)) {
        base = text.slice(sectionStart, record.start)
        sectionStart = record.end
        state = 'incoming'
        continue
      }
      if (OPEN.test(line) || CLOSE.test(line)) state = 'outside'
      continue
    }
    const close = CLOSE.exec(line)
    if (close !== null) {
      const incoming = text.slice(sectionStart, record.start)
      incomingLabel = close[1] ?? 'INCOMING'
      blocks.push({
        id: blocks.length,
        start,
        end: record.end,
        startLine,
        endLine: record.line,
        currentLabel,
        baseLabel,
        incomingLabel,
        current,
        base,
        incoming,
        marker: text.slice(start, record.end)
      })
      state = 'outside'
      continue
    }
    if (OPEN.test(line) || SEPARATOR.test(line)) state = 'outside'
  }
  return blocks
}

/** Text that replaces one conflict block for a choice. */
export function mergeChoiceText(block: ConflictBlock, choice: MergeChoice): string {
  if (choice === 'current') return block.current
  if (choice === 'incoming') return block.incoming
  const current = block.current.length === 0 || block.current.endsWith('\n')
    ? block.current
    : `${block.current}\n`
  return `${current}${block.incoming}`
}

/** Replaces one block in the current text, leaving every other byte intact. */
export function replaceConflictBlock(
  text: string,
  block: ConflictBlock,
  choice: MergeChoice
): string {
  return `${text.slice(0, block.start)}${mergeChoiceText(block, choice)}${text.slice(block.end)}`
}
