import { describe, expect, it } from 'vitest'
import {
  extendParsed,
  parseInlines,
  parseText,
  type Block
} from './markdown-parser'

function blocks(text: string): Block[] {
  return parseText(text).blocks
}

describe('markdown parser', () => {
  it('parses headings, paragraphs, rules and blockquotes', () => {
    const parsed = blocks('## Title\n\nbody **bold**\n\n---\n\n> quoted')
    expect(parsed[0]).toMatchObject({ kind: 'heading', level: 2, text: 'Title' })
    expect(parsed[1]).toMatchObject({ kind: 'paragraph' })
    expect(parsed[2]).toMatchObject({ kind: 'hr' })
    expect(parsed[3]).toMatchObject({ kind: 'blockquote' })
  })

  it('parses inline bold, italic, code and safe links', () => {
    expect(parseInlines('a **b** *c* `d` [e](https://example.com)')).toMatchObject([
      { kind: 'text', value: 'a ' },
      { kind: 'bold' },
      { kind: 'text', value: ' ' },
      { kind: 'italic' },
      { kind: 'text', value: ' ' },
      { kind: 'code', value: 'd' },
      { kind: 'text', value: ' ' },
      { kind: 'link', url: 'https://example.com', text: 'e' }
    ])
  })

  it('refuses javascript and file links', () => {
    expect(parseInlines('[x](javascript:alert(1))').some((item) => item.kind === 'link')).toBe(
      false
    )
    expect(parseInlines('[x](file:///etc/passwd)').some((item) => item.kind === 'link')).toBe(
      false
    )
  })

  it('parses lists, tables and fenced code', () => {
    const parsed = blocks(
      '- one\n- two\n\n1. first\n2. second\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nconst x = 1\n```'
    )
    expect(parsed[0]).toMatchObject({ kind: 'list', ordered: false })
    expect(parsed[1]).toMatchObject({ kind: 'list', ordered: true })
    expect(parsed[2]).toMatchObject({ kind: 'table' })
    expect(parsed[3]).toMatchObject({ kind: 'code', text: 'const x = 1' })
  })

  it('treats an unclosed fence as code through EOF', () => {
    expect(blocks('```\nconst x = 1')).toMatchObject([{ kind: 'code', text: 'const x = 1' }])
  })

  it('does not render a table until its separator line arrives', () => {
    expect(blocks('| A | B |')[0]).toMatchObject({ kind: 'paragraph' })
    expect(blocks('| A | B |\n| --- | --- |')[0]).toMatchObject({ kind: 'table' })
  })

  it('keeps closed block identity while the open tail grows', () => {
    const first = parseText('first paragraph\n\nsecond')
    const second = extendParsed(first, 'first paragraph\n\nsecond grows')
    expect(second.blocks[0]).toBe(first.blocks[0])
    expect(second.blocks[1]).not.toBe(first.blocks[1])
  })
})
