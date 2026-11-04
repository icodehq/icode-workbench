import { describe, expect, it } from 'vitest'
import type { GitLogEntry } from '../../../shared/domain/git-workspace'
import { buildHistoryGraph } from './history-graph'

function commit(oid: string, parents: string[]): GitLogEntry {
  return {
    oid,
    shortOid: oid.slice(0, 4),
    parents,
    subject: oid,
    author: 'A',
    authorEmail: 'a@test',
    authoredAt: 1,
    refs: []
  }
}

describe('history graph lanes', () => {
  it('keeps a linear history on one lane', () => {
    const rows = buildHistoryGraph([commit('c', ['b']), commit('b', ['a']), commit('a', [])])
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 0])
    expect(rows.map((row) => row.lanes)).toEqual([[0], [0], [0]])
    expect(rows.every((row) => row.merge === false)).toBe(true)
  })

  it('opens a second lane for a merge parent and closes it at the fork', () => {
    const rows = buildHistoryGraph([
      commit('m', ['a', 'b']),
      commit('a', ['p']),
      commit('b', ['p']),
      commit('p', [])
    ])
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 1, 0])
    expect(rows[0]?.parentLanes).toEqual([0, 1])
    expect(rows[0]?.lanes).toEqual([0, 1])
    expect(rows[0]?.merge).toBe(true)
    expect(rows[1]?.lanes).toEqual([0, 1])
    expect(rows[2]?.lanes).toEqual([0, 1])
    expect(rows[3]?.lanes).toEqual([0])
  })

  it('starts a new lane when a page begins mid-history', () => {
    const rows = buildHistoryGraph([commit('x', ['y']), commit('z', [])])
    expect(rows.map((row) => row.lane)).toEqual([0, 1])
    expect(rows[0]?.lanes).toEqual([0])
    expect(rows[1]?.lanes).toEqual([0, 1])
  })

  it('reuses a free lane instead of growing forever', () => {
    const rows = buildHistoryGraph([
      commit('m', ['a', 'b']),
      commit('a', ['p']),
      commit('b', []),
      commit('c', []),
      commit('p', [])
    ])
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 1, 1, 0])
  })
})
