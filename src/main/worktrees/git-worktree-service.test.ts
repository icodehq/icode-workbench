import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitWorktreeService } from './git-worktree-service'
import { SessionServiceError } from '../sessions/session-errors'

const roots: string[] = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function makeRepo(): {
  root: string
  repo: string
  service: GitWorktreeService
  baseOid: string
} {
  const root = mkdtempSync(join(tmpdir(), 'icode-worktree-'))
  roots.push(root)
  const repo = join(root, 'atlas')
  mkdirSync(repo)
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  writeFileSync(join(repo, 'README.md'), '# atlas\n')
  git(repo, 'add', 'README.md')
  execFileSync('git', [
    '-C',
    repo,
    '-c',
    'user.email=icode@test',
    '-c',
    'user.name=iCode',
    'commit',
    '-qm',
    'init'
  ])
  const baseOid = git(repo, 'rev-parse', 'HEAD')
  return {
    root,
    repo,
    service: new GitWorktreeService({ worktreeRoot: join(root, 'worktrees') }),
    baseOid
  }
}

function errCode(error: unknown): string | undefined {
  return error instanceof SessionServiceError ? error.appError.code : undefined
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('repository inspection', () => {
  it('reports the baseline commit and branch of a normal repository', async () => {
    const { service, repo, baseOid } = makeRepo()
    await expect(service.inspectRepository(repo)).resolves.toMatchObject({
      headOid: baseOid,
      headRef: 'main',
      unborn: false,
      inProgressOperation: null
    })
  })

  it('reports an unborn repository instead of guessing a baseline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'icode-unborn-'))
    roots.push(root)
    const repo = join(root, 'empty')
    mkdirSync(repo)
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    const service = new GitWorktreeService({ worktreeRoot: join(root, 'worktrees') })
    await expect(service.inspectRepository(repo)).resolves.toMatchObject({
      unborn: true,
      headOid: null
    })
  })

  it('detects an in-progress merge', async () => {
    const { root, repo, service } = makeRepo()
    mkdirSync(join(repo, '.git', 'rebase-merge'), { recursive: true })
    const state = await service.inspectRepository(repo)
    expect(state.inProgressOperation).toBe('rebase-merge')
    expect(root).toBeTruthy()
  })
})

describe('creating isolated worktrees', () => {
  it('creates a registered worktree at the recorded branch and commit', async () => {
    const { service, repo, baseOid, root } = makeRepo()
    const path = join(root, 'worktrees', 'repo_a', 'ses_one')
    await service.create({ primaryRoot: repo, path, branch: 'icode/ses_one', baseOid })

    const registered = await service.listWorktrees(repo)
    expect(registered.map((entry) => entry.path)).toContain(path)
    expect(registered.find((entry) => entry.path === path)?.branch).toBe('icode/ses_one')
    expect(git(path, 'rev-parse', 'HEAD')).toBe(baseOid)
    const inspection = await service.inspect({ primaryRoot: repo, path, branch: 'icode/ses_one' })
    expect(inspection).toMatchObject({ pathExists: true, registered: true, dirtyFiles: [] })
  })

  it('keeps two sessions isolated and leaves the primary checkout untouched', async () => {
    const { service, repo, baseOid, root } = makeRepo()
    const first = join(root, 'worktrees', 'repo_a', 'ses_one')
    const second = join(root, 'worktrees', 'repo_a', 'ses_two')
    await service.create({ primaryRoot: repo, path: first, branch: 'icode/ses_one', baseOid })
    await service.create({ primaryRoot: repo, path: second, branch: 'icode/ses_two', baseOid })

    writeFileSync(join(first, 'agent.txt'), 'first only\n')
    expect(existsSync(join(second, 'agent.txt'))).toBe(false)
    expect(existsSync(join(repo, 'agent.txt'))).toBe(false)
    expect(git(first, 'status', '--porcelain')).toContain('agent.txt')
    expect(git(second, 'status', '--porcelain')).toBe('')
  })

  it('serializes concurrent creates in one repository', async () => {
    const { service, repo, baseOid, root } = makeRepo()
    const paths = [join(root, 'worktrees', 'r', 'a'), join(root, 'worktrees', 'r', 'b')]
    await Promise.all([
      service.create({ primaryRoot: repo, path: paths[0]!, branch: 'icode/a', baseOid }),
      service.create({ primaryRoot: repo, path: paths[1]!, branch: 'icode/b', baseOid })
    ])
    const registered = await service.listWorktrees(repo)
    for (const path of paths) {
      expect(registered.some((entry) => entry.path === path)).toBe(true)
    }
  })

  it('refuses a path outside the managed root', async () => {
    const { service, repo, baseOid } = makeRepo()
    await expect(
      service.create({
        primaryRoot: repo,
        path: '/tmp/not-managed/escape',
        branch: 'icode/escape',
        baseOid
      })
    ).rejects.toSatisfy((error: unknown) => errCode(error) === 'WORKTREE_INCONSISTENT')
  })
})

describe('removal protection', () => {
  it('reports dirty files and refuses a clean removal until they are gone', async () => {
    const { service, repo, baseOid, root } = makeRepo()
    const path = join(root, 'worktrees', 'r', 's')
    await service.create({ primaryRoot: repo, path, branch: 'icode/s', baseOid })
    writeFileSync(join(path, 'dirty.txt'), 'work\n')

    const inspection = await service.inspect({ primaryRoot: repo, path, branch: 'icode/s' })
    expect(inspection.dirtyFiles).toContain('dirty.txt')

    await expect(service.remove({ primaryRoot: repo, path, force: false })).rejects.toSatisfy(
      (error: unknown) => errCode(error) === 'WORKTREE_DIRTY'
    )
    expect(existsSync(path)).toBe(true)

    await service.remove({ primaryRoot: repo, path, force: true })
    expect(existsSync(path)).toBe(false)
    // The branch survives a forced worktree removal.
    expect(git(repo, 'rev-parse', '--verify', 'refs/heads/icode/s')).toBeTruthy()
  })

  it('counts unmerged commits and reports zero after a merge', async () => {
    const { service, repo, baseOid, root } = makeRepo()
    const path = join(root, 'worktrees', 'r', 's')
    await service.create({ primaryRoot: repo, path, branch: 'icode/s', baseOid })
    writeFileSync(join(path, 'work.txt'), 'x\n')
    git(path, 'add', 'work.txt')
    execFileSync('git', [
      '-C',
      path,
      '-c',
      'user.email=icode@test',
      '-c',
      'user.name=iCode',
      'commit',
      '-qm',
      'work'
    ])
    await expect(service.countUnmerged(repo, 'icode/s')).resolves.toBe(1)

    git(repo, 'merge', '--ff-only', 'icode/s')
    await expect(service.countUnmerged(repo, 'icode/s')).resolves.toBe(0)
  })

  it('re-creates a vanished worktree from its retained branch', async () => {
    const { service, repo, baseOid, root } = makeRepo()
    const path = join(root, 'worktrees', 'r', 's')
    await service.create({ primaryRoot: repo, path, branch: 'icode/s', baseOid })
    rmSync(path, { recursive: true, force: true })
    // Git still has stale registration for the removed directory.
    expect((await service.listWorktrees(repo)).some((entry) => entry.path === path)).toBe(true)

    await service.recover({ primaryRoot: repo, path, branch: 'icode/s' })
    expect(existsSync(join(path, 'README.md'))).toBe(true)
    expect(git(path, 'rev-parse', 'HEAD')).toBe(baseOid)
  })
})

describe('branch helpers', () => {
  it('reports branch existence and refuses to delete while a worktree uses it', async () => {
    const { service, repo, baseOid, root } = makeRepo()
    const path = join(root, 'worktrees', 'r', 's')
    await service.create({ primaryRoot: repo, path, branch: 'icode/s', baseOid })
    await expect(service.branchExists(repo, 'icode/s')).resolves.toBe(true)
    const registered = await service.listWorktrees(repo)
    expect(registered.some((entry) => entry.branch === 'icode/s')).toBe(true)

    await service.remove({ primaryRoot: repo, path, force: false })
    await service.deleteBranch({ primaryRoot: repo, branch: 'icode/s', force: false })
    await expect(service.branchExists(repo, 'icode/s')).resolves.toBe(false)
  })
})

describe('porcelain parsing', () => {
  it('parses worktree entries', async () => {
    const { parseWorktreeList } = await import('./git-worktree-service')
    const entries = parseWorktreeList(
      'worktree /a\nHEAD abc\nbranch refs/heads/main\n\nworktree /b\nHEAD def\nbranch refs/heads/icode/x\n'
    )
    expect(entries).toEqual([
      { path: '/a', head: 'abc', branch: 'main' },
      { path: '/b', head: 'def', branch: 'icode/x' }
    ])
  })
})

describe('recovery edge cases', () => {
  it('clears an empty leftover directory from a failed create', async () => {
    const { service, repo, baseOid, root } = makeRepo()
    const path = join(root, 'worktrees', 'r', 'leftover')
    await service.create({ primaryRoot: repo, path, branch: 'icode/leftover', baseOid })
    await service.remove({ primaryRoot: repo, path, force: false })
    mkdirSync(path, { recursive: true })

    await service.recover({ primaryRoot: repo, path, branch: 'icode/leftover' })
    expect(existsSync(join(path, 'README.md'))).toBe(true)
  })

  it('refuses to recover over a non-empty unregistered directory', async () => {
    const { service, repo, baseOid, root } = makeRepo()
    const path = join(root, 'worktrees', 'r', 'junk')
    await service.create({ primaryRoot: repo, path, branch: 'icode/junk', baseOid })
    await service.remove({ primaryRoot: repo, path, force: false })
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'unknown.txt'), 'keep me\n')

    await expect(service.recover({ primaryRoot: repo, path, branch: 'icode/junk' })).rejects.toSatisfy(
      (error: unknown) => errCode(error) === 'WORKTREE_INCONSISTENT'
    )
    expect(existsSync(join(path, 'unknown.txt'))).toBe(true)
  })
})
