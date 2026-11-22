import { describe, expect, it } from 'vitest'
import {
  moveRowId,
  orderByStoredIds,
  orderRowIds,
  pruneSidebarOrder,
  sessionGroupKey
} from './sidebar-order'

describe('sidebar order', () => {
  it('keeps a remembered order and appends unmentioned rows', () => {
    expect(orderRowIds(['a', 'b', 'c', 'd'], ['c', 'gone', 'a'])).toEqual(['c', 'a', 'b', 'd'])
  })

  it('deduplicates remembered ids and preserves the first mention', () => {
    expect(orderRowIds(['a', 'b'], ['b', 'a', 'b'])).toEqual(['b', 'a'])
  })

  it('orders objects by a key extractor', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(orderByStoredIds(rows, ['c'], (row) => row.id)).toEqual([
      { id: 'c' },
      { id: 'a' },
      { id: 'b' }
    ])
  })

  it('moves a row before and after its target', () => {
    expect(moveRowId(['a', 'b', 'c'], 'a', 'c', true)).toEqual(['b', 'c', 'a'])
    expect(moveRowId(['a', 'b', 'c'], 'c', 'a', false)).toEqual(['c', 'a', 'b'])
    expect(moveRowId(['a', 'b', 'c'], 'b', 'c', false)).toEqual(['a', 'b', 'c'])
  })

  it('leaves the order untouched for unknown or identical rows', () => {
    expect(moveRowId(['a', 'b'], 'a', 'a', true)).toEqual(['a', 'b'])
    expect(moveRowId(['a', 'b'], 'a', 'missing', true)).toEqual(['a', 'b'])
    expect(moveRowId(['a', 'b'], 'missing', 'a', false)).toEqual(['a', 'b'])
  })

  it('prunes stale ids and empty groups without touching live ones', () => {
    const pruned = pruneSidebarOrder(
      {
        projects: ['repo_1', 'gone'],
        worktrees: {
          repo_1: ['/live', '/gone'],
          repo_gone: ['/live']
        },
        sessions: {
          'default:repo_1': ['ses_1', 'ses_gone'],
          'worktree:/gone': ['ses_2']
        }
      },
      {
        projects: new Set(['repo_1']),
        worktrees: { repo_1: new Set(['/live']) },
        sessions: { 'default:repo_1': new Set(['ses_1']) }
      }
    )
    expect(pruned).toEqual({
      projects: ['repo_1'],
      worktrees: { repo_1: ['/live'] },
      sessions: { 'default:repo_1': ['ses_1'] }
    })
  })

  it('keys the default checkout and each worktree separately', () => {
    expect(sessionGroupKey('repo_1', null)).toBe('default:repo_1')
    expect(sessionGroupKey('repo_1', '/checkouts/one')).toBe('worktree:/checkouts/one')
  })
})
