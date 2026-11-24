import { describe, expect, it } from 'vitest'
import {
  defaultWorkspaceKey,
  filePathFromTabKey,
  fileTabKey,
  isFileTabKey,
  isSessionTabKey,
  moveTabKey,
  orderTabKeys,
  parseTabKey,
  sessionGroupKey,
  sessionIdFromTabKey,
  sessionTabKey,
  workspaceKeyForSession,
  worktreeWorkspaceKey
} from './workspace-key'

describe('workspace keys', () => {
  it('keys the default checkout and worktrees by stable identity', () => {
    expect(sessionGroupKey('repo_1', null)).toBe('default:repo_1')
    expect(sessionGroupKey('repo_1', '/checkouts/one')).toBe('worktree:/checkouts/one')
    expect(defaultWorkspaceKey('repo_1')).toBe('default:repo_1')
    expect(worktreeWorkspaceKey('/checkouts/one')).toBe('worktree:/checkouts/one')
    expect(workspaceKeyForSession({ repoId: 'repo_1', worktree: null })).toBe('default:repo_1')
    expect(
      workspaceKeyForSession({
        repoId: 'repo_1',
        worktree: { path: '/checkouts/one' } as never
      })
    ).toBe('worktree:/checkouts/one')
  })
})

describe('tab keys', () => {
  it('namespaces session and file keys', () => {
    expect(sessionTabKey('ses_a')).toBe('session:ses_a')
    expect(fileTabKey('src/a.ts')).toBe('file:src/a.ts')
    expect(isSessionTabKey('session:ses_a')).toBe(true)
    expect(isFileTabKey('file:src/a.ts')).toBe(true)
    expect(sessionIdFromTabKey('session:ses_a')).toBe('ses_a')
    expect(filePathFromTabKey('file:src/a.ts')).toBe('src/a.ts')
    expect(sessionIdFromTabKey('file:src/a.ts')).toBeNull()
    expect(filePathFromTabKey('session:ses_a')).toBeNull()
  })

  it('parses session, file and diff keys', () => {
    expect(parseTabKey('session:ses_a')).toEqual({
      kind: 'session',
      key: 'session:ses_a',
      sessionId: 'ses_a'
    })
    expect(parseTabKey('file:src/a.ts')).toEqual({
      kind: 'file',
      key: 'file:src/a.ts',
      path: 'src/a.ts'
    })
    expect(parseTabKey('diff:unstaged:src/a.ts')).toEqual({
      kind: 'diff',
      key: 'diff:unstaged:src/a.ts'
    })
    expect(parseTabKey('unknown')).toBeNull()
    expect(parseTabKey('session:')).toBeNull()
    expect(parseTabKey('file:')).toBeNull()
  })
})

describe('tab ordering', () => {
  it('keeps remembered order and appends unknown keys in natural order', () => {
    expect(orderTabKeys(['session:b', 'file:a', 'session:a'], ['file:a', 'session:a'])).toEqual([
      'file:a',
      'session:a',
      'session:b'
    ])
  })

  it('moves a tab into the target slot in drag direction', () => {
    const ids = ['a', 'b', 'c', 'd']
    expect(moveTabKey(ids, 'a', 'c')).toEqual(['b', 'c', 'a', 'd'])
    expect(moveTabKey(ids, 'd', 'b')).toEqual(['a', 'd', 'b', 'c'])
    expect(moveTabKey(ids, 'a', 'a')).toEqual(ids)
    expect(moveTabKey(ids, 'x', 'a')).toEqual(ids)
  })
})
