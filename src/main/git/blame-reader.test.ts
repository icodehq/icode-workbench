import { describe, expect, it } from 'vitest'
import { parseBlamePorcelain } from './blame-reader'

describe('parseBlamePorcelain', () => {
  it('reads per-line metadata and sorts by final line', () => {
    const oid = 'a'.repeat(40)
    const output = [
      `${oid} 1 2 1`,
      'author Ada Lovelace',
      'author-mail <ada@test>',
      'author-time 1700000000',
      'summary Second line',
      'filename file.ts',
      '\tsecond',
      `${oid} 2 1 1`,
      'author Grace Hopper',
      'author-mail <grace@test>',
      'author-time 1600000000',
      'summary First line',
      'filename file.ts',
      '\tfirst'
    ].join('\n')
    expect(parseBlamePorcelain(output)).toEqual([
      {
        line: 1,
        oid,
        author: 'Grace Hopper',
        authorTime: 1_600_000_000,
        summary: 'First line',
        committed: true
      },
      {
        line: 2,
        oid,
        author: 'Ada Lovelace',
        authorTime: 1_700_000_000,
        summary: 'Second line',
        committed: true
      }
    ])
  })

  it('marks zero object ids as uncommitted', () => {
    const output = [
      `${'0'.repeat(40)} 1 1 1`,
      'author Not Committed Yet',
      'author-time 1700000000',
      'summary Version of file.ts from file.ts',
      '\tworking line'
    ].join('\n')
    const lines = parseBlamePorcelain(output)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.committed).toBe(false)
    expect(lines[0]?.line).toBe(1)
  })

  it('ignores malformed and incomplete records', () => {
    expect(parseBlamePorcelain('garbage\n')).toEqual([])
    expect(parseBlamePorcelain('')).toEqual([])
  })
})
