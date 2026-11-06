import { describe, expect, it } from 'vitest'
import type { FileEntry } from '../../../shared/domain/workspace-files'
import {
  EMPTY_SELECTION,
  collapseSelectedPaths,
  flattenVisibleRows,
  pruneSelection,
  selectAll,
  selectRow,
  summarizeSelection,
  type SelectionState
} from './selection'

const file = (path: string): FileEntry => ({
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  kind: 'file',
  size: 1,
  modifiedAt: null
})
const dir = (path: string): FileEntry => ({
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  kind: 'directory',
  size: null,
  modifiedAt: null
})

const children: Record<string, FileEntry[]> = {
  '': [dir('src'), file('README.md')],
  src: [file('src/a.ts'), file('src/b.ts')],
  'src/deep': [file('src/deep/c.ts')]
}
const expanded = { '': true, src: true, 'src/deep': true }

describe('files selection', () => {
  it('flattens visible rows and hides Git metadata', () => {
    const rows = flattenVisibleRows(
      { ...children, '': [...(children[''] ?? []), file('.git')] },
      expanded
    )
    expect(rows.map((row) => `${String(row.depth)}:${row.entry.path}`)).toEqual([
      '0:src',
      '1:src/a.ts',
      '1:src/b.ts',
      '0:README.md'
    ])
  })

  it('supports plain, toggle and range selection', () => {
    const rows = flattenVisibleRows(children, expanded)
    let state = selectRow(EMPTY_SELECTION, rows, 'src/a.ts')
    expect([...state.selected]).toEqual(['src/a.ts'])

    state = selectRow(state, rows, 'src/b.ts', { toggle: true })
    expect([...state.selected].sort()).toEqual(['src/a.ts', 'src/b.ts'])

    state = selectRow(EMPTY_SELECTION, rows, 'src')
    state = selectRow(state, rows, 'src/b.ts', { range: true })
    expect([...state.selected]).toEqual(['src', 'src/a.ts', 'src/b.ts'])
    expect(state.anchor).toBe('src')
    expect(state.focused).toBe('src/b.ts')
  })

  it('selects all visible rows and reports file/folder counts', () => {
    const rows = flattenVisibleRows(children, expanded)
    const state = selectAll(rows)
    expect(state.selected.size).toBe(4)
    expect(summarizeSelection(rows, state.selected)).toEqual({
      total: 4,
      files: 3,
      directories: 1
    })
    expect(summarizeSelection(rows, new Set(['not-loaded-yet.ts']))).toEqual({
      total: 1,
      files: 1,
      directories: 0
    })
  })

  it('prunes selection after a refresh and keeps a valid focus', () => {
    const rows = flattenVisibleRows(children, expanded)
    const state: SelectionState = {
      selected: new Set(['src/a.ts', 'gone.ts']),
      anchor: 'gone.ts',
      focused: 'gone.ts'
    }
    const pruned = pruneSelection(state, rows)
    expect([...pruned.selected]).toEqual(['src/a.ts'])
    expect(pruned.focused).toBe('src/a.ts')
    expect(pruned.anchor).toBe('src/a.ts')
  })

  it('collapses descendants for batch targets', () => {
    expect(collapseSelectedPaths(['src', 'src/a.ts', 'README.md', 'src'])).toEqual([
      'src',
      'README.md'
    ])
  })
})
