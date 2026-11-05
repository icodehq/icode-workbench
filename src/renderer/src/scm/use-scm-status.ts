import { useCallback, useEffect, useRef, useState } from 'react'
import { callApi } from '../lib/api'
import type {
  GitOperationStatePayload,
  GitRangeDiffPayload,
  GitStatusPayload
} from '../../../shared/icode-api'
import type {
  GitOperationKind,
  GitRangeFile,
  GitWorkspaceStatus,
  GitWatchUnavailableReason
} from '../../../shared/domain/git-workspace'
import { workspaceUnavailableText } from '../review/workspace-unavailable'
import {
  loadScmSettings,
  subscribeScmSettings,
  type ScmSettings
} from './scm-settings'

type ScmStatusOptions = {
  sessionId: string
  sessionState: string
  /** The commit this session's worktree was created from. */
  baseOid: string | null
  /** The Source Control tab is visible. Hidden panes hold stale Git status. */
  active: boolean
  /** Bumped by the global refresh action; reloads Git status. */
  refreshToken: number
}

type ScmStatus = {
  snapshot: GitWorkspaceStatus | null
  operation: GitOperationKind | null
  /** Files committed between the session baseline and HEAD. */
  committed: GitRangeFile[] | null
  commitCount: number
  committedLoading: boolean
  /** Explains why the committed slice is unavailable; empty when healthy. */
  baseNote: string
  settings: ScmSettings
  watchMode: 'probing' | 'watch' | 'poll'
  diffTick: number
  note: string
  loading: boolean
  refresh: () => Promise<void>
  /** Re-reads the operation marker after a mutation. */
  reloadOperation: () => Promise<void>
}

/**
 * One owner for the Git status surface: the initial read, live watcher, polling
 * fallback, visibility gating and the optional background fetch.
 */
export function useScmStatus({
  sessionId,
  sessionState,
  baseOid,
  active,
  refreshToken
}: ScmStatusOptions): ScmStatus {
  const [snapshot, setSnapshot] = useState<GitWorkspaceStatus | null>(null)
  const [operation, setOperation] = useState<GitOperationKind | null>(null)
  const [committed, setCommitted] = useState<GitRangeFile[] | null>(null)
  const [commitCount, setCommitCount] = useState(0)
  const [committedLoading, setCommittedLoading] = useState(false)
  const [baseNote, setBaseNote] = useState('')
  const [settings, setSettings] = useState<ScmSettings>(() => loadScmSettings())
  const [watchMode, setWatchMode] = useState<'probing' | 'watch' | 'poll'>('probing')
  const [diffTick, setDiffTick] = useState(0)
  const queuedSilentRefresh = useRef(false)
  const [note, setNote] = useState('')
  useEffect(() => subscribeScmSettings(setSettings), [])
  const [loading, setLoading] = useState(true)
  const gitGeneration = useRef(0)
  const committedGeneration = useRef(0)
  const silentGitInFlight = useRef(false)

  // A different session has a different checkout; drop the previous status
  // immediately rather than showing another worktree's files.
  useEffect(() => {
    setSnapshot(null)
    setNote('')
    setLoading(true)
    setOperation(null)
    setCommitted(null)
    setCommitCount(0)
    setBaseNote('')
    setCommittedLoading(false)
  }, [sessionId])

  const loadGit = useCallback(
    async (silent = false): Promise<void> => {
      if (silent && silentGitInFlight.current) {
        queuedSilentRefresh.current = true
        return
      }
      if (silent) silentGitInFlight.current = true
      const generation = gitGeneration.current + 1
      gitGeneration.current = generation
      if (!silent) setLoading(true)
      try {
        const result = await callApi<GitStatusPayload>(window.icode.git.status({ sessionId }))
        if (generation !== gitGeneration.current) return
        if (!silent) setLoading(false)
        if (!result.ok) {
          // A background poll must not replace a readable surface with a
          // transient error. An explicit refresh still reports the failure.
          if (silent) return
          setSnapshot(null)
          setNote(result.error.message)
          return
        }
        if (result.value.status === 'unavailable') {
          if (silent) return
          setSnapshot(null)
          setNote(workspaceUnavailableText(result.value))
          return
        }
        const next = result.value.snapshot
        setSnapshot((current) =>
          silent && current !== null && JSON.stringify(current) === JSON.stringify(next)
            ? current
            : next
        )
        if (!silent) setNote('')
      } finally {
        if (silent) {
          silentGitInFlight.current = false
          if (queuedSilentRefresh.current) {
            queuedSilentRefresh.current = false
            // A watcher event arrived while the previous read was in flight;
            // read once more so the newest write cannot be lost.
            void loadGit(true)
          }
        }
      }
    },
    [sessionId]
  )

  const loadCommitted = useCallback(
    async (silent = false): Promise<void> => {
      if (baseOid === null) {
        committedGeneration.current += 1
        setCommitted(null)
        setCommitCount(0)
        setBaseNote('')
        setCommittedLoading(false)
        return
      }
      const generation = committedGeneration.current + 1
      committedGeneration.current = generation
      if (!silent) setCommittedLoading(true)
      try {
        const result = await callApi<GitRangeDiffPayload>(
          window.icode.git.rangeDiff({ sessionId, from: baseOid, to: 'HEAD' })
        )
        if (generation !== committedGeneration.current) return
        if (!result.ok) {
          // Like status, a background read must not erase a readable list.
          if (silent) return
          setCommitted(null)
          setCommitCount(0)
          setBaseNote(result.error.message)
          return
        }
        if (result.value.status === 'unavailable') {
          if (silent) return
          setCommitted(null)
          setCommitCount(0)
          setBaseNote(result.value.detail)
          return
        }
        const files = result.value.files
        const count = result.value.commitCount
        setCommitted((current) =>
          current !== null && JSON.stringify(current) === JSON.stringify(files) ? current : files
        )
        setCommitCount((current) => (current === count ? current : count))
        setBaseNote('')
      } finally {
        if (generation === committedGeneration.current) setCommittedLoading(false)
      }
    },
    [baseOid, sessionId]
  )

  // The committed slice changes only when HEAD moves. Status polling catches
  // working-tree writes; this keeps base..HEAD from being re-read on each one.
  const headOid = snapshot?.headOid ?? null
  useEffect(() => {
    if (!active || headOid === null) return
    void loadCommitted()
  }, [active, headOid, loadCommitted])

  useEffect(() => {
    void loadGit()
  }, [loadGit, refreshToken])

  const loadOperation = useCallback(async (): Promise<void> => {
    const result = await callApi<GitOperationStatePayload>(
      window.icode.git.operationState({ sessionId })
    )
    if (result.ok && result.value.status === 'ok') setOperation(result.value.operation)
    else setOperation(null)
  }, [sessionId])

  /**
   * The worktree is written by an Agent, not by this panel. Without a live
   * read, a finished edit stays invisible until the user presses Refresh or
   * leaves and reopens Source Control. Poll only while the tab is visible and
   * the session can still write; hidden panels and exited sessions do not
   * spend work.
   */
  useEffect(() => {
    if (!active || (sessionState !== 'live' && sessionState !== 'starting')) return
    if (watchMode !== 'poll') return
    let cancelled = false
    let timer: number | null = null
    const tick = async (): Promise<void> => {
      if (cancelled) return
      if (document.visibilityState === 'visible') {
        await loadGit(true)
      }
      if (!cancelled) timer = window.setTimeout(() => void tick(), 2000)
    }
    timer = window.setTimeout(() => void tick(), 2000)
    const onVisibility = (): void => {
      if (!cancelled && document.visibilityState === 'visible') {
        void loadGit(true)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [active, loadGit, sessionState, watchMode])

  /**
   * Live worktree watching.
   *
   * The watcher is requested only while Source Control is visible. A local
   * target gets one coalesced event per write window; the controller then
   * re-reads status and bumps `diffTick` so the focused diff refreshes. A guest
   * target reports `watching: false` and keeps the polling fallback until the
   * Host protocol v2 lands.
   */
  useEffect(() => {
    if (!active) return
    let cancelled = false
    const start = async (): Promise<void> => {
      const result = await callApi<{ watching: boolean; reason?: GitWatchUnavailableReason }>(
        window.icode.git.watchStatus({ sessionId, active: true })
      )
      if (cancelled) {
        if (result.ok && result.value.watching) {
          void window.icode.git.watchStatus({ sessionId, active: false })
        }
        return
      }
      setWatchMode(result.ok && result.value.watching ? 'watch' : 'poll')
    }
    const unsubscribe = window.icode.git.onStatusChange((event) => {
      if (cancelled || event.sessionId !== sessionId) return
      if (event.failed) {
        setWatchMode('poll')
        return
      }
      if (document.visibilityState !== 'visible') return
      setDiffTick((value) => value + 1)
      void loadGit(true)
      void loadOperation()
    })
    void start()
    const onVisibility = (): void => {
      const visible = document.visibilityState === 'visible'
      void window.icode.git.watchStatus({ sessionId, active: visible })
      if (visible) {
        void loadGit(true)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      unsubscribe()
      document.removeEventListener('visibilitychange', onVisibility)
      setWatchMode('probing')
      void window.icode.git.watchStatus({ sessionId, active: false })
    }
  }, [active, loadGit, loadOperation, sessionId])

  // This tab stays mounted while Terminal or Files is visible. On entering it,
  // the Git snapshot must be re-read: a stale snapshot marks a newly edited
  // file as already committed.
  useEffect(() => {
    if (!active) return
    void loadGit()
  }, [active, loadGit])

  useEffect(() => {
    if (!active) return
    void loadOperation()
  }, [active, loadOperation, refreshToken])


  const refresh = useCallback(async (): Promise<void> => {
    await Promise.all([loadGit(), loadCommitted()])
  }, [loadCommitted, loadGit])

  return {
    snapshot,
    operation,
    committed,
    commitCount,
    committedLoading,
    baseNote,
    settings,
    watchMode,
    diffTick,
    note,
    loading,
    refresh,
    reloadOperation: loadOperation
  }
}
