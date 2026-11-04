import { describe, expect, it } from 'vitest'
import type { WslExecOutcome } from './exec'
import { WslCommandRunner, type WslProcessLauncher } from './exec'
import {
  defaultDistroName,
  discoverWslDistros,
  isInternalDistro,
  parseDistroNames,
  parseLxssRegistry,
  readRunningDistros
} from './distros'

/** A registry dump in the shape `reg.exe query … /s` actually prints. */
const REGISTRY_DUMP = [
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss',
  '    NatIpAddress    REG_SZ    172.26.1.225',
  '    OOBEComplete    REG_DWORD    0x1',
  '    DefaultDistribution    REG_SZ    {a5489bf0-2b9e-49bf-940e-0c19a6caef73}',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\Notifications',
  '    DrvFsPerfDisabled    REG_DWORD    0x1',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{3089ca97-7f7b-441f-acca-c7365f2ea72e}',
  '    State    REG_DWORD    0x1',
  '    DistributionName    REG_SZ    docker-desktop',
  '    Version    REG_DWORD    0x2',
  '    BasePath    REG_SZ    \\\\?\\D:\\Deployment\\wsl',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{a5489bf0-2b9e-49bf-940e-0c19a6caef73}',
  '    State    REG_DWORD    0x1',
  '    DistributionName    REG_SZ    Ubuntu-26.04',
  '    Version    REG_DWORD    0x2',
  '    DefaultUid    REG_DWORD    0x0',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{b1c2d3e4-1111-2222-3333-444455556666}',
  '    DistributionName    REG_SZ    Ubuntu 24.04 LTS',
  '    Version    REG_DWORD    0x1',
  ''
].join('\r\n')

function runnerReturning(...outcomes: WslExecOutcome[]): WslCommandRunner {
  const launcher: WslProcessLauncher = async () => {
    const outcome = outcomes.shift() ?? { status: 'ok', stdout: '', stderr: '' }
    if (outcome.status === 'ok') {
      return { code: 0, signal: null, stdout: outcome.stdout, stderr: outcome.stderr, timedOut: false }
    }
    if (outcome.status === 'timed_out') {
      return { code: null, signal: 'SIGTERM', stdout: '', stderr: '', timedOut: true }
    }
    return { code: 1, signal: null, stdout: '', stderr: '', timedOut: false }
  }
  return new WslCommandRunner({ launcher, platform: 'win32' })
}

describe('Lxss registry parsing', () => {
  it('reads registrations, skipping the root key and its values', () => {
    const parsed = parseLxssRegistry(REGISTRY_DUMP)
    expect(parsed.registrations.map((r) => r.name)).toEqual([
      'docker-desktop',
      'Ubuntu-26.04',
      'Ubuntu 24.04 LTS'
    ])
    // The root key's NatIpAddress must not become a distro.
    expect(parsed.registrations.some((r) => r.name.includes('172.26'))).toBe(false)
  })

  it('normalizes the registration id and records the default pointer', () => {
    const parsed = parseLxssRegistry(REGISTRY_DUMP)
    expect(parsed.defaultRegistrationId).toBe('a5489bf0-2b9e-49bf-940e-0c19a6caef73')
    expect(parsed.registrations[1]!.registrationId).toBe('a5489bf0-2b9e-49bf-940e-0c19a6caef73')
  })

  it('keeps a distro name containing spaces intact', () => {
    const parsed = parseLxssRegistry(REGISTRY_DUMP)
    const long = parsed.registrations.find((r) => r.name.startsWith('Ubuntu 24'))
    expect(long?.name).toBe('Ubuntu 24.04 LTS')
  })

  it('reads WSL version from the hex REG_DWORD', () => {
    const parsed = parseLxssRegistry(REGISTRY_DUMP)
    expect(parsed.registrations.find((r) => r.name === 'Ubuntu-26.04')?.version).toBe(2)
    expect(parsed.registrations.find((r) => r.name === 'Ubuntu 24.04 LTS')?.version).toBe(1)
  })

  it('returns nothing for an empty registry rather than fabricating a distro', () => {
    expect(parseLxssRegistry('').registrations).toEqual([])
    expect(parseLxssRegistry('').defaultRegistrationId).toBeNull()
  })

  it('survives a localized footer and unrelated lines', () => {
    const localized = [
      REGISTRY_DUMP,
      '操作成功完成。',
      '错误: 系统找不到指定的注册表项或值。'
    ].join('\r\n')
    expect(parseLxssRegistry(localized).registrations).toHaveLength(3)
  })
})

describe('distro name listing', () => {
  it('strips NUL padding and the default marker', () => {
    const output = '*Ubuntu-26.04\u0000\r\ndocker-desktop\u0000\r\n'
    expect(parseDistroNames(output)).toEqual(['Ubuntu-26.04', 'docker-desktop'])
  })

  it('keeps spaces inside a distro name', () => {
    expect(parseDistroNames('Ubuntu 24.04 LTS\n')).toEqual(['Ubuntu 24.04 LTS'])
  })

  it('ignores blank lines and an empty result', () => {
    expect(parseDistroNames('\r\n\r\n')).toEqual([])
    expect(parseDistroNames('')).toEqual([])
  })
})

describe('discovery', () => {
  it('reports registrations with running state from a names-only probe', async () => {
    const runner = runnerReturning({ status: 'ok', stdout: 'Ubuntu-26.04\n', stderr: '' })
    const discovery = await discoverWslDistros({
      runner,
      platform: 'win32',
      queryRegistry: async () => REGISTRY_DUMP
    })
    expect(discovery.status).toBe('ok')
    if (discovery.status !== 'ok') return
    // Docker Desktop's distro is a real registration but not an iCode target.
    expect(discovery.distros.map((d) => d.name)).toEqual(['Ubuntu 24.04 LTS', 'Ubuntu-26.04'])
    expect(discovery.distros.find((d) => d.name === 'Ubuntu-26.04')?.running).toBe(true)
    expect(discovery.distros.find((d) => d.name === 'Ubuntu 24.04 LTS')?.running).toBe(false)
  })

  it('reports running state as unknown, not stopped, when the probe fails', async () => {
    const runner = runnerReturning({ status: 'timed_out' })
    const discovery = await discoverWslDistros({
      runner,
      platform: 'win32',
      queryRegistry: async () => REGISTRY_DUMP
    })
    if (discovery.status !== 'ok') throw new Error('expected ok')
    for (const distro of discovery.distros) expect(distro.running).toBeNull()
  })

  it('reports an unreadable registry as unavailable rather than an empty list', async () => {
    const discovery = await discoverWslDistros({
      runner: runnerReturning({ status: 'ok', stdout: '', stderr: '' }),
      platform: 'win32',
      queryRegistry: async () => null
    })
    expect(discovery.status).toBe('unavailable')
    if (discovery.status === 'unavailable') expect(discovery.reason).toBe('registry_unreadable')
  })

  it('retries one failed registry read before declaring WSL unavailable', async () => {
    let calls = 0
    const discovery = await discoverWslDistros({
      runner: runnerReturning({ status: 'ok', stdout: '', stderr: '' }),
      platform: 'win32',
      queryRegistry: async () => {
        calls += 1
        return calls === 1 ? null : REGISTRY_DUMP
      }
    })
    // A transient miss must not read as "no WSL on this machine".
    expect(calls).toBe(2)
    expect(discovery.status).toBe('ok')
    if (discovery.status === 'ok') {
      expect(discovery.distros.map((distro) => distro.name)).toContain('Ubuntu-26.04')
    }
  })

  it('gives up after two failed reads', async () => {
    let calls = 0
    const discovery = await discoverWslDistros({
      runner: runnerReturning({ status: 'ok', stdout: '', stderr: '' }),
      platform: 'win32',
      queryRegistry: async () => {
        calls += 1
        return null
      }
    })
    expect(calls).toBe(2)
    expect(discovery.status).toBe('unavailable')
  })

  it('does not retry a decode failure, which is deterministic', async () => {
    let calls = 0
    await discoverWslDistros({
      runner: runnerReturning({ status: 'ok', stdout: '', stderr: '' }),
      platform: 'win32',
      queryRegistry: async () => {
        calls += 1
        return { undecodable: true }
      }
    })
    expect(calls).toBe(1)
  })

  it('reports undecodable names instead of passing on a mangled distro name', async () => {
    const discovery = await discoverWslDistros({
      runner: runnerReturning({ status: 'ok', stdout: '', stderr: '' }),
      platform: 'win32',
      queryRegistry: async () => ({ undecodable: true })
    })
    expect(discovery.status).toBe('unavailable')
    if (discovery.status === 'unavailable') expect(discovery.reason).toBe('undecodable_names')
  })

  it('reports no distros when the registry has no registrations', async () => {
    const discovery = await discoverWslDistros({
      runner: runnerReturning({ status: 'ok', stdout: '', stderr: '' }),
      platform: 'win32',
      queryRegistry: async () => 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\r\n'
    })
    expect(discovery.status).toBe('ok')
    if (discovery.status === 'ok') expect(discovery.distros).toEqual([])
  })

  it('is unavailable off Windows', async () => {
    const discovery = await discoverWslDistros({
      runner: runnerReturning({ status: 'ok', stdout: '', stderr: '' }),
      platform: 'linux',
      queryRegistry: async () => REGISTRY_DUMP
    })
    expect(discovery.status).toBe('unavailable')
    if (discovery.status === 'unavailable') expect(discovery.reason).toBe('not_windows')
  })

  it('resolves the default distro through its GUID, not by list order', async () => {
    const runner = runnerReturning({ status: 'ok', stdout: '', stderr: '' })
    const discovery = await discoverWslDistros({
      runner,
      platform: 'win32',
      queryRegistry: async () => REGISTRY_DUMP
    })
    if (discovery.status !== 'ok') throw new Error('expected ok')
    expect(defaultDistroName(discovery)).toBe('Ubuntu-26.04')
  })

  it('returns null when the running probe exits non-zero', async () => {
    const runner = runnerReturning({ status: 'exit_failure', code: 1, signal: null, stdout: '', stderr: '' })
    expect(await readRunningDistros(runner)).toBeNull()
  })

  it('asks for the quiet form, because the headed form is localized', async () => {
    // Measured: without --quiet the running list starts with
    // `适用于 Linux 的 Windows 子系统发行版:`, which would parse as a distro name.
    const seen: string[][] = []
    const launcher: WslProcessLauncher = async (spec) => {
      seen.push([...spec.args])
      return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
    }
    await readRunningDistros(new WslCommandRunner({ launcher, platform: 'win32' }))
    expect(seen[0]).toEqual(['--list', '--running', '--quiet'])
  })

  it('cannot adopt a header line as a distro, since only registrations are reported', async () => {
    const runner = runnerReturning({
      status: 'ok',
      stdout: '适用于 Linux 的 Windows 子系统发行版:\nUbuntu-26.04\n',
      stderr: ''
    })
    const discovery = await discoverWslDistros({
      runner,
      platform: 'win32',
      queryRegistry: async () => REGISTRY_DUMP
    })
    if (discovery.status !== 'ok') throw new Error('expected ok')
    expect(discovery.distros.map((d) => d.name)).toEqual(['Ubuntu 24.04 LTS', 'Ubuntu-26.04'])
  })

  it('strips a UTF-16 BOM if it survives decoding', () => {
    expect(parseDistroNames('\uFEFFUbuntu-26.04\r\n')).toEqual(['Ubuntu-26.04'])
  })

  it('recognises Docker Desktop distros as internal', () => {
    expect(isInternalDistro('docker-desktop')).toBe(true)
    expect(isInternalDistro('Docker-Desktop-Data')).toBe(true)
    expect(isInternalDistro('Ubuntu-26.04')).toBe(false)
  })
})
