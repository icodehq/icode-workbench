import { describe, expect, it } from 'vitest'
import {
  parseOperationMarker,
  parseRemotes,
  parseSubmoduleStatus,
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

describe('parseRemotes', () => {
  it('pairs fetch and push URLs and falls back to the fetch URL', () => {
    const output = [
      'origin\thttps://example.test/atlas.git (fetch)',
      'origin\tgit@example.test:atlas.git (push)',
      'backup\t/tmp/backup.git (fetch)',
      'backup\t/tmp/backup.git (push)',
      'fetch-only\t/tmp/other.git (fetch)'
    ].join('\n')
    expect(parseRemotes(output)).toEqual([
      {
        name: 'origin',
        url: 'https://example.test/atlas.git',
        pushUrl: 'git@example.test:atlas.git'
      },
      { name: 'backup', url: '/tmp/backup.git', pushUrl: '/tmp/backup.git' },
      { name: 'fetch-only', url: '/tmp/other.git', pushUrl: null }
    ])
  })

  it('ignores blank and malformed lines', () => {
    expect(parseRemotes('\nnot a remote line\n')).toEqual([])
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

describe('parseSubmoduleStatus', () => {
  it('reads state, object id, path and configured branch', () => {
    const output = [
      ' ' + 'a'.repeat(40) + ' vendor/lib (heads/main)',
      '-' + 'b'.repeat(40) + ' vendor/uninit',
      '+' + 'c'.repeat(40) + ' vendor/modified',
      'U' + 'd'.repeat(40) + ' vendor/conflict (heads/next)',
      'garbage',
      ''
    ].join('\n')
    expect(parseSubmoduleStatus(output)).toEqual([
      {
        path: 'vendor/lib',
        oid: 'a'.repeat(40),
        state: 'clean',
        branch: 'heads/main'
      },
      {
        path: 'vendor/uninit',
        oid: 'b'.repeat(40),
        state: 'uninitialized',
        branch: null
      },
      {
        path: 'vendor/modified',
        oid: 'c'.repeat(40),
        state: 'modified',
        branch: null
      },
      {
        path: 'vendor/conflict',
        oid: 'd'.repeat(40),
        state: 'conflict',
        branch: 'heads/next'
      }
    ])
  })

  it('handles empty output and CRLF', () => {
    expect(parseSubmoduleStatus('')).toEqual([])
    const line = ' ' + 'e'.repeat(40) + ' vendor/lib (main)\r\n'
    expect(parseSubmoduleStatus(line)).toMatchObject([
      { path: 'vendor/lib', state: 'clean', branch: 'main' }
    ])
  })
})
