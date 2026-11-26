/**
 * Soft-wrapped logical lines and logical-index to buffer-range mapping.
 *
 * Adapted from an MIT-licensed reference implementation (Copyright (c) 2026 Lovecast Inc.),
 * `src/shared/terminal/links/wrapped-terminal-link-ranges.ts`. This slice keeps
 * only soft wraps; hard/edge-wrap heuristics arrive with file links.
 */

import type {
  TerminalLinkBuffer,
  TerminalLinkBufferLine,
  TerminalLinkBufferRange
} from './terminal-link-buffer'

type WrappedLogicalRow = {
  y: number
  text: string
  columns: number[]
  startIndex: number
  isWrapped: boolean
  lineLength: number
}

export type WrappedLogicalLine = {
  text: string
  rows: WrappedLogicalRow[]
}

const MAX_SOFT_WRAPPED_LINK_ROWS = 200
const MAX_SOFT_WRAPPED_LINK_CHARS = 20_000

function translateLineWithCells(
  line: TerminalLinkBufferLine
): { text: string; columns: number[] } | null {
  let text = ''
  const columns: number[] = []
  let endColumn = 0

  for (let x = 0; x < line.length; x += 1) {
    const cell = line.getCell?.(x)
    if (!cell?.getWidth || !cell.getChars) return null
    const width = cell.getWidth()
    if (width === 0) continue
    const chars = cell.getChars() || ' '
    text += chars
    for (let index = 0; index < chars.length; index += 1) columns.push(x)
    endColumn = x + Math.max(width, 1)
  }

  columns.push(endColumn)
  return { text, columns }
}

export function translateLineWithColumns(line: TerminalLinkBufferLine): {
  text: string
  columns: number[]
} {
  const columns: number[] = []
  const text = line.translateToString(false, 0, undefined, columns)
  if (columns.length === text.length + 1) return { text, columns }

  const cellTranslation = translateLineWithCells(line)
  if (cellTranslation !== null) return cellTranslation

  return {
    text,
    columns: Array.from({ length: text.length + 1 }, (_value, index) => index)
  }
}

/**
 * Builds the logical line containing a 1-based buffer row. Returns null when the
 * row is unavailable or the wrapped chain exceeds the safety caps.
 */
export function buildWrappedLogicalLine(
  buffer: TerminalLinkBuffer,
  bufferLineNumber: number
): WrappedLogicalLine | null {
  const y = bufferLineNumber - 1
  if (!buffer.getLine(y)) return null

  let startY = y
  let rowCount = 1
  while (startY > 0 && buffer.getLine(startY)?.isWrapped) {
    if (rowCount >= MAX_SOFT_WRAPPED_LINK_ROWS) return null
    startY -= 1
    rowCount += 1
  }

  let endY = y
  while (buffer.getLine(endY + 1)?.isWrapped) {
    if (rowCount >= MAX_SOFT_WRAPPED_LINK_ROWS) return null
    endY += 1
    rowCount += 1
  }

  let text = ''
  const rows: WrappedLogicalRow[] = []
  for (let rowY = startY; rowY <= endY; rowY += 1) {
    const line = buffer.getLine(rowY)
    if (!line) return null
    const translated = translateLineWithColumns(line)
    if (text.length + translated.text.length > MAX_SOFT_WRAPPED_LINK_CHARS) return null
    rows.push({
      y: rowY,
      text: translated.text,
      columns: translated.columns,
      startIndex: text.length,
      isWrapped: line.isWrapped,
      lineLength: line.length
    })
    text += translated.text
  }

  return { text, rows }
}

function mapLogicalIndexToBufferPosition(
  logicalLine: WrappedLogicalLine,
  index: number,
  bias: 'start' | 'end'
): { x: number; y: number } | null {
  for (let rowIndex = 0; rowIndex < logicalLine.rows.length; rowIndex += 1) {
    const row = logicalLine.rows[rowIndex]!
    const rowStart = row.startIndex
    const rowEnd = rowStart + row.text.length
    const isTarget =
      bias === 'start'
        ? index < rowEnd || (index === rowEnd && rowIndex === logicalLine.rows.length - 1)
        : index <= rowEnd && (index > rowStart || rowIndex === 0)
    if (!isTarget) continue

    const localIndex = Math.max(0, Math.min(index - rowStart, row.columns.length - 1))
    const column = row.columns[localIndex] ?? localIndex
    return { x: column, y: row.y + 1 }
  }
  return null
}

/** Maps zero-based half-open string indexes to xterm's 1-based inclusive range. */
export function rangeForParsedLink(
  logicalLine: WrappedLogicalLine,
  startIndex: number,
  endIndex: number
): TerminalLinkBufferRange | null {
  const start = mapLogicalIndexToBufferPosition(logicalLine, startIndex, 'start')
  const end = mapLogicalIndexToBufferPosition(logicalLine, endIndex, 'end')
  if (start === null || end === null) return null
  return {
    start: { x: start.x + 1, y: start.y },
    end: { x: end.x, y: end.y }
  }
}
