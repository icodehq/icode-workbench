import { describe, expect, it } from 'vitest'
import type { GitRangeFile } from '../../../shared/domain/git-workspace'
import { buildCommitFileTree, flattenCommitFileTree } from './commit-file-tree'

function label(node: { kind: 'folder'; name: string } | { kind: 'file'; file: GitRangeFile }): string {
  if (node.kind === 'folder') return node.name
  return node.file.path.slice(node.file.path.lastIndexOf('/') + 1)
}

function file(path: string, overrides: Partial<GitRangeFile> = {}): GitRangeFile {
  return {
    path,
    oldPath: null,
    status: 'modified',
    additions: 1,
    deletions: 1,
    binary: false,
    ...overrides
  }
}

describe('buildCommitFileTree', () => {
  it('groups nested paths and sorts folders before files', () => {
    const tree = buildCommitFileTree([
      file('src/z.ts'),
      file('README.md'),
      file('src/components/Button.tsx'),
      file('src/a.ts'),
      file('docs/guide.md')
    ])

    expect(tree.map(label)).toEqual(['docs', 'src', 'README.md'])
    const src = tree.find((node) => node.kind === 'folder' && node.name === 'src')
    expect(src?.kind).toBe('folder')
    if (src?.kind !== 'folder') return
    expect(src.children.map(label)).toEqual(['components', 'a.ts', 'z.ts'])
    const components = src.children.find((node) => node.kind === 'folder')
    expect(components?.kind === 'folder' && components.children[0]?.kind === 'file'
      ? components.children[0].file.path
      : null).toBe('src/components/Button.tsx')
  })

  it('reuses a folder shared by files added in any order', () => {
    const tree = buildCommitFileTree([file('a/deep/one.ts'), file('a/two.ts'), file('a/deep/three.ts')])
    expect(tree).toHaveLength(1)
    const a = tree[0]
    expect(a?.kind).toBe('folder')
    if (a?.kind !== 'folder') return
    expect(a.children.map(label)).toEqual(['deep', 'two.ts'])
    const deep = a.children[0]
    expect(deep?.kind === 'folder' ? deep.children.length : 0).toBe(2)
  })

  it('puts a renamed file at its new path and keeps the entry', () => {
    const renamed = file('src/new.ts', {
      oldPath: 'old.ts',
      status: 'renamed'
    })
    const tree = buildCommitFileTree([renamed])
    const src = tree[0]
    expect(src?.kind).toBe('folder')
    if (src?.kind !== 'folder') return
    const leaf = src.children[0]
    expect(leaf?.kind === 'file' ? leaf.file : null).toBe(renamed)
  })

  it('ignores empty and duplicate paths', () => {
    const first = file('a.ts')
    const tree = buildCommitFileTree([file(''), first, file('a.ts')])
    expect(tree).toHaveLength(1)
    expect(tree[0]?.kind === 'file' ? tree[0].file : null).toBe(first)
  })
})

describe('flattenCommitFileTree', () => {
  it('omits the children of a collapsed folder but keeps the folder row', () => {
    const files = [file('src/a.ts'), file('src/deep/b.ts'), file('root.md')]
    const tree = buildCommitFileTree(files)

    const expanded = flattenCommitFileTree(tree, new Set())
    expect(expanded.map((row) => (row.kind === 'folder' ? row.path : row.file.path))).toEqual([
      'src',
      'src/deep',
      'src/deep/b.ts',
      'src/a.ts',
      'root.md'
    ])
    expect(expanded.map((row) => row.depth)).toEqual([0, 1, 2, 1, 0])

    const collapsed = flattenCommitFileTree(tree, new Set(['src']))
    expect(collapsed.map((row) => (row.kind === 'folder' ? row.path : row.file.path))).toEqual([
      'src',
      'root.md'
    ])
    expect(collapsed[0]).toMatchObject({ kind: 'folder', collapsed: true })
  })
})
