import { describe, expect, it } from 'vitest'
import { deriveWatchRoots } from './watch-roots'

describe('deriveWatchRoots', () => {
  it('always includes the checkout root', () => {
    expect(deriveWatchRoots({ expanded: {}, tabPaths: [] })).toEqual([''])
  })

  it('includes expanded folders and open-tab parents', () => {
    expect(
      deriveWatchRoots({
        expanded: { '': true, src: true, 'src/components': true, docs: false },
        tabPaths: ['src/components/Button.tsx', 'README.md']
      })
    ).toEqual(['', 'src', 'src/components'])
  })

  it('drops generated folders, absolute paths, and traversal', () => {
    expect(
      deriveWatchRoots({
        expanded: {
          'node_modules/pkg': true,
          'client/node_modules': true,
          '/etc': true,
          '..': true,
          src: true
        },
        tabPaths: ['/absolute/file.ts', 'client/node_modules/x.js', '../escape.ts']
      })
    ).toEqual(['', 'src'])
  })

  it('dedupes and sorts for stable IPC', () => {
    const roots = deriveWatchRoots({
      expanded: { b: true, a: true, '': true },
      tabPaths: ['a/file.ts', 'b/file.ts']
    })
    expect(roots).toEqual(['', 'a', 'b'])
    expect(new Set(roots).size).toBe(roots.length)
  })
})
