import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitReadError, cutToLastNewline, runGitRead, truncateUtf8 } from './bounded-read'
import { assertContained, assertSafeRelativePath } from './path-safety'

const roots: string[] = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function makeRepo(): { root: string; repo: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), 'icode-git-read-'))
  roots.push(root)
  const repo = join(root, 'atlas')
  mkdirSync(repo)
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
  git(repo, 'add', '.')
  execFileSync(
    'git',
    ['-C', repo, '-c', 'user.email=icode@test', '-c', 'user.name=iCode', 'commit', '-qm', 'init'],
    { stdio: 'pipe' }
  )
  return { root, repo, base: git(repo, 'rev-parse', 'HEAD') }
}

function codeOf(error: unknown): string | undefined {
  return error instanceof GitReadError ? error.appError.code : undefined
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
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
