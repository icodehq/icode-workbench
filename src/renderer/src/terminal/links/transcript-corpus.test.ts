import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import type { ILink, Terminal as XtermTerminal } from '@xterm/xterm'
import { createUrlLinkProvider } from './url-link-provider'
import { buildWrappedLogicalLine } from './wrapped-line'

/**
 * Raw-byte terminal transcript corpus.
 *
 * Fixtures are written through xterm's real headless parser so the link
 * provider sees the same buffer rows and cell widths as production. Add a
 * fixture for every parity-matrix row that depends on terminal byte handling.
 */
const FIXTURES = new URL('../../../../../tests/fixtures/terminal/links/', import.meta.url)

async function emulator(fixture: string, cols: number): Promise<Terminal> {
  const terminal = new Terminal({
    cols,
    rows: 16,
    scrollback: 100,
    allowProposedApi: true,
    convertEol: true
  })
  const raw = readFileSync(new URL(fixture, FIXTURES), 'utf8')
  await new Promise<void>((resolve) => terminal.write(raw, resolve))
  return terminal
}

function linksAt(terminal: Terminal, row: number): ILink[] | undefined {
  let result: ILink[] | undefined
  const term = { buffer: terminal.buffer } as unknown as XtermTerminal
  createUrlLinkProvider({
    term,
    activate: () => undefined,
    isDisposed: () => false
  }).provideLinks(row, (links) => {
    result = links
  })
  return result
}

function textRows(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active
  return Array.from(
    { length: buffer.length },
    (_value, index) => buffer.getLine(index)?.translateToString(true) ?? ''
  )
}

describe('terminal link transcript corpus', () => {
  it('detects one URL across a soft wrap at 40 columns', async () => {
    const terminal = await emulator('url-wrapped-40.raw', 40)
    const rows = textRows(terminal)
    const startIndex = rows.findIndex((line) => line.includes('https://'))
    const endIndex = rows.findIndex((line) => line.includes('wrapped/url'))
    expect(startIndex).toBeGreaterThanOrEqual(0)
    expect(endIndex).toBeGreaterThan(startIndex)

    const logical = buildWrappedLogicalLine(terminal.buffer.active, startIndex + 1)
    expect(logical?.text).toContain(
      'https://example.com/icode/terminal/parity/wrapped/url'
    )

    const startLinks = linksAt(terminal, startIndex + 1)
    expect(startLinks).toHaveLength(1)
    expect(startLinks?.[0]?.text).toBe(
      'https://example.com/icode/terminal/parity/wrapped/url'
    )
    expect(startLinks?.[0]?.range.start.y).toBe(startIndex + 1)
    expect(startLinks?.[0]?.range.end.y).toBe(endIndex + 1)
    expect(linksAt(terminal, endIndex + 1)).toHaveLength(1)
    terminal.dispose()
  })

  it('keeps the same URL on one row at 120 columns', async () => {
    const terminal = await emulator('url-120.raw', 120)
    const rows = textRows(terminal)
    const index = rows.findIndex((line) => line.includes('wrapped/url'))
    expect(index).toBeGreaterThanOrEqual(0)

    const links = linksAt(terminal, index + 1)
    expect(links).toHaveLength(1)
    expect(links?.[0]?.range.start.y).toBe(index + 1)
    expect(links?.[0]?.range.end.y).toBe(index + 1)
    terminal.dispose()
  })

  it('does not claim OSC 8 link text that is not a URL', async () => {
    const terminal = await emulator('osc8-nonurl.raw', 80)
    const rows = textRows(terminal)
    const index = rows.findIndex((line) => line.includes('click here'))
    expect(index).toBeGreaterThanOrEqual(0)
    expect(rows[index]).not.toContain('https://example.com/from-osc8')

    // xterm's OSC 8 provider owns this cell; the text provider must stay silent
    // so the two providers cannot activate the link twice.
    expect(linksAt(terminal, index + 1)).toBeUndefined()
    terminal.dispose()
  })
})
