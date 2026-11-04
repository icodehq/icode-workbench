import { describe, expect, it } from 'vitest'
import { quickChangeForLine, quickDiffPatch } from './quick-diff-actions'
import type { LineChange } from './line-diff'

const PATCH = [
  'diff --git a/a.txt b/a.txt',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,3 +1,3 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  '@@ -10,3 +10,3 @@',
  ' ten',
  '-eleven',
  '+ELEVEN',
  ' twelve',
  ''
].join('\n')

const first: LineChange = {
  oldStart: 2,
  oldCount: 1,
  newStart: 2,
  newCount: 1,
  newAnchor: 2
}
const second: LineChange = {
  oldStart: 11,
  oldCount: 1,
  newStart: 11,
  newCount: 1,
  newAnchor: 11
}

describe('quickChangeForLine', () => {
  it('maps modified lines and deletion anchors', () => {
    expect(quickChangeForLine([first, second], 2)).toBe(0)
    expect(quickChangeForLine([first, second], 11)).toBe(1)
    expect(quickChangeForLine([first, second], 5)).toBeNull()
    const deletion: LineChange = {
      oldStart: 4,
      oldCount: 2,
      newStart: 0,
      newCount: 0,
      newAnchor: 4
    }
    expect(quickChangeForLine([deletion], 4)).toBe(0)
    expect(quickChangeForLine([deletion], 5)).toBeNull()
  })
})

describe('quickDiffPatch', () => {
  it('selects only the intersecting Git hunk', () => {
    const result = quickDiffPatch(PATCH, first, 'forward')
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.patch).toContain('@@ -1,3 +1,3 @@')
    expect(result.patch).toContain('-two')
    expect(result.patch).toContain('+TWO')
    expect(result.patch).not.toContain('@@ -10,3 +10,3 @@')
    expect(result.patch).not.toContain('+ELEVEN')
  })

  it('builds a reverse patch for the selected hunk', () => {
    const result = quickDiffPatch(PATCH, second, 'reverse')
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.patch).toContain('@@ -10,3 +10,3 @@')
    expect(result.patch).toContain('-eleven')
    expect(result.patch).toContain('+ELEVEN')
    expect(result.patch).not.toContain('@@ -1,3 +1,3 @@')
  })

  it('handles a pure addition', () => {
    const additionPatch = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,2 +1,3 @@',
      ' one',
      '+middle',
      ' two',
      ''
    ].join('\n')
    const addition: LineChange = {
      oldStart: 0,
      oldCount: 0,
      newStart: 2,
      newCount: 1,
      newAnchor: 2
    }
    const result = quickDiffPatch(additionPatch, addition, 'forward')
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.patch).toContain('+middle')
  })

  it('reports when no hunk intersects the change', () => {
    const outside: LineChange = {
      oldStart: 99,
      oldCount: 1,
      newStart: 99,
      newCount: 1,
      newAnchor: 99
    }
    expect(quickDiffPatch(PATCH, outside, 'forward')).toMatchObject({ status: 'error' })
  })
})
