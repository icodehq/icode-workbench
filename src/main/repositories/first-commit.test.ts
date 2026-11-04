import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RepositoryRecord } from '../../shared/domain/repository'
import { newRepoId } from '../../shared/domain/ids'
import { toCanonicalRepositoryPath } from '../../shared/domain/paths'
import type { WslCommandRunner } from '../wsl/exec'
import { GitWorktreeService } from '../worktrees/git-worktree-service'
import {
  GENERATED_IGNORE_PATTERNS,
  RepositoryPreparationError,
  prepareFirstCommit
} from './first-commit'

const roots: string[] = []
const environment: Array<[string, string | undefined]> = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  for (const [key, value] of environment.splice(0)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'icode-first-commit-'))
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

function makeRepo(root: string): RepositoryRecord {
  mkdirSync(root, { recursive: true })
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.name', 'First Commit Test')
  git(root, 'config', 'user.email', 'first@commit.test')
  return {
    id: newRepoId(),
    path: toCanonicalRepositoryPath(root),
    displayName: 'project',
    addedAt: 1,
    lastOpenedAt: 1,
    currentBranch: null,
    availability: 'present',
    gitCommonDir: join(root, '.git'),
    executionTarget: { kind: 'local' }
  }
}

function deps(): {
  runner: WslCommandRunner
  gitWorktrees: GitWorktreeService
} {
  return {
    // Local preparation never invokes the WSL runner.
    runner: {} as WslCommandRunner,
    gitWorktrees: new GitWorktreeService({ worktreeRoot: join(tempRoot(), 'worktrees') })
  }
}

describe('first commit preparation', () => {
  it('leaves dependency folders out and creates a .gitignore when absent', async () => {
    const root = tempRoot()
    const repository = makeRepo(root)
    writeFileSync(join(root, 'README.md'), 'project\n')
    mkdirSync(join(root, 'app', 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(root, 'app', 'node_modules', 'pkg', 'index.js'), 'dependency\n')

    const result = await prepareFirstCommit(repository, deps())

    expect(result.alreadyCommitted).toBe(false)
    expect(result.createdGitignore).toBe(true)
    expect(result.skippedFolders).toContain('node_modules/')
    expect(result.skippedFolders).toEqual([...GENERATED_IGNORE_PATTERNS])
    expect(existsSync(join(root, '.gitignore'))).toBe(true)
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('node_modules/')
    const tracked = git(root, 'ls-files')
    expect(tracked).toContain('README.md')
    expect(tracked).toContain('.gitignore')
    expect(tracked).not.toContain('node_modules')
    expect(git(root, 'status', '--porcelain').trim()).toBe('')
  })

  it('respects an existing .gitignore and uses one-time excludes instead of rewriting it', async () => {
    const root = tempRoot()
    const repository = makeRepo(root)
    const original = '# Keep this file exactly as it is.\n'
    writeFileSync(join(root, '.gitignore'), original)
    writeFileSync(join(root, 'README.md'), 'project\n')
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'dependency\n')

    const result = await prepareFirstCommit(repository, deps())

    expect(result.createdGitignore).toBe(false)
    expect(result.skippedFolders).toContain('node_modules/')
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(original)
    const tracked = git(root, 'ls-files')
    expect(tracked).toContain('README.md')
    expect(tracked).toContain('.gitignore')
    expect(tracked).not.toContain('node_modules')
  })

  it('creates an empty initial commit for an empty folder without adding .gitignore', async () => {
    const root = tempRoot()
    const repository = makeRepo(root)

    const result = await prepareFirstCommit(repository, deps())

    expect(result.alreadyCommitted).toBe(false)
    expect(result.committedFiles).toBe(0)
    expect(result.createdGitignore).toBe(false)
    expect(result.skippedFolders).toEqual([])
    expect(existsSync(join(root, '.gitignore'))).toBe(false)
    expect(git(root, 'log', '-1', '--pretty=%s').trim()).toBe('Initial commit')
  })

  it('does not create a second baseline when HEAD already exists', async () => {
    const root = tempRoot()
    const repository = makeRepo(root)
    writeFileSync(join(root, 'README.md'), 'project\n')
    git(root, 'add', 'README.md')
    git(root, 'commit', '-qm', 'existing baseline')
    const before = git(root, 'rev-parse', 'HEAD').trim()

    const result = await prepareFirstCommit(repository, deps())

    expect(result.alreadyCommitted).toBe(true)
    expect(result.committedFiles).toBe(0)
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(before)
    expect(git(root, 'log', '--pretty=%s')).toBe('existing baseline\n')
  })

  it('fails before committing when Git has no author identity', async () => {
    const root = tempRoot()
    const repository = makeRepo(root)
    git(root, 'config', '--unset', 'user.name')
    git(root, 'config', '--unset', 'user.email')
    writeFileSync(join(root, 'README.md'), 'project\n')
    setEnv('GIT_CONFIG_GLOBAL', join(tempRoot(), 'missing-global-config'))
    setEnv('GIT_CONFIG_SYSTEM', join(tempRoot(), 'missing-system-config'))
    setEnv('GIT_CONFIG_NOSYSTEM', '1')

    const error = await prepareFirstCommit(repository, deps()).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(RepositoryPreparationError)
    expect((error as RepositoryPreparationError).appError.code).toBe('GIT_IDENTITY_MISSING')
    expect(() => git(root, 'rev-parse', '--verify', 'HEAD')).toThrow()
  })
})
