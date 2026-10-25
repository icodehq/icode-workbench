import { describe, expect, it } from 'vitest'
import { areaForCode, parseAheadBehind, parsePorcelainZ, statusForCode } from '../../shared/domain/git-workspace'
import { looksBinaryBytes, normalizeRelativePath, parentPath } from '../../shared/domain/workspace-files'

/**
 * The Git panel and file tree are small, but their parsers decide what a user
 * sees. These are the cases that silently corrupt a list when they are wrong:
 * renames consuming a second NUL field, a sibling path that looks contained, and
 * a binary file rendered as mojibake.
 */
describe('porcelain parsing', () => {
  it('reads a modified, a staged and an untracked entry', () => {
    // ' M' = unstaged modification, 'M ' = staged, '??' = untracked.
    const entries = parsePorcelainZ(' M src/a.ts\u0000M  src/b.ts\u0000?? notes.md\u0000')
    expect(entries.map((entry) => `${entry.code}|${entry.path}|${entry.area}`)).toEqual([
      ' M|src/a.ts|unstaged',
      'M |src/b.ts|staged',
      '??|notes.md|untracked'
    ])
  })

  it('keeps the path that follows a rename', () => {
    // A rename has two NUL-separated fields; dropping the second shifts every
    // later entry and loses the new path.
    const entries = parsePorcelainZ('R  new/name.ts\u0000old/name.ts\u0000 M after.ts\u0000')
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ path: 'new/name.ts', oldPath: 'old/name.ts', status: 'renamed' })
    expect(entries[1]).toMatchObject({ path: 'after.ts', area: 'unstaged' })
  })

  it('classifies conflicts', () => {
    expect(areaForCode('UU')).toBe('conflicted')
    expect(statusForCode('UU')).toBe('unmerged')
    expect(areaForCode('AA')).toBe('conflicted')
  })

  it('reads ahead/behind', () => {
    expect(parseAheadBehind('2\t5\n')).toEqual({ ahead: 2, behind: 5 })
    expect(parseAheadBehind('garbage')).toEqual({ ahead: 0, behind: 0 })
  })
})

describe('relative path validation', () => {
  it('accepts normal worktree paths', () => {
    expect(normalizeRelativePath('')).toBe('')
    expect(normalizeRelativePath('src/main/index.ts')).toBe('src/main/index.ts')
  })

  it('refuses anything that escapes the worktree', () => {
    expect(normalizeRelativePath('../etc/passwd')).toBeNull()
    expect(normalizeRelativePath('src/../../x')).toBeNull()
    expect(normalizeRelativePath('/etc/passwd')).toBeNull()
    expect(normalizeRelativePath('C:/Windows/system32')).toBeNull()
    expect(normalizeRelativePath('a/./b')).toBeNull()
    expect(normalizeRelativePath('a\u0000b')).toBeNull()
  })

  it('computes a parent directory', () => {
    expect(parentPath('a/b/c.ts')).toBe('a/b')
    expect(parentPath('top.ts')).toBe('')
  })
})

describe('binary detection', () => {
  it('treats a NUL as binary and plain UTF-8 as text', () => {
    expect(looksBinaryBytes([0x61, 0x00, 0x62])).toBe(true)
    expect(looksBinaryBytes(Buffer.from('hello\nworld\n', 'utf8'))).toBe(false)
    // A UTF-8 multibyte sequence has no NUL and must stay text.
    expect(looksBinaryBytes(Buffer.from('héllo', 'utf8'))).toBe(false)
  })
})

/**
 * Regression for the defect Work 81 measured in the running app: Git's porcelain
 * output begins with a significant space for an unstaged change, and the shared
 * Git helper trims stdout. The first entry's path then lost its first character
 * and the panel showed `rc/app.ts` for `src/app.ts`.
 */
describe('porcelain survives a trimmed reader', () => {
  it('documents that trimming corrupts the first unstaged path', () => {
    const porcelain = ' M src/app.ts\u0000?? src/feature.ts\u0000'
    expect(parsePorcelainZ(porcelain)[0]?.path).toBe('src/app.ts')
    // What a trimming reader produced: the leading space is gone, so every path
    // shifts left by one and the first is wrong.
    const trimmed = porcelain.trim()
    expect(parsePorcelainZ(trimmed)[0]?.path).toBe('rc/app.ts')
  })
})
