import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitWorkspaceService } from './git-workspace-service'
import { GitWorktreeService } from '../worktrees/git-worktree-service'
import { samePathResolved } from '../worktrees/worktree-status'
import { SessionService } from '../sessions/session-service'
import { FakeHostGateway } from '../sessions/fake-host-gateway'
import { makeRepositoryService, makeTempRoot, openTempDatabase } from '../persistence/persistence-test-fixtures'
import { WorktreeStore } from '../persistence/worktree-store'
import { newSessionId, toPtyIncarnationId } from '../../shared/domain/ids'

/**
 * Work 83: per-file staging, branch switching and push/pull safety.
 *
 * The invariant under test is that no operation loses a user's change. A dirty
 * worktree must be refused rather than carried across a branch switch, and a
 * missing upstream must produce a sentence the user can act on.
 *
 * Git is real; only the session row is seeded directly, because this suite is
 * about the Git service rather than session lifecycle.
 */

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function gitRaw(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
}

/** Mirrors the renderer's raw hunk splitter so the service consumes real patches. */
function splitPatch(patch: string): { header: string; hunks: string[] } {
  const lines = patch.split('\n')
  const starts: number[] = []
  for (const [index, line] of lines.entries()) if (line.startsWith('@@ ')) starts.push(index)
  if (starts.length === 0) return { header: patch, hunks: [] }
  return {
    header: lines.slice(0, starts[0]!).join('\n'),
    hunks: starts.map((start, index) => lines.slice(start, starts[index + 1] ?? lines.length).join('\n'))
  }
}

function noIndexDiff(cwd: string, path: string): string {
  try {
    return execFileSync(
      'git',
      ['-C', cwd, 'diff', '--no-index', '--no-color', '--', '/dev/null', path],
      { encoding: 'utf8' }
    )
  } catch (error) {
    return (error as { stdout?: string }).stdout ?? ''
  }
}

type Fixture = {
  service: GitWorkspaceService
  sessionId: string
  worktree: string
  branch: string
}

async function realRepo(): Promise<Fixture> {
  const root = makeTempRoot('icode-gitw-')
  const db = openTempDatabase(root)
  const stores = makeRepositoryService(db)
  const worktrees = new WorktreeStore(db)
  const gitWorktrees = new GitWorktreeService({ worktreeRoot: join(root.dir, 'worktrees') })
  // The session service is only needed to seed rows through the fixture; the
  // Git service under test reads the stores directly.
  void new SessionService({
    database: db,
    repositories: stores.repositories,
    sessions: stores.sessions,
    worktrees,
    gitWorktrees,
    host: new FakeHostGateway(),
    detectHarness: async () => ({
      state: 'available',
      harness: 'claude',
      version: '2.1.310',
      resolvedPath: '/usr/bin/claude',
      command: { command: '/usr/bin/claude', args: [] },
      diagnostics: {
        resolvedPath: '/usr/bin/claude',
        outcome: 'exited',
        exitCode: 0,
        signal: null,
        stdoutTail: '',
        stderrTail: '',
        durationMs: 1,
        observedAt: 1,
        attempts: 1
      }
    }),
    now: () => 1_700_000_000_000
  })

  const repoPath = join(root.dir, 'repo')
  mkdirSync(repoPath, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', repoPath], { stdio: 'pipe' })
  writeFileSync(join(repoPath, 'a.txt'), 'one\n')
  writeFileSync(join(repoPath, 'b.txt'), 'two\n')
  git(repoPath, 'add', '.')
  execFileSync(
    'git',
    ['-C', repoPath, '-c', 'user.email=w83@test', '-c', 'user.name=W83', 'commit', '-qm', 'init'],
    { stdio: 'pipe' }
  )
  const baseOid = git(repoPath, 'rev-parse', 'HEAD')
  const added = await stores.service.addRepository(repoPath)

  const sessionId = newSessionId()
  const worktreePath = join(root.dir, 'worktrees', 'wt')
  const branch = 'icode/w83'
  mkdirSync(join(root.dir, 'worktrees'), { recursive: true })
  execFileSync('git', ['-C', repoPath, 'worktree', 'add', '-q', '-b', branch, worktreePath, baseOid], {
    stdio: 'pipe'
  })

  const workspace = stores.repositories.workspaceForRepo(added.repository.id)!
  stores.sessions.insert({
    id: sessionId,
    workspaceId: workspace.id,
    harness: 'claude',
    title: 'git workspace',
    createdAt: 1,
    lastActiveAt: 1,
    observation: {
      lastObservedState: 'exited',
      lastObservedExitCode: 0,
      lastObservedError: null,
      lastObservedIncarnationId: toPtyIncarnationId('inc_w83_0001'),
      lastObservedAt: 1
    }
  })
  worktrees.insert({
    sessionId,
    repoId: added.repository.id,
    path: worktreePath,
    branch,
    baseRef: 'main',
    baseOid,
    state: 'ready',
    error: null,
    createdAt: 1,
    updatedAt: 1
  })

  cleanups.push(() => {
    db.close()
    rmSync(root.dir, { recursive: true, force: true })
    root.cleanup()
  })

  return {
    service: new GitWorkspaceService({
      repositories: stores.repositories,
      worktrees,
      gitWorktrees
    }),
    sessionId,
    worktree: worktreePath,
    branch
  }
}

describe('git workspace: workflow operations', () => {
  it('stages and unstages one path without touching the others', async () => {
    const f = await realRepo()
    writeFileSync(join(f.worktree, 'a.txt'), 'changed\n')
    writeFileSync(join(f.worktree, 'b.txt'), 'also changed\n')

    const staged = await f.service.setPathStaged(f.sessionId, 'a.txt', true)
    expect(staged).toMatchObject({ status: 'ok', path: 'a.txt', staged: true })
    expect(git(f.worktree, 'diff', '--cached', '--name-only')).toBe('a.txt')
    expect(git(f.worktree, 'diff', '--name-only')).toBe('b.txt')

    const unstaged = await f.service.setPathStaged(f.sessionId, 'a.txt', false)
    expect(unstaged).toMatchObject({ status: 'ok', staged: false })
    expect(git(f.worktree, 'diff', '--cached', '--name-only')).toBe('')
    expect(git(f.worktree, 'diff', '--name-only').split('\n').sort()).toEqual(['a.txt', 'b.txt'])
  })

  it('stages a brand-new file too', async () => {
    const f = await realRepo()
    writeFileSync(join(f.worktree, 'fresh.txt'), 'new\n')
    expect(await f.service.setPathStaged(f.sessionId, 'fresh.txt', true)).toMatchObject({ status: 'ok' })
    expect(git(f.worktree, 'diff', '--cached', '--name-only')).toBe('fresh.txt')
  })

  it('lists every file inside a new untracked directory and stages it by path', async () => {
    const f = await realRepo()
    mkdirSync(join(f.worktree, 'newdir'), { recursive: true })
    writeFileSync(join(f.worktree, 'newdir', 'deep.txt'), 'new\n')

    const status = await f.service.status(f.sessionId)
    expect(status.status).toBe('ok')
    if (status.status === 'ok') {
      expect(status.snapshot.untracked.map((entry) => entry.path)).toContain('newdir/deep.txt')
    }

    expect(await f.service.setPathStaged(f.sessionId, 'newdir/deep.txt', true)).toMatchObject({
      status: 'ok'
    })
    expect(git(f.worktree, 'diff', '--cached', '--name-only')).toBe('newdir/deep.txt')
  })

  it('refuses to stage a path Git does not report', async () => {
    const f = await realRepo()
    const result = await f.service.setPathStaged(f.sessionId, 'nope.txt', true)
    expect(result).toMatchObject({ status: 'unavailable', reason: 'not-found' })
  })

  it('commits every tracked change with sign-off in one call', async () => {
    const f = await realRepo()
    git(f.worktree, 'config', 'user.email', 'w83@test')
    git(f.worktree, 'config', 'user.name', 'W83')
    writeFileSync(join(f.worktree, 'a.txt'), 'changed\n')
    writeFileSync(join(f.worktree, 'b.txt'), 'also changed\n')

    const committed = await f.service.commit(f.sessionId, 'Commit everything', {
      all: true,
      signOff: true
    })
    expect(committed.status).toBe('ok')
    expect(git(f.worktree, 'status', '--porcelain')).toBe('')
    expect(git(f.worktree, 'log', '-1', '--pretty=%B')).toContain(
      'Signed-off-by: W83 <w83@test>'
    )
  })

  it('refuses a commit when neither the index nor tracked files changed', async () => {
    const f = await realRepo()
    const committed = await f.service.commit(f.sessionId, 'Nothing to do', { all: true })
    expect(committed).toMatchObject({ status: 'unavailable', reason: 'nothing-to-commit' })
  })

  it('lists branches and switches to a clean one', async () => {
    const f = await realRepo()
    git(f.worktree, 'branch', 'other')

    const branches = await f.service.branches(f.sessionId)
    expect(branches.status).toBe('ok')
    if (branches.status === 'ok') {
      expect(branches.names).toEqual(expect.arrayContaining(['other']))
      expect(branches.current).toBe(f.branch)
    }

    const switched = await f.service.switchBranch(f.sessionId, 'other')
    expect(switched).toMatchObject({ status: 'ok', branch: 'other' })
    expect(git(f.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('other')
  })

  it('refuses to switch a dirty worktree and preserves the changes', async () => {
    const f = await realRepo()
    git(f.worktree, 'branch', 'other')
    writeFileSync(join(f.worktree, 'a.txt'), 'uncommitted work\n')

    const result = await f.service.switchBranch(f.sessionId, 'other')
    expect(result).toMatchObject({ status: 'unavailable', reason: 'dirty-worktree' })
    if (result.status === 'unavailable') expect(result.detail).toContain('a.txt')
    // Still on the original branch, with the edit intact.
    expect(git(f.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(f.branch)
    expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('uncommitted work\n')
  })

  it('refuses to switch to the branch it is already on', async () => {
    const f = await realRepo()
    const result = await f.service.switchBranch(f.sessionId, f.branch)
    expect(result.status).toBe('unavailable')
  })

  it('explains a missing upstream instead of failing opaquely', async () => {
    const f = await realRepo()
    const push = await f.service.push(f.sessionId)
    expect(push).toMatchObject({ status: 'unavailable', reason: 'no-upstream' })
    if (push.status === 'unavailable') expect(push.detail).toContain('git push -u')

    const pull = await f.service.pull(f.sessionId)
    expect(pull).toMatchObject({ status: 'unavailable', reason: 'no-upstream' })
  })

  it('reports a missing remote when an upstream is configured but no remote exists', async () => {
    const f = await realRepo()
    // An upstream ref that exists locally but has no remote behind it.
    git(f.worktree, 'config', `branch.${f.branch}.remote`, '.')
    git(f.worktree, 'config', `branch.${f.branch}.merge`, `refs/heads/${f.branch}`)
    const push = await f.service.push(f.sessionId)
    expect(push.status).toBe('unavailable')
    if (push.status === 'unavailable') expect(['no-remote', 'git-failed']).toContain(push.reason)
  })
})

describe('git workspace: inspection and history operations', () => {
  it('reads recent commits newest first', async () => {
    const f = await realRepo()
    writeFileSync(join(f.worktree, 'a.txt'), 'changed\n')
    execFileSync('git', [
      '-C',
      f.worktree,
      '-c',
      'user.email=w83@test',
      '-c',
      'user.name=W83',
      'commit',
      '-qam',
      'Fix the fixture'
    ])

    const history = await f.service.history(f.sessionId, 10)
    expect(history.status).toBe('ok')
    if (history.status !== 'ok') return
    expect(history.branch).toBe(f.branch)
    expect(history.commits[0]).toMatchObject({ subject: 'Fix the fixture', author: 'W83' })
    expect(history.commits[0]?.oid).toHaveLength(7)
  })

  it('pages the History feed with full parents and ref decorations', async () => {
    const f = await realRepo()
    git(f.worktree, 'config', 'user.email', 'w83@test')
    git(f.worktree, 'config', 'user.name', 'W83')
    writeFileSync(join(f.worktree, 'a.txt'), 'first change\n')
    git(f.worktree, 'commit', '-qam', 'first')
    writeFileSync(join(f.worktree, 'b.txt'), 'second change\n')
    git(f.worktree, 'commit', '-qam', 'second')

    const first = await f.service.log(f.sessionId, { limit: 2, skip: 0 })
    expect(first.status).toBe('ok')
    if (first.status !== 'ok') return
    expect(first.commits.map((commit) => commit.subject)).toEqual(['second', 'first'])
    expect(first.hasMore).toBe(true)
    expect(first.nextSkip).toBe(2)
    expect(first.headOid).toBe(git(f.worktree, 'rev-parse', 'HEAD'))
    expect(first.commits[0]?.refs.join(' ')).toContain(f.branch)
    expect(first.commits[0]?.parents).toHaveLength(1)
    expect(first.commits[0]?.parents[0]).toHaveLength(40)

    const second = await f.service.log(f.sessionId, { limit: 2, skip: first.nextSkip })
    expect(second.status).toBe('ok')
    if (second.status !== 'ok') return
    expect(second.commits.map((commit) => commit.subject)).toEqual(['init'])
    expect(second.hasMore).toBe(false)
    expect(second.commits[0]?.parents).toEqual([])
  })

  it('reports upstream ahead/behind and can include every ref', async () => {
    const f = await realRepo()
    git(f.worktree, 'config', 'user.email', 'w83@test')
    git(f.worktree, 'config', 'user.name', 'W83')
    const bare = join(f.worktree, '..', 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', bare], { stdio: 'pipe' })
    git(f.worktree, 'remote', 'add', 'origin', bare)
    git(f.worktree, 'push', '-q', '-u', 'origin', f.branch)

    writeFileSync(join(f.worktree, 'a.txt'), 'local only\n')
    git(f.worktree, 'commit', '-qam', 'local only')
    const page = await f.service.log(f.sessionId, { limit: 5 })
    expect(page.status).toBe('ok')
    if (page.status !== 'ok') return
    expect(page.upstream).toBe(`origin/${f.branch}`)
    expect(page.ahead).toBe(1)
    expect(page.behind).toBe(0)

    git(f.worktree, 'checkout', '-q', '-b', 'side', 'HEAD~1')
    writeFileSync(join(f.worktree, 'b.txt'), 'side only\n')
    git(f.worktree, 'commit', '-qam', 'side only')
    git(f.worktree, 'checkout', '-q', f.branch)

    const headOnly = await f.service.log(f.sessionId, { limit: 10 })
    expect(headOnly.status).toBe('ok')
    if (headOnly.status !== 'ok') return
    expect(headOnly.commits.some((commit) => commit.subject === 'side only')).toBe(false)

    const all = await f.service.log(f.sessionId, { limit: 10, allRefs: true })
    expect(all.status).toBe('ok')
    if (all.status !== 'ok') return
    expect(all.commits.some((commit) => commit.subject === 'side only')).toBe(true)
  })

  it('reads a commit detail with first-parent files and stats', async () => {
    const f = await realRepo()
    git(f.worktree, 'config', 'user.email', 'w83@test')
    git(f.worktree, 'config', 'user.name', 'W83')
    writeFileSync(join(f.worktree, 'a.txt'), 'first change\n')
    git(f.worktree, 'commit', '-qam', 'first')
    const firstOid = git(f.worktree, 'rev-parse', 'HEAD')
    writeFileSync(join(f.worktree, 'b.txt'), 'second change\n')
    git(f.worktree, 'commit', '-qam', 'second subject\n\nsecond body line')
    const secondOid = git(f.worktree, 'rev-parse', 'HEAD')

    const detail = await f.service.commitDetail(f.sessionId, secondOid)
    expect(detail.status).toBe('ok')
    if (detail.status !== 'ok') return
    expect(detail.subject).toBe('second subject')
    expect(detail.body).toContain('second body line')
    expect(detail.parentOid).toBe(firstOid)
    expect(detail.files.map((file) => file.path)).toEqual(['b.txt'])
    expect(detail.files[0]).toMatchObject({ status: 'modified', additions: 1, deletions: 1 })
    expect(detail.additions).toBe(1)
    expect(detail.deletions).toBe(1)
  })

  it('diffs a root commit against the empty tree', async () => {
    const f = await realRepo()
    const root = git(f.worktree, 'rev-parse', 'HEAD')
    const detail = await f.service.commitDetail(f.sessionId, root)
    expect(detail.status).toBe('ok')
    if (detail.status !== 'ok') return
    expect(detail.parentOid).toBeNull()
    expect(detail.parents).toEqual([])
    expect(detail.files.map((file) => file.path).sort()).toEqual(['a.txt', 'b.txt'])
    expect(detail.files.every((file) => file.status === 'added')).toBe(true)
    expect(detail.additions).toBe(2)
  })

  it('rejects unsafe History refs, paths and commit ids', async () => {
    const f = await realRepo()
    expect(await f.service.log(f.sessionId, { ref: '-n1' })).toMatchObject({
      status: 'unavailable'
    })
    expect(await f.service.log(f.sessionId, { path: '../escape' })).toMatchObject({
      status: 'unavailable'
    })
    expect(await f.service.commitDetail(f.sessionId, '--help')).toMatchObject({
      status: 'unavailable'
    })
  })

  it('reads line blame and marks uncommitted lines', async () => {
    const f = await realRepo()
    const committed = await f.service.blame(f.sessionId, 'a.txt')
    expect(committed.status).toBe('ok')
    if (committed.status !== 'ok') return
    expect(committed.lines).toHaveLength(1)
    expect(committed.lines[0]).toMatchObject({ line: 1, committed: true })
    expect(committed.lines[0]?.oid).toHaveLength(40)

    writeFileSync(join(f.worktree, 'a.txt'), 'working change\n')
    const working = await f.service.blame(f.sessionId, 'a.txt')
    expect(working.status).toBe('ok')
    if (working.status !== 'ok') return
    expect(working.lines[0]).toMatchObject({ line: 1, committed: false })
    expect(await f.service.blame(f.sessionId, '../escape')).toMatchObject({
      status: 'unavailable'
    })
  })

  it('reads a file at HEAD with binary and size guards', async () => {
    const f = await realRepo()
    const head = await f.service.fileAtRevision(f.sessionId, 'HEAD', 'a.txt')
    expect(head).toMatchObject({ status: 'ok', rev: 'HEAD', binary: false, tooLarge: false })
    if (head.status === 'ok') {
      expect(head.text).toBe('one\n')
      expect(head.oid).toHaveLength(40)
    }

    git(f.worktree, 'config', 'user.email', 'w83@test')
    git(f.worktree, 'config', 'user.name', 'W83')
    writeFileSync(join(f.worktree, 'binary.bin'), Buffer.from([0, 1, 2, 3]))
    writeFileSync(join(f.worktree, 'huge.txt'), 'x'.repeat(2 * 1024 * 1024 + 10))
    git(f.worktree, 'add', 'binary.bin', 'huge.txt')
    git(f.worktree, 'commit', '-qm', 'guards')

    const binary = await f.service.fileAtRevision(f.sessionId, 'HEAD', 'binary.bin')
    expect(binary).toMatchObject({ status: 'ok', binary: true, tooLarge: false })
    const huge = await f.service.fileAtRevision(f.sessionId, 'HEAD', 'huge.txt')
    expect(huge).toMatchObject({ status: 'ok', binary: false, tooLarge: true })
    expect(await f.service.fileAtRevision(f.sessionId, 'HEAD', 'missing.txt')).toMatchObject({
      status: 'unavailable'
    })
    expect(await f.service.fileAtRevision(f.sessionId, '-n1', 'a.txt')).toMatchObject({
      status: 'unavailable'
    })
  })

  it('reads stage 0 of the index for a split working-tree diff', async () => {
    const f = await realRepo()
    writeFileSync(join(f.worktree, 'a.txt'), 'staged change\n')
    git(f.worktree, 'add', 'a.txt')
    const staged = await f.service.indexFile(f.sessionId, 'a.txt')
    expect(staged).toMatchObject({ status: 'ok', path: 'a.txt', binary: false, tooLarge: false })
    if (staged.status === 'ok') expect(staged.text).toBe('staged change\n')

    // The worktree can move ahead of the index; this API must keep reading the
    // staged blob so an unstaged diff's pre-image is stable.
    writeFileSync(join(f.worktree, 'a.txt'), 'working change\n')
    const stillStaged = await f.service.indexFile(f.sessionId, 'a.txt')
    if (stillStaged.status === 'ok') expect(stillStaged.text).toBe('staged change\n')

    writeFileSync(join(f.worktree, 'untracked.txt'), 'not added\n')
    expect(await f.service.indexFile(f.sessionId, 'untracked.txt')).toMatchObject({
      status: 'unavailable'
    })
    writeFileSync(join(f.worktree, 'binary.bin'), Buffer.from([0, 1, 2, 3]))
    git(f.worktree, 'add', 'binary.bin')
    expect(await f.service.indexFile(f.sessionId, 'binary.bin')).toMatchObject({
      status: 'ok',
      binary: true
    })
    expect(await f.service.indexFile(f.sessionId, '../escape')).toMatchObject({
      status: 'unavailable'
    })
    expect(await f.service.indexFile(f.sessionId, '-n1')).toMatchObject({ status: 'unavailable' })
  })

  it('stages and unstages one hunk without touching the other side', async () => {
    const f = await realRepo()
    git(f.worktree, 'config', 'user.email', 'w83@test')
    git(f.worktree, 'config', 'user.name', 'W83')
    const lines = Array.from({ length: 20 }, (_, index) => `line ${String(index + 1)}`)
    writeFileSync(join(f.worktree, 'a.txt'), `${lines.join('\n')}\n`)
    git(f.worktree, 'add', 'a.txt')
    git(f.worktree, 'commit', '-qm', 'twenty lines')
    lines[1] = 'line 2 changed'
    lines[17] = 'line 18 changed'
    writeFileSync(join(f.worktree, 'a.txt'), `${lines.join('\n')}\n`)

    const patch = gitRaw(f.worktree, 'diff', '--', 'a.txt')
    const split = splitPatch(patch)
    expect(split.hunks).toHaveLength(2)
    const first = `${split.header}\n${split.hunks[0]!}`

    const staged = await f.service.applyPatch(f.sessionId, first, 'a.txt', 'stage')
    expect(staged).toMatchObject({ status: 'ok', mode: 'stage', path: 'a.txt' })
    const cached = gitRaw(f.worktree, 'diff', '--cached', '--', 'a.txt')
    expect(cached).toContain('line 2 changed')
    expect(cached).not.toContain('line 18 changed')
    expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toContain('line 18 changed')

    // Applying the same hunk again is stale: Git rejects it rather than
    // duplicating the change or overwriting the second hunk.
    await expect(f.service.applyPatch(f.sessionId, first, 'a.txt', 'stage')).resolves.toMatchObject({
      status: 'unavailable'
    })

    const cachedPatch = gitRaw(f.worktree, 'diff', '--cached', '--', 'a.txt')
    const cachedSplit = splitPatch(cachedPatch)
    expect(cachedSplit.hunks).toHaveLength(1)
    const unstaged = await f.service.applyPatch(
      f.sessionId,
      `${cachedSplit.header}\n${cachedSplit.hunks[0]!}`,
      'a.txt',
      'unstage'
    )
    expect(unstaged).toMatchObject({ status: 'ok', mode: 'unstage' })
    expect(gitRaw(f.worktree, 'diff', '--cached', '--', 'a.txt')).toBe('')

    const remaining = splitPatch(gitRaw(f.worktree, 'diff', '--', 'a.txt'))
    expect(remaining.hunks).toHaveLength(2)
    const discarded = await f.service.applyPatch(
      f.sessionId,
      `${remaining.header}\n${remaining.hunks[0]!}`,
      'a.txt',
      'discard'
    )
    expect(discarded).toMatchObject({ status: 'ok', mode: 'discard' })
    const afterDiscard = readFileSync(join(f.worktree, 'a.txt'), 'utf8')
    expect(afterDiscard).toContain('\nline 2\n')
    expect(afterDiscard).not.toContain('line 2 changed')
    expect(afterDiscard).toContain('line 18 changed')
    expect(gitRaw(f.worktree, 'diff', '--cached', '--', 'a.txt')).toBe('')
  })

  it('stages an untracked file hunk and rejects a mismatched path', async () => {
    const f = await realRepo()
    writeFileSync(join(f.worktree, 'new.txt'), 'hello\nworld\n')
    const patch = noIndexDiff(f.worktree, 'new.txt')
    expect(patch).toContain('@@ -0,0 +1,2 @@')

    await expect(f.service.applyPatch(f.sessionId, patch, 'other.txt', 'stage')).resolves.toMatchObject({
      status: 'unavailable'
    })
    const staged = await f.service.applyPatch(f.sessionId, patch, 'new.txt', 'stage')
    expect(staged).toMatchObject({ status: 'ok' })
    expect(git(f.worktree, 'ls-files', '--error-unmatch', '--', 'new.txt')).toBe('new.txt')
    expect(readFileSync(join(f.worktree, 'new.txt'), 'utf8')).toBe('hello\nworld\n')

    // The reverse of a `new file mode` patch unstages the file without touching it.
    const cached = splitPatch(gitRaw(f.worktree, 'diff', '--cached', '--', 'new.txt'))
    const unstaged = await f.service.applyPatch(
      f.sessionId,
      `${cached.header}\n${cached.hunks[0]!}`,
      'new.txt',
      'unstage'
    )
    expect(unstaged).toMatchObject({ status: 'ok', mode: 'unstage' })
    expect(gitRaw(f.worktree, 'diff', '--cached', '--', 'new.txt')).toBe('')
    expect(readFileSync(join(f.worktree, 'new.txt'), 'utf8')).toBe('hello\nworld\n')

    await expect(
      f.service.applyPatch(f.sessionId, patch, 'new.txt', 'discard')
    ).resolves.toMatchObject({ status: 'unavailable' })
  })

  it('refuses multi-file, rename and submodule patches', async () => {
    const f = await realRepo()
    const multi = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-one',
      '+ONE',
      'diff --git a/b.txt b/b.txt',
      '--- a/b.txt',
      '+++ b/b.txt',
      '@@ -1 +1 @@',
      '-two',
      '+TWO',
      ''
    ].join('\n')
    await expect(f.service.applyPatch(f.sessionId, multi, 'a.txt', 'stage')).resolves.toMatchObject({
      status: 'unavailable'
    })

    const rename = [
      'diff --git a/a.txt b/c.txt',
      'similarity index 100%',
      'rename from a.txt',
      'rename to c.txt',
      '--- a/a.txt',
      '+++ b/c.txt',
      '@@ -1 +1 @@',
      '-one',
      '+ONE',
      ''
    ].join('\n')
    await expect(f.service.applyPatch(f.sessionId, rename, 'a.txt', 'stage')).resolves.toMatchObject({
      status: 'unavailable'
    })

    const submodule = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-Subproject commit 1111111',
      '+Subproject commit 2222222',
      ''
    ].join('\n')
    await expect(
      f.service.applyPatch(f.sessionId, submodule, 'a.txt', 'stage')
    ).resolves.toMatchObject({ status: 'unavailable' })
  })

  it('reads one file between revisions and counts its lines', async () => {
    const f = await realRepo()
    git(f.worktree, 'config', 'user.email', 'w83@test')
    git(f.worktree, 'config', 'user.name', 'W83')
    writeFileSync(join(f.worktree, 'a.txt'), 'first change\n')
    git(f.worktree, 'commit', '-qam', 'first')
    const first = git(f.worktree, 'rev-parse', 'HEAD')
    writeFileSync(join(f.worktree, 'a.txt'), 'second change\n')
    git(f.worktree, 'commit', '-qam', 'second')
    const second = git(f.worktree, 'rev-parse', 'HEAD')

    const diff = await f.service.revisionFileDiff(f.sessionId, first, second, 'a.txt')
    expect(diff.status).toBe('ok')
    if (diff.status !== 'ok') return
    expect(diff.patch).toContain('-first change')
    expect(diff.patch).toContain('+second change')
    expect(diff.additions).toBe(1)
    expect(diff.deletions).toBe(1)
    expect(diff.binary).toBe(false)
    expect(diff.truncated).toBe(false)

    expect(
      await f.service.revisionFileDiff(f.sessionId, first, second, '../escape')
    ).toMatchObject({ status: 'unavailable' })
    expect(
      await f.service.revisionFileDiff(f.sessionId, '-n1', second, 'a.txt')
    ).toMatchObject({ status: 'unavailable' })
  })

  it('counts a removed line that begins with dashes', async () => {
    const f = await realRepo()
    git(f.worktree, 'config', 'user.email', 'w83@test')
    git(f.worktree, 'config', 'user.name', 'W83')
    writeFileSync(join(f.worktree, 'a.txt'), 'keep\n--dash line\n')
    git(f.worktree, 'commit', '-qam', 'add dashed line')
    writeFileSync(join(f.worktree, 'a.txt'), 'keep\n')
    git(f.worktree, 'commit', '-qam', 'remove dashed line')

    const diff = await f.service.revisionFileDiff(f.sessionId, 'HEAD^', 'HEAD', 'a.txt')
    expect(diff.status).toBe('ok')
    if (diff.status !== 'ok') return
    expect(diff.deletions).toBe(1)
    expect(diff.additions).toBe(0)
  })

  it('reports a binary file instead of fabricating a text patch', async () => {
    const f = await realRepo()
    git(f.worktree, 'config', 'user.email', 'w83@test')
    git(f.worktree, 'config', 'user.name', 'W83')
    writeFileSync(join(f.worktree, 'a.txt'), Buffer.from([0, 1, 2, 3, 0, 255]))
    git(f.worktree, 'commit', '-qam', 'binary')

    const diff = await f.service.revisionFileDiff(f.sessionId, 'HEAD^', 'HEAD', 'a.txt')
    expect(diff.status).toBe('ok')
    if (diff.status !== 'ok') return
    expect(diff.binary).toBe(true)
    expect(diff.additions).toBeNull()
    expect(diff.deletions).toBeNull()
  })

  it('creates a local branch at HEAD without switching the checkout', async () => {
    const f = await realRepo()
    const created = await f.service.createBranch(f.sessionId, 'review/next')
    expect(created).toMatchObject({ status: 'ok', branch: 'review/next' })
    expect(git(f.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(f.branch)
    expect(git(f.worktree, 'branch', '--list', 'review/next')).toContain('review/next')

    const duplicate = await f.service.createBranch(f.sessionId, 'review/next')
    expect(duplicate.status).toBe('unavailable')
  })

  it('creates a branch at an older commit and a local tag', async () => {
    const f = await realRepo()
    git(f.worktree, 'config', 'user.email', 'w83@test')
    git(f.worktree, 'config', 'user.name', 'W83')
    writeFileSync(join(f.worktree, 'a.txt'), 'first change\n')
    git(f.worktree, 'commit', '-qam', 'first')
    const first = git(f.worktree, 'rev-parse', 'HEAD')
    writeFileSync(join(f.worktree, 'a.txt'), 'second change\n')
    git(f.worktree, 'commit', '-qam', 'second')

    const branch = await f.service.createBranch(f.sessionId, 'review/older', first)
    expect(branch).toMatchObject({ status: 'ok', branch: 'review/older' })
    expect(git(f.worktree, 'rev-parse', 'review/older')).toBe(first)

    const tag = await f.service.createTag(f.sessionId, 'v-test', first)
    expect(tag).toMatchObject({ status: 'ok', name: 'v-test', oid: first })
    expect(git(f.worktree, 'tag', '--list', 'v-test')).toBe('v-test')

    const duplicate = await f.service.createTag(f.sessionId, 'v-test', first)
    expect(duplicate.status).toBe('unavailable')
    const invalid = await f.service.createTag(f.sessionId, 'bad name', first)
    expect(invalid.status).toBe('unavailable')
  })

  it('renames and deletes merged branches but refuses the current branch', async () => {
    const f = await realRepo()
    const created = await f.service.createBranch(f.sessionId, 'old-name')
    expect(created.status).toBe('ok')

    const renamed = await f.service.renameBranch(f.sessionId, 'old-name', 'new-name')
    expect(renamed).toMatchObject({ status: 'ok', from: 'old-name', branch: 'new-name' })
    expect(git(f.worktree, 'branch', '--list', 'old-name')).toBe('')
    expect(git(f.worktree, 'branch', '--list', 'new-name')).toContain('new-name')

    const deleted = await f.service.deleteBranch(f.sessionId, 'new-name')
    expect(deleted).toMatchObject({ status: 'ok', branch: 'new-name' })
    expect(git(f.worktree, 'branch', '--list', 'new-name')).toBe('')
    expect(await f.service.deleteBranch(f.sessionId, f.branch)).toMatchObject({
      status: 'unavailable'
    })
  })

  it('refuses to delete a branch with unmerged commits', async () => {
    const f = await realRepo()
    git(f.worktree, 'config', 'user.email', 'w83@test')
    git(f.worktree, 'config', 'user.name', 'W83')
    git(f.worktree, 'checkout', '-q', '-b', 'unmerged')
    writeFileSync(join(f.worktree, 'b.txt'), 'unmerged work\n')
    git(f.worktree, 'commit', '-qam', 'unmerged work')
    git(f.worktree, 'checkout', '-q', f.branch)

    expect(await f.service.deleteBranch(f.sessionId, 'unmerged')).toMatchObject({
      status: 'unavailable'
    })
    expect(git(f.worktree, 'branch', '--list', 'unmerged')).toContain('unmerged')
  })

  it('merges a local branch and leaves a conflict marker on refusal', async () => {
    const f = await realRepo()
    git(f.worktree, 'config', 'user.email', 'w83@test')
    git(f.worktree, 'config', 'user.name', 'W83')
    const base = git(f.worktree, 'rev-parse', 'HEAD')

    git(f.worktree, 'checkout', '-q', '-b', 'feature')
    writeFileSync(join(f.worktree, 'b.txt'), 'feature work\n')
    git(f.worktree, 'commit', '-qam', 'feature work')
    git(f.worktree, 'checkout', '-q', f.branch)
    const merged = await f.service.mergeBranch(f.sessionId, 'feature')
    expect(merged).toMatchObject({ status: 'ok', branch: 'feature' })
    expect(readFileSync(join(f.worktree, 'b.txt'), 'utf8')).toBe('feature work\n')

    git(f.worktree, 'checkout', '-q', '-b', 'conflict', base)
    writeFileSync(join(f.worktree, 'a.txt'), 'conflict side\n')
    git(f.worktree, 'commit', '-qam', 'conflict side')
    git(f.worktree, 'checkout', '-q', f.branch)
    writeFileSync(join(f.worktree, 'a.txt'), 'current side\n')
    git(f.worktree, 'commit', '-qam', 'current side')

    const conflicted = await f.service.mergeBranch(f.sessionId, 'conflict')
    expect(conflicted.status).toBe('unavailable')
    const state = await f.service.operationState(f.sessionId)
    if (state.status === 'ok') expect(state.operation).toBe('merge')
    expect(await f.service.abortOperation(f.sessionId)).toMatchObject({ status: 'ok' })
  })

  it('reads submodule state and initializes, updates, syncs and stages pointers', async () => {
    const f = await realRepo()
    git(f.worktree, 'config', 'user.email', 'w83@test')
    git(f.worktree, 'config', 'user.name', 'W83')
    const subrepo = join(f.worktree, '..', 'sub-repo')
    mkdirSync(subrepo, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main', subrepo], { stdio: 'pipe' })
    writeFileSync(join(subrepo, 'lib.txt'), 'submodule one\n')
    execFileSync(
      'git',
      ['-C', subrepo, '-c', 'user.email=w83@test', '-c', 'user.name=W83', 'add', '.'],
      { stdio: 'pipe' }
    )
    execFileSync(
      'git',
      [
        '-C',
        subrepo,
        '-c',
        'user.email=w83@test',
        '-c',
        'user.name=W83',
        'commit',
        '-qm',
        'sub init'
      ],
      { stdio: 'pipe' }
    )
    execFileSync(
      'git',
      [
        '-C',
        f.worktree,
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        subrepo,
        'vendor/lib'
      ],
      { stdio: 'pipe' }
    )
    git(f.worktree, 'add', '.gitmodules', 'vendor/lib')
    git(f.worktree, 'commit', '-qm', 'add submodule')

    const clean = await f.service.submoduleStatus(f.sessionId)
    expect(clean.status).toBe('ok')
    if (clean.status === 'ok') {
      expect(clean.submodules).toMatchObject([{ path: 'vendor/lib', state: 'clean' }])
    }

    git(f.worktree, 'submodule', 'deinit', '-f', '--', 'vendor/lib')
    const uninitialized = await f.service.submoduleStatus(f.sessionId)
    if (uninitialized.status === 'ok') {
      expect(uninitialized.submodules[0]?.state).toBe('uninitialized')
    }
    expect(
      await f.service.submoduleAction(f.sessionId, 'init', 'vendor/lib')
    ).toMatchObject({ status: 'ok', action: 'init' })
    expect(
      await f.service.submoduleAction(f.sessionId, 'update', 'vendor/lib')
    ).toMatchObject({ status: 'ok', action: 'update' })
    expect(
      await f.service.submoduleAction(f.sessionId, 'sync', 'vendor/lib')
    ).toMatchObject({ status: 'ok', action: 'sync' })
    const reinitialized = await f.service.submoduleStatus(f.sessionId)
    if (reinitialized.status === 'ok') {
      expect(reinitialized.submodules[0]?.state).toBe('clean')
    }

    const subPath = join(f.worktree, 'vendor', 'lib')
    execFileSync('git', ['-C', subPath, 'config', 'user.email', 'w83@test'], { stdio: 'pipe' })
    execFileSync('git', ['-C', subPath, 'config', 'user.name', 'W83'], { stdio: 'pipe' })
    writeFileSync(join(subPath, 'lib.txt'), 'submodule two\n')
    execFileSync('git', ['-C', subPath, 'commit', '-qam', 'sub two'], { stdio: 'pipe' })
    const modified = await f.service.submoduleStatus(f.sessionId)
    if (modified.status === 'ok') {
      expect(modified.submodules[0]?.state).toBe('modified')
    }
    expect(
      await f.service.submoduleAction(f.sessionId, 'stage', 'vendor/lib')
    ).toMatchObject({ status: 'ok', action: 'stage' })
    const staged = await f.service.submoduleStatus(f.sessionId)
    if (staged.status === 'ok') {
      expect(staged.submodules[0]?.state).toBe('clean')
    }
    expect(
      await f.service.submoduleAction(f.sessionId, 'sync', '../escape')
    ).toMatchObject({ status: 'unavailable' })
  }, 60_000)

  it('lists worktrees, locks and unlocks an extra one, and protects session checkouts', async () => {
    const f = await realRepo()
    const extra = join(f.worktree, '..', 'extra-worktree')
    git(f.worktree, 'worktree', 'add', '--detach', extra, 'HEAD')

    const listed = await f.service.worktreeList(f.sessionId)
    expect(listed.status).toBe('ok')
    if (listed.status !== 'ok') return
    expect(listed.worktrees.length).toBeGreaterThanOrEqual(3)
    const primary = listed.worktrees.find((entry) => entry.primary)
    const sessionEntry = listed.worktrees.find(
      (entry) => entry.sessionId === f.sessionId
    )
    const extraEntry = listed.worktrees.find(
      (entry) => entry.path.replace(/\\/gu, '/').endsWith('/extra-worktree')
    )
    expect(primary?.active).toBe(false)
    expect(sessionEntry?.active).toBe(true)
    expect(extraEntry?.active).toBe(false)
    expect(extraEntry?.primary).toBe(false)

    expect(
      await f.service.worktreeAction(f.sessionId, 'remove', sessionEntry!.path)
    ).toMatchObject({ status: 'unavailable' })
    expect(
      await f.service.worktreeAction(f.sessionId, 'lock', sessionEntry!.path)
    ).toMatchObject({ status: 'unavailable' })
    expect(
      await f.service.worktreeAction(f.sessionId, 'remove', primary!.path)
    ).toMatchObject({ status: 'unavailable' })

    expect(
      await f.service.worktreeAction(f.sessionId, 'lock', extraEntry!.path, 'smoke lock')
    ).toMatchObject({ status: 'ok', action: 'lock' })
    const locked = await f.service.worktreeList(f.sessionId)
    if (locked.status === 'ok') {
      const entry = locked.worktrees.find((candidate) => candidate.path === extraEntry!.path)
      expect(entry?.locked).toBe('smoke lock')
    }
    expect(
      await f.service.worktreeAction(f.sessionId, 'unlock', extraEntry!.path)
    ).toMatchObject({ status: 'ok', action: 'unlock' })
    expect(await f.service.worktreeAction(f.sessionId, 'prune')).toMatchObject({
      status: 'ok',
      action: 'prune'
    })
    expect(
      await f.service.worktreeAction(f.sessionId, 'remove', extraEntry!.path)
    ).toMatchObject({ status: 'ok', action: 'remove' })
    expect(existsSync(extra)).toBe(false)
  })

  it('creates, lists, inspects, applies, pops and drops stashes', async () => {
    const f = await realRepo()
    git(f.worktree, 'config', 'user.email', 'w83@test')
    git(f.worktree, 'config', 'user.name', 'W83')
    writeFileSync(join(f.worktree, 'a.txt'), 'stashed work\n')

    expect(await f.service.stashPush(f.sessionId, 'work in progress', false, false)).toMatchObject({
      status: 'ok',
      created: true
    })
    expect(gitRaw(f.worktree, 'status', '--porcelain')).toBe('')
    const listed = await f.service.stashList(f.sessionId)
    expect(listed.status).toBe('ok')
    if (listed.status === 'ok') {
      expect(listed.stashes).toHaveLength(1)
      expect(listed.stashes[0]).toMatchObject({ index: 0, ref: 'stash@{0}' })
      expect(listed.stashes[0]?.subject).toContain('work in progress')
    }
    const diff = await f.service.stashDiff(f.sessionId, 0)
    expect(diff.status).toBe('ok')
    if (diff.status === 'ok') expect(diff.patch).toContain('stashed work')

    expect(await f.service.stashAction(f.sessionId, 0, 'apply')).toMatchObject({
      status: 'ok',
      action: 'apply'
    })
    expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('stashed work\n')
    git(f.worktree, 'checkout', '--', 'a.txt')

    expect(await f.service.stashAction(f.sessionId, 0, 'pop')).toMatchObject({
      status: 'ok',
      action: 'pop'
    })
    expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('stashed work\n')
    const empty = await f.service.stashList(f.sessionId)
    if (empty.status === 'ok') expect(empty.stashes).toHaveLength(0)
    git(f.worktree, 'checkout', '--', 'a.txt')

    expect(await f.service.stashPush(f.sessionId, '', false, false)).toMatchObject({
      status: 'ok',
      created: false
    })
    expect(await f.service.stashAction(f.sessionId, 0, 'drop')).toMatchObject({
      status: 'unavailable'
    })
    expect(await f.service.stashDiff(f.sessionId, -1)).toMatchObject({ status: 'unavailable' })
  })

  it('stashes untracked files when requested', async () => {
    const f = await realRepo()
    git(f.worktree, 'config', 'user.email', 'w83@test')
    git(f.worktree, 'config', 'user.name', 'W83')
    writeFileSync(join(f.worktree, 'new.txt'), 'untracked stash\n')
    expect(await f.service.stashPush(f.sessionId, 'untracked', true, false)).toMatchObject({
      status: 'ok',
      created: true
    })
    expect(existsSync(join(f.worktree, 'new.txt'))).toBe(false)
    const diff = await f.service.stashDiff(f.sessionId, 0)
    if (diff.status === 'ok') expect(diff.patch).toContain('untracked stash')
    expect(await f.service.stashAction(f.sessionId, 0, 'drop')).toMatchObject({ status: 'ok' })
  })

  it('reads conflict stages and resolves the path before continuing', async () => {
    const f = await realRepo()
    git(f.worktree, 'config', 'user.email', 'w83@test')
    git(f.worktree, 'config', 'user.name', 'W83')
    const base = git(f.worktree, 'rev-parse', 'HEAD')

    git(f.worktree, 'checkout', '-q', '-b', 'side', base)
    writeFileSync(join(f.worktree, 'a.txt'), 'side\n')
    git(f.worktree, 'commit', '-qam', 'side')
    git(f.worktree, 'checkout', '-q', f.branch)
    writeFileSync(join(f.worktree, 'a.txt'), 'current\n')
    git(f.worktree, 'commit', '-qam', 'current')
    expect(await f.service.mergeBranch(f.sessionId, 'side')).toMatchObject({
      status: 'unavailable'
    })

    const conflict = await f.service.conflictFile(f.sessionId, 'a.txt')
    expect(conflict.status).toBe('ok')
    if (conflict.status === 'ok') {
      expect(conflict.current.text).toBe('current\n')
      expect(conflict.incoming.text).toBe('side\n')
      expect(conflict.base?.text).toBe('one\n')
      expect(conflict.current.oid).toHaveLength(40)
    }
    expect(await f.service.conflictFile(f.sessionId, 'b.txt')).toMatchObject({
      status: 'unavailable'
    })
    expect(await f.service.conflictFile(f.sessionId, '../escape')).toMatchObject({
      status: 'unavailable'
    })

    writeFileSync(join(f.worktree, 'a.txt'), 'resolved\n')
    expect(await f.service.resolveConflict(f.sessionId, 'a.txt')).toMatchObject({
      status: 'ok',
      path: 'a.txt'
    })
    expect(await f.service.resolveConflict(f.sessionId, 'a.txt')).toMatchObject({
      status: 'unavailable'
    })
    expect(await f.service.conflictFile(f.sessionId, 'a.txt')).toMatchObject({
      status: 'unavailable'
    })
    const continued = await f.service.continueOperation(f.sessionId)
    expect(continued).toMatchObject({ status: 'ok', operation: 'merge' })
    const state = await f.service.operationState(f.sessionId)
    if (state.status === 'ok') expect(state.operation).toBeNull()
    expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('resolved\n')
    expect(git(f.worktree, 'log', '-1', '--pretty=%s')).toContain('Merge')
  })

  it('reports binary and CRLF conflict stages without corrupting bytes', async () => {
    const f = await realRepo()
    git(f.worktree, 'config', 'user.email', 'w83@test')
    git(f.worktree, 'config', 'user.name', 'W83')
    writeFileSync(join(f.worktree, 'bin.dat'), Buffer.from([0, 1, 2]))
    writeFileSync(join(f.worktree, 'crlf.txt'), 'base\r\n')
    git(f.worktree, 'add', 'bin.dat', 'crlf.txt')
    git(f.worktree, 'commit', '-qm', 'fixtures')
    const base = git(f.worktree, 'rev-parse', 'HEAD')

    git(f.worktree, 'checkout', '-q', '-b', 'binary-side', base)
    writeFileSync(join(f.worktree, 'bin.dat'), Buffer.from([0, 9, 2]))
    writeFileSync(join(f.worktree, 'crlf.txt'), 'side\r\n')
    git(f.worktree, 'commit', '-qam', 'binary side')
    git(f.worktree, 'checkout', '-q', f.branch)
    writeFileSync(join(f.worktree, 'bin.dat'), Buffer.from([0, 7, 2]))
    writeFileSync(join(f.worktree, 'crlf.txt'), 'current\r\n')
    git(f.worktree, 'commit', '-qam', 'binary current')
    expect(await f.service.mergeBranch(f.sessionId, 'binary-side')).toMatchObject({
      status: 'unavailable'
    })

    const binary = await f.service.conflictFile(f.sessionId, 'bin.dat')
    expect(binary.status).toBe('ok')
    if (binary.status === 'ok') {
      expect(binary.current.binary).toBe(true)
      expect(binary.incoming.binary).toBe(true)
      expect(binary.current.text).toBe('')
    }
    const crlf = await f.service.conflictFile(f.sessionId, 'crlf.txt')
    expect(crlf.status).toBe('ok')
    if (crlf.status === 'ok') {
      expect(crlf.current.text).toBe('current\r\n')
      expect(crlf.incoming.text).toBe('side\r\n')
      expect(crlf.base?.text).toBe('base\r\n')
    }
    await f.service.abortOperation(f.sessionId)
  })

  it('reads symlink conflict stages as their link targets', async () => {
    const f = await realRepo()
    git(f.worktree, 'config', 'user.email', 'w83@test')
    git(f.worktree, 'config', 'user.name', 'W83')
    git(f.worktree, 'config', 'core.symlinks', 'true')
    try {
      symlinkSync('one', join(f.worktree, 'link'))
    } catch {
      return
    }
    git(f.worktree, 'add', 'link')
    git(f.worktree, 'commit', '-qm', 'link base')
    const base = git(f.worktree, 'rev-parse', 'HEAD')

    git(f.worktree, 'checkout', '-q', '-b', 'link-side', base)
    rmSync(join(f.worktree, 'link'))
    symlinkSync('two', join(f.worktree, 'link'))
    git(f.worktree, 'add', 'link')
    git(f.worktree, 'commit', '-qm', 'link side')
    git(f.worktree, 'checkout', '-q', f.branch)
    rmSync(join(f.worktree, 'link'))
    symlinkSync('three', join(f.worktree, 'link'))
    git(f.worktree, 'add', 'link')
    git(f.worktree, 'commit', '-qm', 'link current')
    expect(await f.service.mergeBranch(f.sessionId, 'link-side')).toMatchObject({
      status: 'unavailable'
    })

    const conflict = await f.service.conflictFile(f.sessionId, 'link')
    expect(conflict.status).toBe('ok')
    if (conflict.status === 'ok') {
      expect(conflict.current.text).toContain('three')
      expect(conflict.incoming.text).toContain('two')
      expect(conflict.base?.text).toContain('one')
    }
    await f.service.abortOperation(f.sessionId)
  })

  it('refuses to fabricate stages for a rename/rename conflict', async () => {
    const f = await realRepo()
    git(f.worktree, 'config', 'user.email', 'w83@test')
    git(f.worktree, 'config', 'user.name', 'W83')
    writeFileSync(join(f.worktree, 'renamed.txt'), 'rename me\n')
    git(f.worktree, 'add', 'renamed.txt')
    git(f.worktree, 'commit', '-qm', 'rename base')
    const base = git(f.worktree, 'rev-parse', 'HEAD')

    git(f.worktree, 'checkout', '-q', '-b', 'rename-side', base)
    git(f.worktree, 'mv', 'renamed.txt', 'side-name.txt')
    git(f.worktree, 'commit', '-qm', 'side rename')
    git(f.worktree, 'checkout', '-q', f.branch)
    git(f.worktree, 'mv', 'renamed.txt', 'current-name.txt')
    git(f.worktree, 'commit', '-qm', 'current rename')
    expect(await f.service.mergeBranch(f.sessionId, 'rename-side')).toMatchObject({
      status: 'unavailable'
    })

    // The sides live on different paths (current-name.txt stage 2, side-name.txt
    // stage 3), so a single-path merge editor must fall back to the file/terminal.
    expect(await f.service.conflictFile(f.sessionId, 'current-name.txt')).toMatchObject({
      status: 'unavailable'
    })
    expect(await f.service.conflictFile(f.sessionId, 'side-name.txt')).toMatchObject({
      status: 'unavailable'
    })
    await f.service.abortOperation(f.sessionId)
  })

  it('rebases the current branch and leaves a rebase marker on conflict', async () => {
    const f = await realRepo()
    git(f.worktree, 'config', 'user.email', 'w83@test')
    git(f.worktree, 'config', 'user.name', 'W83')
    const base = git(f.worktree, 'rev-parse', 'HEAD')

    writeFileSync(join(f.worktree, 'b.txt'), 'local work\n')
    git(f.worktree, 'commit', '-qam', 'local work')
    git(f.worktree, 'checkout', '-q', '-b', 'upstream-line', base)
    writeFileSync(join(f.worktree, 'a.txt'), 'upstream work\n')
    git(f.worktree, 'commit', '-qam', 'upstream work')
    git(f.worktree, 'checkout', '-q', f.branch)

    const rebased = await f.service.rebaseBranch(f.sessionId, 'upstream-line')
    expect(rebased).toMatchObject({ status: 'ok', branch: 'upstream-line' })
    expect(git(f.worktree, 'log', '--pretty=%s', '-2')).toContain('local work')
    expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('upstream work\n')
    expect(readFileSync(join(f.worktree, 'b.txt'), 'utf8')).toBe('local work\n')

    git(f.worktree, 'checkout', '-q', '-b', 'conflict-line', base)
    writeFileSync(join(f.worktree, 'a.txt'), 'conflict upstream\n')
    git(f.worktree, 'commit', '-qam', 'conflict upstream')
    git(f.worktree, 'checkout', '-q', f.branch)
    writeFileSync(join(f.worktree, 'a.txt'), 'conflict local\n')
    git(f.worktree, 'commit', '-qam', 'conflict local')

    const conflicted = await f.service.rebaseBranch(f.sessionId, 'conflict-line')
    expect(conflicted.status).toBe('unavailable')
    const state = await f.service.operationState(f.sessionId)
    if (state.status === 'ok') expect(state.operation).toBe('rebase')
    expect(await f.service.abortOperation(f.sessionId)).toMatchObject({ status: 'ok' })
    expect(git(f.worktree, 'status', '--porcelain')).toBe('')
  })

  it('deletes only a local tag', async () => {
    const f = await realRepo()
    const tag = await f.service.createTag(f.sessionId, 'v-delete', git(f.worktree, 'rev-parse', 'HEAD'))
    expect(tag.status).toBe('ok')
    expect(await f.service.deleteTag(f.sessionId, 'v-delete')).toMatchObject({
      status: 'ok',
      name: 'v-delete'
    })
    expect(git(f.worktree, 'tag', '--list', 'v-delete')).toBe('')
    expect(await f.service.deleteTag(f.sessionId, 'v-delete')).toMatchObject({
      status: 'unavailable'
    })
  })

  it('lists tags and checks one out detached, refusing dirty work', async () => {
    const f = await realRepo()
    git(f.worktree, 'config', 'user.email', 'w83@test')
    git(f.worktree, 'config', 'user.name', 'W83')
    const head = git(f.worktree, 'rev-parse', 'HEAD')
    expect(await f.service.createTag(f.sessionId, 'v-check', head)).toMatchObject({ status: 'ok' })

    const list = await f.service.tags(f.sessionId)
    expect(list.status).toBe('ok')
    if (list.status !== 'ok') return
    expect(list.tags).toContainEqual({ name: 'v-check', oid: head })

    const checked = await f.service.checkoutRef(f.sessionId, 'v-check')
    expect(checked).toMatchObject({ status: 'ok', ref: 'v-check', headOid: head })
    expect(git(f.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')
    expect((await f.service.switchBranch(f.sessionId, f.branch)).status).toBe('ok')

    writeFileSync(join(f.worktree, 'a.txt'), 'dirty\n')
    expect(await f.service.checkoutRef(f.sessionId, 'v-check')).toMatchObject({
      status: 'unavailable'
    })
    expect(git(f.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(f.branch)
  })

  it('cherry-picks and reverts a commit through the operation queue', async () => {
    const f = await realRepo()
    git(f.worktree, 'config', 'user.email', 'w83@test')
    git(f.worktree, 'config', 'user.name', 'W83')
    writeFileSync(join(f.worktree, 'a.txt'), 'picked change\n')
    git(f.worktree, 'commit', '-qam', 'pick me')
    const picked = git(f.worktree, 'rev-parse', 'HEAD')
    git(f.worktree, 'checkout', '-q', '-b', 'other', 'HEAD~1')

    const cherry = await f.service.cherryPick(f.sessionId, picked)
    expect(cherry).toMatchObject({ status: 'ok', subject: 'pick me' })
    expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('picked change\n')
    expect(git(f.worktree, 'rev-list', '--count', 'HEAD')).toBe('2')

    const reverted = await f.service.revert(f.sessionId, picked)
    expect(reverted.status).toBe('ok')
    expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('one\n')
    expect(git(f.worktree, 'log', '-1', '--pretty=%s')).toContain('Revert')
  })

  it('refuses to continue a conflicted operation and aborts it cleanly', async () => {
    const f = await realRepo()
    git(f.worktree, 'config', 'user.email', 'w83@test')
    git(f.worktree, 'config', 'user.name', 'W83')
    const base = git(f.worktree, 'rev-parse', 'HEAD')
    writeFileSync(join(f.worktree, 'a.txt'), 'side change\n')
    git(f.worktree, 'commit', '-qam', 'side change')
    const side = git(f.worktree, 'rev-parse', 'HEAD')
    git(f.worktree, 'checkout', '-q', '-b', 'other', base)
    writeFileSync(join(f.worktree, 'a.txt'), 'other change\n')
    git(f.worktree, 'commit', '-qam', 'other change')
    expect(() => git(f.worktree, 'cherry-pick', side)).toThrow()

    expect((await f.service.operationState(f.sessionId)).status).toBe('ok')
    const state = await f.service.operationState(f.sessionId)
    if (state.status === 'ok') expect(state.operation).toBe('cherry-pick')

    const blocked = await f.service.continueOperation(f.sessionId)
    expect(blocked).toMatchObject({ status: 'unavailable' })
    if (blocked.status === 'unavailable') expect(blocked.detail).toContain('Resolve')

    const aborted = await f.service.abortOperation(f.sessionId)
    expect(aborted).toMatchObject({ status: 'ok', operation: 'cherry-pick' })
    const after = await f.service.operationState(f.sessionId)
    if (after.status === 'ok') expect(after.operation).toBeNull()
    expect(git(f.worktree, 'status', '--porcelain')).toBe('')
    expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('other change\n')
  })

  it('continues a resolved cherry-pick through the queue', async () => {
    const f = await realRepo()
    git(f.worktree, 'config', 'user.email', 'w83@test')
    git(f.worktree, 'config', 'user.name', 'W83')
    const base = git(f.worktree, 'rev-parse', 'HEAD')
    writeFileSync(join(f.worktree, 'a.txt'), 'side change\n')
    git(f.worktree, 'commit', '-qam', 'side change')
    const side = git(f.worktree, 'rev-parse', 'HEAD')
    git(f.worktree, 'checkout', '-q', '-b', 'other', base)
    writeFileSync(join(f.worktree, 'a.txt'), 'other change\n')
    git(f.worktree, 'commit', '-qam', 'other change')
    expect(() => git(f.worktree, 'cherry-pick', side)).toThrow()

    writeFileSync(join(f.worktree, 'a.txt'), 'resolved\n')
    git(f.worktree, 'add', 'a.txt')
    const continued = await f.service.continueOperation(f.sessionId)
    expect(continued).toMatchObject({ status: 'ok', operation: 'cherry-pick' })
    const after = await f.service.operationState(f.sessionId)
    if (after.status === 'ok') expect(after.operation).toBeNull()
    expect(git(f.worktree, 'log', '-1', '--pretty=%s')).toBe('side change')

    const noop = await f.service.continueOperation(f.sessionId)
    expect(noop.status).toBe('unavailable')
  })

  it('resets soft and hard without pushing', async () => {
    const f = await realRepo()
    git(f.worktree, 'config', 'user.email', 'w83@test')
    git(f.worktree, 'config', 'user.name', 'W83')
    const base = git(f.worktree, 'rev-parse', 'HEAD')
    writeFileSync(join(f.worktree, 'a.txt'), 'first change\n')
    git(f.worktree, 'commit', '-qam', 'first')
    writeFileSync(join(f.worktree, 'a.txt'), 'second change\n')
    git(f.worktree, 'commit', '-qam', 'second')

    const soft = await f.service.resetTo(f.sessionId, base, 'soft')
    expect(soft).toMatchObject({ status: 'ok', oid: base, branch: f.branch })
    expect(git(f.worktree, 'rev-parse', 'HEAD')).toBe(base)
    expect(git(f.worktree, 'status', '--porcelain')).toContain('M  a.txt')

    const hard = await f.service.resetTo(f.sessionId, base, 'hard')
    expect(hard.status).toBe('ok')
    expect(git(f.worktree, 'status', '--porcelain')).toBe('')
    expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('one\n')
  })

  it('compares HEAD with the exact session baseline, including renames', async () => {
    const f = await realRepo()
    execFileSync('git', ['-C', f.worktree, 'mv', 'b.txt', 'renamed.txt'])
    writeFileSync(join(f.worktree, 'a.txt'), 'changed\n')
    execFileSync('git', [
      '-C',
      f.worktree,
      '-c',
      'user.email=w83@test',
      '-c',
      'user.name=W83',
      'commit',
      '-qam',
      'Rename and edit'
    ])

    const compared = await f.service.compare(f.sessionId)
    expect(compared.status).toBe('ok')
    if (compared.status !== 'ok') return
    expect(compared.ahead).toBe(1)
    expect(compared.behind).toBe(0)
    expect(compared.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'renamed.txt',
          oldPath: 'b.txt',
          status: 'R',
          additions: expect.any(Number)
        })
      ])
    )
  })

  it('amends the last commit without touching earlier history', async () => {
    const f = await realRepo()
    writeFileSync(join(f.worktree, 'b.txt'), 'changed\n')
    execFileSync('git', [
      '-C',
      f.worktree,
      '-c',
      'user.email=w83@test',
      '-c',
      'user.name=W83',
      'commit',
      '-qam',
      'First subject'
    ])
    const before = git(f.worktree, 'rev-parse', 'HEAD')

    const amended = await f.service.amend(f.sessionId, 'Better subject')
    expect(amended.status).toBe('ok')
    if (amended.status !== 'ok') return
    expect(amended.subject).toBe('Better subject')
    expect(git(f.worktree, 'log', '-1', '--pretty=%s')).toBe('Better subject')
    expect(git(f.worktree, 'rev-parse', 'HEAD')).not.toBe(before)
    expect(git(f.worktree, 'rev-list', '--count', 'HEAD')).toBe('2')
  })

  it('lists, adds and removes remotes with name and URL validation', async () => {
    const f = await realRepo()
    const bare = join(f.worktree, '..', 'remote.git')
    const backup = join(f.worktree, '..', 'backup.git')
    execFileSync('git', ['init', '-q', '--bare', bare], { stdio: 'pipe' })
    execFileSync('git', ['init', '-q', '--bare', backup], { stdio: 'pipe' })

    const added = await f.service.addRemote(f.sessionId, 'origin', bare)
    expect(added).toMatchObject({ status: 'ok', name: 'origin' })
    const addedBackup = await f.service.addRemote(f.sessionId, 'backup', backup)
    expect(addedBackup.status).toBe('ok')

    const list = await f.service.remotes(f.sessionId)
    expect(list.status).toBe('ok')
    if (list.status !== 'ok') return
    expect(list.remotes.map((remote) => remote.name)).toEqual(['backup', 'origin'])
    expect(list.remotes.find((remote) => remote.name === 'origin')?.url).toBe(bare)

    expect(await f.service.removeRemote(f.sessionId, 'backup')).toMatchObject({
      status: 'ok',
      name: 'backup'
    })
    expect(await f.service.addRemote(f.sessionId, 'bad name', '/tmp/x')).toMatchObject({
      status: 'unavailable'
    })
    expect(await f.service.addRemote(f.sessionId, 'safe', '-upload-pack=evil')).toMatchObject({
      status: 'unavailable'
    })
  })

  it('fetches one named remote and reports an unknown remote', async () => {
    const f = await realRepo()
    const bare = join(f.worktree, '..', 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', bare], { stdio: 'pipe' })
    git(f.worktree, 'remote', 'add', 'origin', bare)
    expect((await f.service.publish(f.sessionId)).status).toBe('ok')

    const fetched = await f.service.fetchRemote(f.sessionId, 'origin')
    expect(fetched).toMatchObject({ status: 'ok', remote: 'origin' })
    const pruned = await f.service.fetchRemote(f.sessionId, 'origin', true)
    expect(pruned).toMatchObject({ status: 'ok', remote: 'origin' })
    expect(await f.service.fetchRemote(f.sessionId, 'missing')).toMatchObject({
      status: 'unavailable'
    })
  })

  it('pushes tags explicitly and only to the default remote', async () => {
    const f = await realRepo()
    const bare = join(f.worktree, '..', 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', bare], { stdio: 'pipe' })
    git(f.worktree, 'remote', 'add', 'origin', bare)
    const published = await f.service.publish(f.sessionId)
    expect(published.status).toBe('ok')
    const head = git(f.worktree, 'rev-parse', 'HEAD')
    expect(await f.service.createTag(f.sessionId, 'v-push', head)).toMatchObject({ status: 'ok' })

    const pushed = await f.service.pushTags(f.sessionId)
    expect(pushed).toMatchObject({ status: 'ok', remote: 'origin' })
    expect(git(bare, 'tag', '--list', 'v-push')).toBe('v-push')
  })

  it('lists remote branches and sets the current branch upstream', async () => {
    const f = await realRepo()
    const bare = join(f.worktree, '..', 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', bare], { stdio: 'pipe' })
    git(f.worktree, 'remote', 'add', 'origin', bare)
    expect((await f.service.publish(f.sessionId)).status).toBe('ok')
    git(f.worktree, 'branch', 'other')
    git(f.worktree, 'push', '-q', 'origin', 'other')

    const remoteBranches = await f.service.remoteBranches(f.sessionId)
    expect(remoteBranches.status).toBe('ok')
    if (remoteBranches.status !== 'ok') return
    expect(remoteBranches.branches).toEqual(
      expect.arrayContaining([`origin/${f.branch}`, 'origin/other'])
    )

    const changed = await f.service.setUpstream(f.sessionId, 'origin/other')
    expect(changed).toMatchObject({ status: 'ok', branch: f.branch, upstream: 'origin/other' })
    expect(git(f.worktree, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/other')
    expect(await f.service.setUpstream(f.sessionId, 'origin/missing')).toMatchObject({
      status: 'unavailable'
    })
    expect(await f.service.setUpstream(f.sessionId, '-bad')).toMatchObject({
      status: 'unavailable'
    })
  })

  it('force-pushes with a lease and refuses a stale remote', async () => {
    const f = await realRepo()
    git(f.worktree, 'config', 'user.email', 'w83@test')
    git(f.worktree, 'config', 'user.name', 'W83')
    const bare = join(f.worktree, '..', 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', bare], { stdio: 'pipe' })
    git(f.worktree, 'remote', 'add', 'origin', bare)
    expect((await f.service.publish(f.sessionId)).status).toBe('ok')

    writeFileSync(join(f.worktree, 'a.txt'), 'local\n')
    git(f.worktree, 'commit', '-qam', 'local')
    expect((await f.service.push(f.sessionId)).status).toBe('ok')

    const clone = join(f.worktree, '..', 'other')
    execFileSync('git', ['clone', '-q', '-b', f.branch, bare, clone], { stdio: 'pipe' })
    git(clone, 'config', 'user.email', 'other@test')
    git(clone, 'config', 'user.name', 'Other')
    writeFileSync(join(clone, 'a.txt'), 'remote\n')
    git(clone, 'commit', '-qam', 'remote')
    git(clone, 'push', '-q', 'origin', f.branch)

    writeFileSync(join(f.worktree, 'a.txt'), 'rewritten\n')
    git(f.worktree, 'commit', '-qam', 'rewritten')
    const stale = await f.service.forcePush(f.sessionId)
    expect(stale.status).toBe('unavailable')

    expect((await f.service.fetch(f.sessionId)).status).toBe('ok')
    const forced = await f.service.forcePush(f.sessionId)
    expect(forced).toMatchObject({ status: 'ok', branch: f.branch })
  })

  it('publishes the branch by setting its upstream, then fetches the remote', async () => {
    const f = await realRepo()
    const bare = join(f.worktree, '..', 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', bare], { stdio: 'pipe' })
    git(f.worktree, 'remote', 'add', 'origin', bare)

    const published = await f.service.publish(f.sessionId)
    expect(published).toMatchObject({ status: 'ok', branch: f.branch })
    if (published.status === 'ok') expect(published.upstream).toBe(`origin/${f.branch}`)
    expect(git(f.worktree, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe(`origin/${f.branch}`)

    const fetched = await f.service.fetch(f.sessionId)
    expect(fetched).toMatchObject({ status: 'ok', remote: 'origin' })
  })

  it('lists refs and worktrees for the branch and remote surfaces', async () => {
    const f = await realRepo()
    git(f.worktree, 'branch', 'other')

    const refs = await f.service.refs(f.sessionId)
    expect(refs.status).toBe('ok')
    if (refs.status === 'ok') {
      expect(refs.refs.filter((ref) => ref.kind === 'local').map((ref) => ref.name)).toEqual(
        expect.arrayContaining(['main', 'other', f.branch])
      )
      expect(refs.refs.find((ref) => ref.current)?.name).toBe(f.branch)
    }

    const worktrees = await f.service.worktrees(f.sessionId)
    expect(worktrees.status).toBe('ok')
    if (worktrees.status === 'ok') {
      expect(
        worktrees.worktrees.some((entry) => samePathResolved(entry.path, f.worktree))
      ).toBe(true)
      const entry = worktrees.worktrees.find((candidate) => candidate.branch === f.branch)
      expect(entry).toBeDefined()
      expect(samePathResolved(entry!.path, f.worktree)).toBe(true)
    }
  })

  it('resolves the local worktree and Git directory for the watcher', async () => {
    const f = await realRepo()
    const details = await f.service.watchTargetDetails(f.sessionId)
    expect(details).toMatchObject({
      worktreePath: f.worktree,
      target: { kind: 'local' }
    })
    expect(details?.gitDir.endsWith('.git')).toBe(true)
    expect(await f.service.watchTarget(f.sessionId)).toEqual({
      worktreePath: f.worktree,
      gitDir: details?.gitDir
    })
  })

  it('reports an in-progress merge marker from the common Git directory', async () => {
    const f = await realRepo()
    const commonDir = execFileSync(
      'git',
      ['-C', f.worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8' }
    ).trim()
    writeFileSync(join(commonDir, 'MERGE_HEAD'), `${git(f.worktree, 'rev-parse', 'HEAD')}\n`)
    const state = await f.service.operationState(f.sessionId)
    expect(state).toMatchObject({ status: 'ok', operation: 'merge', marker: 'MERGE_HEAD' })
    rmSync(join(commonDir, 'MERGE_HEAD'))
    expect(await f.service.operationState(f.sessionId)).toMatchObject({
      status: 'ok',
      operation: null,
      marker: null
    })
  })

  it('diffs a revision range and reports renames with both paths', async () => {
    const f = await realRepo()
    const base = git(f.worktree, 'rev-parse', 'HEAD')
    writeFileSync(join(f.worktree, 'a.txt'), 'changed\n')
    execFileSync('git', ['-C', f.worktree, 'add', 'a.txt'], { stdio: 'pipe' })
    execFileSync(
      'git',
      ['-C', f.worktree, '-c', 'user.email=w83@test', '-c', 'user.name=W83', 'commit', '-qm', 'change a'],
      { stdio: 'pipe' }
    )

    const changed = await f.service.rangeDiff(f.sessionId, base, 'HEAD')
    expect(changed.status).toBe('ok')
    if (changed.status !== 'ok') return
    expect(changed.truncated).toBe(false)
    expect(changed.files).toEqual([
      expect.objectContaining({ path: 'a.txt', status: 'modified', additions: 1, deletions: 1 })
    ])

    const beforeRename = git(f.worktree, 'rev-parse', 'HEAD')
    execFileSync('git', ['-C', f.worktree, 'mv', 'a.txt', 'renamed.txt'], { stdio: 'pipe' })
    execFileSync(
      'git',
      ['-C', f.worktree, '-c', 'user.email=w83@test', '-c', 'user.name=W83', 'commit', '-qm', 'rename a'],
      { stdio: 'pipe' }
    )
    const renamed = await f.service.rangeDiff(f.sessionId, beforeRename, 'HEAD')
    expect(renamed.status).toBe('ok')
    if (renamed.status !== 'ok') return
    expect(renamed.files).toEqual([
      expect.objectContaining({ path: 'renamed.txt', oldPath: 'a.txt', status: 'renamed' })
    ])
  })

  it('refuses an unavailable range instead of handing it to Git as an option', async () => {
    const f = await realRepo()
    expect(await f.service.rangeDiff(f.sessionId, '--help', 'HEAD')).toMatchObject({
      status: 'unavailable',
      reason: 'git-failed'
    })
    expect(await f.service.rangeDiff(f.sessionId, 'not-a-ref', 'HEAD')).toMatchObject({
      status: 'unavailable',
      reason: 'git-failed'
    })
  })

  it('stages and unstages a mixed selection with per-path outcomes', async () => {
    const f = await realRepo()
    writeFileSync(join(f.worktree, 'a.txt'), 'changed\n')
    writeFileSync(join(f.worktree, 'fresh.txt'), 'new\n')

    const staged = await f.service.setPathsStaged(
      f.sessionId,
      [
        { path: 'a.txt', area: 'unstaged' },
        { path: 'fresh.txt', area: 'untracked' },
        { path: 'b.txt', area: 'staged' }
      ],
      true
    )
    expect(staged.status).toBe('ok')
    if (staged.status !== 'ok') return
    expect(staged.result.applied.sort()).toEqual(['a.txt', 'fresh.txt'])
    expect(staged.result.skipped).toEqual(['b.txt'])
    expect(staged.result.failed).toEqual([])
    expect(git(f.worktree, 'diff', '--cached', '--name-only').split('\n').sort()).toEqual([
      'a.txt',
      'fresh.txt'
    ])

    const unstaged = await f.service.setPathsStaged(
      f.sessionId,
      [
        { path: 'a.txt', area: 'staged' },
        { path: 'fresh.txt', area: 'staged' },
        { path: 'b.txt', area: 'unstaged' }
      ],
      false
    )
    expect(unstaged.status).toBe('ok')
    if (unstaged.status !== 'ok') return
    expect(unstaged.result.applied.sort()).toEqual(['a.txt', 'fresh.txt'])
    expect(git(f.worktree, 'diff', '--cached', '--name-only')).toBe('')
  })

  it('rejects stale destructive discard and applies a fresh one', async () => {
    const f = await realRepo()
    writeFileSync(join(f.worktree, 'a.txt'), 'changed\n')
    const snapshot = await f.service.status(f.sessionId)
    expect(snapshot.status).toBe('ok')
    if (snapshot.status !== 'ok') return
    const revision = snapshot.snapshot.revision
    expect(revision).toBeDefined()

    // The live Agent changes another path after the user saw the snapshot.
    writeFileSync(join(f.worktree, 'b.txt'), 'agent edit\n')
    const stale = await f.service.discardPaths(
      f.sessionId,
      [{ path: 'a.txt', area: 'unstaged' }],
      revision
    )
    expect(stale).toMatchObject({ status: 'unavailable', reason: 'git-failed' })
    if (stale.status === 'unavailable') expect(stale.detail).toContain('changed since this selection')
    expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('changed\n')

    const fresh = await f.service.status(f.sessionId)
    expect(fresh.status).toBe('ok')
    if (fresh.status !== 'ok') return
    const discarded = await f.service.discardPaths(
      f.sessionId,
      [{ path: 'a.txt', area: 'unstaged' }],
      fresh.snapshot.revision
    )
    expect(discarded.status).toBe('ok')
    if (discarded.status === 'ok') expect(discarded.result.applied).toEqual(['a.txt'])
    expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('one\n')
  })

  it('discards an untracked selection by deleting the file', async () => {
    const f = await realRepo()
    writeFileSync(join(f.worktree, 'fresh.txt'), 'new\n')
    const result = await f.service.discardPaths(f.sessionId, [
      { path: 'fresh.txt', area: 'untracked' }
    ])
    expect(result.status).toBe('ok')
    if (result.status === 'ok') expect(result.result.applied).toEqual(['fresh.txt'])
    expect(() => readFileSync(join(f.worktree, 'fresh.txt'), 'utf8')).toThrow()
  })
})

/**
 * Opt-in budgets for the change set that motivated lazy stats. Run with
 * `ICODE_PERF=1 pnpm exec vitest run src/main/git/git-workspace-service.test.ts`.
 * The default suite skips it because creating 10,000 files is not a unit test.
 */
describe.runIf(process.env.ICODE_PERF === '1')('large repository performance', () => {
  it('reads 10k untracked files without per-file stats inside the budget', async () => {
    const f = await realRepo()
    const generated = join(f.worktree, 'generated')
    mkdirSync(generated, { recursive: true })
    for (let index = 0; index < 10_000; index += 1) {
      writeFileSync(join(generated, `file-${String(index)}.txt`), 'x\n')
    }

    // Warm the page cache the way a second refresh sees it.
    await f.service.status(f.sessionId)
    const samples: number[] = []
    let count = 0
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const started = performance.now()
      const result = await f.service.status(f.sessionId)
      samples.push(performance.now() - started)
      expect(result.status).toBe('ok')
      if (result.status !== 'ok') return
      count = result.snapshot.untracked.length
      // Lazy stats: the status read must not run numstat over 10k files.
      expect(result.snapshot.untracked[0]?.added).toBeUndefined()
      expect(result.snapshot.didHitLimit).not.toBe(true)
    }
    const median = [...samples].sort((left, right) => left - right)[1]!
    console.log(
      `[perf] status: ${median.toFixed(1)} ms median for ${String(count)} untracked files ` +
        `(samples: ${samples.map((sample) => sample.toFixed(1)).join(', ')} ms)`
    )
    expect(count).toBe(10_000)
    expect(median).toBeLessThan(300)
  }, 180_000)
})
