import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ChainService } from './chain-service'
import { BranchService } from '../git/branch-service'
import { RemoteService } from '../git/remote-service'
import {
  makeRepositoryService,
  makeTempRoot,
  openTempDatabase,
  type TempRoot
} from '../persistence/persistence-test-fixtures'
import { WorktreeStore } from '../persistence/worktree-store'
import { GitWorktreeService } from '../worktrees/git-worktree-service'
import type { TaskStore } from '../tasks/task-store'
import type { TaskRecord } from '../../shared/domain/task'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function commitFile(cwd: string, file: string, message: string): string {
  writeFileSync(join(cwd, file), `${message}\n`)
  git(cwd, 'add', file)
  execFileSync(
    'git',
    [
      '-C',
      cwd,
      '-c',
      'user.email=icode@test',
      '-c',
      'user.name=iCode',
      'commit',
      '-qm',
      message
    ],
    { stdio: 'pipe' }
  )
  return git(cwd, 'rev-parse', 'HEAD')
}

async function setup() {
  const root: TempRoot = makeTempRoot('icode-chain-svc-')
  const db = openTempDatabase(root)
  const stores = makeRepositoryService(db)
  const worktrees = new WorktreeStore(db)
  const gitWorktrees = new GitWorktreeService({ worktreeRoot: join(root.dir, 'worktrees') })
  const remotes = new RemoteService({ repositories: stores.repositories, gitWorktrees })
  const branches = new BranchService({
    repositories: stores.repositories,
    worktrees,
    gitWorktrees,
    remotes
  })

  const repoPath = join(root.dir, 'atlas')
  mkdirSync(repoPath)
  execFileSync('git', ['init', '-q', '-b', 'main', repoPath])
  const mainOid = commitFile(repoPath, 'README.md', 'init')

  const bare = join(root.dir, 'origin.git')
  execFileSync('git', ['init', '--bare', '-q', bare])
  git(repoPath, 'remote', 'add', 'origin', bare)
  git(repoPath, 'checkout', '-q', '-b', 'feature')
  const featureOid = commitFile(repoPath, 'feature.txt', 'feature')
  git(repoPath, 'push', '-q', 'origin', 'feature')
  git(repoPath, 'checkout', '-q', 'main')

  const added = await stores.service.addRepository(repoPath)
  const dependencies: TaskRecord[] = []
  const tasks = {
    dependenciesOf: () => dependencies,
    findById: () => null
  } as unknown as TaskStore
  const service = new ChainService({
    repositories: stores.repositories,
    tasks,
    gitWorktrees,
    branches
  })

  cleanups.push(() => {
    db.close()
    root.cleanup()
  })

  return {
    root,
    repoPath,
    repoId: added.repository.id,
    mainOid,
    featureOid,
    dependencies,
    service
  }
}

function task(
  fixture: Awaited<ReturnType<typeof setup>>,
  overrides: Partial<TaskRecord> = {}
): TaskRecord {
  return {
    id: 'task_1',
    repoId: fixture.repoId,
    chainBranch: 'icode/chain/task_1',
    startFrom: 'refs/remotes/origin/feature',
    ...overrides
  } as TaskRecord
}

describe('ChainService remote start refs', () => {
  it('creates the chain branch at the fetched remote tip', async () => {
    const f = await setup()
    git(f.repoPath, 'checkout', '-q', 'feature')
    const remoteTip = commitFile(f.repoPath, 'feature.txt', 'feature two')
    git(f.repoPath, 'push', '-q', 'origin', 'feature')
    git(f.repoPath, 'checkout', '-q', 'main')
    // Stale tracking ref proves the call refreshed it before branching.
    git(f.repoPath, 'update-ref', 'refs/remotes/origin/feature', f.featureOid)
    git(f.repoPath, 'branch', '-D', 'feature')

    await expect(f.service.resolveTaskBase(task(f))).resolves.toEqual({
      baseRef: 'icode/chain/task_1',
      baseOid: remoteTip
    })
    expect(git(f.repoPath, 'rev-parse', 'refs/heads/icode/chain/task_1')).toBe(remoteTip)
  })

  it('refuses to start a dependent over a missing chain branch', async () => {
    const f = await setup()
    f.dependencies.push(task(f, { id: 'task_0' }))

    await expect(
      f.service.resolveTaskBase(
        task(f, { chainBranch: 'icode/chain/missing', startFrom: null })
      )
    ).rejects.toMatchObject({ appError: { code: 'CHAIN_BRANCH_MISSING' } })
  })

  it('uses the primary HEAD when no start ref is given', async () => {
    const f = await setup()
    await expect(
      f.service.resolveTaskBase(
        task(f, { chainBranch: null, startFrom: null })
      )
    ).resolves.toEqual({ baseRef: 'main', baseOid: f.mainOid })
  })
})
