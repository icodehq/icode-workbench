import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CloneService,
  isValidCloneName,
  type CloneEvent
} from './clone-service'
import {
  createLocalGitExecutor,
  createLocalHostFileSystem,
  type HostFileSystem
} from './executor'
import type { WslCommandRunner } from '../wsl/exec'
import { resetGuestGitEnvironments } from '../wsl/git/guest-git'

const local = { kind: 'local' as const }
const wsl = { kind: 'wsl' as const, distro: 'Ubuntu', distroId: 'distro-1' }

type StreamResult = {
  stdout: Buffer
  stderr: Buffer
  exitCode: number | null
  timedOut: boolean
}

type FakeStream = (
  cwd: string,
  args: string[],
  handlers: { onStdout?(chunk: Buffer): void; onStderr?(chunk: Buffer): void },
  options?: { timeoutMs?: number; signal?: AbortSignal }
) => Promise<StreamResult>

function setup(options: {
  target?: typeof local | typeof wsl
  stream?: FakeStream
  unborn?: boolean
  fs?: Partial<HostFileSystem>
  runner?: WslCommandRunner
} = {}) {
  const target = options.target ?? local
  const removed: string[] = []
  const existing = new Set<string>()
  const fs: HostFileSystem = {
    isDirectory: async () => true,
    exists: async (path) => existing.has(path),
    ensureParentDirectory: async () => undefined,
    isEmptyDirectory: async () => false,
    removeDirectory: async () => undefined,
    removeTree: async (path) => {
      removed.push(path)
      existing.delete(path)
    },
    ...options.fs
  }
  const events: CloneEvent[] = []
  const service = new CloneService({
    projectFolders: {
      resolveCloneParent: async ({ path }) => path,
      resolveCloneSource: async ({ path }) => path
    },
    gitWorktrees: {
      hostFsFor: async () => fs,
      streamGitFor: async () => options.stream ?? null,
      gitResultFor: async () =>
        async () => ({
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          exitCode: options.unborn === false ? 0 : 1,
          timedOut: false
        })
    },
    runner: options.runner ?? ({} as WslCommandRunner)
  })
  service.subscribe((event) => events.push(event))
  return { service, events, removed, existing, target, fs }
}

function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      if (predicate()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting for event'))
      setTimeout(tick, 10)
    }
    tick()
  })
}

describe('isValidCloneName', () => {
  it('accepts ordinary folder names and refuses traversal', () => {
    expect(isValidCloneName('repo')).toBe(true)
    expect(isValidCloneName('my-repo_2')).toBe(true)
    expect(isValidCloneName('..')).toBe(false)
    expect(isValidCloneName('a/b')).toBe(false)
    expect(isValidCloneName('a\\b')).toBe(false)
    expect(isValidCloneName('CON')).toBe(false)
    expect(isValidCloneName('name.')).toBe(false)
  })
})

describe('CloneService', () => {
  it('refuses invalid input before touching the filesystem', async () => {
    const { service } = setup()
    await expect(
      service.start({
        requestId: 'clone-1',
        url: 'ext::sh -c calc',
        target: local,
        parentPath: '/tmp',
        name: 'repo'
      })
    ).rejects.toMatchObject({ appError: { code: 'INVALID_ARGUMENT' } })
    await expect(
      service.start({
        requestId: 'clone-1',
        url: 'https://github.com/o/r.git',
        target: local,
        parentPath: '/tmp',
        name: '../escape'
      })
    ).rejects.toMatchObject({ appError: { code: 'INVALID_ARGUMENT' } })
  })

  it('refuses an existing destination', async () => {
    const { service, existing } = setup()
    existing.add('/projects/repo')
    await expect(
      service.start({
        requestId: 'clone-1',
        url: 'https://github.com/o/r.git',
        target: local,
        parentPath: '/projects',
        name: 'repo'
      })
    ).rejects.toMatchObject({ appError: { code: 'INVALID_ARGUMENT' } })
  })

  it('streams progress and reports a successful clone', async () => {
    const stream: FakeStream = async (_cwd, _args, handlers) => {
      handlers.onStderr?.(Buffer.from('Cloning into \'repo\'...\n'))
      handlers.onStderr?.(Buffer.from('Receiving objects:  50% (5/10)\r'))
      handlers.onStderr?.(Buffer.from('Receiving objects: 100% (10/10)\r\n'))
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, timedOut: false }
    }
    const { service, events, existing } = setup({ stream, unborn: false })
    await service.start({
      requestId: 'clone-1',
      url: 'https://github.com/o/r.git',
      target: local,
      parentPath: '/projects',
      name: 'repo'
    })
    // The clone creates the destination; simulate it being present afterwards.
    existing.add('/projects/repo')
    await waitFor(() => events.some((event) => event.type === 'done'))
    const done = events.find((event) => event.type === 'done')
    expect(done).toMatchObject({ destination: '/projects/repo', unborn: false })
    expect(events.some((event) => event.type === 'progress' && event.phase === 'receiving')).toBe(
      true
    )
  })

  it('cancels and removes a partial clone', async () => {
    let created = false
    const stream: FakeStream = async (_cwd, _args, _handlers, options) => {
      created = true
      await new Promise<void>((resolve) => {
        options?.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: null, timedOut: false }
    }
    const { service, events, removed, existing } = setup({ stream })
    await service.start({
      requestId: 'clone-1',
      url: 'https://github.com/o/r.git',
      target: local,
      parentPath: '/projects',
      name: 'repo'
    })
    existing.add('/projects/repo')
    existing.add('/projects/repo/.git')
    await waitFor(() => created)
    expect(service.cancel('clone-1')).toBe(true)
    await waitFor(() => events.some((event) => event.type === 'cancelled'))
    expect(events.find((event) => event.type === 'cancelled')).toMatchObject({
      cleanup: 'removed'
    })
    expect(removed).toEqual(['/projects/repo'])
  })

  it('treats a transport rejection after cancellation as cancelled', async () => {
    const stream: FakeStream = async (_cwd, _args, _handlers, options) => {
      if (options?.signal?.aborted === true) throw new Error('AbortError')
      await new Promise<void>((resolve) => {
        options?.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      throw new Error('AbortError')
    }
    const { service, events, removed, existing } = setup({ stream })
    await service.start({
      requestId: 'clone-1',
      url: 'https://github.com/o/r.git',
      target: local,
      parentPath: '/projects',
      name: 'repo'
    })
    existing.add('/projects/repo')
    existing.add('/projects/repo/.git')
    service.cancel('clone-1')
    await waitFor(() => events.some((event) => event.type === 'cancelled'))
    expect(events.find((event) => event.type === 'cancelled')).toMatchObject({
      cleanup: 'removed'
    })
    expect(removed).toEqual(['/projects/repo'])
  })

  it('classifies an authentication failure and cleans up', async () => {    const stream: FakeStream = async () => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.from('fatal: could not read Username: terminal prompts disabled'),
      exitCode: 128,
      timedOut: false
    })
    const { service, events, removed, existing } = setup({ stream })
    await service.start({
      requestId: 'clone-1',
      url: 'https://github.com/o/r.git',
      target: local,
      parentPath: '/projects',
      name: 'repo'
    })
    existing.add('/projects/repo')
    existing.add('/projects/repo/.git')
    await waitFor(() => events.some((event) => event.type === 'failed'))
    expect(events.find((event) => event.type === 'failed')).toMatchObject({
      error: { code: 'GIT_AUTH_FAILED', messageKey: 'remote.auth.local' },
      cleanup: 'removed'
    })
    expect(removed).toEqual(['/projects/repo'])
  })

  it('preserves a non-empty directory that was not created by the clone', async () => {
    const stream: FakeStream = async () => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.from('fatal: destination path already exists'),
      exitCode: 128,
      timedOut: false
    })
    const { service, events, removed, existing } = setup({ stream })
    await service.start({
      requestId: 'clone-1',
      url: 'https://github.com/o/r.git',
      target: local,
      parentPath: '/projects',
      name: 'repo'
    })
    existing.add('/projects/repo')
    await waitFor(() => events.some((event) => event.type === 'failed'))
    expect(events.find((event) => event.type === 'failed')).toMatchObject({ cleanup: 'failed' })
    expect(removed).toEqual([])
  })

  it('routes a WSL clone through the guest runner', async () => {
    resetGuestGitEnvironments()
    const argvSeen: string[][] = []
    const runner = {
      runBytes: async (request: { argv: readonly string[] }) => {
        if (request.argv[0] === 'sh' && String(request.argv[2]).includes('command -v git')) {
          return {
            code: 0,
            signal: null,
            stdout: Buffer.from(
              '__ICODE_GIT_OUT_START__/usr/local/bin:/usr/bin\0/usr/bin/git\0/home/u__ICODE_GIT_OUT_END__'
            ),
            stderr: Buffer.alloc(0),
            timedOut: false
          }
        }
        return {
          code: 0,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          timedOut: false
        }
      },
      runStream: async (request: { argv: readonly string[] }) => {
        argvSeen.push([...request.argv])
        return { code: 0, signal: null, timedOut: false, cancelled: false }
      },
      buildArgs: (request: { argv: readonly string[] }) => [...request.argv]
    } as unknown as WslCommandRunner
    const { service, events, existing } = setup({ target: wsl, runner, unborn: false })
    await service.start({
      requestId: 'clone-1',
      url: 'https://github.com/o/r.git',
      target: wsl,
      parentPath: '/home/u',
      name: 'repo'
    })
    existing.add('/home/u/repo')
    await waitFor(() => events.some((event) => event.type === 'done'))
    expect(argvSeen[0]).toContain('clone')
    expect(argvSeen[0]).toContain('--progress')
    expect(argvSeen[0]!.slice(-2)).toEqual(['https://github.com/o/r.git', '/home/u/repo'])
  })

  it('clones a real local repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'icode-clone-'))
    const seed = join(root, 'seed')
    const parent = join(root, 'projects')
    execFileSync('git', ['init', '-q', seed])
    writeFileSync(join(seed, 'README.md'), '# seed\n')
    execFileSync('git', ['-C', seed, 'add', '.'])
    execFileSync('git', ['-C', seed, 'commit', '-q', '-m', 'seed'], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com'
      }
    })
    mkdirSync(parent, { recursive: true })

    const executor = createLocalGitExecutor()
    const events: CloneEvent[] = []
    const service = new CloneService({
      projectFolders: {
        resolveCloneParent: async ({ path }) => path,
        resolveCloneSource: async ({ path }) => path
      },
      gitWorktrees: {
        hostFsFor: async () => createLocalHostFileSystem(),
        streamGitFor: async () =>
          (cwd, args, handlers, options) =>
            executor.stream!(
              { cwd, args, timeoutMs: options?.timeoutMs ?? 10_000 },
              {
                onStdout: handlers.onStdout ?? (() => undefined),
                ...(handlers.onStderr ? { onStderr: handlers.onStderr } : {})
              }
            ),
        gitResultFor: async () => (cwd, args) => executor.exec({ cwd, args, timeoutMs: 10_000 })
      },
      runner: {} as WslCommandRunner
    })
    service.subscribe((event) => events.push(event))
    await service.start({
      requestId: 'clone-real',
      url: seed,
      target: local,
      parentPath: parent,
      name: 'cloned'
    })
    await waitFor(() => events.some((event) => event.type === 'done'), 10_000)
    expect(events.find((event) => event.type === 'done')).toMatchObject({ unborn: false })
    expect(existsSync(join(parent, 'cloned', 'README.md'))).toBe(true)
  }, 20_000)
})
