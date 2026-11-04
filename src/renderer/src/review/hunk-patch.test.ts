import { describe, expect, it } from 'vitest'
import {
  buildLinePatch,
  hunkPatch,
  lineSelectionKey,
  splitPatchHunks
} from './hunk-patch'

const PATCH = [
  'diff --git a/a.txt b/a.txt',
  'index 1111111..2222222 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,2 +1,2 @@',
  ' one',
  '-two',
  '+TWO',
  '@@ -10,2 +10,3 @@',
  ' ten',
  '+eleven',
  ' eleven',
  '\\ No newline at end of file',
  ''
].join('\n')

describe('splitPatchHunks', () => {
  it('preserves the preamble and every raw hunk', () => {
    const split = splitPatchHunks(PATCH)
    expect(split.header).toBe(
      ['diff --git a/a.txt b/a.txt', 'index 1111111..2222222 100644', '--- a/a.txt', '+++ b/a.txt'].join(
        '\n'
      )
    )
    expect(split.hunks).toHaveLength(2)
    expect(split.hunks[0]).toBe('@@ -1,2 +1,2 @@\n one\n-two\n+TWO')
    expect(split.hunks[1]).toContain('\\ No newline at end of file')
  })

  it('returns the whole patch as header when there is no hunk', () => {
    const binary = 'diff --git a/x b/x\nBinary files a/x and b/x differ\n'
    expect(splitPatchHunks(binary)).toEqual({ header: binary, hunks: [] })
  })

  it('handles an empty patch', () => {
    expect(splitPatchHunks('')).toEqual({ header: '', hunks: [] })
  })
})

describe('hunkPatch', () => {
  it('combines the preamble with exactly one hunk', () => {
    const first = hunkPatch(PATCH, 0)
    expect(first).not.toBeNull()
    expect(first).toContain('diff --git a/a.txt b/a.txt')
    expect(first).toContain('@@ -1,2 +1,2 @@')
    expect(first).not.toContain('@@ -10,2 +10,3 @@')
    expect(first).not.toContain('\\ No newline')
  })

  it('keeps a trailing no-newline marker with its hunk', () => {
    const second = hunkPatch(PATCH, 1)
    expect(second).toContain('@@ -10,2 +10,3 @@')
    expect(second).toContain('\\ No newline at end of file')
    expect(second).not.toContain('@@ -1,2 +1,2 @@')
  })

  it('returns null outside the hunk range', () => {
    expect(hunkPatch(PATCH, 2)).toBeNull()
    expect(hunkPatch('', 0)).toBeNull()
  })
})

const LINE_PATCH = [
  'diff --git a/a.txt b/a.txt',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,3 +1,4 @@',
  ' a',
  '-b',
  '+B',
  ' c',
  '+d',
  ''
].join('\n')

const selected = (...keys: string[]): ReadonlySet<string> => new Set(keys)

describe('buildLinePatch', () => {
  it('stages both sides of a selected replacement', () => {
    const result = buildLinePatch(
      LINE_PATCH,
      0,
      selected(lineSelectionKey('new', 2)),
      'forward'
    )
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.patch).toContain('-b')
    expect(result.patch).toContain('+B')
    expect(result.patch).not.toContain('+d')
    expect(result.patch).toContain('diff --git a/a.txt b/a.txt')
  })

  it('selecting the removed side of a replacement selects the same pair', () => {
    const fromOld = buildLinePatch(
      LINE_PATCH,
      0,
      selected(lineSelectionKey('old', 2)),
      'forward'
    )
    const fromNew = buildLinePatch(
      LINE_PATCH,
      0,
      selected(lineSelectionKey('new', 2)),
      'forward'
    )
    expect(fromOld).toEqual(fromNew)
  })

  it('keeps pair order when a later replacement is selected first', () => {
    const twoPairs = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,4 +1,4 @@',
      ' a',
      '-b',
      '+B',
      '-c',
      '+C',
      ' d',
      ''
    ].join('\n')
    const result = buildLinePatch(
      twoPairs,
      0,
      selected(lineSelectionKey('new', 3)),
      'forward'
    )
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.patch).toContain(' b\n-c\n+C\n d')
    expect(result.patch).not.toContain('+B')

    const reverse = buildLinePatch(
      twoPairs,
      0,
      selected(lineSelectionKey('new', 3)),
      'reverse'
    )
    expect(reverse.status).toBe('ok')
    if (reverse.status !== 'ok') return
    expect(reverse.patch).toContain(' B\n-c\n+C\n d')
  })

  it('keeps an unselected replacement as context and stages one added line', () => {
    const result = buildLinePatch(
      LINE_PATCH,
      0,
      selected(lineSelectionKey('new', 4)),
      'forward'
    )
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.patch).toContain('\n b\n')
    expect(result.patch).toContain('+d')
    expect(result.patch).not.toContain('-b')
    expect(result.patch).not.toContain('+B')
  })

  it('reverse-applies a selected pair and keeps unselected additions as context', () => {
    const result = buildLinePatch(
      LINE_PATCH,
      0,
      selected(lineSelectionKey('new', 2)),
      'reverse'
    )
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.patch).toContain('-b')
    expect(result.patch).toContain('+B')
    expect(result.patch).toContain('\n d\n')
    expect(result.patch).not.toContain('+d')
  })

  it('reverse-applies only the selected standalone addition', () => {
    const result = buildLinePatch(
      LINE_PATCH,
      0,
      selected(lineSelectionKey('new', 4)),
      'reverse'
    )
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.patch).toContain('\n B\n')
    expect(result.patch).toContain('+d')
    expect(result.patch).not.toContain('-b')
    expect(result.patch).not.toContain('+B')
  })

  it('rejects empty or out-of-hunk selections', () => {
    expect(buildLinePatch(LINE_PATCH, 0, selected(), 'forward')).toMatchObject({
      status: 'error'
    })
    expect(
      buildLinePatch(LINE_PATCH, 0, selected(lineSelectionKey('new', 99)), 'forward')
    ).toMatchObject({ status: 'error' })
    expect(buildLinePatch(LINE_PATCH, 9, selected(lineSelectionKey('new', 2)), 'forward')).toMatchObject({
      status: 'error'
    })
  })

  it('refuses line-level patches for a file without a trailing newline', () => {
    const noNewline = LINE_PATCH.replace('+d\n', '+d\n\\ No newline at end of file\n')
    expect(
      buildLinePatch(noNewline, 0, selected(lineSelectionKey('new', 2)), 'forward')
    ).toMatchObject({ status: 'error' })
  })
})
