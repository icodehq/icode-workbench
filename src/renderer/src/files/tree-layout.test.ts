import { describe, expect, it } from 'vitest'
import type { FileEntry } from '../../../shared/domain/workspace-files'
import { buildTreeRows, nestedNamesFor, parseNestingPatterns } from './tree-layout'

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

  it('adds custom nesting pairs without dropping the defaults', () => {
    const custom = ['*.ts -> $1.gen.ts, $1.fixture.ts', 'package.json -> pnpm-workspace.yaml']
    const nestedChildren = {
      '': [
        file('foo.ts'),
        file('foo.gen.ts'),
        file('foo.fixture.ts'),
        file('foo.test.ts'),
        file('package.json'),
        file('pnpm-workspace.yaml')
      ]
    }
    const rows = buildTreeRows(nestedChildren, { '': true }, {
      sort: { order: 'name', direction: 'asc' },
      compactFolders: false,
      fileNesting: true,
      nestingPatterns: custom,
      collapsedNested: new Set()
    })
    const foo = rows.find((row) => row.entry.name === 'foo.ts')
    expect(foo?.nestedCount).toBe(3)
    expect(rows.some((row) => row.entry.name === 'foo.gen.ts' && row.nested === true)).toBe(true)
    expect(rows.some((row) => row.entry.name === 'foo.test.ts' && row.nested === true)).toBe(true)
    const pkg = rows.find((row) => row.entry.name === 'package.json')
    expect(pkg?.nestedCount).toBe(1)
    expect(nestedNamesFor('foo.ts', custom)).toEqual(
      expect.arrayContaining(['foo.test.ts', 'foo.gen.ts', 'foo.fixture.ts'])
    )
  })

  it('reports invalid custom nesting lines and ignores them', () => {
    const parsed = parseNestingPatterns([
      '',
      '*.ts -> $1.test.ts',
      'no arrow',
      'package.json ->',
      '*.ts -> $1.*.ts',
      'no-capture -> $1.test.ts'
    ])
    expect(parsed.pairs).toEqual([
      { parent: '*.ts', children: ['$1.test.ts'] },
      { parent: '*.ts', children: ['$1.*.ts'] }
    ])
    expect(parsed.errors).toHaveLength(3)
    expect(nestedNamesFor('x.ts', ['no-capture -> $1.special.ts'])).not.toContain(
      'x.special.ts'
    )
  })
})
