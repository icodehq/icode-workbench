import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { makeRepositoryService, makeTempRoot, openTempDatabase } from '../persistence/persistence-test-fixtures'
import { WorktreeStore } from '../persistence/worktree-store'
import { GitWorktreeService } from '../worktrees/git-worktree-service'
import { GitWorkspaceService } from '../git/git-workspace-service'
import { MergeStore } from '../persistence/merge-store'
import { MergeService } from './merge-service'
import type { Database } from '../persistence/database'
import type { TempRoot } from '../persistence/persistence-test-fixtures'

export type MergeFixture = {
  root: TempRoot
  db: Database
  worktrees: WorktreeStore
  worktreeRoot: string
  repoPath: string
  repoId: string
  mainOid: string
  mergeStore: MergeStore
  merges: MergeService
  git: (cwd: string, args: string[]) => string
  writeAndCommit: (cwd: string, file: string, content: string, message: string) => void
  createSource: (
    branch: string,
    baseOid: string
  ) => Promise<{ sessionId: string; path: string; branch: string }>
  cleanup: () => void
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString().trim()
}

export async function makeRepoFixture(): Promise<MergeFixture> {
  const root = makeTempRoot('icode-merge-')
  const db = openTempDatabase(root)
  const stores = makeRepositoryService(db)
  const worktrees = new WorktreeStore(db)
  const worktreeRoot = join(root.dir, 'worktrees')
  mkdirSync(worktreeRoot, { recursive: true })
  const gitWorktrees = new GitWorktreeService({
    worktreeRoot,
    now: () => Date.now()
  })
  const gitWorkspace = new GitWorkspaceService({
    repositories: stores.repositories,
    worktrees,
    gitWorktrees,
    sessions: { get: async () => ({ state: 'exited' }) }
  })
  const mergeStore = new MergeStore(db)
  const merges = new MergeService({
    database: db,
    repositories: stores.repositories,
    worktrees,
    merges: mergeStore,
    gitWorktrees,
    gitWorkspace,
    now: () => Date.now(),
    newId: () => `merge_${randomUUID()}`,
    onChanged: () => undefined
  })

  const repoPath = join(root.dir, 'repo')
  mkdirSync(repoPath, { recursive: true })
  runGit(repoPath, ['init', '-q', '-b', 'main'])
  writeFileSync(join(repoPath, 'README.md'), 'base\n')
  runGit(repoPath, ['add', 'README.md'])
  runGit(repoPath, ['-c', 'user.email=icode@test', '-c', 'user.name=iCode', 'commit', '-qm', 'base'])
  const mainOid = runGit(repoPath, ['rev-parse', 'HEAD'])
  const added = await stores.service.addRepository(repoPath)
  const repoId = added.repository.id as string
  const workspace = stores.repositories.workspaceForRepo(added.repository.id)!

  const fixture: MergeFixture = {
    root,
    db,
    worktrees,
    worktreeRoot,
    repoPath,
    repoId,
    mainOid,
    mergeStore,
    merges,
    git: runGit,
    writeAndCommit: (cwd, file, content, message) => {
      writeFileSync(join(cwd, file), content)
      runGit(cwd, ['add', file])
      runGit(cwd, [
        '-c',
        'user.email=icode@test',
        '-c',
        'user.name=iCode',
        'commit',
        '-qm',
        message
      ])
    },
    createSource: async (branch, baseOid) => {
      const sessionId = `ses_${randomUUID()}`
      const path = join(worktreeRoot, sessionId)
      const now = Date.now()
      stores.sessions.insert({
        id: sessionId as never,
        workspaceId: workspace.id,
        harness: 'claude',
        title: 'test',
        role: 'interactive',
        createdAt: now,
        lastActiveAt: now,
        observation: {
          lastObservedState: 'exited',
          lastObservedExitCode: 0,
          lastObservedError: null,
          lastObservedIncarnationId: null,
          lastObservedAt: now
        }
      })
      worktrees.insert({
        sessionId: sessionId as never,
        repoId: added.repository.id,
        path,
        branch,
        baseRef: 'main',
        baseOid,
        state: 'ready',
        error: null,
        createdAt: now,
        updatedAt: now
      })
      worktrees.insertBranch({
        branch,
        repoId: added.repository.id,
        sessionId,
        taskId: null,
        kind: 'session',
        baseOid,
        createdAt: now
      })
      await gitWorktrees.create({ primaryRoot: repoPath, path, branch, baseOid })
      return { sessionId, path, branch }
    },
    cleanup: () => {
      db.close()
      try {
        runGit(repoPath, ['worktree', 'prune'])
      } catch {
        // best effort
      }
      rmSync(root.dir, { recursive: true, force: true })
      root.cleanup()
    }
  }
  return fixture
}
