import { describe, expect, it } from 'vitest'
import type { GitWorktreeService } from '../worktrees/git-worktree-service'
import { ClonePersistenceService } from './clone-persistence'

const local = { kind: 'local' as const }

type GitCall = { args: string[]; input?: Buffer | string }

function service(options: {
  scoped?: string
  all?: string
  resultCode?: number
  inputCode?: number
} = {}): {
  persistence: ClonePersistenceService
  gitCalls: GitCall[]
  inputCalls: GitCall[]
} {
  const gitCalls: GitCall[] = []
  const inputCalls: GitCall[] = []
  const gitWorktrees = {
    gitResultFor: async () =>
      async (_cwd: string, args: string[]) => {
        gitCalls.push({ args })
        if (args.includes('--get-urlmatch')) {
          return {
            stdout: Buffer.from(options.scoped ?? ''),
            stderr: Buffer.alloc(0),
            exitCode: options.resultCode ?? (options.scoped ? 0 : 1),
            timedOut: false
          }
        }
        if (args.includes('--get-all')) {
          return {
            stdout: Buffer.from(options.all ?? ''),
            stderr: Buffer.alloc(0),
            exitCode: options.resultCode ?? (options.all ? 0 : 1),
            timedOut: false
          }
        }
        return {
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          exitCode: options.resultCode ?? 0,
          timedOut: false
        }
      },
    gitInputFor: async () =>
      async (_cwd: string, args: string[], input: Buffer | string) => {
        inputCalls.push({ args, input })
        return { stdout: '', stderr: '', exitCode: options.inputCode ?? 0, timedOut: false }
      }
  } as unknown as Pick<GitWorktreeService, 'gitResultFor' | 'gitInputFor'>
  return { persistence: new ClonePersistenceService({ gitWorktrees }), gitCalls, inputCalls }
}

const url = 'https://gitee.com/owner/repo.git'

describe('ClonePersistenceService', () => {
  it('detects a URL-scoped or global helper', async () => {
    const scoped = service({ scoped: 'manager' })
    expect(await scoped.persistence.hasHelper(local, '/projects', url)).toBe(true)
    const global = service({ all: 'store' })
    expect(await global.persistence.hasHelper(local, '/projects', url)).toBe(true)
    const none = service()
    expect(await none.persistence.hasHelper(local, '/projects', url)).toBe(false)
  })

  it('approves with the original helper list and a line-oriented payload', async () => {
    const { persistence, inputCalls } = service()
    await persistence.approve(
      local,
      '/projects',
      url,
      'alice',
      Buffer.from('secret-token')
    )
    expect(inputCalls).toHaveLength(1)
    expect(inputCalls[0]!.args).toEqual([
      '-c',
      'credential.useHttpPath=true',
      'credential',
      'approve'
    ])
    const payload = Buffer.from(inputCalls[0]!.input!)
    expect(payload.toString('utf8')).toBe(
      'protocol=https\nhost=gitee.com\npath=owner/repo.git\nusername=alice\npassword=secret-token\n\n'
    )
    expect(inputCalls[0]!.args).not.toContain('credential.helper=')
  })

  it('configures store only on the explicit path, then approves through it', async () => {
    const { persistence, gitCalls, inputCalls } = service()
    await persistence.store(local, '/projects', url, 'alice', Buffer.from('secret-token'))
    expect(gitCalls[0]!.args).toEqual([
      'config',
      '--global',
      '--add',
      'credential.helper',
      'store'
    ])
    expect(inputCalls[0]!.args).toEqual([
      '-c',
      'credential.helper=',
      '-c',
      'credential.helper=store',
      '-c',
      'credential.useHttpPath=true',
      'credential',
      'approve'
    ])
  })

  it('switches origin only when the SSH URL keeps the host', async () => {
    const { persistence, gitCalls } = service()
    await persistence.switchRemoteToSsh(
      local,
      '/projects',
      url,
      'git@gitee.com:owner/repo.git'
    )
    expect(gitCalls[0]!.args).toEqual([
      'remote',
      'set-url',
      'origin',
      'git@gitee.com:owner/repo.git'
    ])
    await expect(
      persistence.switchRemoteToSsh(
        local,
        '/projects',
        url,
        'git@evil.example:owner/repo.git'
      )
    ).rejects.toMatchObject({ appError: { code: 'INVALID_ARGUMENT' } })
  })

  it('returns an app error instead of Git stderr when the helper fails', async () => {
    const { persistence } = service({ inputCode: 1 })
    await expect(
      persistence.approve(local, '/projects', url, 'alice', Buffer.from('token'))
    ).rejects.toMatchObject({ appError: { code: 'GIT_REMOTE_FAILED' } })
  })
})
