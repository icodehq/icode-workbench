import { describe, expect, it, vi } from 'vitest'
import { parseRepoId } from '../../shared/domain/ids'
import type { ExecutionTarget } from '../../shared/domain/repository'
import {
  createWatchTargetResolvers,
  type GitWatchDetails,
  type WatchCheckoutRef,
  type WatchTargetResolverDeps
} from './target-resolution'

const REPO_ID = parseRepoId('repo_af0d7e50-a9a3-4761-9a56-d66d11377ee5')!
const LOCAL: ExecutionTarget = { kind: 'local' }
const WSL: ExecutionTarget = {
  kind: 'wsl',
  distro: 'Ubuntu-26.04',
  distroId: 'a7925834-54e3-402c-b40b-3d63ebf6bc4c'
}

function makeDeps(options: {
  worktree?: WatchCheckoutRef | null
  workspace?: WatchCheckoutRef | null
  target?: ExecutionTarget | null
  gitDetails?: GitWatchDetails | null
} = {}) {
  const watchTargetDetails = vi.fn(
    async (): Promise<GitWatchDetails | null> => options.gitDetails ?? null
  )
  const deps: WatchTargetResolverDeps = {
    worktrees: { findBySession: () => options.worktree ?? null },
    sessions: { sessionWorkspaceFor: () => options.workspace ?? null },
    repositories: {
      findById: () =>
        options.target === null ? null : { executionTarget: options.target ?? LOCAL }
    },
    gitWorkspace: { watchTargetDetails }
  }
  return { deps, watchTargetDetails }
}

const localGitDetails: GitWatchDetails = {
  worktreePath: '/repo/wt',
  gitDir: '/repo/wt/.git',
  target: LOCAL
}

describe('createWatchTargetResolvers', () => {
  it('resolves a local worktree for both watchers', async () => {
    const { deps, watchTargetDetails } = makeDeps({
      worktree: { repoId: REPO_ID, path: '/repo/wt' },
      gitDetails: localGitDetails
    })
    const resolvers = createWatchTargetResolvers(deps)

    await expect(resolvers.resolveFilesWatchTarget('ses_local')).resolves.toEqual({
      worktreePath: '/repo/wt'
    })
    await expect(resolvers.resolveGitWatchTarget('ses_local')).resolves.toEqual({
      worktreePath: '/repo/wt',
      gitDir: '/repo/wt/.git'
    })
    expect(watchTargetDetails).toHaveBeenCalledWith('ses_local')
  })

  it('resolves the primary checkout for a local default-checkout session', async () => {
    const { deps } = makeDeps({
      workspace: { repoId: REPO_ID, path: '/repo' },
      gitDetails: { worktreePath: '/repo', gitDir: '/repo/.git', target: LOCAL }
    })
    const resolvers = createWatchTargetResolvers(deps)

    await expect(resolvers.resolveFilesWatchTarget('ses_default')).resolves.toEqual({
      worktreePath: '/repo'
    })
    await expect(resolvers.resolveGitWatchTarget('ses_default')).resolves.toEqual({
      worktreePath: '/repo',
      gitDir: '/repo/.git'
    })
  })

  it('never watches a WSL worktree and never asks the guest to resolve it', async () => {
    const { deps, watchTargetDetails } = makeDeps({
      worktree: { repoId: REPO_ID, path: '/mnt/d/yibei' },
      target: WSL,
      // If this were ever consulted the resolver would be spending a guest call.
      gitDetails: { worktreePath: '/mnt/d/yibei', gitDir: '/mnt/d/yibei/.git', target: WSL }
    })
    const resolvers = createWatchTargetResolvers(deps)

    await expect(resolvers.resolveFilesWatchTarget('ses_wsl')).resolves.toBeNull()
    await expect(resolvers.resolveGitWatchTarget('ses_wsl')).resolves.toBeNull()
    expect(watchTargetDetails).not.toHaveBeenCalled()
  })

  it('never watches a WSL default checkout either', async () => {
    const { deps, watchTargetDetails } = makeDeps({
      workspace: { repoId: REPO_ID, path: '/mnt/d/yibei' },
      target: WSL
    })
    const resolvers = createWatchTargetResolvers(deps)

    await expect(resolvers.resolveFilesWatchTarget('ses_wsl_default')).resolves.toBeNull()
    await expect(resolvers.resolveGitWatchTarget('ses_wsl_default')).resolves.toBeNull()
    expect(watchTargetDetails).not.toHaveBeenCalled()
  })

  it('returns null for a missing session or repository', async () => {
    const missingSession = createWatchTargetResolvers(makeDeps().deps)
    await expect(missingSession.resolveFilesWatchTarget('ses_missing')).resolves.toBeNull()
    await expect(missingSession.resolveGitWatchTarget('ses_missing')).resolves.toBeNull()

    const missingRepo = createWatchTargetResolvers(
      makeDeps({ worktree: { repoId: REPO_ID, path: '/repo/wt' }, target: null }).deps
    )
    await expect(missingRepo.resolveFilesWatchTarget('ses_no_repo')).resolves.toBeNull()
    await expect(missingRepo.resolveGitWatchTarget('ses_no_repo')).resolves.toBeNull()
  })

  it('refuses a guest Git target even when the repository row says local', async () => {
    const { deps } = makeDeps({
      worktree: { repoId: REPO_ID, path: '/repo/wt' },
      gitDetails: { worktreePath: '/repo/wt', gitDir: '/repo/wt/.git', target: WSL }
    })
    const resolvers = createWatchTargetResolvers(deps)

    await expect(resolvers.resolveGitWatchTarget('ses_mismatch')).resolves.toBeNull()
    await expect(resolvers.resolveFilesWatchTarget('ses_mismatch')).resolves.toEqual({
      worktreePath: '/repo/wt'
    })
  })
})
