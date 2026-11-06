import { describe, expect, it } from 'vitest'
import type { GitStatusEntry, GitWorkspaceStatus } from '../../../shared/domain/git-workspace'
import { buildFileDecorations } from './file-decorations'

const entry = (path: string, status: GitStatusEntry['status'], area: GitStatusEntry['area']): GitStatusEntry => ({
  path,
  oldPath: null,
  code: ' M',
  area,
  status
})

const snapshot = (overrides: Partial<GitWorkspaceStatus> = {}): GitWorkspaceStatus => ({
  branch: 'main',
  headOid: 'a'.repeat(40),
  upstream: null,
  ahead: 0,
  behind: 0,
  staged: [],
  unstaged: [],
  untracked: [],
  conflicted: [],
  clean: false,
  ...overrides
})

describe('file decorations', () => {
  it('maps status letters, tones and folder ancestors', () => {
    const decorations = buildFileDecorations(
      snapshot({
        staged: [entry('src/a.ts', 'added', 'staged')],
        unstaged: [entry('src/b.ts', 'modified', 'unstaged')],
        untracked: [entry('docs/new.md', 'untracked', 'untracked')],
        conflicted: [entry('src/c.ts', 'unmerged', 'conflicted')]
      })
    )
    expect(decorations.files.get('src/a.ts')).toMatchObject({ letter: 'A', tone: 'text-add' })
    expect(decorations.files.get('src/b.ts')).toMatchObject({ letter: 'M', tone: 'text-signal' })
    expect(decorations.files.get('docs/new.md')).toMatchObject({ letter: 'U', tone: 'text-add' })
    expect(decorations.files.get('src/c.ts')).toMatchObject({ letter: '!', tone: 'text-destructive' })
    expect([...decorations.folders].sort()).toEqual(['docs', 'src'])
  })

  it('lets the worktree state win over the index and conflict win over both', () => {
    const decorations = buildFileDecorations(
      snapshot({
        staged: [entry('a.ts', 'added', 'staged'), entry('b.ts', 'added', 'staged')],
        unstaged: [entry('a.ts', 'modified', 'unstaged')],
        conflicted: [entry('b.ts', 'unmerged', 'conflicted')]
      })
    )
    expect(decorations.files.get('a.ts')?.letter).toBe('M')
    expect(decorations.files.get('b.ts')?.letter).toBe('!')
  })

  it('is empty without a snapshot', () => {
    expect(buildFileDecorations(null)).toEqual({ files: new Map(), folders: new Set() })
  })
})
