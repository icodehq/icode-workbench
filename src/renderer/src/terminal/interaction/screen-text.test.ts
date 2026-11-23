import { describe, expect, it } from 'vitest'
import {
  TERMINAL_CLIPBOARD_MAX_CHARS,
  capClipboardText,
  readScreenText,
  type ScreenTextBuffer
} from './screen-text'

function buffer(lines: string[], viewportY = 0): ScreenTextBuffer {
  return {
    viewportY,
    length: lines.length,
    getLine(row) {
      const line = lines[row]
      if (line === undefined) return undefined
      return {
        translateToString: (trimRight?: boolean) =>
          trimRight === true ? line.replace(/\s+$/u, '') : line
      }
    }
  }
}

describe('readScreenText', () => {
  it('reads only the visible viewport', () => {
    expect(readScreenText(buffer(['a', 'b', 'c', 'd'], 2), 2)).toBe('c\nd')
  })

  it('trims trailing spaces and trailing blank rows', () => {
    expect(readScreenText(buffer(['a   ', '', '   ']), 3)).toBe('a')
  })

  it('clamps at the end of the buffer and tolerates missing lines', () => {
    expect(readScreenText(buffer(['a']), 5)).toBe('a')
    const sparse: ScreenTextBuffer = {
      viewportY: 0,
      length: 2,
      getLine: (row) => (row === 1 ? { translateToString: () => 'last' } : undefined)
    }
    expect(readScreenText(sparse, 2)).toBe('\nlast')
  })

  it('returns nothing for an empty viewport', () => {
    expect(readScreenText(buffer([]), 5)).toBe('')
    expect(readScreenText(buffer(['a']), 0)).toBe('')
  })
})

describe('capClipboardText', () => {
  it('keeps the tail of an oversized copy', () => {
    const text = 'x'.repeat(TERMINAL_CLIPBOARD_MAX_CHARS + 5)
    expect(capClipboardText(text)).toBe(text.slice(-TERMINAL_CLIPBOARD_MAX_CHARS))
  })

  it('leaves a short copy untouched', () => {
    expect(capClipboardText('short', 10)).toBe('short')
  })
})
