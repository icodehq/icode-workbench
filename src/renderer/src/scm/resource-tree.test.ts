import { describe, expect, it } from 'vitest'
import type { GitStatusEntry } from '../../../shared/domain/git-workspace'
import type { WorkingTreeEntry, WorkingTreeGroups } from '../review/working-tree'
import { selectionKey } from './selection-model'
import {
  DEFAULT_SCM_TREE_OPTIONS,
  folderKeys,
  scmGroups,
  scmRows,
  visibleResourceKeys,
  type ScmTreeOptions
} from './resource-tree'

const entry = (
  path: string,
  area: WorkingTreeEntry['area'],
  status: GitStatusEntry['status'] = 'modified'
): WorkingTreeEntry => {
  const statusEntry: GitStatusEntry = {
    path,
    oldPath: null,
    code: area === 'staged' ? 'M ' : ' M',
    area: area === 'conflicts' ? 'conflicted' : area === 'committed' ? 'staged' : area,
    status
  }
  return { key: selectionKey({ area, entry: statusEntry }), area, entry: statusEntry, added: 1, removed: 0 }
}

const groups = (entries: WorkingTreeEntry[]): WorkingTreeGroups => ({
  conflicts: entries.filter((item) => item.area === 'conflicts'),
  staged: entries.filter((item) => item.area === 'staged'),
  unstaged: entries.filter((item) => item.area === 'unstaged'),
  untracked: entries.filter((item) => item.area === 'untracked'),
  committed: entries.filter((item) => item.area === 'committed')
})

const options = (overrides: Partial<ScmTreeOptions> = {}): ScmTreeOptions => ({
  ...DEFAULT_SCM_TREE_OPTIONS,
  ...overrides
})

const sample = groups([
  entry('src/auth/session.ts', 'unstaged'),
  entry('src/auth/token.ts', 'staged'),
  entry('src/app.ts', 'unstaged'),
  entry('docs/readme.md', 'untracked'),
  entry('src/conflict.ts', 'conflicts')
])

describe('scmGroups', () => {
  it('uses VS Code group order and hides empty groups', () => {
    const result = scmGroups(sample, options())
    expect(result.map((group) => group.id)).toEqual(['conflicts', 'staged', 'unstaged', 'untracked'])
    expect(result.map((group) => group.label)).toEqual([
      'Merge Changes',
      'Staged Changes',
      'Changes',
      'Untracked Files'
    ])
  })

  it('renders committed rows as a trailing read-only group', () => {
    const combined: WorkingTreeGroups = {
      ...sample,
      committed: [entry('src/done.ts', 'committed')]
    }
    const result = scmGroups(combined, options())
    expect(result.map((group) => group.id)).toEqual([
      'conflicts',
      'staged',
      'unstaged',
      'untracked',
      'committed'
    ])
    expect(result.at(-1)).toMatchObject({
      id: 'committed',
      label: 'Committed in This Session',
      entries: [expect.objectContaining({ key: 'committed:src/done.ts' })]
    })
  })

  it('filters by path and can hide or mix untracked files', () => {
    const filtered = scmGroups(sample, options({ query: 'auth' }))
    expect(filtered.flatMap((group) => group.entries.map((item) => item.entry.path))).toEqual([
      'src/auth/token.ts',
      'src/auth/session.ts'
    ])
    expect(scmGroups(sample, options({ untrackedMode: 'hidden' })).map((group) => group.id)).not.toContain(
      'untracked'
    )
    const mixed = scmGroups(sample, options({ untrackedMode: 'mixed' }))
    const changes = mixed.find((group) => group.id === 'unstaged')
    expect(changes?.entries.map((item) => item.entry.path)).toEqual(
      expect.arrayContaining(['src/app.ts', 'src/auth/session.ts', 'docs/readme.md'])
    )
    expect(mixed.some((group) => group.id === 'untracked')).toBe(false)
  })
})

describe('scmRows', () => {
  it('flattens list mode in sort order and exposes selectable keys', () => {
    const rows = scmRows(sample, options({ mode: 'list', sort: 'name' }))
    expect(rows[0]).toMatchObject({ kind: 'group', id: 'conflicts', depth: 0 })
    expect(rows.filter((row) => row.kind === 'resource').map((row) => row.id)).toEqual([
      'conflicts:src/conflict.ts',
      'staged:src/auth/token.ts',
      'unstaged:src/app.ts',
      'unstaged:src/auth/session.ts',
      'untracked:docs/readme.md'
    ])
    expect(visibleResourceKeys(rows)).toHaveLength(5)
  })

  it('builds nested folders and compacts single-child chains in tree mode', () => {
    const rows = scmRows(sample, options({ mode: 'tree', compactFolders: false }))
    const folderPaths = rows
      .filter((row): row is Extract<(typeof rows)[number], { kind: 'folder' }> => row.kind === 'folder')
      .map((row) => row.path)
    expect(folderPaths).toEqual(expect.arrayContaining(['docs', 'src', 'src/auth']))
    expect(folderPaths.filter((path) => path === 'src')).toHaveLength(3)
    const compact = scmRows(sample, options({ mode: 'tree', compactFolders: true }))
    const labels = compact
      .filter((row): row is Extract<(typeof compact)[number], { kind: 'folder' }> => row.kind === 'folder')
      .map((row) => row.label)
    expect(labels).toEqual(expect.arrayContaining(['src', 'src/auth', 'docs']))
  })

  it('hides descendants when a group or folder is collapsed', () => {
    const collapsed = scmRows(sample, options({ mode: 'tree', collapsed: new Set(['staged']) }))
    expect(collapsed.some((row) => row.kind === 'resource' && row.id === 'staged:src/auth/token.ts')).toBe(false)
    const folderId = collapsed.find(
      (row): row is Extract<(typeof collapsed)[number], { kind: 'folder' }> =>
        row.kind === 'folder' && row.group === 'unstaged' && row.path === 'src'
    )?.id
    expect(folderId).toBeDefined()
    const folderCollapsed = scmRows(sample, options({ mode: 'tree', collapsed: new Set([folderId!]) }))
    expect(folderCollapsed.some((row) => row.kind === 'resource' && row.id === 'unstaged:src/app.ts')).toBe(false)
    expect(folderKeys(folderCollapsed, folderId!).length).toBeGreaterThan(0)
  })
})
