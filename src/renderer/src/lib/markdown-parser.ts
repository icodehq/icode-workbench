/**
 * Small, dependency-free Markdown parser for Mira's replies.
 *
 * Adapted from LoongClaw's session-view Markdown parser: a two-phase parse
 * (blocks, then inline spans) with an incremental path for streaming. It is
 * intentionally not a general-purpose Markdown implementation; it covers the
 * constructs agents actually emit and renders React elements, so untrusted
 * output never becomes HTML.
 */

export type Inline =
  | { kind: 'text'; value: string }
  | { kind: 'bold'; children: Inline[] }
  | { kind: 'italic'; children: Inline[] }
  | { kind: 'code'; value: string }
  | { kind: 'link'; url: string; text: string }

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; text: string }
  | { kind: 'hr' }
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'table'; headers: Inline[][]; rows: Inline[][][] }
  | { kind: 'code'; text: string }
  | { kind: 'blockquote'; children: Inline[] }

const BOLD = /\*\*(.+?)\*\*/g
const ITALIC = /\*(.+?)\*/g
const INLINE_CODE = /`([^`]+)`/g
const LINK = /\[([^\]]+)\]\(([^)]+)\)/g

function safeLink(url: string): string | null {
  const trimmed = url.trim()
  return /^https?:\/\//iu.test(trimmed) ? trimmed : null
}

export function parseInlines(raw: string): Inline[] {
  if (raw.length === 0) return []
  if (!/[`*\[\]]/u.test(raw)) return [{ kind: 'text', value: raw }]

  const patterns: { regex: RegExp; kind: 'bold' | 'italic' | 'code' | 'link' }[] = [
    { regex: new RegExp(BOLD.source, 'g'), kind: 'bold' },
    { regex: new RegExp(ITALIC.source, 'g'), kind: 'italic' },
    { regex: new RegExp(INLINE_CODE.source, 'g'), kind: 'code' },
    { regex: new RegExp(LINK.source, 'g'), kind: 'link' }
  ]

  const tokens: Inline[] = []
  let pos = 0

  while (pos < raw.length) {
    let earliest: { kind: 'bold' | 'italic' | 'code' | 'link'; match: RegExpExecArray } | null =
      null
    for (const { regex, kind } of patterns) {
      regex.lastIndex = pos
      const match = regex.exec(raw)
      if (match && (earliest === null || match.index < earliest.match.index)) {
        earliest = { kind, match }
      }
    }

    if (earliest === null) {
      tokens.push({ kind: 'text', value: raw.slice(pos) })
      break
    }

    if (earliest.match.index > pos) {
      tokens.push({ kind: 'text', value: raw.slice(pos, earliest.match.index) })
    }

    const match = earliest.match
    switch (earliest.kind) {
      case 'bold':
        tokens.push({ kind: 'bold', children: parseInlines(match[1]!) })
        break
      case 'italic':
        tokens.push({ kind: 'italic', children: parseInlines(match[1]!) })
        break
      case 'code':
        tokens.push({ kind: 'code', value: match[1]! })
        break
      case 'link': {
        const url = safeLink(match[2]!)
        tokens.push(url === null ? { kind: 'text', value: match[0]! } : { kind: 'link', url, text: match[1]! })
        break
      }
    }

    pos = match.index + match[0].length
  }

  return tokens
}

function isHeading(line: string): 1 | 2 | 3 | 4 | null {
  const match = line.match(/^(#{1,4})\s+(.+)/u)
  return match === null ? null : (match[1]!.length as 1 | 2 | 3 | 4)
}

function isHr(line: string): boolean {
  return /^-{3,}\s*$/u.test(line) || /^\*{3,}\s*$/u.test(line)
}

function isTableSeparator(line: string): boolean {
  const cells = line.split('|')
  const inner = cells.length > 2 ? cells.slice(1, -1) : cells.filter((cell) => cell.trim() !== '')
  if (inner.length === 0) return false
  return inner.every((cell) => /^:?-{3,}:?$/u.test(cell.trim()))
}

function isSpecialLine(line: string): boolean {
  return (
    isHeading(line) !== null ||
    isHr(line) ||
    line.startsWith('```') ||
    line.startsWith('>') ||
    /^\s*([-+*]|\d+\.)\s+/u.test(line)
  )
}

function parseTableRow(line: string): Inline[][] {
  const cells = line.split('|')
  const inner =
    cells.length > 1 && cells[0]!.trim() === '' && cells[cells.length - 1]!.trim() === ''
      ? cells.slice(1, -1)
      : cells
  return inner.map((cell) => parseInlines(cell.trim()))
}

export function parseBlocks(lines: string[]): Block[] {
  return parseBlocksWithBounds(lines).blocks
}

/**
 * `parseBlocks()` plus the line where the still-open final block starts.
 * Closed blocks can never change again, so a streaming update only reparses
 * from this line.
 */
export function parseBlocksWithBounds(lines: string[]): {
  blocks: Block[]
  activeStartLine: number
} {
  const blocks: Block[] = []
  let activeStartLine = lines.length
  let index = 0

  while (index < lines.length) {
    const start = index
    const line = lines[index]!

    if (line.trim() === '') {
      index += 1
      continue
    }

    const heading = isHeading(line)
    if (heading !== null) {
      activeStartLine = start
      blocks.push({ kind: 'heading', level: heading, text: line.replace(/^#{1,4}\s+/u, '') })
      index += 1
      continue
    }

    if (isHr(line)) {
      activeStartLine = start
      blocks.push({ kind: 'hr' })
      index += 1
      continue
    }

    if (line.startsWith('```')) {
      const codeLines: string[] = []
      index += 1
      while (index < lines.length && !lines[index]!.startsWith('```')) {
        codeLines.push(lines[index]!)
        index += 1
      }
      if (index < lines.length) index += 1
      activeStartLine = start
      blocks.push({ kind: 'code', text: codeLines.join('\n') })
      continue
    }

    if (line.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1]!)) {
      const headers = parseTableRow(line)
      index += 2
      const rows: Inline[][][] = []
      while (index < lines.length && lines[index]!.includes('|')) {
        rows.push(parseTableRow(lines[index]!))
        index += 1
      }
      activeStartLine = start
      blocks.push({ kind: 'table', headers, rows })
      continue
    }

    if (line.startsWith('>')) {
      const quoteLines: string[] = []
      while (index < lines.length && lines[index]!.startsWith('>')) {
        quoteLines.push(lines[index]!.replace(/^>\s?/u, ''))
        index += 1
      }
      activeStartLine = start
      blocks.push({ kind: 'blockquote', children: parseInlines(quoteLines.join(' ')) })
      continue
    }

    const listMatch = line.match(/^(\s*)([-+*]|\d+\.)\s+(.+)/u)
    if (listMatch !== null) {
      const ordered = /^\d+\./u.test(listMatch[2]!)
      const items: Inline[][] = []
      while (index < lines.length) {
        const item = lines[index]!.match(/^(\s*)([-+*]|\d+\.)\s+(.+)/u)
        if (item === null) break
        items.push(parseInlines(item[3]!))
        index += 1
      }
      activeStartLine = start
      blocks.push({ kind: 'list', ordered, items })
      continue
    }

    const paragraphLines: string[] = []
    while (index < lines.length && lines[index]!.trim() !== '' && !isSpecialLine(lines[index]!)) {
      paragraphLines.push(lines[index]!)
      index += 1
    }
    if (paragraphLines.length > 0) {
      activeStartLine = start
      blocks.push({ kind: 'paragraph', children: parseInlines(paragraphLines.join(' ')) })
    } else {
      index += 1
    }
  }

  return { blocks, activeStartLine }
}

export type ParsedText = {
  text: string
  blocks: Block[]
  activeOffset: number
}

function offsetOfLine(lines: string[], index: number, sourceLength: number): number {
  let offset = 0
  for (let cursor = 0; cursor < index; cursor += 1) offset += lines[cursor]!.length + 1
  return Math.min(offset, sourceLength)
}

export function parseText(text: string): ParsedText {
  const lines = text.split('\n')
  const { blocks, activeStartLine } = parseBlocksWithBounds(lines)
  return {
    text,
    blocks,
    activeOffset: offsetOfLine(lines, activeStartLine, text.length)
  }
}

/**
 * Extends a previous parse with more text. The closed blocks keep object
 * identity, which lets the renderer memoize them and keep their DOM nodes.
 */
export function extendParsed(previous: ParsedText, text: string): ParsedText {
  if (text === previous.text) return previous
  if (!text.startsWith(previous.text)) return parseText(text)

  const tail = text.slice(previous.activeOffset)
  if (tail === '') return { ...previous, text }

  const lines = tail.split('\n')
  const { blocks, activeStartLine } = parseBlocksWithBounds(lines)
  if (blocks.length === 0) return parseText(text)

  const merged =
    previous.blocks.length === 0
      ? blocks
      : [...previous.blocks.slice(0, -1), ...blocks]

  return {
    text,
    blocks: merged,
    activeOffset: previous.activeOffset + offsetOfLine(lines, activeStartLine, tail.length)
  }
}
