import { describe, expect, it } from 'vitest'
import type { WorkingTreeEntry } from '../review/working-tree'
import type { ScmController } from './use-scm-controller'
import {
  clearScmController,
  findScmEntry,
  findScmEntryByPath,
  getScmController,
  setScmController
} from './controller-registry'

function entry(area: WorkingTreeEntry['area'], path: string): WorkingTreeEntry {
  return {
    key: `${area}:${path}`,
    area,
    entry: {
      path,
      oldPath: null,
      code: ' M',
      area: area === 'conflicts' ? 'conflicted' : area === 'committed' ? 'staged' : area,
      status: 'modified'
    },
    added: 1,
    removed: 0
  }
}

function fakeController(entries: WorkingTreeEntry[]): ScmController {
  const groups: Record<WorkingTreeEntry['area'], WorkingTreeEntry[]> = {
    conflicts: [],
    staged: [],
    unstaged: [],
    untracked: [],
    committed: []
  }
  for (const item of entries) groups[item.area].push(item)
  return { groups } as unknown as ScmController
}

describe('SCM controller registry', () => {
  it('publishes one controller per session and clears only the same instance', () => {
    const first = fakeController([entry('unstaged', 'a.ts')])
    const second = fakeController([entry('staged', 'a.ts')])
    setScmController('ses_a', first)
    expect(getScmController('ses_a')).toBe(first)
    expect(findScmEntry('ses_a', 'unstaged', 'a.ts')?.area).toBe('unstaged')

    setScmController('ses_a', second)
    clearScmController('ses_a', first)
    expect(getScmController('ses_a')).toBe(second)
    clearScmController('ses_a', second)
    expect(getScmController('ses_a')).toBeNull()
  })

  it('finds the same path in another area after a hunk moves', () => {
    setScmController(
      'ses_b',
      fakeController([entry('unstaged', 'a.ts'), entry('staged', 'b.ts')])
    )
    expect(findScmEntryByPath('ses_b', 'a.ts')?.area).toBe('unstaged')
    expect(findScmEntryByPath('ses_b', 'a.ts', 'unstaged')).toBeNull()
    expect(findScmEntryByPath('ses_b', 'missing.ts')).toBeNull()
    clearScmController('ses_b')
  })
})
