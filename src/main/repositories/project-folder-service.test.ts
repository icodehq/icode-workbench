import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { newRepoId } from '../../shared/domain/ids'
import { toCanonicalRepositoryPath } from '../../shared/domain/paths'
import type {
  ExecutionTarget,
  RepositoryPreparation,
  RepositoryRecord
} from '../../shared/domain/repository'
import {
  WslCommandRunner,
  type WslByteResult,
  type WslByteLauncher
} from '../wsl/exec'
import { GitWorktreeService } from '../worktrees/git-worktree-service'
import { ProjectFolderService } from './project-folder-service'
import type { AddRepositoryOutcome } from './repository-service'

const roots: string[] = []
const environment: Array<[string, string | undefined]> = []
const LOCAL: ExecutionTarget = { kind: 'local' }
const WSL: ExecutionTarget = {
  kind: 'wsl',
  distro: 'Ubuntu-26.04',
  distroId: 'reg-1'
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  for (const [key, value] of environment.splice(0)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ade-project-folder-'))
  roots.push(root)
  return root
}

function setEnv(key: string, value: string | undefined): void {
  environment.push([key, process.env[key]])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
}

function makeRepo(root: string): string {
  mkdirSync(root, { recursive: true })
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.name', 'Project Test')
  git(root, 'config', 'user.email', 'project@test.local')
  writeFileSync(join(root, 'README.md'), 'project\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'baseline')
  return root
}

function byteResult(code: number, stdout = '', stderr = ''): WslByteResult {
  return {
    code,
    signal: null,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    timedOut: false
  }
}

/**
 * A scripted distro for path resolution. `wslpath` is scripted separately from
 * `realpath`, so the test can prove the Windows spelling was actually translated
 * instead of merely passed through.
 */
function wslRunner(script: {
  realpath: Record<string, string>
  windowsPaths?: Record<string, string>
  kinds?: Record<string, 'dir' | 'other' | 'missing'>
}): WslCommandRunner {
  const byteLauncher: WslByteLauncher = async (spec) => {
    const args = [...spec.args]
    const exec = args.indexOf('--exec')
    const guest = args.slice(exec + 1)
    if (guest[0] === 'wslpath') {
      const input = guest[2] ?? ''
      const mapped = script.windowsPaths?.[input]
      return mapped === undefined
        ? byteResult(1, '', 'invalid argument')
        : byteResult(0, `${mapped}\n`)
    }
    if (guest[0] === 'sh' && guest[1] === '-c') {
      const path = guest[4] ?? ''
      if (guest[2] === 'realpath -e -- "$1"') {
        const mapped = script.realpath[path]
        return mapped === undefined ? byteResult(1) : byteResult(0, `${mapped}\n`)
      }
      if (guest[2]?.startsWith('test -d')) {
        return byteResult(0, `${script.kinds?.[path] ?? 'dir'}\n`)
      }
    }
    return byteResult(0)
  }
  return new WslCommandRunner({ byteLauncher, platform: 'win32' })
}

function makeService(
  options: {
    localHome?: string
    runner?: WslCommandRunner
    addRepository?: (path: string, target: ExecutionTarget) => Promise<AddRepositoryOutcome>
    startPreparation?: (repository: RepositoryRecord) => RepositoryPreparation
  } = {}
): {
  service: ProjectFolderService
  added: Array<{ path: string; target: ExecutionTarget }>
  started: RepositoryRecord[]
} {
  const added: Array<{ path: string; target: ExecutionTarget }> = []
  const started: RepositoryRecord[] = []
  const service = new ProjectFolderService({
    runner: options.runner ?? ({} as WslCommandRunner),
    gitWorktrees: new GitWorktreeService({ worktreeRoot: join(tempRoot(), 'worktrees') }),
    repositoryService: {
      addRepository: async (path, requestedTarget = LOCAL) => {
        const target = requestedTarget
        added.push({ path, target })
        if (options.addRepository) return options.addRepository(path, target)
        const record: RepositoryRecord = {
          id: newRepoId(),
          path: toCanonicalRepositoryPath(path),
          displayName: 'project',
          addedAt: 1,
          lastOpenedAt: 1,
          currentBranch: null,
          availability: 'present',
          gitCommonDir: null,
          executionTarget: target
        }
        return { repository: record, created: true, registeredViaLinkedWorktree: null }
      }
    },
    preparations: {
      start: (repository) => {
        started.push(repository)
        if (options.startPreparation) return options.startPreparation(repository)
        return {
          state: 'preparing',
          startedAt: 1,
          finishedAt: null,
          committedFiles: null,
          skippedFolders: [],
          error: null
        }
      }
    },
    validateTarget: async (target) => target,
    platform: process.platform,
    localHome: options.localHome ?? join(tempRoot(), 'home'),
    readGuestHome: async () => null
  })
  return { service, added, started }
}

describe('project folder inspection', () => {
  it('classifies a plain folder without walking its tree for a preview', async () => {
    const root = tempRoot()
    writeFileSync(join(root, 'README.md'), 'hello')
    writeFileSync(join(root, 'app.ts'), 'export {}\n')
    const { service } = makeService()
    const inspection = await service.inspect({ path: root, target: LOCAL })
    expect(inspection.kind).toBe('gitless')
    expect(inspection.canInitialize).toBe(true)
    // The recursive preview was the slow gate this flow removes.
    expect(inspection.preview).toBeNull()
  })

  it('offers nested repositories instead of initializing a container', async () => {
    const root = tempRoot()
    const child = makeRepo(join(root, 'child'))
    writeFileSync(join(root, 'notes.txt'), 'not a repo\n')
    const { service } = makeService()
    const inspection = await service.inspect({ path: root, target: LOCAL })
    expect(inspection.kind).toBe('parent')
    expect(inspection.canInitialize).toBe(false)
    expect(inspection.repositories).toEqual([{ path: child, displayName: 'child' }])
  })

  it('recognizes an unborn repository separately from a plain folder', async () => {
    const root = tempRoot()
    git(root, 'init', '-q', '-b', 'main')
    writeFileSync(join(root, 'README.md'), 'first\n')
    const { service } = makeService()
    const inspection = await service.inspect({ path: root, target: LOCAL })
    expect(inspection.kind).toBe('unborn')
    expect(inspection.hasCommit).toBe(false)
    expect(inspection.canInitialize).toBe(true)
    expect(inspection.preview).toBeNull()
  })

  it('resolves a subfolder to the repository root', async () => {
    const root = makeRepo(tempRoot())
    const nested = join(root, 'src')
    mkdirSync(nested)
    writeFileSync(join(nested, 'a.ts'), 'a\n')
    const { service } = makeService()
    const inspection = await service.inspect({ path: nested, target: LOCAL })
    expect(inspection.kind).toBe('repository')
    expect(inspection.hasCommit).toBe(true)
    expect(inspection.root).toBe(root)
  })

  it('refuses to initialize a home directory', async () => {
    const home = tempRoot()
    const { service } = makeService({ localHome: home })
    const inspection = await service.inspect({ path: home, target: LOCAL })
    expect(inspection.kind).toBe('gitless')
    expect(inspection.canInitialize).toBe(false)
    expect(inspection.blockedReason).toContain('home')
  })
})

describe('WSL project location resolution', () => {
  it('translates a Windows drive spelling with the distro\'s wslpath', async () => {
    const runner = wslRunner({
      realpath: { '/mnt/d/Development/app': '/mnt/d/Development/app' },
      windowsPaths: { 'D:\\Development\\app': '/mnt/d/Development/app' }
    })
    const { service } = makeService({ runner })

    await expect(
      service.resolveLocation({ path: 'D:\\Development\\app', target: WSL })
    ).resolves.toEqual({
      path: '/mnt/d/Development/app',
      translatedFrom: 'D:\\Development\\app'
    })
  })

  it('accepts a WSL UNC spelling without invoking the Windows drive translator', async () => {
    const runner = wslRunner({
      realpath: { '/mnt/d/app': '/mnt/d/app' }
    })
    const { service } = makeService({ runner })

    await expect(
      service.resolveLocation({
        path: '\\\\wsl.localhost\\Ubuntu-26.04\\mnt\\d\\app',
        target: WSL
      })
    ).resolves.toEqual({
      path: '/mnt/d/app',
      translatedFrom: '\\\\wsl.localhost\\Ubuntu-26.04\\mnt\\d\\app'
    })
  })

  it('reports a Windows drive that the distro cannot translate', async () => {
    const runner = wslRunner({ realpath: {} })
    const { service } = makeService({ runner })

    const error = await service
      .resolveLocation({ path: 'D:\\Development\\app', target: WSL })
      .catch((value: unknown) => value)
    expect(error).toMatchObject({
      appError: { code: 'PATH_NOT_FOUND', message: expect.stringContaining('could not be mapped') }
    })
  })

  it('refuses a UNC folder belonging to another distro', async () => {
    const runner = wslRunner({ realpath: {} })
    const { service } = makeService({ runner })

    const error = await service
      .resolveLocation({
        path: '\\\\wsl.localhost\\Debian\\home\\you\\app',
        target: WSL
      })
      .catch((value: unknown) => value)
    expect(error).toMatchObject({ appError: { code: 'INVALID_ARGUMENT' } })
  })
})

describe('project folder initialization', () => {
  it('registers a plain folder and starts preparation without waiting for the commit', async () => {
    const root = tempRoot()
    writeFileSync(join(root, 'README.md'), 'hello\n')
    writeFileSync(join(root, 'app.ts'), 'export const value = 1\n')
    const { service, added, started } = makeService()
    const outcome = await service.initialize({
      path: root,
      target: LOCAL,
      identity: { name: 'Project Test', email: 'project@test.local' }
    })
    expect(outcome.initialized).toBe(true)
    expect(outcome.committedFiles).toBe(0)
    expect(outcome.repository.preparation?.state).toBe('preparing')
    // The expensive Git work is owned by the preparation service.
    expect(() => git(root, 'rev-parse', '--verify', 'HEAD')).toThrow()
    expect(added).toEqual([{ path: root, target: LOCAL }])
    expect(started).toHaveLength(1)
  })

  it('registers an empty folder and leaves the empty commit to preparation', async () => {
    const root = tempRoot()
    const { service, started } = makeService()
    const outcome = await service.initialize({
      path: root,
      target: LOCAL,
      identity: { name: 'Project Test', email: 'project@test.local' }
    })
    expect(outcome.initialized).toBe(true)
    expect(outcome.committedFiles).toBe(0)
    expect(outcome.repository.preparation?.state).toBe('preparing')
    expect(() => git(root, 'rev-parse', '--verify', 'HEAD')).toThrow()
    expect(started).toHaveLength(1)
  })

  it('registers an existing unborn repository and starts preparation', async () => {
    const root = tempRoot()
    git(root, 'init', '-q', '-b', 'main')
    writeFileSync(join(root, 'README.md'), 'hello\n')
    const { service, added, started } = makeService()
    const outcome = await service.initialize({
      path: root,
      target: LOCAL,
      identity: { name: 'Project Test', email: 'project@test.local' }
    })
    expect(outcome.initialized).toBe(true)
    expect(outcome.committedFiles).toBe(0)
    expect(outcome.repository.preparation?.state).toBe('preparing')
    expect(() => git(root, 'rev-parse', '--verify', 'HEAD')).toThrow()
    expect(added).toHaveLength(1)
    expect(started).toHaveLength(1)
  })

  it('requires identity before creating the first commit', async () => {
    const root = tempRoot()
    writeFileSync(join(root, 'README.md'), 'hello\n')
    setEnv('GIT_CONFIG_GLOBAL', join(tempRoot(), 'missing-global-config'))
    setEnv('GIT_CONFIG_SYSTEM', join(tempRoot(), 'missing-system-config'))
    setEnv('GIT_CONFIG_NOSYSTEM', '1')
    const { service } = makeService()
    const error = await service.initialize({ path: root, target: LOCAL }).catch((value: unknown) => value)
    expect(error).toMatchObject({ appError: { code: 'GIT_IDENTITY_MISSING' } })
    expect(() => git(root, 'rev-parse', '--git-dir')).toThrow()
  })

  it('refuses to initialize a folder containing a repository', async () => {
    const root = tempRoot()
    makeRepo(join(root, 'child'))
    const { service } = makeService()
    const error = await service
      .initialize({
        path: root,
        target: LOCAL,
        identity: { name: 'Project Test', email: 'project@test.local' }
      })
      .catch((value: unknown) => value)
    expect(error).toMatchObject({ appError: { code: 'INVALID_ARGUMENT' } })
    expect(() => git(root, 'rev-parse', '--git-dir')).toThrow()
  })
})
