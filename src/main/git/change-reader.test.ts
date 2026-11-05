import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseOthersZ,
  parseRawZ,
  parseStatusZ,
  readChangeDiff,
  readChangeList,
  type ReadContext
} from './change-reader'
import { runGitRead } from './bounded-read'
import { parseNumstatZ } from './git-helpers'
import { localContainment, localSymlinkProbe } from './path-safety'

const roots: string[] = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function commit(repo: string, message: string): void {
  execFileSync(
    'git',
    ['-C', repo, '-c', 'user.email=icode@test', '-c', 'user.name=iCode', 'commit', '-qm', message],
    { stdio: 'pipe' }
  )
}

const context: ReadContext = {
  read: runGitRead,
  containment: localContainment,
  symlinkProbe: localSymlinkProbe
}

type Fixture = {
  root: string
  repo: string
  base: string
  sessionId: string
}

function makeRepo(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'icode-change-reader-'))
  roots.push(root)
  const repo = join(root, 'atlas')
  mkdirSync(repo)
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
  writeFileSync(join(repo, 'gone.txt'), 'delete me\n')
  git(repo, 'add', '.')
  commit(repo, 'init')
  return { root, repo, base: git(repo, 'rev-parse', 'HEAD'), sessionId: 'ses_test' }
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
    const output =
      'MM both.txt\u0000 M unstaged.txt\u0000M  staged.txt\u0000?? new.txt\u0000UU conflict.txt\u0000R  new.txt\u0000old.txt\u0000'
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

describe('listing changes since the baseline', () => {
  it('includes a committed change (baseline is not HEAD)', async () => {
    const f = makeRepo()
    writeFileSync(join(f.repo, 'a.txt'), 'one\ntwo changed\nthree\n')
    git(f.repo, 'add', 'a.txt')
    commit(f.repo, 'agent commit')

    const list = await readChangeList(context, {
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

    const list = await readChangeList(context, {
      worktreePath: f.repo,
      baseOid: f.base,
      sessionId: f.sessionId
    })
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

    const list = await readChangeList(context, {
      worktreePath: f.repo,
      baseOid: f.base,
      sessionId: f.sessionId
    })
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

    const list = await readChangeList(context, {
      worktreePath: f.repo,
      baseOid: f.base,
      sessionId: f.sessionId
    })
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

    const list = await readChangeList(context, {
      worktreePath: f.repo,
      baseOid: f.base,
      sessionId: f.sessionId
    })
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

    const list = await readChangeList(context, {
      worktreePath: f.repo,
      baseOid: f.base,
      sessionId: f.sessionId
    })
    expect(list.files.find((file) => file.path === 'a.txt')?.area).toBe('conflicted')
  })

  it('caps the file list and reports truncation', async () => {
    const f = makeRepo()
    for (let index = 0; index < 1001; index += 1) {
      writeFileSync(join(f.repo, `bulk-${String(index)}.txt`), 'x\n')
    }
    const list = await readChangeList(context, {
      worktreePath: f.repo,
      baseOid: f.base,
      sessionId: f.sessionId
    })
    expect(list.files).toHaveLength(1000)
    expect(list.listTruncated).toBe(true)
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

    const diff = await readChangeDiff(context, {
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
