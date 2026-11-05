import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyLoginEnvironment,
  parseLoginEnvironment,
  resetLoginEnvironmentForTest,
  resolveLoginEnvironment
} from './login-environment'

const START = '__ICODE_LOGIN_ENV_START__'
const END = '__ICODE_LOGIN_ENV_END__'

function framed(lines: string[], noise = ''): string {
  return `${noise}${noise.length > 0 ? '\n' : ''}${START}\n${lines.join('\n')}\n${END}\n`
}

function probe(lines: string[], noise?: string) {
  const run = vi.fn(async () => ({ stdout: framed(lines, noise), exitCode: 0 }))
  return run
}

beforeEach(() => {
  resetLoginEnvironmentForTest()
})

describe('parseLoginEnvironment', () => {
  it('reads PATH and LANG between the sentinels and ignores shell noise', () => {
    const output = framed(
      ['PATH=/opt/homebrew/bin:/usr/bin:/bin', 'LANG=en_US.UTF-8', 'LC_ALL='],
      'Last login: today\nnvm loaded'
    )
    expect(parseLoginEnvironment(output)).toEqual({
      path: '/opt/homebrew/bin:/usr/bin:/bin',
      lang: 'en_US.UTF-8'
    })
  })

  it('prefers LC_ALL over LANG and tolerates CRLF', () => {
    const output = `${START}\r\nPATH=/usr/bin\r\nLANG=C\r\nLC_ALL=de_DE.UTF-8\r\n${END}\r\n`
    expect(parseLoginEnvironment(output)).toEqual({
      path: '/usr/bin',
      lang: 'de_DE.UTF-8'
    })
  })

  it('returns no values when the probe never completed', () => {
    expect(parseLoginEnvironment('PATH=/usr/bin\nLANG=C.UTF-8')).toEqual({
      path: null,
      lang: null
    })
    expect(parseLoginEnvironment(`${END}\nPATH=/usr/bin\n${START}`)).toEqual({
      path: null,
      lang: null
    })
  })

  it('does not accept an empty PATH', () => {
    expect(parseLoginEnvironment(framed(['PATH=', 'LANG=C.UTF-8']))).toEqual({
      path: null,
      lang: 'C.UTF-8'
    })
  })
})

describe('resolveLoginEnvironment', () => {
  it('is a no-op on Windows', async () => {
    const run = vi.fn()
    await expect(
      resolveLoginEnvironment({
        platform: 'win32',
        env: {},
        accountShell: null,
        run
      })
    ).resolves.toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  it('prefers $SHELL, then the account shell, then the platform default', async () => {
    const run = probe(['PATH=/usr/bin', 'LANG=C.UTF-8'])
    await resolveLoginEnvironment({
      platform: 'darwin',
      env: { SHELL: '/opt/homebrew/bin/fish' },
      accountShell: '/bin/bash',
      run
    })
    expect(run).toHaveBeenCalledWith(
      '/opt/homebrew/bin/fish',
      ['-ilc', expect.stringContaining(START)],
      3000
    )

    run.mockClear()
    await resolveLoginEnvironment({
      platform: 'darwin',
      env: {},
      accountShell: '/bin/bash',
      run
    })
    expect(run).toHaveBeenCalledWith('/bin/bash', ['-ilc', expect.any(String)], 3000)

    run.mockClear()
    await resolveLoginEnvironment({
      platform: 'darwin',
      env: {},
      accountShell: null,
      run
    })
    expect(run).toHaveBeenCalledWith('/bin/zsh', ['-ilc', expect.any(String)], 3000)

    run.mockClear()
    await resolveLoginEnvironment({
      platform: 'linux',
      env: {},
      accountShell: null,
      run
    })
    expect(run).toHaveBeenCalledWith('/bin/bash', ['-ilc', expect.any(String)], 3000)
  })

  it('imports a UTF-8 locale and falls back when the login shell has none', async () => {
    await expect(
      resolveLoginEnvironment({
        platform: 'darwin',
        env: {},
        accountShell: '/bin/zsh',
        run: probe(['PATH=/usr/bin', 'LANG=en_US.UTF-8'])
      })
    ).resolves.toEqual({
      shell: '/bin/zsh',
      path: '/usr/bin',
      lang: 'en_US.UTF-8'
    })

    await expect(
      resolveLoginEnvironment({
        platform: 'darwin',
        env: {},
        accountShell: '/bin/zsh',
        run: probe(['PATH=/usr/bin', 'LANG=C'])
      })
    ).resolves.toMatchObject({ lang: 'en_US.UTF-8' })

    await expect(
      resolveLoginEnvironment({
        platform: 'linux',
        env: {},
        accountShell: '/bin/bash',
        run: probe(['PATH=/usr/bin'])
      })
    ).resolves.toMatchObject({ lang: 'C.UTF-8' })
  })

  it('leaves the environment alone when the login shell fails', async () => {
    const env = { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' }
    const resolved = await resolveLoginEnvironment({
      platform: 'darwin',
      env,
      accountShell: null,
      run: vi.fn(async () => {
        throw new Error('rc file exited non-zero')
      })
    })
    expect(resolved).toBeNull()
    expect(env).toEqual({ SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' })
  })
})

describe('applyLoginEnvironment', () => {
  it('applies PATH, LANG and SHELL without touching unrelated variables', async () => {
    const env = { FOO: 'bar', PATH: '/usr/bin:/bin', LANG: 'C' }
    const resolved = await applyLoginEnvironment({
      platform: 'darwin',
      env,
      accountShell: null,
      run: probe(['PATH=/opt/homebrew/bin:/usr/bin', 'LANG=en_US.UTF-8'])
    })
    expect(resolved).toMatchObject({ shell: '/bin/zsh' })
    expect(env).toEqual({
      FOO: 'bar',
      PATH: '/opt/homebrew/bin:/usr/bin',
      SHELL: '/bin/zsh',
      LANG: 'en_US.UTF-8'
    })
  })

  it('does not let an inherited non-UTF8 LC_ALL override the login locale', async () => {
    const env = { LANG: 'C', LC_ALL: 'C' }
    await applyLoginEnvironment({
      platform: 'darwin',
      env,
      accountShell: null,
      run: probe(['PATH=/usr/bin', 'LANG=en_US.UTF-8'])
    })
    expect(env.LANG).toBe('en_US.UTF-8')
    expect(env.LC_ALL).toBe('en_US.UTF-8')
  })

  it('resolves once for the process lifetime', async () => {
    const env = { PATH: '/usr/bin' }
    const first = probe(['PATH=/first/bin', 'LANG=en_US.UTF-8'])
    await applyLoginEnvironment({
      platform: 'linux',
      env,
      accountShell: '/bin/bash',
      run: first
    })
    const second = vi.fn()
    await applyLoginEnvironment({
      platform: 'linux',
      env,
      accountShell: '/bin/bash',
      run: second
    })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    expect(env.PATH).toBe('/first/bin')
  })

  it('also caches a failed probe', async () => {
    const run = vi.fn(async () => {
      throw new Error('no shell')
    })
    await expect(
      applyLoginEnvironment({ platform: 'darwin', env: {}, accountShell: null, run })
    ).resolves.toBeNull()
    await applyLoginEnvironment({ platform: 'darwin', env: {}, accountShell: null, run })
    expect(run).toHaveBeenCalledTimes(1)
  })
})
