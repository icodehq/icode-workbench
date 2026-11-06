import { describe, expect, it } from 'vitest'
import type { GitStatusEntry } from '../../../shared/domain/git-workspace'
import type { WorkingTreeEntry } from '../review/working-tree'
import {
  clearSelection,
  keyArea,
  keyPath,
  pruneSelection,
  selectAll,
  selectOnly,
  selectRange,
  selectedEntries,
  selectionActions,
  selectionKey,
  toggleSelection,
  transferSelection
} from './selection-model'

const entry = (path: string, area: WorkingTreeEntry['area']): WorkingTreeEntry => {
  const status: GitStatusEntry = {
    path,
    oldPath: null,
    code: area === 'staged' ? 'M ' : ' M',
    area: area === 'conflicts' ? 'conflicted' : area === 'committed' ? 'staged' : area,
    status: 'modified'
  }
  return { key: selectionKey({ area, entry: status }), area, entry: status, added: 1, removed: 0 }
}

const groups = (entries: WorkingTreeEntry[]) => ({
  conflicts: entries.filter((item) => item.area === 'conflicts'),
  staged: entries.filter((item) => item.area === 'staged'),
  unstaged: entries.filter((item) => item.area === 'unstaged'),
  untracked: entries.filter((item) => item.area === 'untracked'),
  committed: entries.filter((item) => item.area === 'committed')
})

describe('selection keys', () => {
  it('distinguishes the same path in two areas', () => {
    expect(selectionKey(entry('src/a.ts', 'staged'))).toBe('staged:src/a.ts')
    expect(selectionKey(entry('src/a.ts', 'unstaged'))).toBe('unstaged:src/a.ts')
    expect(keyPath('staged:src/a.ts')).toBe('src/a.ts')
    expect(keyArea('staged:src/a.ts')).toBe('staged')
  })
})

describe('selection transitions', () => {
  it('selects one row and toggles it without affecting others', () => {
    const first = selectOnly('unstaged:a')
    expect(first.selected).toEqual(new Set(['unstaged:a']))
    const second = toggleSelection(first, 'staged:a')
    expect(second.selected).toEqual(new Set(['unstaged:a', 'staged:a']))
    expect(second.anchor).toBe('staged:a')
    expect(toggleSelection(second, 'staged:a').selected).toEqual(new Set(['unstaged:a']))
  })

  it('selects an inclusive visible range and falls back when the anchor is gone', () => {
    const keys = ['staged:a', 'staged:b', 'unstaged:c', 'untracked:d']
    expect(selectRange({ selected: new Set(['staged:a']), anchor: 'staged:a' }, keys, 'unstaged:c').selected).toEqual(
      new Set(['staged:a', 'staged:b', 'unstaged:c'])
    )
    expect(selectRange({ selected: new Set(), anchor: 'missing' }, keys, 'unstaged:c')).toEqual({
      selected: new Set(['unstaged:c']),
      anchor: 'unstaged:c'
    })
  })

  it('selects all visible rows and clears', () => {
    expect(selectAll(['a', 'b'])).toEqual({ selected: new Set(['a', 'b']), anchor: 'b' })
    expect(clearSelection()).toEqual({ selected: new Set(), anchor: null })
  })

  it('prunes vanished rows and drops a vanished anchor', () => {
    expect(
      pruneSelection({ selected: new Set(['a', 'b', 'c']), anchor: 'b' }, new Set(['a', 'c']))
    ).toEqual({ selected: new Set(['a', 'c']), anchor: null })
    const unchanged = { selected: new Set(['a']), anchor: 'a' }
    expect(pruneSelection(unchanged, new Set(['a']))).toBe(unchanged)
  })
})

describe('selection transfer', () => {
  it('follows a staged row to the staged area after stage', () => {
    const before = [entry('a.ts', 'unstaged'), entry('b.ts', 'unstaged')]
    const after = [entry('a.ts', 'staged'), entry('b.ts', 'unstaged')]
    const result = transferSelection(
      { selected: new Set(['unstaged:a.ts']), anchor: 'unstaged:a.ts' },
      before,
      after,
      new Set(['a.ts'])
    )
    expect(result.selection.selected).toEqual(new Set(['staged:a.ts']))
    expect(result.followed).toEqual(['a.ts'])
    expect(result.dropped).toEqual([])
  })

  it('drops a vanished row that was not part of the operation', () => {
    const before = [entry('a.ts', 'unstaged'), entry('b.ts', 'unstaged')]
    const after = [entry('a.ts', 'unstaged')]
    const result = transferSelection(
      { selected: new Set(['unstaged:b.ts']), anchor: 'unstaged:b.ts' },
      before,
      after,
      new Set(['a.ts'])
    )
    expect(result.selection.selected.size).toBe(0)
    expect(result.dropped).toEqual(['b.ts'])
  })

  it('keeps the selection in the same area when both areas survive', () => {
    const before = [entry('a.ts', 'staged'), entry('a.ts', 'unstaged')]
    const after = [entry('a.ts', 'staged'), entry('a.ts', 'unstaged')]
    const result = transferSelection(
      { selected: new Set(['unstaged:a.ts']), anchor: 'unstaged:a.ts' },
      before,
      after
    )
    expect(result.selection.selected).toEqual(new Set(['unstaged:a.ts']))
  })
})

describe('selected rows and eligibility', () => {
  it('filters actions by area and excludes conflicts and committed rows from discard', () => {
    const entries = [
      entry('a.ts', 'staged'),
      entry('b.ts', 'unstaged'),
      entry('c.ts', 'untracked'),
      entry('d.ts', 'conflicts'),
      entry('e.ts', 'committed')
    ]
    const selection = { selected: new Set(entries.map(selectionKey)), anchor: null }
    const actions = selectionActions(selection, groups(entries))
    expect(actions.stageable.map((item) => item.entry.path)).toEqual(['b.ts', 'c.ts'])
    expect(actions.unstageable.map((item) => item.entry.path)).toEqual(['a.ts'])
    expect(actions.discardable.map((item) => item.entry.path)).toEqual(['a.ts', 'b.ts', 'c.ts'])
    expect(selectedEntries(selection, groups(entries))).toHaveLength(5)
    expect(selectedEntries(selection, groups(entries)).some((item) => item.area === 'committed')).toBe(
      true
    )
  })
})
