import { describe, expect, it } from 'vitest'
import { lineDiff, quickDiffCounts } from './line-diff'

describe('lineDiff', () => {
  it('reports no changes for identical text', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nb\nc\n')).toEqual([])
  })

  it('finds an inserted line', () => {
    expect(lineDiff('a\nc\n', 'a\nb\nc\n')).toEqual([
      { oldStart: 0, oldCount: 0, newStart: 2, newCount: 1, newAnchor: 2 }
    ])
    expect(quickDiffCounts(lineDiff('a\nc\n', 'a\nb\nc\n'))).toEqual({
      additions: 1,
      deletions: 0
    })
  })

  it('finds a deleted line', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nc\n')).toEqual([
      { oldStart: 2, oldCount: 1, newStart: 0, newCount: 0, newAnchor: 2 }
    ])
  })

  it('groups a replacement as one modified block', () => {
    expect(lineDiff('one\ntwo\nthree\n', 'one\nTWO\nthree\n')).toEqual([
      { oldStart: 2, oldCount: 1, newStart: 2, newCount: 1, newAnchor: 2 }
    ])
  })

  it('handles multiple separated changes and common suffixes', () => {
    const changes = lineDiff('a\nb\nc\nd\ne\n', 'a\nB\nc\nD\ne\n')
    expect(changes).toEqual([
      { oldStart: 2, oldCount: 1, newStart: 2, newCount: 1, newAnchor: 2 },
      { oldStart: 4, oldCount: 1, newStart: 4, newCount: 1, newAnchor: 4 }
    ])
  })

  it('treats a trailing newline change as a line change', () => {
    expect(lineDiff('a\n', 'a')).toEqual([
      { oldStart: 2, oldCount: 1, newStart: 0, newCount: 0, newAnchor: 2 }
    ])
  })

  it('falls back to one block for a pathologically large middle', () => {
    const oldText = Array.from({ length: 2500 }, (_value, index) => `old ${String(index)}`).join('\n')
    const newText = Array.from({ length: 2500 }, (_value, index) => `new ${String(index)}`).join('\n')
    const changes = lineDiff(oldText, newText)
    expect(changes).toEqual([
      { oldStart: 1, oldCount: 2500, newStart: 1, newCount: 2500, newAnchor: 1 }
    ])
  })
})
