import { describe, expect, it } from 'vitest'
import type { GitStatusEntry, GitWorkspaceStatus } from '../../../shared/domain/git-workspace'
import {
  diffScopeFor,
  reviewStatusFor,
  uncommittedFileCount,
  workingTreeGroups
} from './working-tree'

function entry(
  path: string,
  area: GitStatusEntry['area'],
  overrides: Partial<GitStatusEntry> = {}
): GitStatusEntry {
  return {
    path,
    oldPath: null,
    code: area === 'untracked' ? '??' : ' M',
    area,
    status: area === 'untracked' ? 'untracked' : 'modified',
    ...overrides
  }
}

function snapshot(parts: Partial<GitWorkspaceStatus> = {}): GitWorkspaceStatus {
  return {
    branch: 'icode/session',
    headOid: 'abc',
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    clean: true,
    ...parts
  }
}

describe('working tree projection', () => {
  it('keeps staged and unstaged rows for a partially staged path', () => {
    const groups = workingTreeGroups(
      snapshot({
        staged: [entry('src/a.ts', 'staged', { added: 4, removed: 2 })],
        unstaged: [entry('src/a.ts', 'unstaged', { added: 3, removed: 1 })]
      })
    )
    expect(groups.staged[0]).toMatchObject({ key: 'staged:src/a.ts', added: 4, removed: 2 })
    expect(groups.unstaged[0]).toMatchObject({ key: 'unstaged:src/a.ts', added: 3, removed: 1 })
    expect(uncommittedFileCount(groups)).toBe(1)
  })

  it('maps areas and Git statuses onto the area-diff request', () => {
    expect(diffScopeFor('staged')).toBe('staged')
    expect(diffScopeFor('unstaged')).toBe('unstaged')
    expect(diffScopeFor('untracked')).toBe('untracked')
    expect(diffScopeFor('conflicts')).toBe('conflict')
    expect(reviewStatusFor(entry('a', 'untracked'))).toBe('added')
    expect(reviewStatusFor(entry('a', 'unstaged', { status: 'deleted' }))).toBe('deleted')
    expect(reviewStatusFor(entry('a', 'staged', { status: 'renamed' }))).toBe('renamed')
    expect(reviewStatusFor(entry('a', 'conflicted', { status: 'unmerged' }))).toBe('modified')
  })
})
