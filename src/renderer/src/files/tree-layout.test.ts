import { describe, expect, it } from 'vitest'
import type { FileEntry } from '../../../shared/domain/workspace-files'
import { buildTreeRows, nestedNamesFor } from './tree-layout'

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
  '': [dir('src'), file('package.json'), file('package-lock.json')],
  src: [dir('src/features')],
  'src/features': [dir('src/features/auth')],
  'src/features/auth': [file('src/features/auth/session.ts')]
}
const expanded = { '': true, src: true, 'src/features': true, 'src/features/auth': true }

describe('tree layout', () => {
  it('folds unary folder chains into one row', () => {
    const rows = buildTreeRows(children, expanded, {
      sort: { order: 'name', direction: 'asc' },
      compactFolders: true,
      fileNesting: false,
      collapsedNested: new Set()
    })
    const compact = rows.find((row) => row.displayName.includes('src/features'))
    expect(compact).toMatchObject({
      displayName: 'src/features/auth',
      entry: { path: 'src/features/auth', kind: 'directory' },
      depth: 0
    })
    expect(rows.some((row) => row.entry.path === 'src/features')).toBe(false)
    expect(rows.some((row) => row.entry.path === 'src/features/auth/session.ts')).toBe(true)
  })

  it('keeps each level when compact folders are off', () => {
    const rows = buildTreeRows(children, expanded, {
      sort: { order: 'name', direction: 'asc' },
      compactFolders: false,
      fileNesting: false,
      collapsedNested: new Set()
    })
    expect(rows.filter((row) => row.entry.kind === 'directory').map((row) => row.entry.path)).toEqual([
      'src',
      'src/features',
      'src/features/auth'
    ])
  })

  it('nests default pattern children under their parent file', () => {
    const nestedChildren = {
      '': [file('foo.ts'), file('foo.test.ts'), file('foo.js'), file('other.ts')]
    }
    const rows = buildTreeRows(nestedChildren, { '': true }, {
      sort: { order: 'name', direction: 'asc' },
      compactFolders: false,
      fileNesting: true,
      collapsedNested: new Set()
    })
    expect(rows.map((row) => `${row.depth}:${row.entry.name}`)).toEqual([
      '0:foo.ts',
      '1:foo.js',
      '1:foo.test.ts',
      '0:other.ts'
    ])
    const withoutChildren = buildTreeRows(nestedChildren, { '': true }, {
      sort: { order: 'name', direction: 'asc' },
      compactFolders: false,
      fileNesting: true,
      collapsedNested: new Set(['foo.ts'])
    })
    expect(withoutChildren.map((row) => row.entry.name)).toEqual(['foo.ts', 'other.ts'])
    expect(nestedNamesFor('foo.ts')).toContain('foo.test.ts')
  })
})
