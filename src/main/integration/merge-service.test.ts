import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { makeRepoFixture, type MergeFixture } from './merge-service-test-fixture'
import { MergeStore } from '../persistence/merge-store'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

async function setup(): Promise<MergeFixture> {
  const fixture = await makeRepoFixture()
  cleanups.push(fixture.cleanup)
  return fixture
}

describe('merge service', () => {
  it('fast-forwards the primary checkout and updates the review baseline', async () => {
    const f = await setup()
    const source = await f.createSource('session/one', f.mainOid)
    f.writeAndCommit(source.path, 'README.md', 'source change\n', 'source')

    const outcome = await f.merges.start({
      sessionId: source.sessionId,
      targetBranch: 'main'
    })

    expect(outcome.status).toBe('merged')
    expect(f.git(f.repoPath, ['rev-parse', 'main'])).toBe(
      f.git(source.path, ['rev-parse', 'HEAD'])
    )
    expect(f.worktrees.findBySession(source.sessionId)?.baseOid).toBe(f.mainOid)
    expect(f.mergeStore.latestForSession(source.sessionId)?.state).toBe('merged')
  })

  it('commits pending changes before merging', async () => {
    const f = await setup()
    const source = await f.createSource('session/one', f.mainOid)
    writeFileSync(join(source.path, 'pending.txt'), 'pending\n')

    const outcome = await f.merges.start({
      sessionId: source.sessionId,
      targetBranch: 'main',
      commitMessage: 'capture pending work'
    })

    expect(outcome.status).toBe('merged')
    expect(f.git(f.repoPath, ['show', 'main:pending.txt'])).toBe('pending')
    expect(f.mergeStore.latestForSession(source.sessionId)?.commitOid).not.toBeNull()
  })

  it('refuses a dirty primary checkout', async () => {
    const f = await setup()
    const source = await f.createSource('session/one', f.mainOid)
    f.writeAndCommit(source.path, 'README.md', 'source change\n', 'source')
    writeFileSync(join(f.repoPath, 'dirty.txt'), 'dirty\n')

    await expect(
      f.merges.start({ sessionId: source.sessionId, targetBranch: 'main' })
    ).rejects.toMatchObject({ appError: { code: 'WORKTREE_DIRTY' } })
    expect(f.git(f.repoPath, ['rev-parse', 'main'])).toBe(f.mainOid)
  })

  it('fast-forwards a target that is not checked out', async () => {
    const f = await setup()
    f.git(f.repoPath, ['branch', 'release', f.mainOid])
    const source = await f.createSource('session/one', f.mainOid)
    f.writeAndCommit(source.path, 'README.md', 'release change\n', 'release')

    const outcome = await f.merges.start({
      sessionId: source.sessionId,
      targetBranch: 'release'
    })

    expect(outcome.status).toBe('merged')
    expect(f.git(f.repoPath, ['rev-parse', 'release'])).toBe(
      f.git(source.path, ['rev-parse', 'HEAD'])
    )
  })

  it('pauses on a conflict, then continues after resolution', async () => {
    const f = await setup()
    const source = await f.createSource('session/one', f.mainOid)
    f.writeAndCommit(source.path, 'README.md', 'source\n', 'source')
    f.writeAndCommit(f.repoPath, 'README.md', 'main\n', 'main')

    const conflicted = await f.merges.start({
      sessionId: source.sessionId,
      targetBranch: 'main'
    })
    expect(conflicted.status).toBe('conflicted')
    expect(conflicted.record.conflictFiles).toContain('README.md')
    expect(f.mergeStore.latestForSession(source.sessionId)?.state).toBe('conflicted')

    writeFileSync(join(source.path, 'README.md'), 'resolved\n')
    f.git(source.path, ['add', 'README.md'])
    const continued = await f.merges.continueMerge(source.sessionId)

    expect(continued.status).toBe('merged')
    expect(f.git(f.repoPath, ['show', 'main:README.md'])).toBe('resolved')
  })

  it('aborts a conflict without touching the target', async () => {
    const f = await setup()
    const source = await f.createSource('session/one', f.mainOid)
    f.writeAndCommit(source.path, 'README.md', 'source\n', 'source')
    f.writeAndCommit(f.repoPath, 'README.md', 'main\n', 'main')

    const conflicted = await f.merges.start({
      sessionId: source.sessionId,
      targetBranch: 'main'
    })
    expect(conflicted.status).toBe('conflicted')
    const aborted = await f.merges.abort(source.sessionId)

    expect(aborted.state).toBe('aborted')
    expect(f.git(f.repoPath, ['show', 'main:README.md'])).toBe('main')
  })

  it('refuses a target checked out in another worktree', async () => {
    const f = await setup()
    f.git(f.repoPath, ['branch', 'target', f.mainOid])
    const targetPath = join(f.worktreeRoot, 'target-wt')
    f.git(f.repoPath, ['worktree', 'add', '-q', targetPath, 'target'])
    const source = await f.createSource('session/one', f.mainOid)
    f.writeAndCommit(source.path, 'README.md', 'source\n', 'source')

    await expect(
      f.merges.start({ sessionId: source.sessionId, targetBranch: 'target' })
    ).rejects.toMatchObject({ appError: { code: 'GIT_BRANCH_IN_USE' } })
  })
})

describe('merge store', () => {
  it('claims one active merge per session and per target', async () => {
    const f = await setup()
    const store = new MergeStore(f.db)
    const base = {
      repoId: f.repoId,
      sessionId: 'ses_one',
      taskId: null,
      sourceBranch: 'session/one',
      targetBranch: 'main',
      sourceOidBefore: f.mainOid,
      targetOidBefore: f.mainOid,
      now: 1
    }
    const first = store.claim({ ...base, id: randomUUID() })
    expect(first.kind).toBe('claimed')
    expect(store.claim({ ...base, id: randomUUID() }).kind).toBe('session-busy')
    expect(
      store.claim({ ...base, id: randomUUID(), sessionId: 'ses_two', sourceBranch: 'session/two' })
        .kind
    ).toBe('target-busy')
    store.markMerged(
      first.kind === 'claimed' ? first.record.id : '',
      {
        resultOid: f.mainOid,
        targetOidAfter: f.mainOid,
        reviewBaseOid: f.mainOid,
        commitOid: null,
        pushRemote: null,
        pushedAt: null,
        pushError: null
      },
      2
    )
    expect(
      store.claim({
        ...base,
        id: randomUUID(),
        sessionId: 'ses_two',
        sourceBranch: 'session/two'
      }).kind
    ).toBe('claimed')
  })
})
