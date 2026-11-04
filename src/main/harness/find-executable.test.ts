import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findExecutable } from './find-executable'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

/**
 * A PATH directory. Names in `files` carry content; names in `empty` are
 * zero-byte. Both get the execute bit, so size is the only difference — the
 * shape of a Windows Store App Execution Alias stub.
 */
function fixture(files: string[], empty: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'icode-findexec-'))
  dirs.push(dir)
  const write = (file: string, content: string): void => {
    mkdirSync(join(dir, file).replace(/[\\/][^\\/]+$/u, ''), { recursive: true })
    writeFileSync(join(dir, file), content)
    // findExecutable requires the execute bit, mirroring a real launcher.
    chmodSync(join(dir, file), 0o755)
  }
  for (const file of files) write(file, 'x')
  for (const file of empty) write(file, '')
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

  it('rejects a zero-byte candidate', () => {
    // A Store App Execution Alias stub: present, executable, but 0 bytes.
    // Lower-case PATHEXT + file name so the candidate really matches on a
    // case-sensitive test filesystem; Windows itself is case-insensitive.
    const dir = fixture([], ['tool.exe'])
    expect(findExecutable('tool', { PATH: dir, PATHEXT: '.exe' }, 'win32')).toBeNull()
  })

  it('still accepts a non-empty candidate', () => {
    const dir = fixture(['tool.exe'])
    expect(findExecutable('tool', { PATH: dir, PATHEXT: '.exe' }, 'win32')).toBe(
      join(dir, 'tool.exe')
    )
  })

  it('skips a zero-byte candidate and selects the next valid one', () => {
    // The stub would win on extension order alone; resolution must continue.
    const dir = fixture(['tool.cmd'], ['tool.exe'])
    expect(findExecutable('tool', { PATH: dir, PATHEXT: '.exe;.cmd' }, 'win32')).toBe(
      join(dir, 'tool.cmd')
    )
  })

  it('keeps searching later PATH entries when the first is a stub', () => {
    const stubDir = fixture([], ['tool.exe'])
    const realDir = fixture(['tool.exe'])
    const path = [stubDir, realDir].join(delimiter)
    expect(findExecutable('tool', { PATH: path, PATHEXT: '.exe' }, 'win32')).toBe(
      join(realDir, 'tool.exe')
    )
  })

  it('does not select a .ps1 sibling under the default PATHEXT', () => {
    // iCode cannot launch a .ps1: Node reports EFTYPE and a Restricted policy
    // blocks the script host outright.
    const dir = fixture([], ['claude.ps1'])
    expect(findExecutable('claude', { PATH: dir }, 'win32')).toBeNull()
  })

  it('prefers .cmd over .ps1 even when PATHEXT lists .PS1 first', () => {
    const lower = fixture(['claude.cmd', 'claude.ps1'])
    expect(
      findExecutable('claude', { PATH: lower, PATHEXT: '.ps1;.cmd' }, 'win32')
    ).toBe(join(lower, 'claude.cmd'))

    // Uppercase spelling: the exclusion is case-insensitive, like Windows.
    const upper = fixture(['claude.CMD', 'claude.PS1'])
    expect(
      findExecutable('claude', { PATH: upper, PATHEXT: '.PS1;.CMD' }, 'win32')
    ).toBe(join(upper, 'claude.CMD'))
  })
})

describe('findExecutable on POSIX', () => {
  it('resolves an executable file without extensions', () => {
    const dir = fixture(['claude'])
    const found = findExecutable('claude', { PATH: dir }, 'linux')
    expect(found).toBe(join(dir, 'claude'))
  })

  it('accepts a zero-byte executable', () => {
    // POSIX has no CreateProcess stub hazard: an empty script with the execute
    // bit is legitimate, so the Windows size guard must not apply here.
    const dir = fixture([], ['claude'])
    expect(findExecutable('claude', { PATH: dir }, 'linux')).toBe(join(dir, 'claude'))
  })

  it('does not invent a Windows extension on POSIX', () => {
    const dir = fixture(['claude.cmd'])
    expect(findExecutable('claude', { PATH: dir, PATHEXT: '.CMD' }, 'linux')).toBeNull()
  })

  it('ignores path separators in the requested name', () => {
    expect(findExecutable('../../etc/passwd', { PATH: '/usr/bin' }, 'linux')).toBeNull()
  })
})
