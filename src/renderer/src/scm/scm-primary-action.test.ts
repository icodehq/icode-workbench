import { describe, expect, it } from 'vitest'
import type { GitStatusEntry } from '../../../shared/domain/git-workspace'
import type { WorkingTreeEntry, WorkingTreeGroups } from '../review/working-tree'
import { selectionKey } from './selection-model'
import {
  scmPrimaryAction,
  type ScmPrimaryActionInput,
  type SmartCommitMode
} from './scm-primary-action'

const entry = (path: string, area: WorkingTreeEntry['area']): WorkingTreeEntry => {
  const statusEntry: GitStatusEntry = {
    path,
    oldPath: null,
    code: area === 'staged' ? 'M ' : ' M',
    area: area === 'conflicts' ? 'conflicted' : area === 'committed' ? 'staged' : area,
    status: 'modified'
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

const mergeState = (
  overrides: Partial<ScmPrimaryActionInput['merge']> = {}
): ScmPrimaryActionInput['merge'] => ({
  target: null,
  targetOid: null,
  locked: false,
  loading: false,
  reason: '',
  recordState: null,
  alreadyComplete: false,
  ...overrides
})

const input = (overrides: Partial<ScmPrimaryActionInput> = {}): ScmPrimaryActionInput => ({
  groups: groups([]),
  message: '',
  hasUpstream: true,
  ahead: 0,
  behind: 0,
  operation: null,
  smartCommit: 'off' as SmartCommitMode,
  headOid: 'a'.repeat(40),
  branch: 'main',
  commitCount: 0,
  commitsLoading: false,
  merge: mergeState(),
  ...overrides
})

describe('scmPrimaryAction', () => {
  it('continues a merge/rebase when an operation is in progress', () => {
    expect(
      scmPrimaryAction(
        input({ operation: 'merge', groups: groups([entry('a.ts', 'staged')]), message: 'x' })
      )
    ).toMatchObject({
      kind: 'continue',
      label: 'Continue Merge',
      disabled: false,
      operation: 'merge'
    })
    expect(
      scmPrimaryAction(
        input({ operation: 'rebase', groups: groups([entry('conflict.ts', 'conflicts')]) })
      )
    ).toMatchObject({ kind: 'continue', label: 'Continue Rebase', disabled: true })
  })

  it('blocks commits on conflicts and bisect with a reason', () => {
    expect(
      scmPrimaryAction(input({ groups: groups([entry('conflict.ts', 'conflicts')]) }))
    ).toMatchObject({ kind: 'disabled', label: 'Resolve conflicts' })
    expect(scmPrimaryAction(input({ operation: 'bisect' }))).toMatchObject({
      kind: 'disabled',
      label: 'Bisecting'
    })
  })

  it('commits only the index and requires a message', () => {
    const staged = groups([entry('a.ts', 'staged')])
    expect(scmPrimaryAction(input({ groups: staged }))).toMatchObject({
      kind: 'disabled',
      label: 'Commit',
      reason: 'Enter a commit message.'
    })
    expect(scmPrimaryAction(input({ groups: staged, message: 'fix' }))).toMatchObject({
      kind: 'commit',
      label: 'Commit',
      disabled: false
    })
  })

  it('stages first only when smart commit is enabled', () => {
    const working = groups([entry('a.ts', 'unstaged')])
    expect(scmPrimaryAction(input({ groups: working, message: 'fix' }))).toMatchObject({
      kind: 'disabled',
      label: 'Nothing staged'
    })
    expect(
      scmPrimaryAction(input({ groups: working, message: 'fix', smartCommit: 'all' }))
    ).toMatchObject({ kind: 'commit', label: 'Commit All', stageFirst: 'all' })
    expect(
      scmPrimaryAction(input({ groups: working, message: 'fix', smartCommit: 'tracked' }))
    ).toMatchObject({ kind: 'commit', label: 'Commit Tracked', stageFirst: 'tracked' })
  })

  it('publishes before sync when there is no upstream', () => {
    expect(
      scmPrimaryAction(
        input({
          groups: groups([entry('a.ts', 'unstaged')]),
          hasUpstream: false,
          ahead: 2
        })
      )
    ).toMatchObject({ kind: 'publish', label: 'Publish Branch' })
  })

  it('syncs, pushes or pulls according to ahead/behind', () => {
    const gap = groups([entry('a.ts', 'unstaged')])
    expect(scmPrimaryAction(input({ groups: gap, ahead: 2, behind: 3 }))).toMatchObject({
      kind: 'sync'
    })
    expect(scmPrimaryAction(input({ groups: gap, ahead: 2 }))).toMatchObject({
      kind: 'push',
      label: 'Push 2'
    })
    expect(scmPrimaryAction(input({ groups: gap, behind: 3 }))).toMatchObject({
      kind: 'pull',
      label: 'Pull 3'
    })
  })

  it('names detached and unborn states explicitly', () => {
    const staged = groups([entry('a.ts', 'staged')])
    expect(
      scmPrimaryAction(input({ groups: staged, message: 'fix', branch: null }))
    ).toMatchObject({ kind: 'commit', label: 'Commit on detached HEAD' })
    expect(
      scmPrimaryAction(input({ groups: staged, message: 'fix', headOid: null }))
    ).toMatchObject({ kind: 'commit', label: 'Create first commit' })
    expect(scmPrimaryAction(input({ groups: staged, headOid: null }))).toMatchObject({
      kind: 'disabled',
      label: 'Create first commit'
    })
  })

  it('reports a clean repository as up to date', () => {
    expect(scmPrimaryAction(input())).toEqual({
      kind: 'noop',
      label: 'Up to date',
      disabled: true,
      reason: 'Nothing to commit.'
    })
  })

  it('offers merge before push when there are commits and a target', () => {
    expect(
      scmPrimaryAction(
        input({
          branch: 'session/one',
          commitCount: 2,
          ahead: 2,
          merge: mergeState({ target: 'main', targetOid: 'main-old' })
        })
      )
    ).toMatchObject({
      kind: 'merge',
      label: 'Merge into main',
      disabled: false,
      target: 'main'
    })
  })

  it('keeps the commit ladder ahead of merge while the worktree is dirty', () => {
    const staged = groups([entry('a.ts', 'staged')])
    expect(
      scmPrimaryAction(
        input({
          branch: 'session/one',
          commitCount: 2,
          groups: staged,
          message: 'work',
          merge: mergeState({ target: 'main' })
        })
      )
    ).toMatchObject({ kind: 'commit' })

    expect(
      scmPrimaryAction(
        input({
          branch: 'session/one',
          commitCount: 2,
          groups: groups([entry('a.ts', 'unstaged')]),
          merge: mergeState({ target: 'main' })
        })
      ).kind
    ).not.toBe('merge')
  })

  it('does not merge while commits are loading or the target is unknown', () => {
    expect(
      scmPrimaryAction(
        input({
          branch: 'session/one',
          commitCount: 2,
          commitsLoading: true,
          merge: mergeState({ target: 'main' })
        })
      ).kind
    ).not.toBe('merge')

    expect(
      scmPrimaryAction(
        input({
          branch: 'session/one',
          commitCount: 2,
          merge: mergeState({ target: null, loading: false })
        })
      ).kind
    ).not.toBe('merge')
  })

  it('shows a loading merge action while targets load', () => {
    expect(
      scmPrimaryAction(
        input({
          branch: 'session/one',
          commitCount: 2,
          merge: mergeState({ target: null, loading: true })
        })
      )
    ).toMatchObject({
      kind: 'merge',
      label: 'Merge…',
      disabled: true,
      reason: 'Reading target branches…'
    })
  })

  it('suppresses a repeated merge after completion', () => {
    expect(
      scmPrimaryAction(
        input({
          branch: 'session/one',
          commitCount: 2,
          merge: mergeState({ target: 'main', targetOid: 'head', alreadyComplete: true })
        })
      ).kind
    ).not.toBe('merge')
  })

  it('lets a locked task merge even without commits', () => {
    expect(
      scmPrimaryAction(
        input({
          branch: 'session/one',
          commitCount: 0,
          merge: mergeState({ target: 'icode/chain/t1', locked: true })
        })
      )
    ).toMatchObject({
      kind: 'merge',
      label: 'Merge into icode/chain/t1',
      disabled: false
    })
  })

  it('disables merge when the target has a blocking reason', () => {
    expect(
      scmPrimaryAction(
        input({
          branch: 'session/one',
          commitCount: 2,
          merge: mergeState({ target: 'main', reason: 'The target branch is gone.' })
        })
      )
    ).toMatchObject({
      kind: 'merge',
      disabled: true,
      reason: 'The target branch is gone.'
    })
  })

  it('shows merge progress for an active record without a Git operation', () => {
    expect(
      scmPrimaryAction(
        input({
          branch: 'session/one',
          commitCount: 2,
          merge: mergeState({ target: 'main', recordState: 'running' })
        })
      )
    ).toMatchObject({
      kind: 'merge',
      label: 'Merge in progress',
      disabled: true
    })

    expect(
      scmPrimaryAction(
        input({
          branch: 'session/one',
          commitCount: 2,
          merge: mergeState({ target: 'main', recordState: 'conflicted' })
        })
      )
    ).toMatchObject({ kind: 'merge', label: 'Merge in progress', disabled: true })
  })

  it('continues a conflicted merge when Git reports a merge operation', () => {
    expect(
      scmPrimaryAction(
        input({
          branch: 'session/one',
          operation: 'merge',
          merge: mergeState({ target: 'main', recordState: 'conflicted' })
        })
      )
    ).toMatchObject({
      kind: 'continue',
      label: 'Continue Merge',
      disabled: false
    })
  })
})
