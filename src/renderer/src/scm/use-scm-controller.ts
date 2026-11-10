import { translate } from '../i18n/i18n-store'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { callApi, errorNotice } from '../lib/api'
import type {
  FilesWritePayload,
  GitApplyPatchPayload,
  GitBatchPayload,
  GitBranchPayload,
  GitCommandResultMap,
  GitCommitPayload,
  GitOpPayload,
  GitOperationActionPayload,
  GitResolveConflictPayload
} from '../../../shared/icode-api'
import type {
  GitOperationKind,
  GitRangeFile,
  GitWorkspaceStatus
} from '../../../shared/domain/git-workspace'
import type { MergeOutcomePayload, MergeRecordPayload } from '../../../shared/schemas/ipc'
import type { Notice } from '../state/workspace'
import { uncommittedFileCount, workingTreeGroups, type WorkingTreeEntry } from '../review/working-tree'
import { useWorkbenchDraft, type WorkbenchDraftStore } from '../review/drafts'
import { useBranchRefs } from '../state/use-branch-refs'
import { useScmStatus } from './use-scm-status'
import { isBranchProtected } from './branch-protection'
import { scmPrimaryAction, type ScmPrimaryAction } from './scm-primary-action'
import {
  isActiveMergeRecord,
  mergeOperationRoute,
  resolveMergeTargets,
  type MergeTargetResolution
} from './scm-merge'
import type { ScmSettings } from './scm-settings'
import { clearScmStatusSummary, setScmStatusSummary } from './scm-status-store'

type ScmControllerOptions = {
  sessionId: string
  sessionState: string
  /** The repository that owns this session, used for branch refs and merges. */
  repoId: string
  /** The commit this session's worktree was created from. */
  baseOid: string | null
  /** The Source Control tab is visible. Hidden panes hold stale Git status. */
  active: boolean
  /** Bumped by the global refresh action; reloads Git status. */
  refreshToken: number
  notify: (notice: Notice) => void
  /** Notes and the commit message belong to the session. */
  drafts: WorkbenchDraftStore
  /** Called after a Git operation changed the worktree. */
  onChanged: () => void
  /** A task's shared chain branch, preselected as the merge target. */
  mergeTargetHint?: string | null
  /** Whether the task's dependents force the chain branch target. */
  lockMergeTarget?: boolean
}

export type ScmController = {
  sessionId: string
  snapshot: GitWorkspaceStatus | null
  loading: boolean
  note: string
  operation: GitOperationKind | null
  committed: GitRangeFile[] | null
  commitCount: number
  committedLoading: boolean
  baseNote: string
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
  /** Latest merge record for this session, in any state. */
  mergeRecord: MergeRecordPayload | null
  /** True only for running/conflicted records. */
  mergeActive: boolean
  /** Resolved target list, default target and completion state. */
  mergeTargets: MergeTargetResolution
  mergeTarget: string | null
  mergeTargetOid: string | null
  mergeTargetLocked: boolean
  mergeTargetsLoading: boolean
  mergeTargetsReason: string
  reloadMergeTargets: () => Promise<void>
  mergeMenuEnabled: boolean
  mergeMenuReason: string
  pushMenuEnabled: boolean
  pushMenuReason: string
  remotes: string[] | null
  remotesLoading: boolean
  loadRemotes: () => Promise<void>
  startMerge: (targetBranch: string) => Promise<{ ok: boolean; message?: string }>
  continueMerge: () => Promise<void>
  abortMerge: () => Promise<void>
  pushTo: (remote: string, branch: string) => Promise<{ ok: boolean; message?: string }>
  amend: () => Promise<void>
  runPrimary: () => void
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
  repoId,
  baseOid,
  active,
  refreshToken,
  notify,
  drafts,
  onChanged,
  mergeTargetHint = null,
  lockMergeTarget = false
}: ScmControllerOptions): ScmController {
  const draft = useWorkbenchDraft(drafts, sessionId)
  const message = draft.commitMessage
  const [busy, setBusy] = useState(false)
  const status = useScmStatus({
    sessionId,
    sessionState,
    baseOid,
    active,
    refreshToken
  })
  const {
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
    reloadOperation
  } = status

  const branchRefs = useBranchRefs(repoId.length > 0 ? repoId : null)
  const [mergeRecord, setMergeRecord] = useState<MergeRecordPayload | null>(null)
  const mergeGeneration = useRef(0)
  const [remotes, setRemotes] = useState<string[] | null>(null)
  const [remotesLoading, setRemotesLoading] = useState(false)
  const remotesGeneration = useRef(0)

  const loadMergeState = useCallback(async (): Promise<void> => {
    const generation = mergeGeneration.current + 1
    mergeGeneration.current = generation
    const result = await callApi<MergeRecordPayload | null>(
      window.icode.merge.state({ sessionId })
    )
    if (generation !== mergeGeneration.current) return
    setMergeRecord(result.ok ? result.value : null)
  }, [sessionId])

  const loadRemotes = useCallback(async (): Promise<void> => {
    const generation = remotesGeneration.current + 1
    remotesGeneration.current = generation
    setRemotesLoading(true)
    try {
      const result = await callApi<GitCommandResultMap['remotes']>(
        window.icode.git.remotes({ sessionId })
      )
      if (generation !== remotesGeneration.current) return
      if (!result.ok) {
        notify(errorNotice(result.error))
        setRemotes([])
        return
      }
      if (result.value.status !== 'ok') {
        notify({
          tone: 'error',
          message: result.value.detail ?? translate('push.noRemotes')
        })
        setRemotes([])
        return
      }
      setRemotes(result.value.remotes)
    } finally {
      if (generation === remotesGeneration.current) setRemotesLoading(false)
    }
  }, [notify, sessionId])

  // A different session has a different merge record and remote list.
  useEffect(() => {
    mergeGeneration.current += 1
    remotesGeneration.current += 1
    setMergeRecord(null)
    setRemotes(null)
    setRemotesLoading(false)
  }, [sessionId])

  useEffect(() => {
    if (!active) return
    void loadMergeState()
    void branchRefs.reload()
  }, [active, branchRefs.reload, loadMergeState, refreshToken])

  // The checkbox answers the click immediately; this holds the user's intent
  // until the serialized Git operation refreshes the snapshot.
  const [pendingStage, setPendingStage] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const [commitBusy, setCommitBusy] = useState(false)
  const [amendOpen, setAmendOpen] = useState(false)
  const [amendBusy, setAmendBusy] = useState(false)
  const [discardTargets, setDiscardTargets] = useState<WorkingTreeEntry[] | null>(null)
  const pendingStageRef = useRef<Map<string, boolean>>(new Map())
  const stageGeneration = useRef(0)
  const stageChain = useRef<Promise<void>>(Promise.resolve())

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

  // A different session has a different working tree. Status state is reset
  // by useScmStatus; only mutation bookkeeping remains here.
  useEffect(() => {
    stageGeneration.current += 1
    pendingStageRef.current.clear()
    setPendingStage(new Map())
    stageChain.current = Promise.resolve()
    setAmendOpen(false)
    setAmendBusy(false)
    setDiscardTargets(null)
  }, [sessionId])

  const groups = useMemo(() => workingTreeGroups(snapshot), [snapshot])
  const protectedBranch = useMemo(
    () => isBranchProtected(snapshot?.branch, settings.branchProtection),
    [settings.branchProtection, snapshot?.branch]
  )
  const stagePending = pendingStage.size > 0
  const stagedCount = groups.staged.length
  const clean = uncommittedFileCount(groups) === 0
  const mergeTargets = useMemo(
    () =>
      resolveMergeTargets({
        refs: branchRefs.refs,
        sourceBranch: snapshot?.branch ?? null,
        headOid: snapshot?.headOid ?? null,
        hint: mergeTargetHint,
        lockHint: lockMergeTarget,
        loading: branchRefs.loading,
        record: mergeRecord
      }),
    [
      branchRefs.loading,
      branchRefs.refs,
      lockMergeTarget,
      mergeRecord,
      mergeTargetHint,
      snapshot?.branch,
      snapshot?.headOid
    ]
  )
  const mergeTargetsReason = useMemo(() => {
    switch (mergeTargets.reason) {
      case 'loading':
        return translate('scm.merge.loadingTargets')
      case 'no-target':
        return translate('scm.merge.noTargets')
      case 'missing-target':
        return translate('scm.merge.targetMissing')
      default:
        return ''
    }
  }, [mergeTargets.reason])
  const mergeMenuReason = useMemo(() => {
    if (snapshot === null) return translate('scm.changes.gitUnavailable')
    if (snapshot.branch === null) return translate('scm.push.detached')
    if (snapshot.headOid === null) return translate('scm.push.unborn')
    if (busy) return translate('scm.notice.anotherOperation')
    if (mergeRecord !== null && isActiveMergeRecord(mergeRecord)) {
      return translate('scm.merge.active')
    }
    if (operation !== null) return translate('scm.merge.operation')
    if (!clean) return translate('scm.merge.dirty')
    if (committedLoading) return translate('scm.merge.readingCommits')
    if (commitCount === 0 && !lockMergeTarget) return translate('scm.merge.noCommits')
    if (mergeTargets.reason !== '') return mergeTargetsReason
    if (mergeTargets.target === null) return translate('scm.merge.noTargets')
    return ''
  }, [
    busy,
    clean,
    commitCount,
    committedLoading,
    lockMergeTarget,
    mergeRecord,
    mergeTargets.reason,
    mergeTargets.target,
    mergeTargetsReason,
    operation,
    snapshot
  ])
  const mergeMenuEnabled = mergeMenuReason === ''
  const pushMenuReason = useMemo(() => {
    if (snapshot === null) return translate('scm.changes.gitUnavailable')
    if (snapshot.branch === null) return translate('scm.push.detached')
    if (snapshot.headOid === null) return translate('scm.push.unborn')
    if (busy) return translate('scm.notice.anotherOperation')
    if (operation !== null) return translate('scm.merge.operation')
    return ''
  }, [busy, operation, snapshot])
  const pushMenuEnabled = pushMenuReason === ''
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
        branch: snapshot?.branch ?? null,
        commitCount,
        commitsLoading: committedLoading,
        merge: {
          target: mergeTargets.target,
          targetOid: mergeTargets.targetOid,
          locked: mergeTargets.locked,
          loading: mergeTargets.loading,
          reason: mergeTargetsReason,
          recordState:
            mergeRecord !== null && isActiveMergeRecord(mergeRecord)
              ? mergeRecord.state
              : null,
          alreadyComplete: mergeTargets.alreadyComplete
        }
      }),
    [
      commitCount,
      committedLoading,
      groups,
      mergeRecord,
      mergeTargets,
      mergeTargetsReason,
      message,
      operation,
      settings.smartCommit,
      snapshot
    ]
  )
  const canAmend =
    snapshot?.headOid !== null &&
    snapshot?.headOid !== undefined &&
    (stagedCount > 0 || message.trim().length > 0) &&
    !commitBusy &&
    !amendBusy &&
    !stagePending


  const setPathStaged = (path: string, staged: boolean): void => {
    if (busy || commitBusy || amendBusy || pendingStageRef.current.has(path)) return
    markStagePending(path, staged)
    const generation = stageGeneration.current
    const run = async (): Promise<void> => {
      if (stageGeneration.current !== generation) return
      try {
        const result = await callApi<GitOpPayload>(
          window.icode.git.setPathStaged({ sessionId, path, staged })
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
        notify({
          tone: 'success',
          message: translate(staged ? 'scm.notice.staged' : 'scm.notice.unstaged', { path })
        })
      } finally {
        if (stageGeneration.current === generation) {
          try {
            await refresh()
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
      return Promise.resolve({
        ok: false,
        message: translate('scm.notice.anotherOperation')
      })
    }
    const run = async (): Promise<{ ok: boolean; message?: string }> => {
      let outcome: { ok: boolean; message?: string } = {
        ok: false,
        message: translate('scm.notice.hunkFailed')
      }
      try {
        const result = await callApi<GitApplyPatchPayload>(
          window.icode.git.applyPatch({ sessionId, path, patch, mode })
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
          message: translate('scm.notice.hunkApplied', {
            action: translate(
              mode === 'stage'
                ? 'scm.action.stagedDone'
                : mode === 'unstage'
                  ? 'scm.action.unstagedDone'
                  : 'scm.action.discardedDone'
            ),
            path
          })
        })
        outcome = { ok: true }
        return outcome
      } catch (error) {
        outcome = {
          ok: false,
          message: error instanceof Error ? error.message : translate('scm.notice.hunkFailed')
        }
        return outcome
      } finally {
        if (outcome.ok) {
          try {
            await refresh()
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
      return Promise.resolve({
        ok: false,
        message: translate('scm.notice.anotherOperation')
      })
    }
    const run = async (): Promise<{ ok: boolean; message?: string }> => {
      let outcome: { ok: boolean; message?: string } = {
        ok: false,
        message: translate('scm.notice.conflictSaveFailed')
      }
      try {
        const write = await callApi<FilesWritePayload>(
          window.icode.files.write({ sessionId, path, text })
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
          window.icode.git.resolveConflict({ sessionId, path })
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
        notify({
          tone: 'success',
          message: translate('scm.notice.resolved', { path })
        })
        outcome = { ok: true }
        return outcome
      } catch (error) {
        outcome = {
          ok: false,
          message: error instanceof Error ? error.message : translate('scm.notice.conflictSaveFailed')
        }
        return outcome
      } finally {
        if (outcome.ok) {
          try {
            await refresh()
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
      const targets = entries.flatMap((entry) => {
        if (entry.area === 'committed') return []
        return [
          {
            path: entry.entry.path,
            area: entry.area === 'conflicts' ? ('conflicted' as const) : entry.area,
            ...(entry.entry.oldPath ? { oldPath: entry.entry.oldPath } : {}),
            status: entry.entry.status
          }
        ]
      })
      const result = await callApi<GitBatchPayload>(
        window.icode.git.setPathsStaged({ sessionId, targets, staged })
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
          message: translate('scm.notice.couldNotApply', {
            count: outcome.failed.length,
            action: translate(staged ? 'scm.action.staged' : 'scm.action.unstaged'),
            reason: failed?.reason ? `: ${failed.reason}` : '.'
          })
        })
        return false
      }
      notify({
        tone: 'success',
        message: translate('scm.notice.applied', {
          action: translate(staged ? 'scm.action.stagedDone' : 'scm.action.unstagedDone'),
          count: outcome.applied.length
        })
      })
      return true
    } finally {
      setBusy(false)
      await refresh()
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
      const targets = discardTargets.flatMap((target) => {
        if (target.area === 'committed') return []
        return [
          {
            path: target.entry.path,
            area: target.area === 'conflicts' ? ('conflicted' as const) : target.area,
            ...(target.entry.oldPath ? { oldPath: target.entry.oldPath } : {}),
            status: target.entry.status
          }
        ]
      })
      const result = await callApi<GitBatchPayload>(
        window.icode.git.discardPaths({
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
          message: translate('scm.notice.couldNotApply', {
            count: outcome.failed.length,
            action: translate('scm.action.discarded'),
            reason: failed?.reason ? `: ${failed.reason}` : '.'
          })
        })
      } else {
        notify({
          tone: 'success',
          message: translate('scm.notice.discarded', { count: outcome.applied.length })
        })
      }
    } finally {
      setDiscardTargets(null)
      setBusy(false)
      await refresh()
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
        message: translate('scm.notice.protectedCommits', {
          branch: snapshot?.branch ?? translate('scm.notice.thisBranch')
        })
      })
      return false
    }
    setCommitBusy(true)
    try {
      const result = await callApi<GitCommitPayload>(
        window.icode.git.commit({
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
        message: translate('scm.notice.committed', {
          oid: result.value.oid,
          files: result.value.files,
          subject: result.value.subject
        })
      })
      drafts.update(sessionId, (current) => ({
        ...current,
        commitMessage: current.commitMessage === message ? '' : current.commitMessage
      }))
      if (pushAfter) {
        const pushed = await callApi<GitBranchPayload>(window.icode.git.push({ sessionId }))
        if (!pushed.ok) {
          notify(errorNotice(pushed.error))
        } else if (pushed.value.status === 'unavailable') {
          notify({
            tone: 'error',
            message: translate('scm.notice.commitPushFailed', { detail: pushed.value.detail })
          })
        } else {
          notify({
            tone: 'success',
            message: translate('scm.notice.pushed', { branch: pushed.value.branch })
          })
        }
      }
      return true
    } finally {
      setCommitBusy(false)
      await refresh()
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
    if (busy || commitBusy) return
    const route = mergeOperationRoute({ record: mergeRecord, operation, action })
    if (route === 'none') return
    if (route === 'blocked') {
      notify({ tone: 'info', message: translate('scm.merge.continueBlocked') })
      return
    }
    if (route === 'merge') {
      if (action === 'continue') await continueMerge()
      else await abortMerge()
      return
    }
    setBusy(true)
    try {
      const result = await callApi<GitOperationActionPayload>(
        action === 'continue'
          ? window.icode.git.continueOperation({ sessionId })
          : window.icode.git.abortOperation({ sessionId })
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
        message: translate(
          action === 'continue' ? 'scm.notice.continued' : 'scm.notice.aborted',
          { operation: result.value.operation }
        )
      })
    } finally {
      setBusy(false)
      await refresh()
      await reloadOperation()
      await loadMergeState()
      await branchRefs.reload()
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
      const result = await callApi<GitBranchPayload>(window.icode.git[call](input))
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      if (result.value.status === 'unavailable') {
        notify({ tone: 'error', message: result.value.detail })
        return
      }
      if (kind === 'sync') {
        const pushed = await callApi<GitBranchPayload>(window.icode.git.push({ sessionId }))
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
        message: translate(
          kind === 'publish'
            ? 'scm.notice.published'
            : kind === 'pull'
              ? 'scm.notice.pulled'
              : kind === 'sync'
                ? 'scm.notice.synced'
                : 'scm.notice.pushed',
          { branch: result.value.branch }
        )
      })
    } finally {
      setBusy(false)
      await refresh()
      onChanged()
    }
  }

  const startMerge = async (
    targetBranch: string
  ): Promise<{ ok: boolean; message?: string }> => {
    if (busy || commitBusy) {
      return { ok: false, message: translate('scm.notice.anotherOperation') }
    }
    if (operation !== null) {
      return { ok: false, message: translate('scm.merge.operation') }
    }
    if (mergeRecord !== null && isActiveMergeRecord(mergeRecord)) {
      return { ok: false, message: translate('scm.merge.active') }
    }
    if (!clean) {
      return { ok: false, message: translate('scm.merge.dirty') }
    }
    setBusy(true)
    try {
      const result = await callApi<MergeOutcomePayload>(
        window.icode.merge.start({ sessionId, targetBranch })
      )
      if (!result.ok) return { ok: false, message: result.error.message }
      setMergeRecord(result.value.record)
      if (result.value.status === 'merged') {
        notify({
          tone: 'success',
          message: translate('merge.mergedNotice', { branch: targetBranch })
        })
      } else {
        notify({ tone: 'info', message: translate('merge.conflictNotice') })
      }
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : translate('merge.error')
      notify({ tone: 'error', message })
      return { ok: false, message }
    } finally {
      setBusy(false)
      await refresh()
      await reloadOperation()
      await loadMergeState()
      await branchRefs.reload()
      onChanged()
    }
  }

  const continueMerge = async (): Promise<void> => {
    if (busy || commitBusy) return
    setBusy(true)
    try {
      const result = await callApi<MergeOutcomePayload>(
        window.icode.merge.continueMerge({ sessionId })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      setMergeRecord(result.value.record)
      if (result.value.status === 'merged') {
        notify({
          tone: 'success',
          message: translate('merge.mergedNotice', {
            branch: result.value.record.targetBranch
          })
        })
      } else {
        notify({ tone: 'info', message: translate('merge.conflictNotice') })
      }
    } finally {
      setBusy(false)
      await refresh()
      await reloadOperation()
      await loadMergeState()
      await branchRefs.reload()
      onChanged()
    }
  }

  const abortMerge = async (): Promise<void> => {
    if (busy || commitBusy) return
    setBusy(true)
    try {
      const result = await callApi<MergeRecordPayload>(
        window.icode.merge.abort({ sessionId })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      setMergeRecord(result.value)
      notify({ tone: 'info', message: translate('scm.notice.mergeAborted') })
    } finally {
      setBusy(false)
      await refresh()
      await reloadOperation()
      await loadMergeState()
      await branchRefs.reload()
      onChanged()
    }
  }

  const pushTo = async (
    remote: string,
    branch: string
  ): Promise<{ ok: boolean; message?: string }> => {
    if (busy || commitBusy) {
      return { ok: false, message: translate('scm.notice.anotherOperation') }
    }
    if (operation !== null) {
      return { ok: false, message: translate('scm.merge.operation') }
    }
    setBusy(true)
    try {
      const result = await callApi<GitCommandResultMap['pushTo']>(
        window.icode.git.pushTo({ sessionId, remote, branch: branch.trim() })
      )
      if (!result.ok) return { ok: false, message: result.error.message }
      if (result.value.status !== 'ok') {
        return {
          ok: false,
          message: result.value.detail ?? translate('push.error')
        }
      }
      notify({
        tone: 'success',
        message: translate('push.success', { upstream: result.value.upstream })
      })
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : translate('push.error')
      notify({ tone: 'error', message })
      return { ok: false, message }
    } finally {
      setBusy(false)
      await refresh()
      onChanged()
    }
  }

  /** Explicit fetch from the command palette; auto-fetch stays quiet. */
  const amend = async (): Promise<void> => {
    if (!canAmend || amendBusy || pendingStageRef.current.size > 0) return
    if (protectedBranch) {
      notify({
        tone: 'error',
        message: translate('scm.notice.protectedAmend', {
          branch: snapshot?.branch ?? translate('scm.notice.thisBranch')
        })
      })
      return
    }
    const sentMessage = message
    setAmendBusy(true)
    try {
      const result = await callApi<GitCommitPayload>(
        window.icode.git.amend({
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
        message: translate('scm.notice.amended', {
          oid: result.value.oid,
          subject: result.value.subject ? ` · ${result.value.subject}` : ''
        })
      })
    } finally {
      setAmendBusy(false)
      await refresh()
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
      ? translate('scm.noUncommitted')
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
      case 'merge':
        // The presentation layer opens the merge popover instead.
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
    committed,
    commitCount,
    committedLoading,
    baseNote,
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
    mergeRecord,
    mergeActive: mergeRecord !== null && isActiveMergeRecord(mergeRecord),
    mergeTargets,
    mergeTarget: mergeTargets.target,
    mergeTargetOid: mergeTargets.targetOid,
    mergeTargetLocked: mergeTargets.locked,
    mergeTargetsLoading: mergeTargets.loading,
    mergeTargetsReason,
    reloadMergeTargets: branchRefs.reload,
    mergeMenuEnabled,
    mergeMenuReason,
    pushMenuEnabled,
    pushMenuReason,
    remotes,
    remotesLoading,
    loadRemotes,
    startMerge,
    continueMerge,
    abortMerge,
    pushTo,
    amend,
    runPrimary
  }
}
