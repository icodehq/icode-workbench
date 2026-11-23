import { describe, expect, it } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import type { TerminalLinkBuffer, TerminalLinkBufferLine } from './terminal-link-buffer'
import { buildWrappedLogicalLine } from './wrapped-line'
import { createUrlLinkProvider } from './url-link-provider'

function line(
  text: string,
  options: { wrapped?: boolean; widths?: number[] } = {}
): TerminalLinkBufferLine {
  return {
    isWrapped: options.wrapped === true,
    length: text.length,
    translateToString: () => text,
    getCell: (x) => ({
      getWidth: () => options.widths?.[x] ?? 1,
      getChars: () => text[x] ?? ' '
    })
  }
}

function buffer(lines: TerminalLinkBufferLine[]): TerminalLinkBuffer {
  return { getLine: (y) => lines[y] }
}

function linksAt(lines: TerminalLinkBufferLine[], row: number): unknown {
  let result: unknown
  const terminal = { buffer: { active: buffer(lines) } } as unknown as Terminal
  const provider = createUrlLinkProvider({
    term: terminal,
    activate: () => undefined,
    isDisposed: () => false
  })
  provider.provideLinks(row, (links) => {
    result = links
  })
  return result
}

describe('wrapped-line', () => {
  it('joins soft-wrapped rows and maps a range back to cells', () => {
    const lines = [line('visit https://example.com/a'), line('bc/def next', { wrapped: true })]
    const logical = buildWrappedLogicalLine(buffer(lines), 2)
    expect(logical?.text).toBe('visit https://example.com/abc/def next')
    expect(logical?.rows).toHaveLength(2)
  })

  it('stops building beyond the wrapped-row cap', () => {
    const lines = Array.from({ length: 201 }, (_value, index) =>
      line('x', { wrapped: index > 0 })
    )
    expect(buildWrappedLogicalLine(buffer(lines), 201)).toBeNull()
  })
})

describe('url-link-provider', () => {
  it('returns a URL spanning two rows with a 1-based range', () => {
    const lines = [line('visit https://example.com/a'), line('bc/def next', { wrapped: true })]
    const links = linksAt(lines, 2) as
      | Array<{ text: string; range: { start: { x: number; y: number }; end: { x: number; y: number } } }>
      | undefined
    expect(links).toHaveLength(1)
    expect(links?.[0]?.text).toBe('https://example.com/abc/def')
    expect(links?.[0]?.range).toEqual({
      start: { x: 7, y: 1 },
      end: { x: 6, y: 2 }
    })
  })

  it('returns links that intersect either row of the wrapped chain', () => {
    const lines = [line('visit https://example.com/a'), line('bc/def next', { wrapped: true })]
    expect((linksAt(lines, 1) as unknown[] | undefined)?.length).toBe(1)
    expect((linksAt(lines, 3) as unknown[] | undefined)).toBeUndefined()
  })

  it('maps wide cells through the cell fallback', () => {
    const lines = [line('https://example.com/中', { widths: [1, 1, 1, 1, 1, 1, 1, 1, 2] })]
    const links = linksAt(lines, 1) as Array<{ text: string }> | undefined
    expect(links?.[0]?.text).toBe('https://example.com/中')
  })

  it('returns no links for a line without a URL', () => {
    expect(linksAt([line('plain output')], 1)).toBeUndefined()
  })
})
