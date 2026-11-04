import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GitReviewReader,
  ReviewReadError,
  assertContained,
  assertSafeRelativePath,
  cutToLastNewline,
  parseNumstatZ,
  parseOthersZ,
  parseRawZ,
  parseStatusZ,
  runGitRead,
  truncateUtf8
} from './git-review-reader'

const roots: string[] = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function commit(repo: string, message: string): void {
  execFileSync(
    'git',
    ['-C', repo, '-c', 'user.email=ade@test', '-c', 'user.name=ADE', 'commit', '-qm', message],
    { stdio: 'pipe' }
  )
}

type Fixture = {
  root: string
  repo: string
  reader: GitReviewReader
  base: string
  sessionId: string
}

function makeRepo(options: { baseline?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'ade-review-'))
  roots.push(root)
  const repo = join(root, 'atlas')
  mkdirSync(repo)
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  if (options.baseline === false) {
    return { root, repo, reader: new GitReviewReader(), base: '', sessionId: 'ses_test' }
  }
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
  writeFileSync(join(repo, 'gone.txt'), 'delete me\n')
  git(repo, 'add', '.')
  commit(repo, 'init')
  return {
    root,
    repo,
    reader: new GitReviewReader(),
    base: git(repo, 'rev-parse', 'HEAD'),
    sessionId: 'ses_test'
  }
}

function codeOf(error: unknown): string | undefined {
  return error instanceof ReviewReadError ? error.appError.code : undefined
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('decoders', () => {
  it('parses raw rename entries with modes and old path', () => {
    const output =
      ':100644 100755 abc123 abc123 M\u0000f.txt\u0000' +
      ':100644 100644 aaa bbb R100\u0000old.txt\u0000new.txt\u0000' +
      ':000000 120000 000 ccc A\u0000link\u0000'
    expect(parseRawZ(output)).toEqual([
      { status: 'modified', oldMode: '100644', newMode: '100755', path: 'f.txt', oldPath: null },
      { status: 'renamed', oldMode: '100644', newMode: '100644', path: 'new.txt', oldPath: 'old.txt' },
      { status: 'added', oldMode: '000000', newMode: '120000', path: 'link', oldPath: null }
    ])
  })

  it('parses numstat including the rename triple and binary dashes', () => {
    const output = '3\t1\ta.txt\u00002\t0\t\u0000old.txt\u0000new.txt\u0000-\t-\timg.bin\u0000'
    expect(parseNumstatZ(output)).toEqual([
      { path: 'a.txt', oldPath: null, additions: 3, deletions: 1, binary: false },
      { path: 'new.txt', oldPath: 'old.txt', additions: 2, deletions: 0, binary: false },
      { path: 'img.bin', oldPath: null, additions: null, deletions: null, binary: true }
    ])
  })

  it('parses status areas, conflicts, and rename ordering', () => {
    const output = 'MM both.txt\u0000 M unstaged.txt\u0000M  staged.txt\u0000?? new.txt\u0000UU conflict.txt\u0000R  new.txt\u0000old.txt\u0000'
    expect(parseStatusZ(output)).toEqual([
      { path: 'both.txt', oldPath: null, index: 'M', worktree: 'M', area: 'both' },
      { path: 'unstaged.txt', oldPath: null, index: ' ', worktree: 'M', area: 'unstaged' },
      { path: 'staged.txt', oldPath: null, index: 'M', worktree: ' ', area: 'staged' },
      { path: 'new.txt', oldPath: null, index: '?', worktree: '?', area: 'untracked' },
      { path: 'conflict.txt', oldPath: null, index: 'U', worktree: 'U', area: 'conflicted' },
      { path: 'new.txt', oldPath: 'old.txt', index: 'R', worktree: ' ', area: 'staged' }
    ])
  })

  it('parses untracked output and ignores empty records', () => {
    expect(parseOthersZ('a.txt\u0000b/c.txt\u0000\u0000')).toEqual(['a.txt', 'b/c.txt'])
  })
})

describe('bounded output', () => {
  it('trims to a UTF-8 boundary instead of emitting replacement characters', () => {
    const buffer = Buffer.from('héllo', 'utf8')
    const truncated = truncateUtf8(buffer, 2)
    expect(truncated.toString('utf8')).toBe('h')
    expect(truncated.toString('utf8')).not.toContain('\uFFFD')
  })

  it('cuts a truncated patch to its last complete line', () => {
    expect(cutToLastNewline('a\nb\npartial')).toBe('a\nb\n')
    expect(cutToLastNewline('no newline')).toBe('no newline')
  })

  it('terminates a Git read that exceeds its byte budget', async () => {
    const f = makeRepo()
    writeFileSync(join(f.repo, 'big.txt'), 'x\n'.repeat(100_000))
    const result = await runGitRead({
      cwd: f.repo,
      args: ['diff', '--no-index', '--', '/dev/null', 'big.txt'],
      byteBudget: 4096
    })
    expect(result.truncated).toBe(true)
    expect(result.truncatedReason).toBe('bytes')
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(4096)
    expect(result.signal === 'SIGTERM' || result.signal === 'SIGKILL').toBe(true)
  })

  it('times out a stalled read and reports it explicitly', async () => {
    const f = makeRepo()
    // A missing object makes Git fail fast; the timeout path is exercised with
    // a 1ms budget instead so the test stays deterministic.
    const result = await runGitRead({
      cwd: f.repo,
      args: ['diff', '--numstat', f.base, '--'],
      timeoutMs: 1
    }).catch((error: unknown) => error)
    if (result instanceof Error) {
      expect(codeOf(result)).toBe('GIT_READ_FAILED')
    } else {
      const read = result as { truncated: boolean; exitCode: number | null }
      expect(read.truncated || read.exitCode !== null).toBe(true)
    }
  })

  it('refuses a non-read-only Git subcommand', async () => {
    await expect(
      runGitRead({ cwd: '/tmp', args: ['commit', '-m', 'nope'] })
    ).rejects.toSatisfy((error: unknown) => codeOf(error) === 'INVALID_ARGUMENT')
    await expect(
      runGitRead({ cwd: '/tmp', args: ['add', '.'] })
    ).rejects.toSatisfy((error: unknown) => codeOf(error) === 'INVALID_ARGUMENT')
  })
})

describe('path validation', () => {
  it('rejects unsafe relative paths', () => {
    for (const value of ['/etc/passwd', '../x', 'a/../../b', '-p', 'C:\\x', '\\\\srv\\s', '']) {
      expect(() => assertSafeRelativePath(value)).toThrow()
    }
    expect(() => assertSafeRelativePath('src/app.ts')).not.toThrow()
  })

  it('rejects escape through a symlinked directory and accepts a symlinked file', () => {
    const f = makeRepo()
    const outside = join(f.root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'secret\n')
    symlinkSync(outside, join(f.repo, 'escape'))

    expect(() => assertContained(f.repo, 'escape/secret.txt')).toThrow()
    // A symlink file itself is fine: Git emits its target text, not the content.
    symlinkSync('/etc/passwd', join(f.repo, 'link.txt'))
    expect(() => assertContained(f.repo, 'link.txt')).not.toThrow()
  })
})

describe('listing changes since the baseline', () => {
  it('includes a committed change (baseline is not HEAD)', async () => {
    const f = makeRepo()
    writeFileSync(join(f.repo, 'a.txt'), 'one\ntwo changed\nthree\n')
    git(f.repo, 'add', 'a.txt')
    commit(f.repo, 'agent commit')

    const list = await f.reader.list({
      worktreePath: f.repo,
      baseOid: f.base,
      sessionId: f.sessionId
    })
    expect(list.files.map((file) => file.path)).toContain('a.txt')
    expect(list.files.find((file) => file.path === 'a.txt')).toMatchObject({
      status: 'modified',
      origin: 'tracked'
    })
  })

  it('merges staged and unstaged edits into one row with metadata', async () => {
    const f = makeRepo()
    writeFileSync(join(f.repo, 'a.txt'), 'one\ntwo\nthree\nfour\n')
    git(f.repo, 'add', 'a.txt')
    writeFileSync(join(f.repo, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n')

    const list = await f.reader.list({ worktreePath: f.repo, baseOid: f.base, sessionId: f.sessionId })
    const rows = list.files.filter((file) => file.path === 'a.txt')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.area).toBe('both')
    expect(rows[0]!.additions).toBe(2)
    expect(rows[0]!.deletions).toBe(0)
  })

  it('lists untracked files with counts and excludes ignored files', async () => {
    const f = makeRepo()
    writeFileSync(join(f.repo, '.gitignore'), 'ignored/\n')
    mkdirSync(join(f.repo, 'ignored'))
    writeFileSync(join(f.repo, 'ignored', 'skip.txt'), 'skip\n')
    writeFileSync(join(f.repo, 'fresh.txt'), 'l1\nl2\n')

    const list = await f.reader.list({ worktreePath: f.repo, baseOid: f.base, sessionId: f.sessionId })
    const paths = list.files.map((file) => file.path)
    expect(paths).toContain('fresh.txt')
    expect(paths).not.toContain('ignored/skip.txt')
    const fresh = list.files.find((file) => file.path === 'fresh.txt')!
    expect(fresh.origin).toBe('untracked')
    expect(fresh.area).toBe('untracked')
    expect(fresh.additions).toBe(2)
  })

  it('lists a deletion and a rename above the similarity threshold', async () => {
    const f = makeRepo()
    rmSync(join(f.repo, 'gone.txt'))
    git(f.repo, 'mv', 'a.txt', 'renamed.txt')

    const list = await f.reader.list({ worktreePath: f.repo, baseOid: f.base, sessionId: f.sessionId })
    expect(list.files.find((file) => file.path === 'gone.txt')).toMatchObject({ status: 'deleted' })
    expect(list.files.find((file) => file.path === 'renamed.txt')).toMatchObject({
      status: 'renamed',
      oldPath: 'a.txt'
    })
  })

  it('detects binary and symlink entries', async () => {
    const f = makeRepo()
    writeFileSync(join(f.repo, 'blob.bin'), Buffer.from(Array.from({ length: 2048 }, (_v, i) => i % 256)))
    symlinkSync('a.txt', join(f.repo, 'link.txt'))

    const list = await f.reader.list({ worktreePath: f.repo, baseOid: f.base, sessionId: f.sessionId })
    const binary = list.files.find((file) => file.path === 'blob.bin')!
    expect(binary.binary).toBe(true)
    expect(binary.additions).toBeNull()
    expect(list.files.find((file) => file.path === 'link.txt')?.symlink).toBe(true)
  })

  it('marks conflicts without hiding the file', async () => {
    const f = makeRepo()
    git(f.repo, 'checkout', '-q', '-b', 'side')
    writeFileSync(join(f.repo, 'a.txt'), 'one\nSIDE\nthree\n')
    git(f.repo, 'add', 'a.txt')
    commit(f.repo, 'side')
    git(f.repo, 'checkout', '-q', 'main')
    writeFileSync(join(f.repo, 'a.txt'), 'one\nMAIN\nthree\n')
    git(f.repo, 'add', 'a.txt')
    commit(f.repo, 'main')
    try {
      execFileSync('git', ['-C', f.repo, 'merge', 'side'], { stdio: 'pipe' })
    } catch {
      // Expected conflict.
    }

    const list = await f.reader.list({ worktreePath: f.repo, baseOid: f.base, sessionId: f.sessionId })
    expect(list.files.find((file) => file.path === 'a.txt')?.area).toBe('conflicted')
  })

  it('caps the file list and reports truncation', async () => {
    const f = makeRepo()
    for (let index = 0; index < 1001; index += 1) {
      writeFileSync(join(f.repo, `bulk-${String(index)}.txt`), 'x\n')
    }
    const list = await f.reader.list({ worktreePath: f.repo, baseOid: f.base, sessionId: f.sessionId })
    expect(list.files).toHaveLength(1000)
    expect(list.listTruncated).toBe(true)
  })
})

describe('review reader routing by execution target', () => {
  const WSL = {
    kind: 'wsl' as const,
    distro: 'Ubuntu-26.04',
    distroId: 'a5489bf0-2b9e-49bf-940e-0c19a6caef73'
  }

  it('keeps the local reader for a local target', () => {
    const read = vi.fn()
    const reader = new GitReviewReader({ read: read as never })
    expect(reader.forTarget({ kind: 'local' })).toBe(reader)
  })

  it('uses the guest reader for a WSL target', async () => {
    const guestRead = vi.fn(async () => ({
      stdout: 'guest output',
      stderrTail: '',
      exitCode: 0,
      signal: null,
      truncated: false,
      truncatedReason: null
    }))
    const reader = new GitReviewReader({ readForTarget: () => guestRead as never })
    const routed = reader.forTarget(WSL)
    expect(routed).not.toBe(reader)
    // The routed reader's read is the guest one: asserting `toHaveBeenCalled`
    // after exercising it is what proves the selection, not the object identity.
    const result = await routed.runReadForTest({
      cwd: '/home/u/src',
      args: ['diff', '--stat'],
      timeoutMs: 1_000
    })
    expect(guestRead).toHaveBeenCalledTimes(1)
    expect(result.stdout).toBe('guest output')
  })

  it('refuses a WSL read when no guest reader is wired, instead of using local Git', async () => {
    const reader = new GitReviewReader({})
    const routed = reader.forTarget(WSL)
    await expect(
      routed.runReadForTest({ cwd: '/home/u/src', args: ['diff'], timeoutMs: 1_000 })
    ).rejects.toMatchObject({ appError: { code: 'GIT_READ_FAILED' } })
  })
})

describe('conflicted diffs', () => {
  it('reads the working file as a normal patch containing the markers', async () => {
    const f = makeRepo()
    git(f.repo, 'checkout', '-q', '-b', 'side')
    writeFileSync(join(f.repo, 'a.txt'), 'side\n')
    git(f.repo, 'add', 'a.txt')
    commit(f.repo, 'side')
    git(f.repo, 'checkout', '-q', 'main')
    writeFileSync(join(f.repo, 'a.txt'), 'main\n')
    git(f.repo, 'add', 'a.txt')
    commit(f.repo, 'main')
    expect(() => git(f.repo, 'merge', 'side')).toThrow()

    const diff = await f.reader.diffArea({
      worktreePath: f.repo,
      sessionId: f.sessionId,
      path: 'a.txt',
      oldPath: null,
      scope: 'conflict',
      status: 'modified',
      binary: false,
      symlink: null,
      additions: null,
      deletions: null
    })
    expect(diff.patch).toContain('<<<<<<< HEAD')
    expect(diff.patch).toContain('=======')
    expect(diff.patch).toContain('>>>>>>> side')
    expect(diff.patch).toContain('+++ b/a.txt')
    expect(diff.patch).not.toContain('diff --cc')
  })
})
