import { describe, expect, it } from 'vitest'
import type { FileEntry } from '../../../shared/domain/workspace-files'
import { visibleTreeChildren } from './visible-tree'

function entry(path: string, kind: FileEntry['kind'] = 'file'): FileEntry {
  return {
    name: path.split('/').pop() ?? path,
    path,
    kind,
    size: kind === 'file' ? 1 : null,
    modifiedAt: null
  }
}

const children: Record<string, FileEntry[]> = {
  '': [
    entry('src', 'directory'),
    entry('README.md'),
    entry('.git', 'directory'),
    entry('app.log')
  ],
  src: [entry('src/main.ts'), entry('src/generated.ts'), entry('.gitignore')]
}

describe('visible tree children', () => {
  it('hides git metadata at every depth and applies exclude patterns', () => {
    const visible = visibleTreeChildren(children, ['*.log', 'generated.ts'], true, {})
    expect(visible['']?.map((item) => item.name)).toEqual(['src', 'README.md'])
    expect(visible.src?.map((item) => item.name)).toEqual(['main.ts', '.gitignore'])
  })

  it('hides gitignored paths only while the setting is enabled', () => {
    const ignored = { '': new Set(['README.md']), src: new Set(['src/main.ts']) }

    expect(visibleTreeChildren(children, [], true, ignored)['']?.map((item) => item.name))
      .toEqual(['src', 'app.log'])
    expect(visibleTreeChildren(children, [], false, ignored)['']?.map((item) => item.name))
      .toEqual(['src', 'README.md', 'app.log'])
  })

  it('applies directory-only exclude patterns to the directory entry', () => {
    const visible = visibleTreeChildren(children, ['src/'], true, {})
    expect(visible['']?.map((item) => item.name)).toEqual(['README.md', 'app.log'])
  })
})
