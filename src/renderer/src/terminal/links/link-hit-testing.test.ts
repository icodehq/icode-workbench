import { describe, expect, it } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import {
  cellIsInBufferRange,
  findTerminalHttpLinkAtPosition
} from './link-hit-testing'
import type { TerminalLinkBuffer, TerminalLinkBufferLine } from './terminal-link-buffer'

function line(text: string, wrapped = false): TerminalLinkBufferLine {
  return {
    isWrapped: wrapped,
    length: text.length,
    translateToString: () => text,
    getCell: (x) => ({
      getWidth: () => 1,
      getChars: () => text[x] ?? ' '
    })
  }
}

function buffer(lines: TerminalLinkBufferLine[]): TerminalLinkBuffer {
  return { getLine: (y) => lines[y] }
}

function terminal(lines: TerminalLinkBufferLine[]): Pick<Terminal, 'buffer'> {
  return {
    buffer: { active: buffer(lines) }
  } as unknown as Pick<Terminal, 'buffer'>
}

describe('terminal link hit testing', () => {
  it('finds a URL only on the cells it occupies', () => {
    const term = terminal([line('see https://example.com/docs.')])
    expect(findTerminalHttpLinkAtPosition(term, { x: 5, y: 1 })).toBe(
      'https://example.com/docs'
    )
    expect(findTerminalHttpLinkAtPosition(term, { x: 28, y: 1 })).toBe(
      'https://example.com/docs'
    )
    expect(findTerminalHttpLinkAtPosition(term, { x: 4, y: 1 })).toBeNull()
    expect(findTerminalHttpLinkAtPosition(term, { x: 29, y: 1 })).toBeNull()
    expect(findTerminalHttpLinkAtPosition(term, { x: 5, y: 2 })).toBeNull()
  })

  it('finds a soft-wrapped URL on both rows', () => {
    const lines = [line('visit https://example.com/a'), line('bc/def next', true)]
    const term = terminal(lines)
    expect(findTerminalHttpLinkAtPosition(term, { x: 7, y: 1 })).toBe(
      'https://example.com/abc/def'
    )
    expect(findTerminalHttpLinkAtPosition(term, { x: 1, y: 2 })).toBe(
      'https://example.com/abc/def'
    )
    expect(findTerminalHttpLinkAtPosition(term, { x: 6, y: 2 })).toBe(
      'https://example.com/abc/def'
    )
    expect(findTerminalHttpLinkAtPosition(term, { x: 7, y: 2 })).toBeNull()
  })

  it('checks inclusive range boundaries', () => {
    const range = { start: { x: 5, y: 2 }, end: { x: 3, y: 4 } }
    expect(cellIsInBufferRange({ x: 4, y: 2 }, range)).toBe(false)
    expect(cellIsInBufferRange({ x: 5, y: 2 }, range)).toBe(true)
    expect(cellIsInBufferRange({ x: 99, y: 3 }, range)).toBe(true)
    expect(cellIsInBufferRange({ x: 4, y: 4 }, range)).toBe(false)
    expect(cellIsInBufferRange({ x: 3, y: 4 }, range)).toBe(true)
    expect(cellIsInBufferRange({ x: 5, y: 5 }, range)).toBe(false)
  })
})
