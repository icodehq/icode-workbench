import type { AppError } from '../../../shared/domain/errors'
import type {
  ReviewDiffPayload,
  ReviewFilePayload,
  ReviewListPayload,
  ReviewListResult,
  ReviewUnavailableReason
} from '../../../shared/schemas/review'

export type ReviewPhase = 'idle' | 'loading' | 'ready' | 'empty' | 'unavailable' | 'error'

export type ReviewFileState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; diff: ReviewDiffPayload }
  | { phase: 'error'; error: AppError }

export type ReviewState = {
  phase: ReviewPhase
  files: ReviewFilePayload[]
  baselineOid: string | null
  listTruncated: boolean
  unavailable: { reason: ReviewUnavailableReason; detail: string } | null
  error: AppError | null
  selectedPath: string | null
  diffs: Record<string, ReviewFileState>
  /** Incremented per load; responses from an older generation are discarded. */
  generation: number
}

export type ReviewAction =
  | { type: 'reset' }
  | { type: 'loadStart'; generation: number }
  | { type: 'loadSuccess'; result: ReviewListResult; generation: number }
  | { type: 'loadError'; error: AppError; generation: number }
  | { type: 'select'; path: string | null }
  | { type: 'diffStart'; path: string; generation: number }
  | { type: 'diffSuccess'; path: string; diff: ReviewDiffPayload; generation: number }
  | { type: 'diffError'; path: string; error: AppError; generation: number }

export function createReviewState(): ReviewState {
  return {
    phase: 'idle',
    files: [],
    baselineOid: null,
    listTruncated: false,
    unavailable: null,
    error: null,
    selectedPath: null,
    diffs: {},
    generation: 0
  }
}

function keyFor(file: ReviewFilePayload): string {
  return file.oldPath === null ? file.path : `${file.oldPath}\u0000${file.path}`
}

export function fileKey(path: string, oldPath: string | null): string {
  return oldPath === null ? path : `${oldPath}\u0000${path}`
}

function applyList(result: ReviewListPayload): ReviewState {
  const empty = result.files.length === 0
  return {
    phase: empty ? 'empty' : 'ready',
    files: result.files,
    baselineOid: result.baselineOid,
    listTruncated: result.listTruncated,
    unavailable: null,
    error: null,
    selectedPath: empty ? null : (result.files[0]?.path ?? null),
    diffs: {},
    generation: 0
  }
}

export function reviewReducer(state: ReviewState, action: ReviewAction): ReviewState {
  switch (action.type) {
    case 'reset':
      // Keep the counter monotonic so a response from the previous session can
      // never match a freshly started one.
      return { ...createReviewState(), generation: state.generation + 1 }
    case 'loadStart':
      return {
        ...state,
        phase: 'loading',
        error: null,
        generation: action.generation
      }
    case 'loadSuccess': {
      if (action.generation !== state.generation) return state
      if (action.result.status === 'unavailable') {
        return {
          ...state,
          phase: 'unavailable',
          files: [],
          selectedPath: null,
          diffs: {},
          unavailable: { reason: action.result.reason, detail: action.result.detail },
          listTruncated: false
        }
      }
      const next = applyList(action.result)
      return { ...next, generation: state.generation }
    }
    case 'loadError':
      if (action.generation !== state.generation) return state
      return {
        ...state,
        phase: 'error',
        error: action.error,
        files: [],
        selectedPath: null,
        diffs: {}
      }
    case 'select':
      return { ...state, selectedPath: action.path }
    case 'diffStart':
      return {
        ...state,
        diffs: { ...state.diffs, [action.path]: { phase: 'loading' } }
      }
    case 'diffSuccess':
      if (action.generation !== state.generation) return state
      return {
        ...state,
        diffs: {
          ...state.diffs,
          [action.path]: { phase: 'ready', diff: action.diff }
        }
      }
    case 'diffError':
      if (action.generation !== state.generation) return state
      return {
        ...state,
        diffs: { ...state.diffs, [action.path]: { phase: 'error', error: action.error } }
      }
    default:
      return state
  }
}

export function selectedFile(state: ReviewState): ReviewFilePayload | null {
  if (state.selectedPath === null) return null
  return state.files.find((file) => file.path === state.selectedPath) ?? null
}

export function diffStateFor(state: ReviewState, path: string | null): ReviewFileState {
  if (path === null) return { phase: 'idle' }
  return state.diffs[path] ?? { phase: 'idle' }
}

export { keyFor }
