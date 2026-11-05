import { describe, expect, it } from 'vitest'
import {
  WINDOWS_SHELL_CANDIDATES,
  chooseShellCommand,
  fallbackShellCommand,
  resolvedShellCommand
} from './default-shell'

/** Resolution table: only the names listed exist. */
function resolver(available: Record<string, string>) {
  return (name: string): string | null => available[name] ?? null
}

const WINDOWS: Record<string, string> = {
  'pwsh.exe': 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  'powershell.exe': 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'cmd.exe': 'C:\\Windows\\System32\\cmd.exe'
}

describe('shell selection on POSIX', () => {
  it('uses SHELL when set', () => {
    const choice = chooseShellCommand({
      platform: 'linux',
      env: { SHELL: '/usr/bin/zsh' },
      resolve: resolver({ '/usr/bin/zsh': '/usr/bin/zsh' })
    })
    expect(choice).toEqual({ kind: 'command', command: '/usr/bin/zsh' })
  })

  it('keeps the historic /bin/bash default when SHELL is unset', () => {
    const choice = chooseShellCommand({
      platform: 'linux',
      env: {},
      resolve: resolver({})
    })
    expect(choice).toEqual({ kind: 'command', command: '/bin/bash' })
  })

  it('uses the platform shell on macOS when SHELL is unset', () => {
    const choice = chooseShellCommand({
      platform: 'darwin',
      env: {},
      resolve: resolver({})
    })
    expect(choice).toEqual({ kind: 'command', command: '/bin/zsh' })
  })

  it('passes an unresolvable SHELL through so the probe reports it', () => {
    // Behaviour must not change on Linux: the version probe produces the
    // evidence (ENOENT), rather than this function guessing.
    const choice = chooseShellCommand({
      platform: 'darwin',
      env: { SHELL: '/opt/missing/bash' },
      resolve: resolver({})
    })
    expect(choice).toEqual({ kind: 'command', command: '/opt/missing/bash' })
  })

  it('never selects a Windows candidate on POSIX', () => {
    const choice = chooseShellCommand({
      platform: 'linux',
      env: { SHELL: '' },
      resolve: resolver(WINDOWS)
    })
    expect(choice).toEqual({ kind: 'command', command: '/bin/bash' })
  })
})

describe('shell selection on Windows', () => {
  it('prefers an explicit SHELL over discovery', () => {
    const choice = chooseShellCommand({
      platform: 'win32',
      env: { SHELL: 'C:\\Program Files\\Git\\bin\\bash.exe' },
      resolve: resolver({
        ...WINDOWS,
        'C:\\Program Files\\Git\\bin\\bash.exe': 'C:\\Program Files\\Git\\bin\\bash.exe'
      })
    })
    expect(choice).toEqual({
      kind: 'command',
      command: 'C:\\Program Files\\Git\\bin\\bash.exe'
    })
  })

  it('never uses /bin/bash as the default', () => {
    const choice = chooseShellCommand({
      platform: 'win32',
      env: {},
      resolve: resolver(WINDOWS)
    })
    expect(choice.kind).toBe('command')
    if (choice.kind === 'command') {
      expect(choice.command).not.toBe('/bin/bash')
      expect(choice.command).toContain('pwsh.exe')
    }
  })

  it('falls back from PowerShell 7 to Windows PowerShell to cmd', () => {
    const withoutPwsh = chooseShellCommand({
      platform: 'win32',
      env: {},
      resolve: resolver({
        'powershell.exe': 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        'cmd.exe': 'C:\\Windows\\System32\\cmd.exe'
      })
    })
    expect(withoutPwsh).toEqual({ kind: 'command', command: WINDOWS['powershell.exe'] })

    const onlyCmd = chooseShellCommand({
      platform: 'win32',
      env: {},
      resolve: resolver({ 'cmd.exe': 'C:\\Windows\\System32\\cmd.exe' })
    })
    expect(onlyCmd).toEqual({ kind: 'command', command: WINDOWS['cmd.exe'] })
  })

  it('reports an unresolvable configured SHELL with an actionable message', () => {
    const choice = chooseShellCommand({
      platform: 'win32',
      env: { SHELL: 'C:\\stale\\bash.exe' },
      resolve: resolver(WINDOWS)
    })
    expect(choice.kind).toBe('unavailable')
    if (choice.kind === 'unavailable') {
      expect(choice.message).toContain('C:\\stale\\bash.exe')
      expect(choice.message).toContain('SHELL')
    }
  })

  it('reports every candidate when nothing resolves', () => {
    const choice = chooseShellCommand({
      platform: 'win32',
      env: {},
      resolve: resolver({})
    })
    expect(choice.kind).toBe('unavailable')
    if (choice.kind === 'unavailable') {
      for (const candidate of WINDOWS_SHELL_CANDIDATES) {
        expect(choice.message).toContain(candidate)
      }
    }
  })

  it('accepts COMSPEC when it is the only thing available', () => {
    const choice = chooseShellCommand({
      platform: 'win32',
      env: { COMSPEC: 'C:\\Windows\\System32\\cmd.exe' },
      resolve: resolver({ 'C:\\Windows\\System32\\cmd.exe': 'C:\\Windows\\System32\\cmd.exe' })
    })
    expect(choice).toEqual({ kind: 'command', command: 'C:\\Windows\\System32\\cmd.exe' })
  })
})

describe('string helper', () => {
  it('returns a usable placeholder even when no shell resolves', () => {
    expect(
      resolvedShellCommand({ platform: 'win32', env: {}, resolve: resolver({}) })
    ).toBe('cmd.exe')
    expect(
      resolvedShellCommand({ platform: 'linux', env: {}, resolve: resolver({}) })
    ).toBe('/bin/bash')
    expect(
      resolvedShellCommand({ platform: 'darwin', env: {}, resolve: resolver({}) })
    ).toBe('/bin/zsh')
    expect(fallbackShellCommand('win32')).toBe('cmd.exe')
    expect(fallbackShellCommand('linux')).toBe('/bin/bash')
    expect(fallbackShellCommand('darwin')).toBe('/bin/zsh')
  })
})
