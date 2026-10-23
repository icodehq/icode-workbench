import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { samePath, samePathResolved } from './worktree-status'

describe('samePath on POSIX', () => {
  it('matches identical paths and ignores a trailing separator', () => {
    expect(samePath('/tmp/ade/wt/ses_1', '/tmp/ade/wt/ses_1', 'linux')).toBe(true)
    expect(samePath('/tmp/ade/wt/ses_1/', '/tmp/ade/wt/ses_1', 'linux')).toBe(true)
  })

  it('stays case-sensitive and separator-sensitive', () => {
    // Must not inherit Windows leniency on a case-sensitive filesystem.
    expect(samePath('/tmp/Ade/wt', '/tmp/ade/wt', 'linux')).toBe(false)
    expect(samePath('/tmp/ade\\wt', '/tmp/ade/wt', 'linux')).toBe(false)
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
        'C:/Temp/ade-w34/profile/worktrees/repo_1/ses_1',
        'C:\\temp\\ade-w34\\profile\\worktrees\\repo_1\\ses_1',
        'win32'
      )
    ).toBe(true)
  })

  it('ignores drive-letter and directory case', () => {
    expect(samePath('c:\\Temp\\ADE\\wt', 'C:\\temp\\ade\\WT', 'win32')).toBe(true)
  })

  it('ignores a trailing separator in either form', () => {
    expect(samePath('C:\\temp\\ade\\wt\\', 'C:/temp/ade/wt', 'win32')).toBe(true)
    expect(samePath('C:/temp/ade/wt/', 'C:\\temp\\ade\\wt', 'win32')).toBe(true)
  })

  it('still distinguishes genuinely different paths', () => {
    expect(samePath('C:\\temp\\ade\\wt\\ses_1', 'C:\\temp\\ade\\wt\\ses_2', 'win32')).toBe(false)
    expect(samePath('C:\\temp\\ade\\wt', 'D:\\temp\\ade\\wt', 'win32')).toBe(false)
  })

  it('distinguishes a parent from its child', () => {
    expect(samePath('C:\\temp\\ade\\wt', 'C:\\temp\\ade\\wt\\ses_1', 'win32')).toBe(false)
  })
})

describe('samePathResolved', () => {
  it('resolves a symlinked directory to the same location on POSIX', () => {
    const base = mkdtempSync(join(tmpdir(), 'ade-samepath-'))
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
    expect(samePathResolved('/nope/ade/wt', '/nope/ade/wt', 'linux')).toBe(true)
    expect(samePathResolved('/nope/Ade', '/nope/ade', 'linux')).toBe(false)
  })

  it('is separator- and case-insensitive on Windows even for existing paths', () => {
    // The JS realpathSync keeps the caller's casing on Windows, so resolution
    // alone would leave C:/Temp and C:\temp unequal.
    const base = mkdtempSync(join(tmpdir(), 'ade-samepath-win-'))
    try {
      const win = base.replace(/\//g, '\\')
      expect(samePathResolved(win, base, 'win32')).toBe(true)
      expect(samePathResolved(win.toUpperCase(), base, 'win32')).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
