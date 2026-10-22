import { describe, expect, it } from 'vitest'
import { makeAppError } from '../../../shared/domain/errors'
import type { ReviewDiffPayload, ReviewFilePayload } from '../../../shared/schemas/review'
import {
  createReviewState,
  diffStateFor,
  fileKey,
  reviewReducer,
  selectedFile
} from './review-state'

function file(path: string, overrides: Partial<ReviewFilePayload> = {}): ReviewFilePayload {
  return {
    path,
    oldPath: null,
    status: 'modified',
    area: 'unstaged',
    origin: 'tracked',
    additions: 1,
    deletions: 0,
    binary: false,
    symlink: false,
    ...overrides
  }
}

function diff(path: string): ReviewDiffPayload {
  return {
    status: 'available',
    sessionId: 'ses_0123456789abcdef0123456789abcdef',
    path,
    oldPath: null,
    fileStatus: 'modified',
    patch: 'diff --git a/x b/x\n',
    truncated: false,
    truncatedReason: null,
    binary: false,
    symlink: false,
    additions: 1,
    deletions: 0
  }
}

const available = (files: ReviewFilePayload[], listTruncated = false) =>
  ({
    status: 'available' as const,
    sessionId: 'ses_0123456789abcdef0123456789abcdef',
    baselineOid: 'a'.repeat(40),
    files,
    listTruncated
  })

describe('review reducer', () => {
  it('moves from loading to ready and selects the first file', () => {
    let state = reviewReducer(createReviewState(), { type: 'loadStart', generation: 1 })
    expect(state.phase).toBe('loading')
    state = reviewReducer(state, {
      type: 'loadSuccess',
      result: available([file('a.ts'), file('b.ts')]),
      generation: state.generation
    })
    expect(state.phase).toBe('ready')
    expect(state.baselineOid).toBe('a'.repeat(40))
    expect(state.selectedPath).toBe('a.ts')
    expect(selectedFile(state)?.path).toBe('a.ts')
  })

  it('reports an empty review distinctly', () => {
    let state = reviewReducer(createReviewState(), { type: 'loadStart', generation: 1 })
    state = reviewReducer(state, {
      type: 'loadSuccess',
      result: available([]),
      generation: state.generation
    })
    expect(state.phase).toBe('empty')
    expect(state.selectedPath).toBeNull()
  })

  it('keeps the unavailable reason and clears stale files', () => {
    let state = reviewReducer(createReviewState(), { type: 'loadStart', generation: 1 })
    state = reviewReducer(state, {
      type: 'loadSuccess',
      result: available([file('a.ts')]),
      generation: state.generation
    })
    state = reviewReducer(state, { type: 'loadStart', generation: state.generation + 1 })
    state = reviewReducer(state, {
      type: 'loadSuccess',
      result: {
        status: 'unavailable',
        reason: 'primary-checkout',
        detail: 'No session baseline.'
      },
      generation: state.generation
    })
    expect(state.phase).toBe('unavailable')
    expect(state.unavailable?.reason).toBe('primary-checkout')
    expect(state.files).toEqual([])
    expect(state.selectedPath).toBeNull()
  })

  it('discards a response from a superseded generation', () => {
    let state = reviewReducer(createReviewState(), { type: 'loadStart', generation: 1 })
    const stale = state.generation
    state = reviewReducer(state, { type: 'loadStart', generation: 2 })
    const before = state
    state = reviewReducer(state, {
      type: 'loadSuccess',
      result: available([file('stale.ts')]),
      generation: stale
    })
    expect(state).toBe(before)
    expect(state.files).toEqual([])
  })

  it('discards a stale diff response after a session switch', () => {
    let state = reviewReducer(createReviewState(), { type: 'loadStart', generation: 1 })
    const stale = state.generation
    state = reviewReducer(state, { type: 'reset' })
    state = reviewReducer(state, { type: 'loadStart', generation: state.generation + 1 })
    const before = state
    state = reviewReducer(state, {
      type: 'diffSuccess',
      path: 'a.ts',
      diff: diff('a.ts'),
      generation: stale
    })
    expect(state).toBe(before)
  })

  it('tracks per-file loading, success and error', () => {
    let state = reviewReducer(createReviewState(), { type: 'loadStart', generation: 1 })
    state = reviewReducer(state, {
      type: 'loadSuccess',
      result: available([file('a.ts')]),
      generation: state.generation
    })
    const generation = state.generation
    state = reviewReducer(state, { type: 'diffStart', path: 'a.ts', generation })
    expect(diffStateFor(state, 'a.ts').phase).toBe('loading')
    state = reviewReducer(state, { type: 'diffSuccess', path: 'a.ts', diff: diff('a.ts'), generation })
    expect(diffStateFor(state, 'a.ts').phase).toBe('ready')

    state = reviewReducer(state, { type: 'diffStart', path: 'b.ts', generation })
    state = reviewReducer(state, {
      type: 'diffError',
      path: 'b.ts',
      error: makeAppError('GIT_READ_FAILED', 'Could not read the diff.'),
      generation
    })
    expect(diffStateFor(state, 'b.ts')).toMatchObject({
      phase: 'error',
      error: { code: 'GIT_READ_FAILED' }
    })
    expect(diffStateFor(state, 'missing.ts').phase).toBe('idle')
  })

  it('surfaces a load error and clears the listing', () => {
    let state = reviewReducer(createReviewState(), { type: 'loadStart', generation: 1 })
    state = reviewReducer(state, {
      type: 'loadError',
      error: makeAppError('GIT_READ_FAILED', 'Git failed.'),
      generation: state.generation
    })
    expect(state.phase).toBe('error')
    expect(state.error?.code).toBe('GIT_READ_FAILED')
    expect(state.files).toEqual([])
  })

  it('carries list truncation through', () => {
    let state = reviewReducer(createReviewState(), { type: 'loadStart', generation: 1 })
    state = reviewReducer(state, {
      type: 'loadSuccess',
      result: available([file('a.ts')], true),
      generation: state.generation
    })
    expect(state.listTruncated).toBe(true)
  })

  it('keys renames by both paths', () => {
    expect(fileKey('new.ts', 'old.ts')).toBe('old.ts\u0000new.ts')
    expect(fileKey('a.ts', null)).toBe('a.ts')
  })
})
