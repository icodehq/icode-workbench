import { describe, expect, it } from 'vitest'
import {
  buildStageArgs,
  buildUnstageArgs,
  chunkPaths,
  commandPathsFor,
  executeDiscardBatch,
  executePathBatch,
  isValidGitPath,
  planDiscard,
  type GitPathTarget
} from './batch-ops'

const target = (path: string, area: GitPathTarget['area'], extra: Partial<GitPathTarget> = {}): GitPathTarget => ({
  path,
  area,
  ...extra
})

describe('path validation', () => {
  it('accepts repo-relative paths and refuses traversal or Windows spellings', () => {
    expect(isValidGitPath('src/auth/session.ts')).toBe(true)
    expect(isValidGitPath('docs/name with spaces.md')).toBe(true)
    expect(isValidGitPath('')).toBe(false)
    expect(isValidGitPath('/etc/passwd')).toBe(false)
    expect(isValidGitPath('src/../secret')).toBe(false)
    expect(isValidGitPath('src//file.ts')).toBe(false)
    expect(isValidGitPath('src\\file.ts')).toBe(false)
    expect(isValidGitPath('C:file.ts')).toBe(false)
    expect(isValidGitPath('src/\u0000file.ts')).toBe(false)
  })
})

describe('command paths', () => {
  it('stages only working/untracked rows and includes both sides of a rename', () => {
    const targets = [
      target('staged.ts', 'staged'),
      target('work.ts', 'unstaged'),
      target('new.ts', 'untracked'),
      target('conflict.ts', 'conflicted'),
      target('new-name.ts', 'unstaged', { oldPath: 'old-name.ts' })
    ]
    expect(commandPathsFor('stage', targets)).toEqual(['work.ts', 'new.ts', 'new-name.ts', 'old-name.ts'])
  })

  it('unstages only staged rows', () => {
    expect(
      commandPathsFor('unstage', [
        target('staged.ts', 'staged'),
        target('work.ts', 'unstaged'),
        target('conflict.ts', 'conflicted')
      ])
    ).toEqual(['staged.ts'])
  })

  it('deduplicates paths across targets', () => {
    expect(
      commandPathsFor('stage', [target('same.ts', 'unstaged'), target('same.ts', 'untracked')])
    ).toEqual(['same.ts'])
  })
})

describe('command construction', () => {
  it('uses add -A and separates paths from options', () => {
    expect(buildStageArgs(['a.ts', '-b.ts'])).toEqual(['add', '-A', '--', 'a.ts', '-b.ts'])
  })

  it('uses reset with HEAD normally and rm --cached on an unborn branch', () => {
    expect(buildUnstageArgs(['a.ts'], { unborn: false })).toEqual(['reset', '-q', 'HEAD', '--', 'a.ts'])
    expect(buildUnstageArgs(['a.ts'], { unborn: true })).toEqual([
      'rm',
      '--cached',
      '-r',
      '--force',
      '--',
      'a.ts'
    ])
  })
})

describe('chunkPaths', () => {
  it('respects the path count and character budget, keeping an oversized path alone', () => {
    const paths = ['a'.repeat(10), 'b'.repeat(10), 'c'.repeat(4)]
    expect(chunkPaths(paths, { maxChars: 12, maxPaths: 10 })).toEqual([
      ['a'.repeat(10)],
      ['b'.repeat(10)],
      ['c'.repeat(4)]
    ])
    expect(chunkPaths(['a', 'b', 'c'], { maxPaths: 2 })).toEqual([['a', 'b'], ['c']])
    expect(chunkPaths([])).toEqual([])
  })
})

describe('executePathBatch', () => {
  it('applies accepted paths, skips the rest and reports why', async () => {
    const calls: string[][] = []
    const result = await executePathBatch({
      action: 'stage',
      targets: [
        target('work.ts', 'unstaged'),
        target('already.ts', 'staged'),
        target('conflict.ts', 'conflicted')
      ],
      execute: async (args) => {
        calls.push(args)
      }
    })
    expect(calls).toEqual([['add', '-A', '--', 'work.ts']])
    expect(result.applied).toEqual(['work.ts'])
    expect(result.skipped).toEqual(['already.ts', 'conflict.ts'])
    expect(result.failed).toEqual([])
    expect(result.outcomes.map((outcome) => outcome.status)).toEqual(['applied', 'skipped', 'skipped'])
  })

  it('isolates a failing path without losing the successful neighbours', async () => {
    const attempted: string[][] = []
    const result = await executePathBatch({
      action: 'stage',
      targets: [
        target('good-1.ts', 'unstaged'),
        target('bad.ts', 'unstaged'),
        target('good-2.ts', 'unstaged')
      ],
      execute: async (args) => {
        const paths = args.slice(3)
        attempted.push(paths)
        if (paths.includes('bad.ts')) throw new Error('fatal: unable to stat bad.ts')
      }
    })
    expect(result.applied).toEqual(['good-1.ts', 'good-2.ts'])
    expect(result.failed).toEqual(['bad.ts'])
    expect(result.outcomes.find((outcome) => outcome.path === 'bad.ts')?.reason).toContain('unable to stat')
    // The first bulk call fails; the split retries the two halves, and only the
    // bad singleton fails after that.
    expect(attempted.some((paths) => paths.length === 1 && paths[0] === 'bad.ts')).toBe(true)
  })

  it('marks a rename failed when its old path fails', async () => {
    const result = await executePathBatch({
      action: 'stage',
      targets: [target('new.ts', 'unstaged', { oldPath: 'old.ts' })],
      execute: async (args) => {
        if (args.includes('old.ts')) throw new Error('could not add old.ts')
      }
    })
    expect(result.failed).toEqual(['new.ts'])
    expect(result.applied).toEqual([])
  })

  it('uses the unborn unstage command when asked', async () => {
    const calls: string[][] = []
    await executePathBatch({
      action: 'unstage',
      unborn: true,
      targets: [target('new.ts', 'staged')],
      execute: async (args) => {
        calls.push(args)
      }
    })
    expect(calls[0]?.slice(0, 3)).toEqual(['rm', '--cached', '-r'])
  })
})

describe('discard planning', () => {
  it('groups by the remedy and skips conflicts', () => {
    const plan = planDiscard([
      target('staged.ts', 'staged', { status: 'modified' }),
      target('new-name.ts', 'staged', { status: 'renamed', oldPath: 'old-name.ts' }),
      target('added.ts', 'staged', { status: 'added' }),
      target('work.ts', 'unstaged'),
      target('untracked.ts', 'untracked'),
      target('conflict.ts', 'conflicted')
    ])
    expect(plan.skipped.map((outcome) => outcome.path)).toEqual(['conflict.ts'])
    const byKind = Object.fromEntries(plan.groups.map((group) => [group.kind, group]))
    expect(byKind.staged?.paths).toEqual(['staged.ts', 'new-name.ts', 'old-name.ts'])
    expect(byKind.added?.paths).toEqual(['added.ts'])
    expect(byKind.unstaged?.paths).toEqual(['work.ts'])
    expect(byKind.untracked?.paths).toEqual(['untracked.ts'])
    expect(byKind.staged?.commands[0]?.slice(0, 4)).toEqual(['restore', '--staged', '--worktree', '--'])
    expect(byKind.unstaged?.commands[0]?.slice(0, 3)).toEqual(['restore', '--worktree', '--'])
    expect(byKind.added?.commands.map((command) => command[0])).toEqual(['rm', 'clean'])
    expect(byKind.untracked?.commands[0]?.[0]).toBe('clean')
  })
})

describe('executeDiscardBatch', () => {
  it('runs each group and reports a failed tracked path', async () => {
    const commands: string[][] = []
    const result = await executeDiscardBatch({
      targets: [
        target('good.ts', 'unstaged'),
        target('bad.ts', 'unstaged'),
        target('untracked.ts', 'untracked'),
        target('conflict.ts', 'conflicted')
      ],
      execute: async (batch) => {
        for (const command of batch) {
          commands.push([...command])
          if (command.includes('bad.ts') && command[0] === 'restore') {
            throw new Error('could not restore bad.ts')
          }
        }
      }
    })
    expect(result.applied).toEqual(['good.ts', 'untracked.ts'])
    expect(result.failed).toEqual(['bad.ts'])
    expect(result.skipped).toEqual(['conflict.ts'])
    expect(commands.some((command) => command[0] === 'clean')).toBe(true)
  })
})
