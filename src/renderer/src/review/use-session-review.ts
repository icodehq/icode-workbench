import { useCallback, useEffect, useReducer, useRef } from 'react'
import { makeAppError } from '../../../shared/domain/errors'
import { callApi } from '../lib/api'
import { createReviewState, reviewReducer, type ReviewState } from './review-state'

export type SessionReview = {
  state: ReviewState
  refresh: () => void
  selectFile: (path: string) => void
  retryDiff: (path: string) => void
}

/**
 * Loads review data for one session.
 *
 * A single monotonic generation guards every response: switching sessions or
 * refreshing invalidates in-flight requests so a late reply cannot overwrite a
 * newer view. There is no polling and no watcher; the panel refreshes on entry,
 * on manual refresh, and when the session's lifecycle state changes.
 */
export function useSessionReview(
  sessionId: string | null,
  active: boolean,
  sessionState: string | null
): SessionReview {
  const [state, dispatch] = useReducer(reviewReducer, undefined, createReviewState)
  const generationRef = useRef(0)
  const sessionRef = useRef<string | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state

  const loadDiff = useCallback(
    async (path: string, generation: number): Promise<void> => {
      if (sessionId === null) return
      dispatch({ type: 'diffStart', path, generation })
      const result = await callApi(window.ade.review.diff({ sessionId, path }))
      if (result.ok) {
        if (result.value.status === 'available') {
          dispatch({ type: 'diffSuccess', path, diff: result.value, generation })
        } else {
          dispatch({
            type: 'diffError',
            path,
            error: makeAppError('GIT_READ_FAILED', result.value.detail),
            generation
          })
        }
        return
      }
      dispatch({ type: 'diffError', path, error: result.error, generation })
    },
    [sessionId]
  )

  const load = useCallback(async (): Promise<void> => {
    if (sessionId === null) return
    const generation = generationRef.current + 1
    generationRef.current = generation
    dispatch({ type: 'loadStart', generation })
    const result = await callApi(window.ade.review.list({ sessionId }))
    if (!result.ok) {
      dispatch({ type: 'loadError', error: result.error, generation })
      return
    }
    dispatch({ type: 'loadSuccess', result: result.value, generation })
    if (result.value.status !== 'available') return
    const first = result.value.files[0]
    if (first) await loadDiff(first.path, generation)
  }, [loadDiff, sessionId])

  useEffect(() => {
    if (sessionRef.current === sessionId) return
    sessionRef.current = sessionId
    generationRef.current += 1
    dispatch({ type: 'reset' })
  }, [sessionId])

  useEffect(() => {
    if (!active || sessionId === null) return
    void load()
  }, [active, sessionId, sessionState, load])

  const selectFile = useCallback(
    (path: string): void => {
      dispatch({ type: 'select', path })
      const existing = stateRef.current.diffs[path]
      if (existing && existing.phase !== 'error') return
      void loadDiff(path, generationRef.current)
    },
    [loadDiff]
  )

  const refresh = useCallback((): void => {
    void load()
  }, [load])

  const retryDiff = useCallback(
    (path: string): void => {
      void loadDiff(path, generationRef.current)
    },
    [loadDiff]
  )

  return { state, refresh, selectFile, retryDiff }
}
