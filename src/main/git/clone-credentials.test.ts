import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WslCommandRunner } from '../wsl/exec'
import {
  createGuestCredentialBundle,
  createLocalCredentialBundle,
  helperGitOptions,
  matchingInsteadOfPrefix
} from './clone-credentials'

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'icode-clone-credentials-'))
}

async function prepare(url = 'https://gitee.com/owner/repo.git') {
  const root = makeRoot()
  const bundle = await createLocalCredentialBundle({
    root,
    url,
    username: 'alice',
    password: Buffer.from('secret-token')
  })
  const [directory] = readdirSync(root)
  if (directory === undefined) throw new Error('bundle directory was not created')
  const helper = join(root, directory, 'helper.sh')
  return { root, directory: join(root, directory), helper, bundle }
}

describe('clone credential helper', () => {
  it('answers only the bound protocol, host and path', async () => {
    const { helper, bundle } = await prepare()
    try {
      if (process.platform === 'win32') return
      const answer = (input: string): string =>
        execFileSync('sh', [helper, 'get'], { input, encoding: 'utf8' })
      expect(
        answer('protocol=https\nhost=gitee.com\npath=owner/repo.git\n\n')
      ).toBe('username=alice\npassword=secret-token\n')
      expect(answer('protocol=https\nhost=evil.example\npath=owner/repo.git\n\n')).toBe('')
      expect(answer('protocol=https\nhost=gitee.com\npath=other/repo.git\n\n')).toBe('')
      expect(answer('protocol=http\nhost=gitee.com\npath=owner/repo.git\n\n')).toBe('')
      expect(execFileSync('sh', [helper, 'store'], { input: '', encoding: 'utf8' })).toBe('')
    } finally {
      await bundle.dispose()
    }
  })

  it('is accepted by the real Git credential-helper protocol', async () => {
    if (process.platform === 'win32') return
    const { bundle } = await prepare()
    try {
      const env = {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '',
        SSH_ASKPASS: ''
      }
      const args = [...bundle.gitOptions, 'credential', 'fill']
      const output = execFileSync('git', args, {
        input: 'protocol=https\nhost=gitee.com\npath=owner/repo.git\n\n',
        encoding: 'utf8',
        env
      })
      expect(output).toContain('username=alice')
      expect(output).toContain('password=secret-token')
      expect(() =>
        execFileSync('git', args, {
          input: 'protocol=https\nhost=evil.example\npath=owner/repo.git\n\n',
          encoding: 'utf8',
          env,
          stdio: 'pipe'
        })
      ).toThrow()
    } finally {
      await bundle.dispose()
    }
  })

  it('writes private files and removes them on dispose', async () => {
    const { root, directory, bundle } = await prepare()
    if (process.platform !== 'win32') {
      expect(statSync(directory).mode & 0o777).toBe(0o700)
      expect(statSync(join(directory, 'secret')).mode & 0o777).toBe(0o600)
    }
    expect(readFileSync(join(directory, 'secret'), 'utf8')).toBe('alice\nsecret-token\n')
    await bundle.dispose()
    expect(readdirSync(root)).toEqual([])
    await bundle.dispose()
  })

  it('rejects a URL that is not clean HTTPS', async () => {
    await expect(
      createLocalCredentialBundle({
        root: makeRoot(),
        url: 'http://gitee.com/owner/repo.git',
        username: 'alice',
        password: Buffer.from('token')
      })
    ).rejects.toMatchObject({
      appError: { code: 'INVALID_ARGUMENT', messageKey: 'addRepo.clone.auth.httpsOnly' }
    })
    await expect(
      createLocalCredentialBundle({
        root: makeRoot(),
        url: 'https://user:token@gitee.com/owner/repo.git',
        username: 'alice',
        password: Buffer.from('token')
      })
    ).rejects.toMatchObject({
      appError: { code: 'INVALID_ARGUMENT', messageKey: 'addRepo.clone.auth.httpsOnly' }
    })
  })

  it('rejects a line break in a credential', async () => {
    await expect(
      createLocalCredentialBundle({
        root: makeRoot(),
        url: 'https://gitee.com/owner/repo.git',
        username: 'alice',
        password: Buffer.from('token\ninjected')
      })
    ).rejects.toMatchObject({
      appError: { code: 'INVALID_ARGUMENT', messageKey: 'addRepo.clone.auth.invalidCredential' }
    })
  })
})

describe('guest credential bundle', () => {
  type GuestCall = {
    argv: readonly string[]
    stdin?: Buffer | string
  }

  function guestRunner(failLabel?: string): {
    runner: WslCommandRunner
    calls: GuestCall[]
  } {
    const calls: GuestCall[] = []
    const runner = {
      run: async (request: GuestCall & { label?: string }) => {
        calls.push({ argv: request.argv, ...(request.stdin === undefined ? {} : { stdin: request.stdin }) })
        if (failLabel !== undefined && request.label === failLabel) {
          return { status: 'exit_failure', code: 1, stdout: '', stderr: '' }
        }
        return { status: 'ok', stdout: '', stderr: '' }
      }
    } as unknown as WslCommandRunner
    return { runner, calls }
  }

  it('writes helper, binding and secret through stdin before the sweep', async () => {
    const { runner, calls } = guestRunner()
    const bundle = await createGuestCredentialBundle({
      runner,
      distro: 'Ubuntu',
      home: '/home/u',
      requestId: 'req-1',
      url: 'https://gitee.com/owner/repo.git',
      username: 'alice',
      password: Buffer.from('secret-token')
    })
    expect(calls).toHaveLength(5)
    expect(calls[0]!.argv[2]).toContain('mkdir')
    const directoryArg = calls[0]!.argv[4] ?? ''
    expect(directoryArg).toMatch(/^\/home\/u\/\.icode\/clone-auth\/req-1-/u)
    expect(String(calls[1]!.stdin)).toContain('#!/bin/sh')
    expect(String(calls[2]!.stdin)).toBe(
      'https\ngitee.com\nowner/repo.git\nowner/repo.git\n'
    )
    expect(String(calls[3]!.stdin)).toBe('alice\nsecret-token\n')
    expect(calls[4]!.argv[2]).toContain('find')
    expect(bundle.gitOptions[3]).toBe(
      `credential.helper=!'/bin/sh' '${directoryArg}/helper.sh'`
    )

    await bundle.dispose()
    expect(calls.at(-1)!.argv[2]).toBe('rm -rf -- "$1"')
    expect(calls.at(-1)!.argv[4]).toBe(directoryArg)
  })

  it('removes a partial directory when a write fails', async () => {
    const { runner, calls } = guestRunner('clone-auth-secret')
    await expect(
      createGuestCredentialBundle({
        runner,
        distro: 'Ubuntu',
        home: '/home/u',
        requestId: 'req-2',
        url: 'https://gitee.com/owner/repo.git',
        username: 'alice',
        password: Buffer.from('secret-token')
      })
    ).rejects.toMatchObject({ appError: { code: 'INTERNAL' } })
    expect(calls.at(-1)!.argv[2]).toBe('rm -rf -- "$1"')
  })
})

describe('helperGitOptions', () => {
  it('resets inherited helpers before mounting the one-off helper', () => {
    expect(helperGitOptions('/bin/sh', '/tmp/attempt/helper.sh', 'linux')).toEqual([
      '-c',
      'credential.helper=',
      '-c',
      "credential.helper=!'/bin/sh' '/tmp/attempt/helper.sh'",
      '-c',
      'credential.useHttpPath=true'
    ])
  })

  it('uses forward slashes and POSIX quoting on Windows', () => {
    expect(
      helperGitOptions(
        'C:\\Program Files\\Git\\bin\\sh.exe',
        'C:\\Users\\u\\clone-auth\\attempt\\helper.sh',
        'win32'
      )[3]
    ).toBe(
      "credential.helper=!'C:/Program Files/Git/bin/sh.exe' 'C:/Users/u/clone-auth/attempt/helper.sh'"
    )
  })
})

describe('matchingInsteadOfPrefix', () => {
  it('finds a rewrite that applies to the URL', () => {
    const config = [
      'url.git@gitee.com:.insteadof https://gitee.com/',
      'url.ssh://git@example.com/.insteadof https://example.com/'
    ].join('\n')
    expect(matchingInsteadOfPrefix('https://gitee.com/owner/repo.git', config)).toBe(
      'https://gitee.com/'
    )
    expect(matchingInsteadOfPrefix('https://unrelated.com/owner/repo.git', config)).toBeNull()
  })

  it('ignores unrelated configuration and malformed lines', () => {
    expect(matchingInsteadOfPrefix('https://gitee.com/o/r', 'core.editor vim')).toBeNull()
    expect(matchingInsteadOfPrefix('https://gitee.com/o/r', 'url..insteadof')).toBeNull()
  })
})
