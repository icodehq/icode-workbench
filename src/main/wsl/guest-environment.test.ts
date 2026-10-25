import { describe, expect, it } from 'vitest'
import type { WslExecOutcome, WslProcessLauncher } from './exec'
import { WslCommandRunner } from './exec'
import {
  GUEST_LOGIN_SCRIPT,
  GUEST_PLATFORM_SCRIPT,
  parseFramedValues,
  parseGuestLoginEnvironment,
  parseGuestPlatform,
  probeGuestEnvironment
} from './guest-environment'

function framed(sentinel: string, body: string): string {
  return `${sentinel}\n${body}\n${sentinel}\n`
}

const PLATFORM_BODY = [
  'os_id=ubuntu',
  'os_version=26.04',
  'arch=x86_64',
  'glibc=2.43',
  'node_path=/home/u/.nvm/versions/node/v24.15.0/bin/node',
  'node_version=v24.15.0',
  'git_path=/usr/bin/git',
  'git_version=git version 2.43.0'
].join('\n')

const LOGIN_BODY = [
  'login_shell=/bin/bash',
  'login_path=/home/u/.nvm/versions/node/v24.15.0/bin:/usr/bin:/bin',
  'login_node_path=/home/u/.nvm/versions/node/v24.15.0/bin/node',
  'login_node_version=v24.15.0',
  'login_git_path=/usr/bin/git',
  'login_git_version=git version 2.43.0'
].join('\n')

function runnerFor(outcomes: WslExecOutcome[]): WslCommandRunner {
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

describe('framed value parsing', () => {
  it('reads only key=value lines between the markers', () => {
    const values = parseFramedValues(framed('__S__', 'a=1\nb=two words'), '__S__')
    expect(values.get('a')).toBe('1')
    expect(values.get('b')).toBe('two words')
  })

  it('discards a banner printed outside the markers', () => {
    const noisy = `Welcome to Ubuntu!\nRun 'snap refresh' for updates.\n${framed('__S__', 'a=1')}`
    expect(parseFramedValues(noisy, '__S__').get('a')).toBe('1')
  })

  it('discards non-key lines inside the markers', () => {
    const body = 'loading profile...\nssh-askpass: no tty\nok=1'
    expect(parseFramedValues(framed('__S__', body), '__S__').get('ok')).toBe('1')
  })

  it('keeps the first value so a re-export cannot overwrite a measurement', () => {
    const values = parseFramedValues(framed('__S__', 'path=/usr/bin\npath=/overridden'), '__S__')
    expect(values.get('path')).toBe('/usr/bin')
  })

  it('returns nothing without markers', () => {
    expect(parseFramedValues('a=1\n', '__S__').size).toBe(0)
  })
})

describe('platform parsing', () => {
  it('reads os, arch, glibc and executables', () => {
    const platform = parseGuestPlatform(framed('__ADE_PLATFORM__', PLATFORM_BODY))
    expect(platform).toEqual({
      osId: 'ubuntu',
      osVersion: '26.04',
      arch: 'x86_64',
      glibc: '2.43',
      node: { path: '/home/u/.nvm/versions/node/v24.15.0/bin/node', version: 'v24.15.0' },
      git: { path: '/usr/bin/git', version: 'git version 2.43.0' }
    })
  })

  it('reports a missing executable as null, never as an empty path', () => {
    const body = 'arch=x86_64\nnode_path=\nnode_version=\ngit_path=/usr/bin/git\ngit_version=git version 2.43.0'
    const platform = parseGuestPlatform(framed('__ADE_PLATFORM__', body))
    expect(platform?.node).toEqual({ path: null, version: null })
  })

  it('survives a distro whose /etc/os-release is absent', () => {
    const platform = parseGuestPlatform(
      framed('__ADE_PLATFORM__', 'os_id=\nos_version=\narch=aarch64\nglibc=')
    )
    expect(platform?.arch).toBe('aarch64')
    expect(platform?.osId).toBeNull()
    expect(platform?.glibc).toBeNull()
  })

  it('returns null when the section is not ours', () => {
    expect(parseGuestPlatform('random output\n')).toBeNull()
  })
})

describe('login environment parsing', () => {
  it('reads the shell, PATH and executables', () => {
    const login = parseGuestLoginEnvironment(framed('__ADE_LOGIN__', LOGIN_BODY))
    expect(login?.shell).toBe('/bin/bash')
    expect(login?.pathVariable).toContain('.nvm')
    expect(login?.node.path).toContain('node')
    expect(login?.git).toEqual({ path: '/usr/bin/git', version: 'git version 2.43.0' })
  })

  it('is not corrupted by profile output preceding the marker', () => {
    const noisy = `motd: 3 updates available\n${framed('__ADE_LOGIN__', LOGIN_BODY)}`
    expect(parseGuestLoginEnvironment(noisy)?.shell).toBe('/bin/bash')
  })

  it('returns null when the login probe produced nothing framed', () => {
    expect(parseGuestLoginEnvironment('')).toBeNull()
  })
})

describe('guest environment probe', () => {
  it('returns platform plus login environment on a healthy distro', async () => {
    const runner = runnerFor([
      { status: 'ok', stdout: framed('__ADE_PLATFORM__', PLATFORM_BODY), stderr: '' },
      { status: 'ok', stdout: framed('__ADE_LOGIN__', LOGIN_BODY), stderr: '' }
    ])
    const read = await probeGuestEnvironment(runner, 'Ubuntu-26.04')
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    expect(read.environment.platform.arch).toBe('x86_64')
    expect(read.environment.login?.shell).toBe('/bin/bash')
  })

  it('still succeeds when the login-shell probe fails', async () => {
    const runner = runnerFor([
      { status: 'ok', stdout: framed('__ADE_PLATFORM__', PLATFORM_BODY), stderr: '' },
      { status: 'timed_out' }
    ])
    const read = await probeGuestEnvironment(runner, 'Ubuntu-26.04')
    expect(read.status).toBe('ok')
    if (read.status === 'ok') expect(read.environment.login).toBeNull()
  })

  it('reports unavailability when the platform probe times out', async () => {
    const read = await probeGuestEnvironment(runnerFor([{ status: 'timed_out' }]), 'Ubuntu-26.04')
    expect(read.status).toBe('unavailable')
    if (read.status === 'unavailable') expect(read.reason).toBe('timed_out')
  })

  it('treats unframed output as a probe failure, not as a distro without Node', async () => {
    const read = await probeGuestEnvironment(
      runnerFor([{ status: 'ok', stdout: 'not our output', stderr: '' }]),
      'Ubuntu-26.04'
    )
    expect(read.status).toBe('unavailable')
  })

  it('uses constant scripts with no interpolated caller data', () => {
    for (const script of [GUEST_PLATFORM_SCRIPT, GUEST_LOGIN_SCRIPT]) {
      expect(script).toContain('__ADE_')
      expect(script).not.toContain('$1')
      expect(script).not.toContain('${DISTRO')
    }
  })
})
