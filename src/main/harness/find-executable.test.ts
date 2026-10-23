import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findExecutable } from './find-executable'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function fixture(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'ade-findexec-'))
  dirs.push(dir)
  for (const file of files) {
    mkdirSync(join(dir, file).replace(/[\\/][^\\/]+$/u, ''), { recursive: true })
    writeFileSync(join(dir, file), 'x')
    // findExecutable requires the execute bit, mirroring a real launcher.
    chmodSync(join(dir, file), 0o755)
  }
  return dir
}

describe('findExecutable on Windows', () => {
  it('finds a name that already carries an extension', () => {
    // Regression: appending PATHEXT produced `powershell.exe.EXE`.
    const dir = fixture(['powershell.exe'])
    const found = findExecutable(
      'powershell.exe',
      { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      'win32'
    )
    expect(found).toBe(join(dir, 'powershell.exe'))
  })

  it('finds an extensionless name through PATHEXT', () => {
    // Lower-case PATHEXT so the expectation holds on a case-sensitive test
    // filesystem; Windows itself is case-insensitive here.
    const dir = fixture(['claude.cmd'])
    const found = findExecutable(
      'claude',
      { PATH: dir, PATHEXT: '.com;.exe;.bat;.cmd' },
      'win32'
    )
    expect(found).toBe(join(dir, 'claude.cmd'))
  })

  it('does not find a differently-extended sibling', () => {
    const dir = fixture(['tool.cmd'])
    expect(findExecutable('tool.exe', { PATH: dir, PATHEXT: '.exe;.cmd' }, 'win32')).toBeNull()
  })
})

describe('findExecutable on POSIX', () => {
  it('resolves an executable file without extensions', () => {
    const dir = fixture(['claude'])
    const found = findExecutable('claude', { PATH: dir }, 'linux')
    expect(found).toBe(join(dir, 'claude'))
  })

  it('does not invent a Windows extension on POSIX', () => {
    const dir = fixture(['claude.cmd'])
    expect(findExecutable('claude', { PATH: dir, PATHEXT: '.CMD' }, 'linux')).toBeNull()
  })

  it('ignores path separators in the requested name', () => {
    expect(findExecutable('../../etc/passwd', { PATH: '/usr/bin' }, 'linux')).toBeNull()
  })
})
