import { describe, expect, it } from 'vitest'
import { EMPTY_TREE_OID, parseCommitMetadata, parseLogOutput } from './history-reader'

describe('history parsing', () => {
  it('parses log fields, parents and refs across record separators', () => {
    const output =
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\u001fa1\u001fbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb cccccccccccccccccccccccccccccccccccccccc\u001fAda\u001fada@test\u001f1700000000\u001fHEAD -> main, origin/main, tag: v1\u001fSecond commit\u001e\n' +
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\u001fb1\u001f\u001fGrace\u001fgrace@test\u001f1600000000\u001f\u001fRoot commit\u001e'

    const entries = parseLogOutput(output)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      oid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      shortOid: 'a1',
      parents: [
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'cccccccccccccccccccccccccccccccccccccccc'
      ],
      author: 'Ada',
      authorEmail: 'ada@test',
      authoredAt: 1_700_000_000,
      refs: ['HEAD -> main', 'origin/main', 'tag: v1'],
      subject: 'Second commit'
    })
    expect(entries[1]).toMatchObject({
      parents: [],
      refs: [],
      subject: 'Root commit'
    })
  })

  it('ignores empty output and missing trailing records', () => {
    expect(parseLogOutput('')).toEqual([])
    expect(parseLogOutput('\n')).toEqual([])
  })

  it('parses commit metadata and keeps a multi-line body', () => {
    const output =
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\u0000a1\u0000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\u0000Ada\u0000ada@test\u00001700000000\u0000Subject\u0000Body one\n\nBody two\n'

    const metadata = parseCommitMetadata(output)
    expect(metadata).toMatchObject({
      oid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      shortOid: 'a1',
      parents: ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
      author: 'Ada',
      authorEmail: 'ada@test',
      authoredAt: 1_700_000_000,
      subject: 'Subject',
      body: 'Body one\n\nBody two'
    })
    expect(parseCommitMetadata('short')).toBeNull()
  })

  it('exposes the empty-tree hash used for root commits', () => {
    expect(EMPTY_TREE_OID).toHaveLength(40)
  })
})
