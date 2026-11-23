import { describe, expect, it } from 'vitest'
import type { ExecutionTarget } from '../../shared/domain/repository'
import type { WslCommandRunner } from '../wsl/exec'
import type { GitWorktreeService } from '../worktrees/git-worktree-service'
import { CloneSshService } from './clone-ssh'

const wsl: ExecutionTarget = { kind: 'wsl', distro: 'Ubuntu', distroId: 'distro-1' }

function statusBuffer(options: {
  ssh?: string
  keygen?: string
  keyscan?: string
  agent?: boolean
  count?: number
  exists?: boolean
  key?: boolean
} = {}): Buffer {
  const home = '/home/u'
  const header = [
    home,
    '/run/user/1000/openssh_agent',
    options.ssh ?? '/usr/bin/ssh',
    options.keygen ?? '/usr/bin/ssh-keygen',
    options.keyscan ?? '/usr/bin/ssh-keyscan',
    '/usr/bin/ssh-add',
    options.agent === false ? '0' : '1',
    String(options.count ?? 2),
    options.exists ? '1' : '0'
  ].join('\u0000')
  const key =
    options.key === false
      ? ''
      : '\u0000KEY\u0000/home/u/.ssh/id_ed25519.pub\u0000256 SHA256:abc123 comment (ED25519)\u0000ssh-ed25519 AAAA'
  return Buffer.from(header + key)
}

function setup(options: {
  status?: Buffer
  git?: {
    stdout?: string
    stderr?: string
    exitCode: number | null
    timedOut?: boolean
  }
  scan?: Buffer
  pub?: string
}): {
  service: CloneSshService
  runCalls: Array<{ label?: string; argv: readonly string[]; stdin?: Buffer | string }>
  gitCalls: string[][]
} {
  const runCalls: Array<{ label?: string; argv: readonly string[]; stdin?: Buffer | string }> = []
  const gitCalls: string[][] = []
  const runner = {
    runBytes: async (request: { label?: string }) => ({
      code: 0,
      signal: null,
      stdout:
        request.label === 'clone-ssh-keyscan'
          ? (options.scan ?? Buffer.alloc(0))
          : (options.status ?? statusBuffer()),
      stderr: Buffer.alloc(0),
      timedOut: false
    }),
    run: async (request: {
      label?: string
      argv: readonly string[]
      stdin?: Buffer | string
    }) => {
      runCalls.push(request)
      if (request.label === 'clone-ssh-public-key') {
        return { status: 'ok', stdout: options.pub ?? 'ssh-ed25519 AAAA', stderr: '' }
      }
      return { status: 'ok', stdout: '', stderr: '' }
    }
  } as unknown as WslCommandRunner
  const gitWorktrees = {
    gitResultFor: async () =>
      async (_cwd: string, args: string[]) => {
        gitCalls.push(args)
        return {
          stdout: Buffer.from(options.git?.stdout ?? ''),
          stderr: Buffer.from(options.git?.stderr ?? ''),
          exitCode: options.git?.exitCode ?? 0,
          timedOut: options.git?.timedOut ?? false
        }
      }
  } as unknown as Pick<GitWorktreeService, 'gitResultFor'>
  return { service: new CloneSshService({ gitWorktrees, runner }), runCalls, gitCalls }
}

describe('CloneSshService', () => {
  it('reads keys, agent state and the default path from the distro', async () => {
    const { service } = setup({})
    const status = await service.status(wsl)
    expect(status).toMatchObject({
      sshAvailable: true,
      agentAvailable: true,
      agentIdentities: 2,
      home: '/home/u',
      defaultKeyPath: '/home/u/.ssh/id_ed25519',
      defaultKeyExists: false,
      sshPath: '/usr/bin/ssh'
    })
    expect(status.keys).toEqual([
      {
        path: '/home/u/.ssh/id_ed25519.pub',
        type: 'ED25519',
        fingerprint: 'SHA256:abc123',
        publicKey: 'ssh-ed25519 AAAA'
      }
    ])
  })

  it('requires consent and never asks ssh-keygen to overwrite', async () => {
    const { service, runCalls } = setup({})
    await expect(
      service.generate(wsl, true)
    ).resolves.toMatchObject({
      status: 'created',
      keyPath: '/home/u/.ssh/id_ed25519',
      publicKey: 'ssh-ed25519 AAAA'
    })
    const keygen = runCalls.find((call) => call.label === 'clone-ssh-keygen')
    expect(keygen?.argv.join(' ')).toContain('-N ""')
    expect(keygen?.argv.join(' ')).not.toContain('-y')
  })

  it('tests access in BatchMode and classifies a publickey failure', async () => {
    const ok = setup({})
    await expect(
      ok.service.test(wsl, 'git@gitee.com:owner/repo.git')
    ).resolves.toEqual({ status: 'ok' })
    expect(ok.gitCalls[0]!.join(' ')).toContain('core.sshCommand=')
    expect(ok.gitCalls[0]!.join(' ')).toContain('BatchMode=yes')

    const denied = setup({
      git: {
        exitCode: 128,
        stderr: 'git@gitee.com: Permission denied (publickey).'
      }
    })
    await expect(denied.service.test(wsl, 'git@gitee.com:owner/repo.git')).resolves.toMatchObject(
      { status: 'auth_failed', reason: 'publickey' }
    )
  })

  it('offers host-key fingerprints and trusts only a confirmed fresh scan', async () => {
    const scan = Buffer.from(
      '256 SHA256:abc123 comment (ED25519)\u0000gitee.com ssh-ed25519 AAAA\u0000'
    )
    const unknown = setup({
      git: { exitCode: 128, stderr: 'Host key verification failed.' },
      scan
    })
    const result = await unknown.service.test(wsl, 'git@gitee.com:owner/repo.git')
    expect(result).toMatchObject({
      status: 'host_key_unknown',
      host: 'gitee.com',
      port: 22,
      fingerprints: [{ type: 'ED25519', fingerprint: 'SHA256:abc123' }]
    })

    const trust = setup({ scan })
    await expect(
      trust.service.trustHost(wsl, 'gitee.com', 22, ['SHA256:def456'])
    ).rejects.toMatchObject({ appError: { code: 'INVALID_ARGUMENT' } })

    await expect(
      trust.service.trustHost(wsl, 'gitee.com', 22, ['SHA256:abc123'])
    ).resolves.toEqual({ status: 'trusted' })
    const knownHosts = trust.runCalls.find((call) => call.label === 'clone-ssh-known-hosts')
    expect(String(knownHosts?.stdin)).toBe('gitee.com ssh-ed25519 AAAA\n')
  })
})
