import { describe, expect, it } from 'vitest'
import type { BranchRefSummary, MergeRecordPayload } from '../../../shared/schemas/ipc'
import {
  isActiveMergeRecord,
  mergeOperationRoute,
  resolveMergeTargets
} from './scm-merge'

const ref = (name: string, overrides: Partial<BranchRefSummary> = {}): BranchRefSummary => ({
  name,
  oid: `${name}-oid`,
  primaryHead: false,
  worktreePath: null,
  ...overrides
})

const record = (
  overrides: Partial<MergeRecordPayload> = {}
): MergeRecordPayload => ({
  id: 'merge_1',
  repoId: 'repo_1',
  sessionId: 'ses_1',
  taskId: null,
  sourceBranch: 'session/one',
  targetBranch: 'main',
  sourceOidBefore: 'before',
  targetOidBefore: 'main-old',
  targetOidAfter: null,
  resultOid: null,
  reviewBaseOid: null,
  state: 'merged',
  commitOid: null,
  conflictFiles: [],
  error: null,
  pushRemote: null,
  pushedAt: null,
  pushError: null,
  createdAt: 1,
  updatedAt: 1,
  finishedAt: 1,
  ...overrides
})

describe('resolveMergeTargets', () => {
  it('excludes the source branch and prefers the primary checkout', () => {
    const resolution = resolveMergeTargets({
      refs: [
        ref('main', { primaryHead: true, worktreePath: '/primary' }),
        ref('session/one'),
        ref('release')
      ],
      sourceBranch: 'session/one',
      headOid: 'work-head',
      hint: null,
      lockHint: false,
      loading: false,
      record: null
    })

    expect(resolution.target).toBe('main')
    expect(resolution.targetOid).toBe('main-oid')
    expect(resolution.options.map((option) => option.name)).toEqual(['main', 'release'])
    expect(resolution.options[0]?.disabled).toBe(false)
  })

  it('disables a target checked out in another linked worktree', () => {
    const resolution = resolveMergeTargets({
      refs: [ref('main'), ref('release', { worktreePath: '/other' })],
      sourceBranch: 'session/one',
      headOid: 'work-head',
      hint: null,
      lockHint: false,
      loading: false,
      record: null
    })

    expect(resolution.options.find((option) => option.name === 'release')).toMatchObject({
      disabled: true,
      inUse: true
    })
  })

  it('honours a task hint and locks it only when requested', () => {
    const refs = [ref('main', { primaryHead: true }), ref('icode/chain/t1')]
    const locked = resolveMergeTargets({
      refs,
      sourceBranch: 'session/one',
      headOid: 'work-head',
      hint: 'icode/chain/t1',
      lockHint: true,
      loading: false,
      record: null
    })
    expect(locked).toMatchObject({ target: 'icode/chain/t1', locked: true, reason: '' })

    const unlocked = resolveMergeTargets({
      refs,
      sourceBranch: 'session/one',
      headOid: 'work-head',
      hint: 'icode/chain/t1',
      lockHint: false,
      loading: false,
      record: null
    })
    expect(unlocked.locked).toBe(false)
  })

  it('keeps a missing hint as the target and reports it', () => {
    const resolution = resolveMergeTargets({
      refs: [ref('main', { primaryHead: true })],
      sourceBranch: 'session/one',
      headOid: 'work-head',
      hint: 'icode/chain/gone',
      lockHint: true,
      loading: false,
      record: null
    })

    expect(resolution).toMatchObject({
      target: 'icode/chain/gone',
      targetOid: null,
      reason: 'missing-target'
    })
  })

  it('distinguishes loading from no target', () => {
    const loading = resolveMergeTargets({
      refs: [],
      sourceBranch: 'session/one',
      headOid: 'work-head',
      hint: null,
      lockHint: false,
      loading: true,
      record: null
    })
    expect(loading).toMatchObject({ target: null, reason: 'loading' })

    const empty = resolveMergeTargets({
      refs: [ref('session/one')],
      sourceBranch: 'session/one',
      headOid: 'work-head',
      hint: null,
      lockHint: false,
      loading: false,
      record: null
    })
    expect(empty).toMatchObject({ target: null, reason: 'no-target' })
  })

  it('suppresses a repeated merge after the target reaches HEAD', () => {
    const tip = resolveMergeTargets({
      refs: [ref('main', { oid: 'work-head', primaryHead: true })],
      sourceBranch: 'session/one',
      headOid: 'work-head',
      hint: null,
      lockHint: false,
      loading: false,
      record: null
    })
    expect(tip.alreadyComplete).toBe(true)

    const recordComplete = resolveMergeTargets({
      refs: [ref('main', { primaryHead: true })],
      sourceBranch: 'session/one',
      headOid: 'work-head',
      hint: null,
      lockHint: false,
      loading: false,
      record: record({ targetBranch: 'main', resultOid: 'work-head' })
    })
    expect(recordComplete.alreadyComplete).toBe(true)
  })

  it('allows a locked task to record a no-op merge at HEAD', () => {
    const resolution = resolveMergeTargets({
      refs: [ref('icode/chain/t1', { oid: 'work-head' })],
      sourceBranch: 'session/one',
      headOid: 'work-head',
      hint: 'icode/chain/t1',
      lockHint: true,
      loading: false,
      record: null
    })
    expect(resolution.alreadyComplete).toBe(false)
  })
})

describe('isActiveMergeRecord', () => {
  it('counts only running and conflicted records', () => {
    expect(isActiveMergeRecord(null)).toBe(false)
    expect(isActiveMergeRecord(record({ state: 'running' }))).toBe(true)
    expect(isActiveMergeRecord(record({ state: 'conflicted' }))).toBe(true)
    expect(isActiveMergeRecord(record({ state: 'merged' }))).toBe(false)
    expect(isActiveMergeRecord(record({ state: 'aborted' }))).toBe(false)
  })
})

describe('mergeOperationRoute', () => {
  it('routes conflict continue and abort to the merge service', () => {
    expect(
      mergeOperationRoute({
        record: record({ state: 'conflicted' }),
        operation: 'merge',
        action: 'continue'
      })
    ).toBe('merge')
    expect(
      mergeOperationRoute({
        record: record({ state: 'conflicted' }),
        operation: 'merge',
        action: 'abort'
      })
    ).toBe('merge')
  })

  it('blocks continue when the record has no Git operation', () => {
    expect(
      mergeOperationRoute({
        record: record({ state: 'conflicted' }),
        operation: null,
        action: 'continue'
      })
    ).toBe('blocked')
    expect(
      mergeOperationRoute({
        record: record({ state: 'conflicted' }),
        operation: null,
        action: 'abort'
      })
    ).toBe('merge')
  })

  it('falls back to generic Git operations', () => {
    expect(
      mergeOperationRoute({ record: null, operation: 'rebase', action: 'continue' })
    ).toBe('git')
    expect(mergeOperationRoute({ record: null, operation: null, action: 'abort' })).toBe('none')
  })
})
