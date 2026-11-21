import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BranchService } from './branch-service'
import type { RemoteService } from './remote-service'
import { GitWorktreeService } from '../worktrees/git-worktree-service'
import { newRepoId } from '../../shared/domain/ids'
import type { RepositoryRecord } from '../../shared/domain/repository'
import type { RepositoryStore } from '../persistence/repository-store'
import type { WorktreeStore } from '../persistence/worktree-store'

const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function commit(cwd: string, message: string): string {
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
      '--allow-empty',
      '-qm',
      message
    ],
    { stdio: 'pipe' }
  )
  return git(cwd, 'rev-parse', 'HEAD')
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'icode-branch-svc-'))
  roots.push(root)
  const repo = join(root, 'atlas')
  mkdirSync(repo)
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  writeFileSync(join(repo, 'README.md'), '# atlas\n')
  git(repo, 'add', 'README.md')
  const baseOid = commit(repo, 'init')

  const id = newRepoId()
  const repository: RepositoryRecord = {
    id,
    path: repo as RepositoryRecord['path'],
    displayName: 'atlas',
    addedAt: 1,
    lastOpenedAt: 1,
    currentBranch: 'main',
    availability: 'present',
    gitCommonDir: join(repo, '.git') as RepositoryRecord['gitCommonDir'],
    executionTarget: { kind: 'local' },
    preparation: null
  }
  const repositories = {
    findById: (repoId: string) => (repoId === id ? repository : null)
  } as unknown as RepositoryStore
  const gitWorktrees = new GitWorktreeService({ worktreeRoot: join(root, 'worktrees') })
  const fetchTrackingRef = vi.fn(async (_repoId: string, input: { remote: string }) => ({
    status: 'ok' as const,
    name: input.remote
  }))
  const service = new BranchService({
    repositories,
    worktrees: {} as WorktreeStore,
    gitWorktrees,
    remotes: { fetchTrackingRef } as unknown as Pick<RemoteService, 'fetchTrackingRef'>
  })
  return { root, repo, id, baseOid, service, fetchTrackingRef }
}

function configureRemote(root: string, repo: string): void {
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', join(root, 'origin.git')])
}

describe('BranchService.listRefs', () => {
  it('lists local and remote refs, excludes symbolic remote HEAD, and separates collisions', async () => {
    const f = setup()
    git(f.repo, 'update-ref', 'refs/remotes/origin/feature', f.baseOid)
    git(f.repo, 'update-ref', 'refs/remotes/origin/main', f.baseOid)
    git(f.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    git(f.repo, 'branch', 'origin/feature', f.baseOid)

    const refs = await f.service.listRefs(f.id)

    const localFeature = refs.find((ref) => ref.fullName === 'refs/heads/origin/feature')
    const remoteFeature = refs.find((ref) => ref.fullName === 'refs/remotes/origin/feature')
    expect(localFeature).toMatchObject({
      name: 'origin/feature',
      kind: 'local',
      oid: f.baseOid
    })
    expect(remoteFeature).toMatchObject({
      name: 'origin/feature',
      kind: 'remote',
      oid: f.baseOid,
      primaryHead: false,
      worktreePath: null
    })
    expect(refs.find((ref) => ref.fullName === 'refs/remotes/origin/HEAD')).toBeUndefined()
    expect(refs[0]).toMatchObject({ name: 'main', primaryHead: true })
    expect(refs.findIndex((ref) => ref.kind === 'local')).toBeLessThan(
      refs.findIndex((ref) => ref.kind === 'remote')
    )
  })
})

describe('BranchService.resolveStartRef', () => {
  it('refreshes the selected remote-tracking ref before resolving', async () => {
    const f = setup()
    configureRemote(f.root, f.repo)
    git(f.repo, 'update-ref', 'refs/remotes/origin/feature', f.baseOid)
    const nextOid = commit(f.repo, 'next')
    f.fetchTrackingRef.mockImplementation(async () => {
      git(f.repo, 'update-ref', 'refs/remotes/origin/feature', nextOid)
      return { status: 'ok', name: 'origin' }
    })

    await expect(
      f.service.resolveStartRef(f.id, 'refs/remotes/origin/feature', {
        refreshRemote: true
      })
    ).resolves.toEqual({
      baseRef: 'refs/remotes/origin/feature',
      baseOid: nextOid,
      remoteTracking: {
        remote: 'origin',
        branch: 'feature',
        fullRef: 'refs/remotes/origin/feature'
      }
    })
    expect(f.fetchTrackingRef).toHaveBeenCalledWith(f.id, {
      remote: 'origin',
      branch: 'feature'
    })
  })

  it('falls back to the last fetched ref when the refresh fails', async () => {
    const f = setup()
    configureRemote(f.root, f.repo)
    git(f.repo, 'update-ref', 'refs/remotes/origin/feature', f.baseOid)
    f.fetchTrackingRef.mockRejectedValue(new Error('offline'))

    await expect(
      f.service.resolveStartRef(f.id, 'refs/remotes/origin/feature', {
        refreshRemote: true
      })
    ).resolves.toMatchObject({
      baseRef: 'refs/remotes/origin/feature',
      baseOid: f.baseOid
    })
  })

  it('returns null when the refresh fails and no tracking ref exists', async () => {
    const f = setup()
    configureRemote(f.root, f.repo)
    f.fetchTrackingRef.mockRejectedValue(new Error('offline'))

    await expect(
      f.service.resolveStartRef(f.id, 'refs/remotes/origin/feature', {
        refreshRemote: true
      })
    ).resolves.toBeNull()
  })

  it('resolves a stale explicit remote ref without a configured remote', async () => {
    const f = setup()
    git(f.repo, 'update-ref', 'refs/remotes/fork/feature', f.baseOid)

    await expect(f.service.resolveStartRef(f.id, 'refs/remotes/fork/feature')).resolves.toEqual({
      baseRef: 'refs/remotes/fork/feature',
      baseOid: f.baseOid,
      remoteTracking: null
    })
    expect(f.fetchTrackingRef).not.toHaveBeenCalled()
  })

  it('keeps bare names local-first, even when a remote branch shares the name', async () => {
    const f = setup()
    configureRemote(f.root, f.repo)
    const remoteOid = commit(f.repo, 'remote tip')
    git(f.repo, 'update-ref', 'refs/remotes/origin/feature', remoteOid)
    git(f.repo, 'branch', 'origin/feature', f.baseOid)

    await expect(f.service.resolveStartRef(f.id, 'origin/feature', { refreshRemote: true })).resolves.toEqual({
      baseRef: 'origin/feature',
      baseOid: f.baseOid,
      remoteTracking: null
    })
    expect(f.fetchTrackingRef).not.toHaveBeenCalled()
  })

  it('rejects other ref namespaces and invalid syntax', async () => {
    const f = setup()
    await expect(f.service.resolveStartRef(f.id, 'refs/tags/v1')).resolves.toBeNull()
    await expect(f.service.resolveStartRef(f.id, 'bad:ref')).resolves.toBeNull()
    await expect(f.service.resolveStartRef(f.id, 'refs/remotes/origin/HEAD')).resolves.toBeNull()
  })
})
