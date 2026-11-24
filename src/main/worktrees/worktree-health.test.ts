import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppError } from '../../shared/domain/errors'
import { newRepoId, newWorktreeId } from '../../shared/domain/ids'
import type { CanonicalRepositoryPath } from '../../shared/domain/paths'
import type { RepositoryRecord } from '../../shared/domain/repository'
import type {
  OwnedBranchRecord,
  WorktreeRecord,
  WorktreeState
} from '../../shared/domain/worktree'
import {
  parseWorktreeList,
  GitWorktreeService,
  worktreeGitArgs
} from './git-worktree-service'
import { WorktreeHealthService } from './worktree-health'
import { samePathResolved } from './worktree-status'

const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function status(cwd: string): string[] {
  const output = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], {
    encoding: 'utf8'
  })
  return output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
}

function registered(repoPath: string, worktreePath: string): boolean {
  const output = execFileSync('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8'
  })
  return parseWorktreeList(output).some((entry) =>
    samePathResolved(entry.path, worktreePath, process.platform)
  )
}

type Fixture = {
  root: string
  repoPath: string
  wtPath: string
  adminDir: string
  baseOid: string
  service: GitWorktreeService
  repository: RepositoryRecord
  record: WorktreeRecord
  health: WorktreeHealthService
  writes: Array<{ state: WorktreeState; error: AppError | null }>
  clock: { value: number }
}

async function makeFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'icode-worktree-health-'))
  roots.push(root)
  const repoPath = join(root, 'atlas')
  mkdirSync(repoPath)
  execFileSync('git', ['init', '-q', '-b', 'main', repoPath])
  writeFileSync(join(repoPath, 'README.md'), '# atlas\n')
  git(repoPath, 'add', 'README.md')
  execFileSync('git', [
    '-C',
    repoPath,
    '-c',
    'user.email=icode@test',
    '-c',
    'user.name=iCode',
    'commit',
    '-qm',
    'init'
  ])
  const baseOid = git(repoPath, 'rev-parse', 'HEAD')

  const service = new GitWorktreeService({ worktreeRoot: join(root, 'worktrees') })
  const repoId = newRepoId()
  const worktreeId = newWorktreeId()
  const wtPath = service.worktreePathFor(repoId, worktreeId)
  const branch = 'session-branch'
  await service.create({ primaryRoot: repoPath, path: wtPath, branch, baseOid })

  const repository: RepositoryRecord = {
    id: repoId,
    path: repoPath as CanonicalRepositoryPath,
    displayName: 'atlas',
    addedAt: 1,
    lastOpenedAt: 1,
    currentBranch: 'main',
    availability: 'present',
    gitCommonDir: join(repoPath, '.git'),
    executionTarget: { kind: 'local' }
  }
  const record: WorktreeRecord = {
    id: worktreeId,
    repoId,
    path: wtPath,
    branch,
    baseRef: 'main',
    baseOid,
    state: 'ready',
    error: null,
    createdAt: 1,
    updatedAt: 1
  }
  const writes: Fixture['writes'] = []
  const clock = { value: 1_000 }
  const owned: OwnedBranchRecord = {
    branch,
    repoId,
    worktreeId,
    sessionId: null,
    taskId: null,
    kind: 'session',
    baseOid,
    createdAt: 1
  }
  const health = new WorktreeHealthService({
    worktrees: {
      updateStateById: (_id, state, error) => {
        writes.push({ state, error })
      },
      findBranch: (candidate) => (candidate === branch ? owned : null)
    },
    repositories: {
      findById: (id) => (id === repository.id ? repository : null)
    },
    gitWorktrees: service,
    now: () => clock.value
  })

  return {
    root,
    repoPath,
    wtPath,
    adminDir: join(repoPath, '.git', 'worktrees', basename(wtPath)),
    baseOid,
    service,
    repository,
    record,
    health,
    writes,
    clock
  }
}

describe('worktree health probe', () => {
  it('proves a healthy checkout without invoking Git', async () => {
    const f = await makeFixture()
    const list = vi.spyOn(f.service, 'listWorktrees')
    const gitFor = vi.spyOn(f.service, 'gitFor')
    const hostFs = vi.spyOn(f.service, 'hostFsFor')

    await expect(f.health.probe(f.record)).resolves.toEqual({ kind: 'healthy' })
    expect(list).not.toHaveBeenCalled()
    expect(gitFor).not.toHaveBeenCalled()
    expect(hostFs).not.toHaveBeenCalled()
    expect(f.writes).toEqual([])
  })

  it('uses a cached verdict until it is invalidated', async () => {
    const f = await makeFixture()
    await expect(f.health.probe(f.record)).resolves.toEqual({ kind: 'healthy' })

    rmSync(f.adminDir, { recursive: true, force: true })
    await expect(f.health.probe(f.record)).resolves.toEqual({ kind: 'healthy' })

    f.health.invalidate(f.record.id)
    await expect(f.health.probe(f.record)).resolves.toMatchObject({ kind: 'unregistered' })
  })

  it('expires a cached verdict after the TTL', async () => {
    const f = await makeFixture()
    await expect(f.health.probe(f.record)).resolves.toEqual({ kind: 'healthy' })
    rmSync(f.adminDir, { recursive: true, force: true })
    f.clock.value += 61_000
    await expect(f.health.probe(f.record)).resolves.toMatchObject({ kind: 'unregistered' })
  })
})

describe('worktree repairs', () => {
  it('reconstructs a deleted admin entry without losing untracked files', async () => {
    const f = await makeFixture()
    writeFileSync(join(f.wtPath, 'work.txt'), 'keep me\n')
    rmSync(f.adminDir, { recursive: true, force: true })

    await expect(f.health.probe(f.record)).resolves.toMatchObject({
      kind: 'unregistered',
      gitFile: true,
      adminExists: false
    })

    const result = await f.health.ensureHealthy(f.record)
    expect(result.kind).toBe('repaired')
    expect(readFileSync(join(f.wtPath, 'work.txt'), 'utf8')).toBe('keep me\n')
    expect(status(f.wtPath)).toEqual(['?? work.txt'])
    expect(registered(f.repoPath, f.wtPath)).toBe(true)
  })

  it('rebuilds a missing index', async () => {
    const f = await makeFixture()
    rmSync(join(f.adminDir, 'index'))

    await expect(f.health.probe(f.record)).resolves.toMatchObject({ kind: 'reindex' })

    const result = await f.health.ensureHealthy(f.record)
    expect(result.kind).toBe('repaired')
    expect(status(f.wtPath)).toEqual([])
  })

  it('repairs a drifted backlink', async () => {
    const f = await makeFixture()
    writeFileSync(join(f.adminDir, 'gitdir'), '/nonexistent/worktree/.git\n')

    await expect(f.health.probe(f.record)).resolves.toMatchObject({
      kind: 'unregistered',
      gitFile: true,
      adminExists: true
    })

    const result = await f.health.ensureHealthy(f.record)
    expect(result.kind).toBe('repaired')
    expect(status(f.wtPath)).toEqual([])
    expect(registered(f.repoPath, f.wtPath)).toBe(true)
  })

  it('re-adds a missing directory from its owned branch', async () => {
    const f = await makeFixture()
    rmSync(f.wtPath, { recursive: true, force: true })

    await expect(f.health.probe(f.record)).resolves.toEqual({ kind: 'absent' })

    const result = await f.health.ensureHealthy(f.record)
    expect(result.kind).toBe('repaired')
    expect(existsSync(join(f.wtPath, 'README.md'))).toBe(true)
    expect(registered(f.repoPath, f.wtPath)).toBe(true)
  })

  it('refuses to re-create a non-empty unregistered directory', async () => {
    const f = await makeFixture()
    writeFileSync(join(f.wtPath, 'keep.txt'), 'keep\n')
    rmSync(join(f.wtPath, '.git'))

    await expect(f.health.probe(f.record)).resolves.toMatchObject({
      kind: 'unregistered',
      gitFile: false,
      nonEmpty: true
    })

    const result = await f.health.ensureHealthy(f.record)
    expect(result.kind).toBe('fatal')
    if (result.kind !== 'fatal') return
    expect(result.error.code).toBe('WORKTREE_UNRECOVERABLE')
    expect(existsSync(join(f.wtPath, 'keep.txt'))).toBe(true)
    expect(f.writes.at(-1)?.state).toBe('failed')
  })

  it('does not reset a worktree in the middle of a Git operation', async () => {
    const f = await makeFixture()
    writeFileSync(join(f.adminDir, 'MERGE_HEAD'), `${f.baseOid}\n`)
    rmSync(join(f.adminDir, 'index'))

    await expect(f.health.probe(f.record)).resolves.toMatchObject({ kind: 'blocked' })

    const result = await f.health.ensureHealthy(f.record)
    expect(result.kind).toBe('fatal')
    if (result.kind !== 'fatal') return
    expect(result.error.code).toBe('WORKTREE_REPAIR_FAILED')
    expect(existsSync(join(f.adminDir, 'index'))).toBe(false)
    expect(existsSync(join(f.adminDir, 'MERGE_HEAD'))).toBe(true)
  })

  it('clears a stale failed state on the next healthy probe', async () => {
    const f = await makeFixture()
    const failed: WorktreeRecord = { ...f.record, state: 'failed' }
    await expect(f.health.ensureHealthy(failed)).resolves.toEqual({ kind: 'healthy' })
    expect(f.writes.at(-1)).toEqual({ state: 'created', error: null })
  })
})

describe('Windows worktree arguments', () => {
  it('adds core.longpaths only for local Windows checkouts', () => {
    expect(worktreeGitArgs({ kind: 'local' }, ['worktree', 'list'], 'win32')).toEqual([
      '-c',
      'core.longpaths=true',
      'worktree',
      'list'
    ])
    expect(worktreeGitArgs({ kind: 'local' }, ['worktree', 'list'], 'linux')).toEqual([
      'worktree',
      'list'
    ])
    expect(
      worktreeGitArgs(
        { kind: 'wsl', distro: 'Ubuntu', distroId: null },
        ['worktree', 'list'],
        'win32'
      )
    ).toEqual(['worktree', 'list'])
  })
})
