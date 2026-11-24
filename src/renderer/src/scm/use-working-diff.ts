import { useCallback, useEffect, useRef, useState } from 'react'
import { callApi } from '../lib/api'
import type { AppError } from '../../../shared/domain/errors'
import { makeAppError } from '../../../shared/domain/errors'
import type { IpcResult } from '../../../shared/schemas/ipc'
import type { FileDiffPayload, FileDiffResult } from '../../../shared/schemas/changes'
import { translate } from '../i18n/i18n-store'
import { countUnifiedDiffChanges } from '../review/parse-unified-diff'
import type { WorkingTreeEntry } from '../review/working-tree'
import { changeDiffInputFor } from './change-diff-input'

export type WorkingDiffState = {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  diff?: FileDiffPayload
  error?: AppError
  stale?: boolean
}

/**
 * Loads and keeps one working-tree diff fresh for a center diff tab.
 *
 * The tab is self-sufficient: it polls its own patch while visible, so the
 * Source Control pane's watcher does not have to stay live for a diff the user
 * is reading. The Changes list still owns status and mutations.
 */
export function useWorkingDiff(input: {
  sessionId: string
  entry: WorkingTreeEntry | null
  active: boolean
  refreshToken: number
  diffTick?: number
  watchActive?: boolean
  sessionState?: string
}): { state: WorkingDiffState; retry: () => void } {
  const { sessionId, entry, active, refreshToken, diffTick = 0, watchActive = false } = input
  const [state, setState] = useState<WorkingDiffState>({ phase: 'idle' })
  const generation = useRef(0)
  const inFlight = useRef(false)
  const entryRef = useRef<WorkingTreeEntry | null>(entry)
  entryRef.current = entry
  const entryKey = entry?.key ?? null

  const request = useCallback(
    (target: WorkingTreeEntry): Promise<IpcResult<FileDiffResult>> => {
      const body = changeDiffInputFor(sessionId, target)
      if (body === null) {
        return Promise.resolve({
          ok: true,
          value: {
            status: 'unavailable' as const,
            reason: 'invalid-baseline' as const,
            detail: translate('scm.worktree.committedRow')
          }
        })
      }
      return callApi<FileDiffResult>(window.icode.git.changeDiff(body))
    },
    [sessionId]
  )

  const applyResult = useCallback((result: IpcResult<FileDiffResult>): void => {
    if (!result.ok) {
      setState({ phase: 'error', error: result.error })
      return
    }
    if (result.value.status === 'available') {
      const value = result.value
      const next =
        value.binary || value.truncated
          ? value
          : { ...value, ...countUnifiedDiffChanges(value.patch) }
      setState({ phase: 'ready', diff: next })
      return
    }
    const detail = 'detail' in result.value ? result.value.detail : translate('review.diffUnavailable')
    setState({ phase: 'error', error: makeAppError('GIT_READ_FAILED', detail) })
  }, [])

  const load = useCallback(
    async (target: WorkingTreeEntry, quiet: boolean): Promise<void> => {
      if (target.area === 'committed' || inFlight.current) return
      const gen = generation.current
      inFlight.current = true
      if (!quiet) {
        setState((current) =>
          current.phase === 'ready' ? { ...current, stale: true } : { phase: 'loading' }
        )
      }
      try {
        const result = await request(target)
        if (generation.current !== gen) return
        if (quiet) {
          if (!result.ok || result.value.status !== 'available') return
          const value = result.value
          const next =
            value.binary || value.truncated
              ? value
              : { ...value, ...countUnifiedDiffChanges(value.patch) }
          setState((current) =>
            current.phase === 'ready' &&
            current.diff?.patch === next.patch &&
            current.diff?.additions === next.additions &&
            current.diff?.deletions === next.deletions
              ? current
              : { phase: 'ready', diff: next }
          )
          return
        }
        applyResult(result)
      } finally {
        inFlight.current = false
      }
    },
    [applyResult, request]
  )

  useEffect(() => {
    generation.current += 1
    setState({ phase: 'idle' })
  }, [entryKey, sessionId])

  useEffect(() => {
    const target = entryRef.current
    if (!active || target === null || target.area === 'committed') return
    void load(target, false)
  }, [active, diffTick, entryKey, load, refreshToken])

  useEffect(() => {
    const target = entryRef.current
    if (!active || watchActive || target === null || target.area === 'committed') return
    const sessionState = input.sessionState
    if (sessionState !== undefined && sessionState !== 'live' && sessionState !== 'starting') {
      return
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(target, true)
    }, 2000)
    return () => window.clearInterval(timer)
  }, [active, entryKey, input.sessionState, load, watchActive])

  const retry = useCallback((): void => {
    if (entry !== null) void load(entry, false)
  }, [entry, load])

  return { state, retry }
}
