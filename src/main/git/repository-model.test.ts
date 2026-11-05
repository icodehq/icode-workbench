import { describe, expect, it } from 'vitest'
import {
  parseOperationMarker,
  parseWorktreeList,
} from './repository-model'

describe('parseOperationMarker', () => {
  it('maps each in-progress marker and ignores unknown files', () => {
    expect(parseOperationMarker('MERGE_HEAD')).toBe('merge')
    expect(parseOperationMarker('CHERRY_PICK_HEAD')).toBe('cherry-pick')
    expect(parseOperationMarker('REVERT_HEAD')).toBe('revert')
    expect(parseOperationMarker('rebase-merge')).toBe('rebase')
    expect(parseOperationMarker('rebase-apply')).toBe('rebase')
    expect(parseOperationMarker('BISECT_LOG')).toBe('bisect')
    expect(parseOperationMarker('config')).toBeNull()
    expect(parseOperationMarker(null)).toBeNull()
  })
})

describe('parseWorktreeList', () => {
  it('parses records including branches, detached, locked and bare entries', () => {
    const output = [
      'worktree /repo',
      'HEAD ' + '1'.repeat(40),
      'branch refs/heads/main',
      '',
      'worktree /repo-wt',
      'HEAD ' + '2'.repeat(40),
      'branch refs/heads/feature',
      'locked agent session',
      '',
      'worktree /repo-detached',
      'HEAD ' + '3'.repeat(40),
      'detached',
      'prunable gitdir file points to non-existent location',
      ''
    ].join('\n')
    const entries = parseWorktreeList(output)
    expect(entries).toHaveLength(3)
    expect(entries[0]).toMatchObject({ path: '/repo', branch: 'main', bare: false, detached: false })
    expect(entries[1]).toMatchObject({ branch: 'feature', locked: 'agent session' })
    expect(entries[2]).toMatchObject({
      branch: null,
      detached: true,
      prunable: 'gitdir file points to non-existent location'
    })
  })

  it('handles a bare worktree and CRLF output', () => {
    const entries = parseWorktreeList('worktree C:/repo\r\nHEAD ' + 'a'.repeat(40) + '\r\nbare\r\n')
    expect(entries).toEqual([
      {
        path: 'C:/repo',
        head: 'a'.repeat(40),
        branch: null,
        bare: true,
        detached: false,
        locked: null,
        prunable: null
      }
    ])
  })


})
