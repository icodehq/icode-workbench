import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteService, RemoteServiceError, isValidRemoteName } from './remote-service'
import { createLocalGitExecutor } from './executor'
import { newRepoId } from '../../shared/domain/ids'
import type { RepositoryRecord } from '../../shared/domain/repository'
import type { GuestGitResult } from '../wsl/git/guest-git'

const repoId = newRepoId()
const repository: RepositoryRecord = {
  id: repoId,
  path: '/srv/atlas' as RepositoryRecord['path'],
  displayName: 'atlas',
  addedAt: 1,
  lastOpenedAt: 1,
  currentBranch: 'main',
  availability: 'present',
  gitCommonDir: '/srv/atlas/.git',
  executionTarget: { kind: 'local' },
  preparation: null
}

function result(stdout = '', exitCode = 0, stderr = ''): GuestGitResult {
  return {
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    exitCode,
    timedOut: false
  }
}

function setup(options: {
  remoteOutput?: string
  checkRef?: GuestGitResult
  mutate?: (args: string[]) => GuestGitResult
  fetch?: GuestGitResult
} = {}) {
  const calls: string[][] = []
  const run = async (_cwd: string, args: string[]): Promise<GuestGitResult> => {
    calls.push(args)
    if (args[0] === 'remote' && args[1] === '-v') {
      return result(options.remoteOutput ?? '')
    }
    if (args[0] === 'check-ref-format') return options.checkRef ?? result()
    if (args[0] === 'fetch') return options.fetch ?? result()
    return options.mutate?.(args) ?? result()
  }
  const locks: string[] = []
  const text = async (cwd: string, args: string[]): Promise<string> => {
    const out = await run(cwd, args)
    if (out.exitCode !== 0) throw new Error(out.stderr.toString('utf8').trim() || 'git failed')
    return out.stdout.toString('utf8').trim()
  }
  const service = new RemoteService({
    repositories: { findById: (id) => (id === repoId ? repository : null) },
    gitWorktrees: {
      gitFor: async () => text,
      gitResultFor: async () => run,
      runRepositoryExclusive: async (path, _target, task) => {
        locks.push(path)
        return task()
      }
    }
  })
  return { service, calls, locks }
}

describe('isValidRemoteName', () => {
  it('accepts ordinary names and refuses ref syntax', () => {
    expect(isValidRemoteName('origin')).toBe(true)
    expect(isValidRemoteName('upstream-2')).toBe(true)
    expect(isValidRemoteName('-x')).toBe(false)
    expect(isValidRemoteName('has space')).toBe(false)
    expect(isValidRemoteName('a..b')).toBe(false)
    expect(isValidRemoteName('refs/heads/x')).toBe(false)
    expect(isValidRemoteName('x.lock')).toBe(false)
  })
})

describe('RemoteService', () => {
  it('lists remotes with redacted URLs and provider recognition', async () => {
    const { service } = setup({
      remoteOutput: [
        'origin\thttps://alice:ghp_secret@github.com/o/r.git (fetch)',
        'origin\thttps://github.com/o/r.git (push)',
        'mirror\tgit@gitlab.com:group/sub/repo.git (fetch)',
        'mirror\tgit@gitlab.com:group/sub/repo.git (push)'
      ].join('\n')
    })
    const remotes = await service.list(repoId)
    expect(remotes).toEqual([
      {
        name: 'mirror',
        displayFetchUrl: 'git@gitlab.com:group/sub/repo.git',
        displayPushUrl: null,
        provider: 'gitlab',
        webUrl: 'https://gitlab.com/group/sub/repo',
        hasCredentials: false
      },
      {
        name: 'origin',
        displayFetchUrl: 'https://***@github.com/o/r.git',
        displayPushUrl: 'https://github.com/o/r.git',
        provider: 'github',
        webUrl: 'https://github.com/o/r',
        hasCredentials: true
      }
    ])
  })

  it('shows a distinct push URL', async () => {
    const { service } = setup({
      remoteOutput: [
        'origin\thttps://github.com/o/r.git (fetch)',
        'origin\tssh://git@github.com/o/r.git (push)'
      ].join('\n')
    })
    const [remote] = await service.list(repoId)
    expect(remote?.displayPushUrl).toBe('ssh://git@github.com/o/r.git')
  })

  it('adds a remote under the repository lock with -- separation', async () => {
    const { service, calls, locks } = setup()
    const added = await service.add(repoId, {
      name: 'origin',
      url: 'https://github.com/o/r.git'
    })
    expect(added).toEqual({ status: 'ok', name: 'origin' })
    expect(calls).toContainEqual([
      'check-ref-format',
      '--allow-onelevel',
      'origin'
    ])
    expect(calls).toContainEqual([
      'remote',
      'add',
      '--',
      'origin',
      'https://github.com/o/r.git'
    ])
    expect(locks).toEqual(['/srv/atlas'])
  })

  it('refuses a duplicate remote name', async () => {
    const { service } = setup({ remoteOutput: 'origin\thttps://github.com/o/r.git (fetch)' })
    await expect(
      service.add(repoId, { name: 'origin', url: 'https://github.com/o/r.git' })
    ).rejects.toMatchObject({ appError: { code: 'INVALID_ARGUMENT' } })
  })

  it('refuses an invalid name or URL before Git runs', async () => {
    const { service, calls } = setup()
    await expect(
      service.add(repoId, { name: 'bad name', url: 'https://github.com/o/r.git' })
    ).rejects.toBeInstanceOf(RemoteServiceError)
    await expect(
      service.add(repoId, { name: 'origin', url: 'ext::sh -c calc' })
    ).rejects.toBeInstanceOf(RemoteServiceError)
    expect(calls).toEqual([])
  })

  it('refuses a name Git rejects', async () => {
    const { service } = setup({ checkRef: result('', 1, 'fatal: invalid refspec') })
    await expect(
      service.add(repoId, { name: 'origin', url: 'https://github.com/o/r.git' })
    ).rejects.toMatchObject({ appError: { code: 'INVALID_ARGUMENT' } })
  })

  it('sets a URL only for an existing remote', async () => {
    const { service, calls } = setup({ remoteOutput: 'origin\thttps://github.com/o/r.git (fetch)' })
    await service.setUrl(repoId, {
      name: 'origin',
      url: 'https://github.com/o/r2.git'
    })
    expect(calls).toContainEqual([
      'remote',
      'set-url',
      '--',
      'origin',
      'https://github.com/o/r2.git'
    ])
    await expect(
      service.setUrl(repoId, { name: 'missing', url: 'https://github.com/o/r.git' })
    ).rejects.toMatchObject({ appError: { code: 'INVALID_ARGUMENT' } })
  })

  it('removes an existing remote', async () => {
    const { service, calls } = setup({ remoteOutput: 'origin\thttps://github.com/o/r.git (fetch)' })
    await service.remove(repoId, 'origin')
    expect(calls).toContainEqual(['remote', 'remove', '--', 'origin'])
  })

  it('fetches and classifies an authentication failure', async () => {
    const success = setup({ remoteOutput: 'origin\thttps://github.com/o/r.git (fetch)' })
    await expect(success.service.fetch(repoId, { name: 'origin' })).resolves.toEqual({
      status: 'ok',
      name: 'origin'
    })
    expect(success.calls).toContainEqual(['fetch', '--prune', '--', 'origin'])

    const denied = setup({
      remoteOutput: 'origin\thttps://github.com/o/r.git (fetch)',
      fetch: result('', 128, "fatal: could not read Username for 'https://github.com'")
    })
    await expect(denied.service.fetch(repoId, { name: 'origin' })).rejects.toMatchObject({
      appError: { code: 'GIT_AUTH_FAILED', messageKey: 'remote.auth.local' }
    })
  })

  it('reports a fetch timeout as a remote failure', async () => {
    const { service } = setup({
      remoteOutput: 'origin\thttps://github.com/o/r.git (fetch)',
      fetch: { ...result(), timedOut: true, exitCode: null }
    })
    await expect(service.fetch(repoId, { name: 'origin' })).rejects.toMatchObject({
      appError: { code: 'GIT_REMOTE_FAILED' }
    })
  })

  it('refuses an unknown repository', async () => {
    const { service } = setup()
    await expect(service.list(newRepoId())).rejects.toMatchObject({
      appError: { code: 'INVALID_ARGUMENT' }
    })
  })

  it('works against a real repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'icode-remotes-'))
    const remote = join(root, 'remote.git')
    execFileSync('git', ['init', '-q', root])
    execFileSync('git', ['init', '--bare', '-q', remote])
    const executor = createLocalGitExecutor()
    const service = new RemoteService({
      repositories: {
        findById: (id) =>
          id === repoId ? { ...repository, path: root as RepositoryRecord['path'] } : null
      },
      gitWorktrees: {
        gitFor: async () => async (cwd, args, timeoutMs = 10_000) => {
          const result = await executor.exec({ cwd, args, timeoutMs })
          if (result.exitCode !== 0) {
            throw new Error(result.stderr.toString('utf8').trim() || 'git failed')
          }
          return result.stdout.toString('utf8').trim()
        },
        gitResultFor: async () => (cwd, args, timeoutMs = 10_000) =>
          executor.exec({ cwd, args, timeoutMs }),
        runRepositoryExclusive: async (_path, _target, task) => task()
      }
    })

    await expect(service.add(repoId, { name: 'origin', url: remote })).resolves.toEqual({
      status: 'ok',
      name: 'origin'
    })
    const listed = await service.list(repoId)
    expect(listed.map((entry) => entry.name)).toEqual(['origin'])
    expect(listed[0]?.displayFetchUrl).toBe(remote)
    await expect(
      service.setUrl(repoId, { name: 'origin', url: remote })
    ).resolves.toEqual({ status: 'ok', name: 'origin' })
    await expect(service.fetch(repoId, { name: 'origin' })).resolves.toEqual({
      status: 'ok',
      name: 'origin'
    })
    await expect(service.remove(repoId, 'origin')).resolves.toEqual({
      status: 'ok',
      name: 'origin'
    })
    expect(await service.list(repoId)).toEqual([])
  })
})
