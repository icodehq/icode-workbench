import { describe, expect, it } from 'vitest'
import type { BranchRefSummary } from '../../../shared/schemas/ipc'
import {
  groupStartFromRefs,
  startFromGroupLabelKey,
  startFromValue
} from './start-from-refs'

function ref(
  name: string,
  kind: BranchRefSummary['kind'],
  overrides: Partial<BranchRefSummary> = {}
): BranchRefSummary {
  return {
    name,
    fullName: kind === 'local' ? `refs/heads/${name}` : `refs/remotes/${name}`,
    kind,
    oid: `${name}-oid`,
    primaryHead: false,
    worktreePath: null,
    ...overrides
  }
}

describe('groupStartFromRefs', () => {
  it('shows local branches before remote-tracking branches', () => {
    const groups = groupStartFromRefs([
      ref('origin/main', 'remote'),
      ref('main', 'local', { primaryHead: true }),
      ref('origin/feature', 'remote'),
      ref('feature', 'local')
    ])
    expect(groups.map((group) => group.kind)).toEqual(['local', 'remote'])
    expect(groups[0]?.refs.map((entry) => entry.name)).toEqual(['main', 'feature'])
    expect(groups[1]?.refs.map((entry) => entry.name)).toEqual([
      'origin/main',
      'origin/feature'
    ])
  })

  it('omits an empty remote group', () => {
    expect(groupStartFromRefs([ref('main', 'local')])).toEqual([
      { kind: 'local', refs: [ref('main', 'local')] }
    ])
  })

  it('keeps local and remote entries with the same display name distinct', () => {
    const refs = [ref('origin/foo', 'local'), ref('origin/foo', 'remote')]
    expect(startFromValue(refs[0]!)).toBe('origin/foo')
    expect(startFromValue(refs[1]!)).toBe('refs/remotes/origin/foo')
  })
})

describe('startFromGroupLabelKey', () => {
  it('maps each kind to its catalog key', () => {
    expect(startFromGroupLabelKey('local')).toBe('common.localBranches')
    expect(startFromGroupLabelKey('remote')).toBe('common.remoteBranches')
  })
})
