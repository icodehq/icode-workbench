import { parseStatusLines } from './git-worktree-service'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { samePath, samePathResolved } from './worktree-status'

describe('samePath on POSIX', () => {
  it('matches identical paths and ignores a trailing separator', () => {
    expect(samePath('/tmp/icode/wt/ses_1', '/tmp/icode/wt/ses_1', 'linux')).toBe(true)
    expect(samePath('/tmp/icode/wt/ses_1/', '/tmp/icode/wt/ses_1', 'linux')).toBe(true)
  })

  it('stays case-sensitive and separator-sensitive', () => {
    // Must not inherit Windows leniency on a case-sensitive filesystem.
    expect(samePath('/tmp/Icode/wt', '/tmp/icode/wt', 'linux')).toBe(false)
    expect(samePath('/tmp/icode\\wt', '/tmp/icode/wt', 'linux')).toBe(false)
  })

  it('keeps the default platform behaviour unchanged', () => {
    expect(samePath('/a/b', '/a/b')).toBe(true)
    expect(samePath('/a/b/', '/a/b')).toBe(true)
  })
})

describe('samePath on Windows', () => {
  it('treats git forward slashes and Node backslashes as the same path', () => {
    // The exact shape observed on Windows: git reports C:/Temp, Node built C:\temp
    expect(
      samePath(
        'C:/Temp/icode-w34/profile/worktrees/repo_1/ses_1',
        'C:\\temp\\icode-w34\\profile\\worktrees\\repo_1\\ses_1',
        'win32'
      )
    ).toBe(true)
  })

  it('ignores drive-letter and directory case', () => {
    expect(samePath('c:\\Temp\\iCode\\wt', 'C:\\temp\\icode\\WT', 'win32')).toBe(true)
  })

  it('ignores a trailing separator in either form', () => {
    expect(samePath('C:\\temp\\icode\\wt\\', 'C:/temp/icode/wt', 'win32')).toBe(true)
    expect(samePath('C:/temp/icode/wt/', 'C:\\temp\\icode\\wt', 'win32')).toBe(true)
  })

  it('still distinguishes genuinely different paths', () => {
    expect(samePath('C:\\temp\\icode\\wt\\ses_1', 'C:\\temp\\icode\\wt\\ses_2', 'win32')).toBe(false)
    expect(samePath('C:\\temp\\icode\\wt', 'D:\\temp\\icode\\wt', 'win32')).toBe(false)
  })

  it('distinguishes a parent from its child', () => {
    expect(samePath('C:\\temp\\icode\\wt', 'C:\\temp\\icode\\wt\\ses_1', 'win32')).toBe(false)
  })
})

describe('samePathResolved', () => {
  it('resolves a symlinked directory to the same location on POSIX', () => {
    const base = mkdtempSync(join(tmpdir(), 'icode-samepath-'))
    try {
      const real = join(base, 'real')
      const link = join(base, 'link')
      mkdirSync(real)
      symlinkSync(real, link, 'dir')
      expect(samePathResolved(link, real, 'linux')).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('still falls back to string comparison for a path that does not exist', () => {
    expect(samePathResolved('/nope/icode/wt', '/nope/icode/wt', 'linux')).toBe(true)
    expect(samePathResolved('/nope/Icode', '/nope/icode', 'linux')).toBe(false)
  })

  // APFS realpath treats a backslash as an ordinary filename character, so a
  // simulated Windows path cannot be resolved against a real macOS directory.
  // The product never compares win32 paths on darwin; Linux/Windows still cover
  // the separator and case folding.
  it.skipIf(process.platform === 'darwin')(
    'is separator- and case-insensitive on Windows even for existing paths',
    () => {
    // The JS realpathSync keeps the caller's casing on Windows, so resolution
    // alone would leave C:/Temp and C:\temp unequal.
    const base = mkdtempSync(join(tmpdir(), 'icode-samepath-win-'))
    try {
      const win = base.replace(/\//g, '\\')
      expect(samePathResolved(win, base, 'win32')).toBe(true)
      expect(samePathResolved(win.toUpperCase(), base, 'win32')).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('porcelain status parsing', () => {
  it('keeps a leading status column that trimming removed', () => {
    // `git status --porcelain` prints " M a.txt"; stdout.trim() turns that into
    // "M a.txt", and a fixed slice(3) then reported ".txt".
    expect(parseStatusLines('M a.txt')).toEqual(['a.txt'])
  })

  it('parses an untrimmed line too', () => {
    expect(parseStatusLines(' M a.txt\n')).toEqual(['a.txt'])
  })

  it('parses staged additions and untracked files', () => {
    expect(parseStatusLines('A  new.txt\n?? loose.txt\n')).toEqual(['new.txt', 'loose.txt'])
  })

  it('reports the rename target, not the source', () => {
    expect(parseStatusLines('R  old.txt -> new.txt\n')).toEqual(['new.txt'])
  })

  it('keeps paths with spaces intact', () => {
    expect(parseStatusLines('M dir/a b.txt')).toEqual(['dir/a b.txt'])
  })

  it('ignores blank lines', () => {
    expect(parseStatusLines('\n\n')).toEqual([])
  })
})
