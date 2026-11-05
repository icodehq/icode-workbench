import { describe, expect, it } from 'vitest'
import type { FileEntry } from '../../../shared/domain/workspace-files'
import { sortFileEntries } from './sort-entries'

const entry = (
  path: string,
  kind: 'file' | 'directory',
  modifiedAt: number | null = null
): FileEntry => ({
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  kind,
  size: kind === 'file' ? 1 : null,
  modifiedAt
})

describe('files sort', () => {
  it('keeps folders first and sorts names both ways', () => {
    const entries = [
      entry('b.ts', 'file'),
      entry('z', 'directory'),
      entry('a.ts', 'file'),
      entry('A', 'directory')
    ]
    expect(sortFileEntries(entries, { order: 'name', direction: 'asc' }).map((e) => e.name)).toEqual([
      'A',
      'z',
      'a.ts',
      'b.ts'
    ])
    expect(sortFileEntries(entries, { order: 'name', direction: 'desc' }).map((e) => e.name)).toEqual([
      'z',
      'A',
      'b.ts',
      'a.ts'
    ])
  })

  it('sorts by extension then name, with folders first', () => {
    const entries = [
      entry('z.ts', 'file'),
      entry('a.md', 'file'),
      entry('b.ts', 'file'),
      entry('dir', 'directory')
    ]
    expect(sortFileEntries(entries, { order: 'type', direction: 'asc' }).map((e) => e.name)).toEqual([
      'dir',
      'a.md',
      'b.ts',
      'z.ts'
    ])
  })

  it('sorts modified in both directions and leaves unknown times last', () => {
    const entries = [
      entry('old.ts', 'file', 100),
      entry('new.ts', 'file', 300),
      entry('unknown.ts', 'file', null),
      entry('mid.ts', 'file', 200)
    ]
    expect(
      sortFileEntries(entries, { order: 'modified', direction: 'asc' }).map((e) => e.name)
    ).toEqual(['old.ts', 'mid.ts', 'new.ts', 'unknown.ts'])
    expect(
      sortFileEntries(entries, { order: 'modified', direction: 'desc' }).map((e) => e.name)
    ).toEqual(['new.ts', 'mid.ts', 'old.ts', 'unknown.ts'])
  })
})
