import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { callApi, errorNotice } from '../lib/api'
import type {
  FilesWritePayload,
  GitApplyPatchPayload,
  GitBatchPayload,
  GitBranchPayload,
  GitCommitPayload,
  GitFetchPayload,
  GitOpPayload,
  GitOperationActionPayload,
  GitOperationStatePayload,
  GitResolveConflictPayload,
  GitStatusPayload
} from '../../../shared/ade-api'
import type {
  GitOperationKind,
  GitWorkspaceStatus,
  GitWatchUnavailableReason
} from '../../../shared/domain/git-workspace'
import type { Notice } from '../state/workspace'
import { uncommittedFileCount, workingTreeGroups, type WorkingTreeEntry } from '../review/working-tree'
import { workspaceUnavailableText } from '../review/workspace-unavailable'
import { useWorkbenchDraft, type WorkbenchDraftStore } from '../review/drafts'
import { autoFetchDelayMs } from './auto-fetch'
import { isBranchProtected } from './branch-protection'
import { scmPrimaryAction, type ScmPrimaryAction } from './scm-primary-action'
import { loadScmSettings, subscribeScmSettings, type ScmSettings } from './scm-settings'
import { clearScmStatusSummary, setScmStatusSummary } from './scm-status-store'

type ScmControllerOptions = {
  sessionId: string
  sessionState: string
  /** The Source Control tab is visible. Hidden panes hold stale Git status. */
  active: boolean
  /** Bumped by the global refresh action; reloads Git status. */
  refreshToken: number
  /** Bumped when the header branch menu changed the checkout. */
  gitRevision: number
  notify: (notice: Notice) => void
  /** Notes and the commit message belong to the session. */
  drafts: WorkbenchDraftStore
  /** Called after a Git operation changed the worktree. */
  onChanged: () => void
}

export type ScmController = {
  sessionId: string
  snapshot: GitWorkspaceStatus | null
  loading: boolean
  note: string
  operation: GitOperationKind | null
  watchMode: 'probing' | 'watch' | 'poll'
  /** Bumped whenever the watcher saw a write, so diffs can refresh. */
  diffTick: number
  settings: ScmSettings
  message: string
  setMessage: (value: string) => void
  groups: ReturnType<typeof workingTreeGroups>
  primary: ScmPrimaryAction
  stagedCount: number
  uncommittedCount: number
  workingSummary: string
  busy: boolean
  commitBusy: boolean
  amendBusy: boolean
  stagePending: boolean
  canAmend: boolean
  protectedBranch: boolean
  amendOpen: boolean
  setAmendOpen: (open: boolean) => void
  discardTargets: WorkingTreeEntry[] | null
  refresh: () => void
  setPathStaged: (path: string, staged: boolean) => void
  /** Applies one hunk to the index; the caller already built the patch. */
  applyHunk: (
    path: string,
    patch: string,
    mode: 'stage' | 'unstage' | 'discard'
  ) => Promise<{ ok: boolean; message?: string }>
  /** Writes a merge result and marks the path resolved. */
  resolveConflict: (
    path: string,
    text: string
  ) => Promise<{ ok: boolean; message?: string }>
  setEntriesStaged: (entries: readonly WorkingTreeEntry[], staged: boolean) => Promise<boolean>
  requestDiscard: (entries: WorkingTreeEntry[]) => void
  cancelDiscard: () => void
  confirmDiscard: () => Promise<void>
  continueOperation: () => Promise<void>
  abortOperation: () => Promise<void>
  commit: (pushAfter: boolean) => Promise<void>
  /** `git commit -a` for tracked changes, used by the sidebar menu. */
  commitAll: () => Promise<void>
  runRemoteAction: (kind: 'push' | 'pull' | 'publish' | 'sync') => Promise<void>
  /** An explicit fetch (the palette command); auto-fetch stays quiet. */
  fetchNow: () => Promise<void>
  amend: () => Promise<void>
  runPrimary: () => void
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${String(count)} ${count === 1 ? singular : pluralForm}`
}

/**
 * One controller per Source Control tab.
 *
 * It owns the Git snapshot, the live watcher/poll lifecycle, stage intents,
 * batch mutations, discard confirmation and the commit ladder. The view keeps
 * only presentation state (selection, menus, filter, diff view models), so a
 * remount does not restart Git reads or lose a commit message draft.
 */
export function useScmController({
  sessionId,
  sessionState,
  active,
  refreshToken,
  gitRevision,
  notify,
  drafts,
  onChanged
}: ScmControllerOptions): ScmController {
  const draft = useWorkbenchDraft(drafts, sessionId)
  const message = draft.commitMessage
  const [snapshot, setSnapshot] = useState<GitWorkspaceStatus | null>(null)
  const [operation, setOperation] = useState<GitOperationKind | null>(null)
  const [settings, setSettings] = useState<ScmSettings>(() => loadScmSettings())
  const [watchMode, setWatchMode] = useState<'probing' | 'watch' | 'poll'>('probing')
  const [diffTick, setDiffTick] = useState(0)
  const queuedSilentRefresh = useRef(false)
  const [note, setNote] = useState('')
  useEffect(() => subscribeScmSettings(setSettings), [])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  // The checkbox answers the click immediately; this holds the user's intent
  // until the serialized Git operation refreshes the snapshot.
  const [pendingStage, setPendingStage] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const [commitBusy, setCommitBusy] = useState(false)
  const [amendOpen, setAmendOpen] = useState(false)
  const [amendBusy, setAmendBusy] = useState(false)
  const [discardTargets, setDiscardTargets] = useState<WorkingTreeEntry[] | null>(null)
  const gitGeneration = useRef(0)
  const silentGitInFlight = useRef(false)
  const pendingStageRef = useRef<Map<string, boolean>>(new Map())
  const stageGeneration = useRef(0)
  const stageChain = useRef<Promise<void>>(Promise.resolve())
  const busyRef = useRef(false)
  const operationRef = useRef<GitOperationKind | null>(null)
  const upstreamRef = useRef<string | null>(null)
  const autoFetchFailures = useRef(0)

  const markStagePending = useCallback((path: string, staged: boolean): void => {
    pendingStageRef.current.set(path, staged)
    setPendingStage((current) => {
      const next = new Map(current)
      next.set(path, staged)
      return next
    })
  }, [])

  const clearStagePending = useCallback((path: string): void => {
    pendingStageRef.current.delete(path)
    setPendingStage((current) => {
      if (!current.has(path)) return current
      const next = new Map(current)
      next.delete(path)
      return next
    })
  }, [])

  const setMessage = useCallback(
    (value: string): void => {
      drafts.update(sessionId, (current) => ({ ...current, commitMessage: value }))
    },
    [drafts, sessionId]
  )

  // A different session is a different working tree. Its draft lives in the
  // store, so only controller-local state is reset here.
  useEffect(() => {
    // In-flight stage calls belong to the previous session. Let them settle
    // without touching the new session's pending state.
    stageGeneration.current += 1
    pendingStageRef.current.clear()
    setPendingStage(new Map())
    stageChain.current = Promise.resolve()
    setSnapshot(null)
    setNote('')
    setLoading(true)
    setAmendOpen(false)
    setAmendBusy(false)
    setDiscardTargets(null)
    setOperation(null)
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
        const result = await callApi<GitStatusPayload>(window.ade.git.status({ sessionId }))
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

  useEffect(() => {
    void loadGit()
  }, [loadGit, refreshToken, gitRevision])

  const loadOperation = useCallback(async (): Promise<void> => {
    const result = await callApi<GitOperationStatePayload>(
      window.ade.git.operationState({ sessionId })
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
      if (document.visibilityState === 'visible') await loadGit(true)
      if (!cancelled) timer = window.setTimeout(() => void tick(), 2000)
    }
    timer = window.setTimeout(() => void tick(), 2000)
    const onVisibility = (): void => {
      if (!cancelled && document.visibilityState === 'visible') void loadGit(true)
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
        window.ade.git.watchStatus({ sessionId, active: true })
      )
      if (cancelled) {
        if (result.ok && result.value.watching) {
          void window.ade.git.watchStatus({ sessionId, active: false })
        }
        return
      }
      setWatchMode(result.ok && result.value.watching ? 'watch' : 'poll')
    }
    const unsubscribe = window.ade.git.onStatusChange((event) => {
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
      void window.ade.git.watchStatus({ sessionId, active: visible })
      if (visible) void loadGit(true)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      unsubscribe()
      document.removeEventListener('visibilitychange', onVisibility)
      setWatchMode('probing')
      void window.ade.git.watchStatus({ sessionId, active: false })
    }
  }, [active, loadGit, loadOperation, sessionId])

  /**
   * Optional background fetch while Source Control is visible.
   *
   * It is renderer-driven, single-flight, paused while the window is hidden or
   * an operation is running, and backs off quietly on failure. Manual and
   * automatic fetches share the same Git service, which sets
   * `GIT_TERMINAL_PROMPT=0`, so this can never prompt for credentials.
   */
  useEffect(() => {
    if (!active || !settings.autoFetch) return
    let cancelled = false
    let inFlight = false
    let timer: number | null = null
    const schedule = (): void => {
      if (cancelled) return
      timer = window.setTimeout(
        () => void tick(),
        autoFetchDelayMs(settings.autoFetchIntervalSec, autoFetchFailures.current)
      )
    }
    const tick = async (): Promise<void> => {
      if (cancelled) return
      if (
        document.visibilityState !== 'visible' ||
        busyRef.current ||
        operationRef.current !== null ||
        upstreamRef.current === null
      ) {
        schedule()
        return
      }
      if (inFlight) return
      inFlight = true
      try {
        const result = await callApi<GitFetchPayload>(window.ade.git.fetch({ sessionId }))
        if (cancelled) return
        if (result.ok && result.value.status === 'ok') {
          autoFetchFailures.current = 0
          void loadGit(true)
          void loadOperation()
        } else {
          autoFetchFailures.current = Math.min(3, autoFetchFailures.current + 1)
        }
      } finally {
        inFlight = false
        schedule()
      }
    }
    schedule()
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [
    active,
    loadGit,
    loadOperation,
    sessionId,
    settings.autoFetch,
    settings.autoFetchIntervalSec
  ])

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
  }, [active, gitRevision, loadOperation, refreshToken])

  const groups = useMemo(() => workingTreeGroups(snapshot), [snapshot])
  const protectedBranch = useMemo(
    () => isBranchProtected(snapshot?.branch, settings.branchProtection),
    [settings.branchProtection, snapshot?.branch]
  )
  const stagePending = pendingStage.size > 0
  const stagedCount = groups.staged.length
  const primary = useMemo(
    () =>
      scmPrimaryAction({
        groups,
        message,
        hasUpstream: snapshot?.upstream !== null && snapshot?.upstream !== undefined,
        ahead: snapshot?.ahead ?? 0,
        behind: snapshot?.behind ?? 0,
        operation,
        smartCommit: settings.smartCommit,
        headOid: snapshot?.headOid ?? null,
        branch: snapshot?.branch ?? null
      }),
    [groups, message, operation, settings.smartCommit, snapshot]
  )
  const canAmend =
    snapshot?.headOid !== null &&
    snapshot?.headOid !== undefined &&
    (stagedCount > 0 || message.trim().length > 0) &&
    !commitBusy &&
    !amendBusy &&
    !stagePending

  busyRef.current = busy
  operationRef.current = operation
  upstreamRef.current = snapshot?.upstream ?? null

  const refresh = useCallback((): void => {
    void loadGit()
  }, [loadGit])

  const setPathStaged = (path: string, staged: boolean): void => {
    if (busy || commitBusy || amendBusy || pendingStageRef.current.has(path)) return
    markStagePending(path, staged)
    const generation = stageGeneration.current
    const run = async (): Promise<void> => {
      if (stageGeneration.current !== generation) return
      try {
        const result = await callApi<GitOpPayload>(
          window.ade.git.setPathStaged({ sessionId, path, staged })
        )
        if (stageGeneration.current !== generation) return
        if (!result.ok) {
          clearStagePending(path)
          notify(errorNotice(result.error))
          return
        }
        if (result.value.status === 'unavailable') {
          clearStagePending(path)
          notify({ tone: 'error', message: result.value.detail })
          return
        }
        notify({ tone: 'success', message: `${staged ? 'Staged' : 'Unstaged'} ${path}` })
      } finally {
        if (stageGeneration.current === generation) {
          try {
            await loadGit()
          } finally {
            clearStagePending(path)
            onChanged()
          }
        }
      }
    }
    // Stage operations share one Git index; run them in click order so a
    // second click cannot race the first one's index.lock.
    stageChain.current = stageChain.current.then(run).catch(() => {})
  }

  /**
   * One hunk action shares the index with the file-level stage queue.
   *
   * It is serialized through the same chain so a hunk cannot race a stage-all
   * click into `index.lock`. A failure keeps the diff on screen and returns the
   * message to the hunk header instead of replacing the whole view.
   */
  const applyHunk = (
    path: string,
    patch: string,
    mode: 'stage' | 'unstage' | 'discard'
  ): Promise<{ ok: boolean; message?: string }> => {
    if (busy || commitBusy || amendBusy) {
      return Promise.resolve({ ok: false, message: 'Another Git operation is still running.' })
    }
    const run = async (): Promise<{ ok: boolean; message?: string }> => {
      let outcome: { ok: boolean; message?: string } = {
        ok: false,
        message: 'Git did not apply that hunk.'
      }
      try {
        const result = await callApi<GitApplyPatchPayload>(
          window.ade.git.applyPatch({ sessionId, path, patch, mode })
        )
        if (!result.ok) {
          notify(errorNotice(result.error))
          outcome = { ok: false, message: result.error.message }
          return outcome
        }
        if (result.value.status === 'unavailable') {
          notify({ tone: 'error', message: result.value.detail })
          outcome = { ok: false, message: result.value.detail }
          return outcome
        }
        notify({
          tone: 'success',
          message: `${
            mode === 'stage' ? 'Staged' : mode === 'unstage' ? 'Unstaged' : 'Discarded'
          } a hunk in ${path}`
        })
        outcome = { ok: true }
        return outcome
      } catch (error) {
        outcome = {
          ok: false,
          message: error instanceof Error ? error.message : 'Git did not apply that hunk.'
        }
        return outcome
      } finally {
        if (outcome.ok) {
          try {
            await loadGit()
          } catch {
            // The watcher will publish the next real status; the hunk is applied.
          }
          onChanged()
        }
      }
    }
    const task = stageChain.current.then(run)
    stageChain.current = task.then(
      () => undefined,
      () => undefined
    )
    return task
  }

  /**
   * Saves a merge result through Files, then stages it.
   *
   * The file is written first so the index always points at the exact text the
   * editor showed. Staging is serialized with the other index writers so a
   * continue click cannot race `git add`.
   */
  const resolveConflict = (
    path: string,
    text: string
  ): Promise<{ ok: boolean; message?: string }> => {
    if (busy || commitBusy || amendBusy) {
      return Promise.resolve({ ok: false, message: 'Another Git operation is still running.' })
    }
    const run = async (): Promise<{ ok: boolean; message?: string }> => {
      let outcome: { ok: boolean; message?: string } = {
        ok: false,
        message: 'The conflict could not be saved.'
      }
      try {
        const write = await callApi<FilesWritePayload>(
          window.ade.files.write({ sessionId, path, text })
        )
        if (!write.ok) {
          notify(errorNotice(write.error))
          outcome = { ok: false, message: write.error.message }
          return outcome
        }
        if (write.value.status !== 'ok') {
          notify({ tone: 'error', message: write.value.detail })
          outcome = { ok: false, message: write.value.detail }
          return outcome
        }
        const resolved = await callApi<GitResolveConflictPayload>(
          window.ade.git.resolveConflict({ sessionId, path })
        )
        if (!resolved.ok) {
          notify(errorNotice(resolved.error))
          outcome = { ok: false, message: resolved.error.message }
          return outcome
        }
        if (resolved.value.status !== 'ok') {
          notify({ tone: 'error', message: resolved.value.detail })
          outcome = { ok: false, message: resolved.value.detail }
          return outcome
        }
        notify({ tone: 'success', message: `Resolved ${path}` })
        outcome = { ok: true }
        return outcome
      } catch (error) {
        outcome = {
          ok: false,
          message: error instanceof Error ? error.message : 'The conflict could not be saved.'
        }
        return outcome
      } finally {
        if (outcome.ok) {
          try {
            await loadGit()
          } catch {
            // The watcher will publish the next status.
          }
          onChanged()
        }
      }
    }
    const task = stageChain.current.then(run)
    stageChain.current = task.then(
      () => undefined,
      () => undefined
    )
    return task
  }

  const setEntriesStaged = async (
    entries: readonly WorkingTreeEntry[],
    staged: boolean
  ): Promise<boolean> => {
    if (entries.length === 0 || busy) return false
    setBusy(true)
    try {
      const targets = entries.map((entry) => ({
        path: entry.entry.path,
        area: entry.area === 'conflicts' ? ('conflicted' as const) : entry.area,
        ...(entry.entry.oldPath ? { oldPath: entry.entry.oldPath } : {}),
        status: entry.entry.status
      }))
      const result = await callApi<GitBatchPayload>(
        window.ade.git.setPathsStaged({ sessionId, targets, staged })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return false
      }
      if (result.value.status === 'unavailable') {
        notify({ tone: 'error', message: result.value.detail })
        return false
      }
      const outcome = result.value.result
      if (outcome.failed.length > 0) {
        const failed = outcome.outcomes.find((entry) => entry.status === 'failed')
        notify({
          tone: 'error',
          message: `${plural(outcome.failed.length, 'path')} could not be ${staged ? 'staged' : 'unstaged'}${failed?.reason ? `: ${failed.reason}` : '.'}`
        })
        return false
      }
      notify({
        tone: 'success',
        message: `${staged ? 'Staged' : 'Unstaged'} ${plural(outcome.applied.length, 'path')}.`
      })
      return true
    } finally {
      setBusy(false)
      await loadGit()
      onChanged()
    }
  }

  const requestDiscard = useCallback((entries: WorkingTreeEntry[]): void => {
    setDiscardTargets(entries.length > 0 ? entries : null)
  }, [])

  const cancelDiscard = useCallback((): void => {
    setDiscardTargets(null)
  }, [])

  const confirmDiscard = async (): Promise<void> => {
    if (busy || pendingStageRef.current.size > 0 || discardTargets === null) return
    setBusy(true)
    try {
      const targets = discardTargets.map((target) => ({
        path: target.entry.path,
        area: target.area === 'conflicts' ? ('conflicted' as const) : target.area,
        ...(target.entry.oldPath ? { oldPath: target.entry.oldPath } : {}),
        status: target.entry.status
      }))
      const result = await callApi<GitBatchPayload>(
        window.ade.git.discardPaths({
          sessionId,
          targets,
          ...(snapshot?.revision ? { expectedRevision: snapshot.revision } : {})
        })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      if (result.value.status === 'unavailable') {
        notify({ tone: 'error', message: result.value.detail })
        return
      }
      const outcome = result.value.result
      if (outcome.failed.length > 0) {
        const failed = outcome.outcomes.find((entry) => entry.status === 'failed')
        notify({
          tone: 'error',
          message: `${plural(outcome.failed.length, 'path')} could not be discarded${failed?.reason ? `: ${failed.reason}` : '.'}`
        })
      } else {
        notify({
          tone: 'success',
          message: `Discarded ${plural(outcome.applied.length, 'path')}.`
        })
      }
    } finally {
      setDiscardTargets(null)
      setBusy(false)
      await loadGit()
      onChanged()
    }
  }

  const runCommit = async (
    options: { all?: boolean; signOff?: boolean },
    pushAfter: boolean
  ): Promise<boolean> => {
    if (commitBusy || pendingStageRef.current.size > 0) return false
    if (protectedBranch) {
      notify({
        tone: 'error',
        message: `${snapshot?.branch ?? 'This branch'} is protected by Settings. Commits are disabled.`
      })
      return false
    }
    setCommitBusy(true)
    try {
      const result = await callApi<GitCommitPayload>(
        window.ade.git.commit({
          sessionId,
          message,
          ...options,
          ...(settings.alwaysSignOff ? { signOff: true } : {}),
          ...(settings.enableCommitSigning ? { sign: true } : {})
        })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return false
      }
      if (result.value.status === 'unavailable') {
        notify({ tone: 'error', message: result.value.detail })
        return false
      }
      notify({
        tone: 'success',
        message: `Committed ${result.value.oid} · ${result.value.files} file(s): ${result.value.subject}`
      })
      drafts.update(sessionId, (current) => ({
        ...current,
        commitMessage: current.commitMessage === message ? '' : current.commitMessage
      }))
      if (pushAfter) {
        const pushed = await callApi<GitBranchPayload>(window.ade.git.push({ sessionId }))
        if (!pushed.ok) {
          notify(errorNotice(pushed.error))
        } else if (pushed.value.status === 'unavailable') {
          notify({
            tone: 'error',
            message: `Commit succeeded, but push failed: ${pushed.value.detail}`
          })
        } else {
          notify({ tone: 'success', message: `Pushed ${pushed.value.branch}` })
        }
      }
      return true
    } finally {
      setCommitBusy(false)
      await loadGit()
      onChanged()
    }
  }

  const commit = async (pushAfter: boolean): Promise<void> => {
    if (primary.kind !== 'commit' || primary.disabled) return
    await runCommit({}, pushAfter)
  }

  const commitAll = async (): Promise<void> => {
    if (message.trim().length === 0 || groups.conflicts.length > 0) return
    await runCommit({ all: true }, false)
  }

  const runOperationAction = async (action: 'continue' | 'abort'): Promise<void> => {
    if (busy || commitBusy || operation === null) return
    setBusy(true)
    try {
      const result = await callApi<GitOperationActionPayload>(
        action === 'continue'
          ? window.ade.git.continueOperation({ sessionId })
          : window.ade.git.abortOperation({ sessionId })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      if (result.value.status === 'unavailable') {
        notify({ tone: 'error', message: result.value.detail })
        return
      }
      notify({
        tone: 'success',
        message: `${action === 'continue' ? 'Continued' : 'Aborted'} ${result.value.operation}`
      })
    } finally {
      setBusy(false)
      await loadGit()
      await loadOperation()
      onChanged()
    }
  }

  const runRemoteAction = async (
    kind: 'push' | 'pull' | 'publish' | 'sync'
  ): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const call = kind === 'publish' ? 'publish' : kind === 'pull' || kind === 'sync' ? 'pull' : 'push'
      const input =
        call === 'pull' ? { sessionId, rebase: settings.pullRebase } : { sessionId }
      const result = await callApi<GitBranchPayload>(window.ade.git[call](input))
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      if (result.value.status === 'unavailable') {
        notify({ tone: 'error', message: result.value.detail })
        return
      }
      if (kind === 'sync') {
        const pushed = await callApi<GitBranchPayload>(window.ade.git.push({ sessionId }))
        if (!pushed.ok) {
          notify(errorNotice(pushed.error))
          return
        }
        if (pushed.value.status === 'unavailable') {
          notify({ tone: 'error', message: pushed.value.detail })
          return
        }
      }
      notify({
        tone: 'success',
        message:
          kind === 'publish'
            ? `Published ${result.value.branch}`
            : kind === 'pull'
              ? `Pulled ${result.value.branch}`
              : kind === 'sync'
                ? `Synced ${result.value.branch}`
                : `Pushed ${result.value.branch}`
      })
    } finally {
      setBusy(false)
      await loadGit()
      onChanged()
    }
  }

  /** Explicit fetch from the command palette; auto-fetch stays quiet. */
  const fetchNow = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const result = await callApi<GitFetchPayload>(window.ade.git.fetch({ sessionId }))
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      if (result.value.status === 'unavailable') {
        notify({ tone: 'error', message: result.value.detail })
        return
      }
      notify({ tone: 'success', message: `Fetched ${result.value.remote}` })
    } finally {
      setBusy(false)
      await loadGit()
      onChanged()
    }
  }

  const amend = async (): Promise<void> => {
    if (!canAmend || amendBusy || pendingStageRef.current.size > 0) return
    if (protectedBranch) {
      notify({
        tone: 'error',
        message: `${snapshot?.branch ?? 'This branch'} is protected by Settings. Amending is disabled.`
      })
      return
    }
    const sentMessage = message
    setAmendBusy(true)
    try {
      const result = await callApi<GitCommitPayload>(
        window.ade.git.amend({
          sessionId,
          ...(sentMessage.trim().length > 0 ? { message: sentMessage.trim() } : {}),
          ...(settings.enableCommitSigning ? { sign: true } : {})
        })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      if (result.value.status === 'unavailable') {
        notify({ tone: 'error', message: result.value.detail })
        return
      }
      drafts.update(sessionId, (current) => ({
        ...current,
        commitMessage: current.commitMessage === sentMessage ? '' : current.commitMessage
      }))
      setAmendOpen(false)
      notify({
        tone: 'success',
        message: `Amended ${result.value.oid}${result.value.subject ? ` · ${result.value.subject}` : ''}`
      })
    } finally {
      setAmendBusy(false)
      await loadGit()
      onChanged()
    }
  }

  useEffect(() => {
    if (!active) return
    setScmStatusSummary({
      sessionId,
      branch: snapshot?.branch ?? null,
      upstream: snapshot?.upstream ?? null,
      ahead: snapshot?.ahead ?? 0,
      behind: snapshot?.behind ?? 0,
      conflicts: groups.conflicts.length,
      staged: groups.staged.length,
      changed: groups.unstaged.length,
      untracked: groups.untracked.length,
      operation
    })
  }, [active, groups, operation, sessionId, snapshot])

  useEffect(() => () => clearScmStatusSummary(sessionId), [sessionId])

  const uncommittedCount = uncommittedFileCount(groups)
  const workingSummary =
    uncommittedCount === 0
      ? 'No uncommitted changes'
      : `${String(uncommittedCount)} uncommitted · ${String(stagedCount)} staged · ${String(groups.unstaged.length)} changed · ${String(groups.untracked.length)} untracked`

  const runPrimary = useCallback((): void => {
    switch (primary.kind) {
      case 'commit':
        if (primary.stageFirst) {
          const entries =
            primary.stageFirst === 'all'
              ? [...groups.unstaged, ...groups.untracked]
              : groups.unstaged
          void (async () => {
            if (entries.length === 0) return
            if (await setEntriesStaged(entries, true)) await commit(false)
          })()
        } else {
          void commit(false)
        }
        break
      case 'publish':
      case 'push':
      case 'pull':
      case 'sync':
        void runRemoteAction(primary.kind)
        break
      case 'continue':
        void runOperationAction('continue')
        break
      default:
        break
    }
  }, [
    commit,
    groups.unstaged,
    groups.untracked,
    notify,
    primary,
    runOperationAction,
    runRemoteAction,
    setEntriesStaged
  ])

  return {
    sessionId,
    snapshot,
    loading,
    note,
    operation,
    watchMode,
    diffTick,
    settings,
    message,
    setMessage,
    groups,
    primary,
    stagedCount,
    uncommittedCount,
    workingSummary,
    busy,
    commitBusy,
    amendBusy,
    stagePending,
    canAmend,
    protectedBranch,
    amendOpen,
    setAmendOpen,
    discardTargets,
    refresh,
    setPathStaged,
    applyHunk,
    resolveConflict,
    setEntriesStaged,
    requestDiscard,
    cancelDiscard,
    confirmDiscard,
    continueOperation: () => runOperationAction('continue'),
    abortOperation: () => runOperationAction('abort'),
    commit,
    commitAll,
    runRemoteAction,
    fetchNow,
    amend,
    runPrimary
  }
}
