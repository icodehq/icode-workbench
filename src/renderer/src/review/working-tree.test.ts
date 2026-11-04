import { describe, expect, it } from 'vitest'
import type { GitStatusEntry, GitWorkspaceStatus } from '../../../shared/domain/git-workspace'
import {
  diffScopeFor,
  primaryCommitAction,
  reviewStatusFor,
  stageableEntryCount,
  uncommittedFileCount,
  workingTreeCounts,
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
    expect(workingTreeCounts(groups)).toEqual({
      conflicts: 0,
      staged: 1,
      unstaged: 1,
      untracked: 0
    })
  })

  it('counts stageable rows without counting staged rows', () => {
    const groups = workingTreeGroups(
      snapshot({
        staged: [entry('b.ts', 'staged')],
        unstaged: [entry('a.ts', 'unstaged'), entry('a.ts', 'unstaged')],
        untracked: [entry('c.ts', 'untracked')]
      })
    )
    expect(stageableEntryCount(groups)).toBe(3)
  })

  it('uses the primary-action ladder', () => {
    const base = {
      message: '',
      hasUpstream: true,
      ahead: 0,
      behind: 0
    }
    const conflicts = workingTreeGroups(snapshot({ conflicted: [entry('x.ts', 'conflicted')] }))
    expect(primaryCommitAction({ ...base, groups: conflicts }).kind).toBe('blocked')

    const staged = workingTreeGroups(snapshot({ staged: [entry('a.ts', 'staged')] }))
    expect(primaryCommitAction({ ...base, groups: staged })).toMatchObject({
      kind: 'commit',
      disabled: true,
      reason: 'Write a commit message first.'
    })
    expect(primaryCommitAction({ ...base, groups: staged, message: 'message' })).toMatchObject({
      kind: 'commit',
      label: 'Commit 1 file',
      disabled: false
    })

    const unstaged = workingTreeGroups(snapshot({ unstaged: [entry('a.ts', 'unstaged')] }))
    expect(primaryCommitAction({ ...base, groups: unstaged })).toMatchObject({
      kind: 'stage',
      label: 'Stage all'
    })

    const clean = workingTreeGroups(snapshot())
    expect(primaryCommitAction({ ...base, groups: clean, ahead: 2 }).kind).toBe('push')
    expect(primaryCommitAction({ ...base, groups: clean, behind: 2 }).kind).toBe('pull')
    expect(primaryCommitAction({ ...base, groups: clean, ahead: 1, behind: 1 }).kind).toBe('sync')
    expect(primaryCommitAction({ ...base, groups: clean, hasUpstream: false }).kind).toBe('publish')
    expect(primaryCommitAction({ ...base, groups: clean }).kind).toBe('noop')
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
