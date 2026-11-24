import { describe, expect, it } from 'vitest'
import { changeDiffInputFor } from './change-diff-input'
import type { WorkingTreeEntry } from '../review/working-tree'

function entry(overrides: Partial<WorkingTreeEntry> & Pick<WorkingTreeEntry, 'area'>): WorkingTreeEntry {
  return {
    key: `${overrides.area}:${overrides.entry?.path ?? 'a.ts'}`,
    entry: {
      path: 'a.ts',
      oldPath: null,
      code: ' M',
      area:
        overrides.area === 'conflicts'
          ? 'conflicted'
          : overrides.area === 'committed'
            ? 'staged'
            : overrides.area,
      status: 'modified'
    },
    added: 2,
    removed: 1,
    ...overrides
  }
}

describe('changeDiffInputFor', () => {
  it('maps a working-tree row to the changeDiff input', () => {
    expect(changeDiffInputFor('ses_a', entry({ area: 'unstaged' }))).toEqual({
      sessionId: 'ses_a',
      path: 'a.ts',
      oldPath: null,
      scope: 'unstaged',
      status: 'modified',
      binary: false,
      symlink: null,
      additions: 2,
      deletions: 1
    })
  })

  it('maps conflict rows to the conflict scope and status words', () => {
    const conflicted = entry({
      area: 'conflicts',
      entry: {
        path: 'a.ts',
        oldPath: null,
        code: 'UU',
        area: 'conflicted',
        status: 'unmerged',
        binary: true
      }
    })
    expect(changeDiffInputFor('ses_a', conflicted)).toMatchObject({
      scope: 'conflict',
      status: 'modified',
      binary: true
    })
  })

  it('returns null for committed rows (they use revisionFileDiff)', () => {
    expect(changeDiffInputFor('ses_a', entry({ area: 'committed' }))).toBeNull()
  })
})
