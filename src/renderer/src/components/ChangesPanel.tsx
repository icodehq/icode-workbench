import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowUpRight,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  History,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Sparkles,
  TerminalSquare,
  Undo2,
  Upload
} from 'lucide-react'
import type { AgentSendResult } from '../lib/agent-send'
import type { Notice } from '../state/workspace'
import type { HarnessId } from '../../../shared/domain/harness'
import { isAgentHarness } from '../../../shared/domain/harness'
import type { WorkingTreeEntry } from '../review/working-tree'
import { afterAgentSend, useWorkbenchDraft, type WorkbenchDraftStore } from '../review/drafts'
import { useScmController } from '../scm/use-scm-controller'
import { useCommitMessageGeneration } from '../scm/use-commit-message-generation'
import { registerScmCommand, type ScmCommandId } from '../scm/scm-commands'
import AmendDialog from './AmendDialog'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import type { MenuAnchor } from './context-menu-position'
import ScmHistoryView from './ScmHistoryView'
import ScmMergePopover from './ScmMergePopover'
import ScmPushPopover from './ScmPushPopover'
import RepositorySettingsDialog from './RepositorySettingsDialog'
import type { LineComment } from './UnifiedDiffView'
import WorkingTreeView from './WorkingTreeView'
import { useT, useTp } from '../i18n/use-i18n'
import type { ScmMergeRequest } from '../scm/scm-merge'

type Props = {
  sessionId: string
  sessionState: string
  /** The repository that owns this session, used for branch refs and merges. */
  repoId: string
  /** The session's harness; generation is hidden for Shell sessions. */
  harness: HarnessId
  /** The commit this session's worktree was created from. */
  baseOid: string | null
  /** Bumped by the global refresh action; reloads Git status. */
  refreshToken: number
  /** The Source Control tab is visible; hidden panes may hold stale Git status. */
  active: boolean
  notify: (notice: Notice) => void
  /** Opens the selected path in the Files tab. */
  onOpenPath: (path: string) => void
  onOpenTerminal: () => void
  /** Hands line notes to the Agent's own terminal. */
  onSendToAgent: (text: string) => Promise<AgentSendResult>
  canSendToAgent: boolean
  /** Notes and the commit message belong to the session. */
  drafts: WorkbenchDraftStore
  /** Called after a Git operation changed the worktree. */
  onChanged: () => void
  /** A task's shared chain branch, preselected as the merge target. */
  mergeTargetHint?: string | null
  /** Whether the task's dependents force the chain branch target. */
  lockMergeTarget?: boolean
  /** A request from a task's Accept & merge action. */
  mergeRequest?: ScmMergeRequest | null
  onMergeRequestHandled?: () => void
  /** A Files request to open History for one path. */
  initialHistoryPath?: { path: string; nonce: number } | null
  onHistoryPathHandled?: () => void
}

function anchorFor(element: HTMLElement | null): MenuAnchor | null {
  if (element === null) return null
  const rect = element.getBoundingClientRect()
  return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
}

/**
 * Source Control: a VS Code-style SCM sidebar plus the editor/diff area.
 *
 * The controller owns Git state and mutations; this component owns the note
 * draft and the layout. The diff surface still uses the unified renderer until
 * Monaco lands in Phase 5, but its selection, multi-select and batch actions
 * already follow the VS Code model.
 */
export default function ChangesPanel({
  sessionId,
  sessionState,
  repoId,
  harness,
  baseOid,
  refreshToken,
  active,
  notify,
  onOpenPath,
  onOpenTerminal,
  onSendToAgent,
  canSendToAgent,
  drafts,
  onChanged,
  mergeTargetHint = null,
  lockMergeTarget = false,
  mergeRequest = null,
  onMergeRequestHandled,
  initialHistoryPath = null,
  onHistoryPathHandled
}: Props): React.JSX.Element {
  const t = useT()
  const tp = useTp()
  const draft = useWorkbenchDraft(drafts, sessionId)
  const comments = draft.comments
  const controller = useScmController({
    sessionId,
    sessionState,
    repoId,
    baseOid,
    active,
    refreshToken,
    notify,
    drafts,
    onChanged,
    mergeTargetHint,
    lockMergeTarget
  })
  const [sent, setSent] = useState(false)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [commitMenuOpen, setCommitMenuOpen] = useState(false)
  const [commitMenuAnchor, setCommitMenuAnchor] = useState<MenuAnchor | null>(null)
  const [mergePopover, setMergePopover] = useState<{
    anchor: MenuAnchor | null
    target: string | null
    lockTarget: boolean
    nonce: number
  } | null>(null)
  const [pushPopover, setPushPopover] = useState<{
    anchor: MenuAnchor | null
    nonce: number
  } | null>(null)
  const [remoteSettings, setRemoteSettings] = useState<{
    add: boolean
    returnToPush: boolean
    anchor: MenuAnchor | null
    nonce: number
  } | null>(null)
  const primaryButtonRef = useRef<HTMLButtonElement | null>(null)
  const menuButtonRef = useRef<HTMLButtonElement | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyPath, setHistoryPath] = useState('')

  useEffect(() => {
    setHistoryOpen(false)
    setHistoryPath('')
    setCommitMenuOpen(false)
    setMergePopover(null)
    setPushPopover(null)
  }, [sessionId])

  useEffect(() => {
    if (initialHistoryPath === null) return
    setHistoryPath(initialHistoryPath.path)
    setHistoryOpen(true)
    onHistoryPathHandled?.()
  }, [initialHistoryPath, onHistoryPathHandled])

  const {
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
    continueOperation,
    abortOperation,
    commit,
    commitAll,
    runRemoteAction,
    mergeRecord,
    mergeActive,
    mergeTargets,
    reloadMergeTargets,
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
  } = controller

  const openMergePopover = (
    target: string | null,
    lockTarget: boolean,
    anchor: MenuAnchor | null
  ): void => {
    void reloadMergeTargets()
    setMergePopover({ anchor, target, lockTarget, nonce: Date.now() })
  }

  const openPushPopover = (anchor: MenuAnchor | null): void => {
    void loadRemotes()
    setPushPopover({ anchor, nonce: Date.now() })
  }

  /**
   * Repository settings is a modal, so the anchored picker is closed first.
   * When it was opened from Push to…, closing settings returns to the picker
   * with a freshly loaded remote list.
   */
  const openRemoteSettings = (add: boolean): void => {
    const anchor = pushPopover?.anchor ?? anchorFor(menuButtonRef.current)
    setRemoteSettings({
      add,
      returnToPush: pushPopover !== null,
      anchor,
      nonce: Date.now()
    })
    setPushPopover(null)
  }

  const closeRemoteSettings = (): void => {
    const settings = remoteSettings
    setRemoteSettings(null)
    void loadRemotes()
    if (settings?.returnToPush === true) {
      setPushPopover({ anchor: settings.anchor, nonce: Date.now() })
    }
  }

  useEffect(() => {
    if (mergeRequest === null || snapshot === null) return
    void reloadMergeTargets()
    setMergePopover({
      anchor: anchorFor(primaryButtonRef.current) ?? anchorFor(menuButtonRef.current),
      target: mergeRequest.target,
      lockTarget: mergeRequest.lockTarget,
      nonce: mergeRequest.nonce
    })
    onMergeRequestHandled?.()
  }, [mergeRequest, onMergeRequestHandled, reloadMergeTargets, snapshot])

  const generation = useCommitMessageGeneration({
    sessionId,
    harness,
    active,
    stagedCount,
    conflicts: groups.conflicts.length,
    message,
    setMessage
  })

  // The session page answers one question: what has this worktree changed
  // since the commit the session started from? Committed and uncommitted
  // paths are counted once in the headline, while the sidebar keeps the
  // Git-honest per-area rows.
  const committedPaths = new Set((committed ?? []).map((file) => file.path))
  const uncommittedPaths = new Set(
    [...groups.conflicts, ...groups.staged, ...groups.unstaged, ...groups.untracked].map(
      (entry) => entry.entry.path
    )
  )
  const changedPathCount = new Set([...committedPaths, ...uncommittedPaths]).size
  const baseShort = baseOid === null ? null : baseOid.slice(0, 7)
  const sessionSummary =
    snapshot === null
      ? workingSummary
      : changedPathCount === 0
        ? baseShort === null
          ? t('scm.changes.noUncommitted')
          : t('scm.changes.noChangesSince', { base: baseShort })
        : [
            commitCount > 0 ? tp('scm.changes.commits', commitCount) : null,
            tp('scm.changes.filesChanged', changedPathCount, {
              suffix:
                baseShort === null ? '' : t('scm.changes.sinceBase', { base: baseShort })
            }),
            uncommittedCount === 0
              ? t('scm.changes.clean')
              : t('scm.changes.uncommitted', { count: uncommittedCount })
          ]
            .filter((part): part is string => part !== null)
            .join(' · ')
  const summaryText =
    committedLoading && committed === null && snapshot !== null
      ? t('scm.changes.readingWorktree')
      : sessionSummary

  // The command palette is app-global; these handlers make the active session's
  // Git operations reachable from it with VS Code's command ids.
  useEffect(() => {
    const changeEntries = [...groups.unstaged, ...groups.untracked]
    const discardable = [...groups.staged, ...groups.unstaged, ...groups.untracked]
    const register = (
      id: ScmCommandId,
      enabled: boolean,
      reason: string,
      run: () => void
    ): (() => void) =>
      registerScmCommand(id, {
        sessionId,
        enabled,
        ...(enabled ? {} : { disabledReason: reason }),
        run
      })
    const idle = !busy && !commitBusy && !stagePending
    const offs = [
      register(
        'git.commit',
        primary.kind === 'commit' && !primary.disabled && idle,
        primary.reason ?? t('scm.changes.noStagedToCommit'),
        () => void commit(false)
      ),
      register(
        'git.commitAll',
        !protectedBranch &&
          groups.staged.length + groups.unstaged.length + groups.untracked.length > 0 &&
          idle,
        protectedBranch
          ? t('scm.changes.protectedShort')
          : t('scm.changes.noChangesToCommit'),
        () => void commitAll()
      ),
      register('git.refresh', true, '', refresh),
      register(
        'git.stageAll',
        changeEntries.length > 0 && !busy && !stagePending,
        t('scm.changes.noUnstagedToStage'),
        () => void setEntriesStaged(changeEntries, true)
      ),
      register(
        'git.unstageAll',
        groups.staged.length > 0 && !busy && !stagePending,
        t('scm.changes.noStagedToUnstage'),
        () => void setEntriesStaged(groups.staged, false)
      ),
      register(
        'git.discardAll',
        discardable.length > 0 && !busy && !stagePending,
        t('scm.changes.noChangesToDiscard'),
        () => requestDiscard(discardable)
      ),
      register(
        'git.pull',
        snapshot !== null && snapshot.upstream !== null && !busy,
        t('scm.changes.noUpstreamPull'),
        () => void runRemoteAction('pull')
      ),
      register(
        'git.push',
        snapshot !== null && snapshot.upstream !== null && !busy,
        t('scm.changes.noUpstreamPush'),
        () => void runRemoteAction('push')
      ),
      register(
        'git.sync',
        snapshot !== null && snapshot.upstream !== null && !busy,
        t('scm.changes.noUpstreamSync'),
        () => void runRemoteAction('sync')
      ),
      register(
        'git.publish',
        snapshot !== null && snapshot.upstream === null && snapshot.branch !== null && !busy,
        t('scm.changes.alreadyUpstream'),
        () => void runRemoteAction('publish')
      ),
      register(
        'git.merge',
        mergeMenuEnabled && !busy,
        mergeMenuReason,
        () =>
          openMergePopover(
            mergeTargets.target,
            mergeTargets.locked,
            anchorFor(menuButtonRef.current)
          )
      ),
      register('git.pushTo', pushMenuEnabled && !busy, pushMenuReason, () =>
        openPushPopover(anchorFor(menuButtonRef.current))
      ),
      register('git.viewHistory', snapshot !== null, t('scm.changes.gitUnavailable'), () =>
        setHistoryOpen(true)
      ),
      register(
        'git.continueOperation',
        operation !== null && !busy,
        t('scm.changes.noOperation'),
        () => void continueOperation()
      ),
      register(
        'git.abortOperation',
        (operation !== null || mergeActive) && !busy,
        t('scm.changes.noOperation'),
        () => void abortOperation()
      )
    ]
    return () => {
      for (const off of offs) off()
    }
  }, [
    abortOperation,
    busy,
    commit,
    commitAll,
    commitBusy,
    continueOperation,
    groups,
    mergeActive,
    mergeMenuEnabled,
    mergeMenuReason,
    mergeTargets,
    operation,
    openMergePopover,
    openPushPopover,
    primary,
    protectedBranch,
    pushMenuEnabled,
    pushMenuReason,
    refresh,
    requestDiscard,
    runRemoteAction,
    sessionId,
    setEntriesStaged,
    snapshot,
    stagePending
  ])

  const updateComments = useCallback(
    (updater: (current: LineComment[]) => LineComment[]): void => {
      drafts.update(sessionId, (current) => ({
        ...current,
        comments: updater(current.comments)
      }))
    },
    [drafts, sessionId]
  )

  const onAddComment = (comment: Omit<LineComment, 'id'>): void => {
    updateComments((current) => [
      ...current,
      {
        ...comment,
        id: `${comment.path}:${comment.side}:${String(comment.line)}:${String(current.length)}`
      }
    ])
  }
  const onRemoveComment = (id: string): void => {
    updateComments((current) => current.filter((comment) => comment.id !== id))
  }

  const formatComments = (notes: LineComment[]): string => {
    const lines = notes.map(
      (note) =>
        `- ${note.path}:${String(note.line)}${note.side === 'old' ? ' (removed line)' : ''} — ${note.text}`
    )
    return `Line notes on these changes:\n${lines.join('\n')}`
  }

  const finishSend = (): void => {
    setSent(true)
    window.setTimeout(() => setSent(false), 2500)
  }

  const sendComments = async (): Promise<void> => {
    if (comments.length === 0 || sending) return
    const sendingIds = new Set(comments.map((comment) => comment.id))
    const payload = formatComments(comments)
    setSending(true)
    setSendError(null)
    let result: AgentSendResult
    try {
      result = await onSendToAgent(payload)
    } catch (error) {
      result = {
        ok: false,
        message: error instanceof Error
          ? error.message
          : t('scm.changes.notesNotAccepted')
      }
    }
    setSending(false)
    if (!result.ok) {
      setSendError(result.message)
      return
    }
    // Only the notes that were actually sent leave the draft. A note added while
    // the terminal was busy is still the user's.
    drafts.update(sessionId, (current) =>
      afterAgentSend(current, { commentIds: sendingIds }, result)
    )
    finishSend()
  }

  const discardLabel =
    discardTargets === null
      ? ''
      : discardTargets.length === 1
        ? (discardTargets[0]?.entry.path ?? '')
        : tp('scm.changes.discardLabel.path', discardTargets.length)

  const partialStaged = groups.staged.some((staged) =>
    groups.unstaged.some((unstaged) => unstaged.entry.path === staged.entry.path)
  )

  const commitMenuItems: ContextMenuItem[] = [
    {
      id: 'amend',
      label: t('scm.changes.menu.amend'),
      icon: <Undo2 size={10} />,
      disabled: !canAmend,
      reason:
        snapshot?.headOid === null
          ? t('scm.changes.amendNoHead')
          : stagedCount === 0 && message.trim().length === 0
            ? t('scm.changes.amendNothing')
            : t('scm.changes.amendReason'),
      testId: 'git-amend',
      onSelect: () => {
        setCommitMenuOpen(false)
        setAmendOpen(true)
      }
    },
    {
      id: 'commit-all',
      label: t('scm.changes.menu.commitAll'),
      icon: <GitCommitHorizontal size={10} />,
      disabled:
        message.trim().length === 0 ||
        groups.conflicts.length > 0 ||
        (stagedCount === 0 && groups.unstaged.length === 0) ||
        commitBusy ||
        busy ||
        stagePending,
      reason:
        message.trim().length === 0
          ? t('scm.changes.commitAllNoMessage')
          : groups.conflicts.length > 0
            ? t('scm.changes.commitAllConflicts')
            : stagedCount === 0 && groups.unstaged.length === 0
              ? t('scm.changes.commitAllNothing')
              : t('scm.changes.commitAllReason'),
      testId: 'git-commit-all',
      onSelect: () => {
        setCommitMenuOpen(false)
        void commitAll()
      }
    },
    {
      id: 'commit-push',
      label: t('scm.changes.menu.commitPush'),
      icon: <ArrowUpRight size={10} />,
      disabled:
        primary.kind !== 'commit' ||
        primary.disabled ||
        !snapshot?.upstream ||
        commitBusy ||
        stagePending,
      reason: snapshot?.upstream
        ? primary.reason
        : t('scm.changes.commitPushNoUpstream'),
      testId: 'git-commit-push',
      onSelect: () => {
        setCommitMenuOpen(false)
        void commit(true)
      }
    },
    {
      id: 'merge',
      label: t('scm.changes.menu.merge'),
      icon: <GitMerge size={10} />,
      disabled: !mergeMenuEnabled,
      reason: mergeMenuReason,
      separatorBefore: true,
      testId: 'git-merge',
      onSelect: () => {
        setCommitMenuOpen(false)
        openMergePopover(
          mergeTargets.target,
          mergeTargets.locked,
          anchorFor(menuButtonRef.current)
        )
      }
    },
    {
      id: 'push-to',
      label: t('scm.changes.menu.pushTo'),
      icon: <Upload size={10} />,
      disabled: !pushMenuEnabled,
      reason: pushMenuReason,
      testId: 'git-push-to',
      onSelect: () => {
        setCommitMenuOpen(false)
        openPushPopover(anchorFor(menuButtonRef.current))
      }
    },
    {
      id: 'pull',
      label: t('scm.changes.menu.pull'),
      icon: <RefreshCw size={10} />,
      disabled: !snapshot?.upstream || busy,
      reason: snapshot?.upstream
        ? t('scm.changes.pullReason')
        : t('scm.changes.pushNoUpstream'),
      testId: 'git-pull',
      onSelect: () => {
        setCommitMenuOpen(false)
        void runRemoteAction('pull')
      }
    },
    {
      id: 'terminal',
      label: t('scm.changes.menu.openTerminal'),
      icon: <TerminalSquare size={10} />,
      separatorBefore: true,
      onSelect: () => {
        setCommitMenuOpen(false)
        onOpenTerminal()
      }
    }
  ]

  const header = (
    <div
      className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card px-5"
      data-testid="scm-session-strip"
    >
      <GitBranch size={12} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 max-w-[220px] truncate font-mono text-[10.5px] text-foreground">
        {snapshot?.branch ??
          (loading ? t('scm.changes.readingBranch') : t('scm.changes.noBranch'))}
      </span>
      {baseShort !== null ? (
        <span className="shrink-0 font-mono text-[9px] text-muted-foreground">
          base {baseShort}
        </span>
      ) : null}
      <span className="h-3 w-px shrink-0 bg-border" />
      <span
        className="min-w-0 truncate text-[10.5px] text-muted-foreground"
        data-testid="review-count"
        data-commit-count={commitCount}
        data-committed-files={committed?.length ?? 0}
        title={baseNote.length > 0 ? baseNote : t('scm.changes.baseTitle')}
      >
        {summaryText}
      </span>
      {groups.conflicts.length > 0 ? (
        <span className="inline-flex shrink-0 items-center gap-0.5 text-[9px] text-destructive">
          <AlertTriangle size={9} />
          {tp('scm.changes.conflicts', groups.conflicts.length)}
        </span>
      ) : null}
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {sent ? (
          <span className="text-[10px] text-add" data-testid="review-notes-sent">
            {t('scm.changes.sent')}
          </span>
        ) : null}
        {comments.length > 0 ? (
          <>
            <span className="text-[10px] text-signal">
              {tp('scm.changes.draftNotes', comments.length)}
            </span>
            <button
              type="button"
              className="inline-flex h-7 items-center gap-2 rounded-md border border-add/40 px-2 text-[10.5px] text-foreground hover:bg-add-weak disabled:opacity-40"
              onClick={() => void sendComments()}
              disabled={!canSendToAgent || sending}
              data-testid="review-line-comments-send"
              title={
                canSendToAgent
                  ? t('scm.changes.sendTitle')
                  : t('scm.changes.sendDisabled')
              }
            >
              {tp('scm.changes.sendNotes', comments.length)}
            </button>
          </>
        ) : null}
        <button
          type="button"
          className={`inline-flex h-7 items-center gap-1 rounded border px-2 text-[10px] ${
            historyOpen
              ? 'border-info/50 bg-info-weak text-info'
              : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
          onClick={() => {
            if (historyOpen) {
              setHistoryOpen(false)
              setHistoryPath('')
            } else {
              setHistoryPath('')
              setHistoryOpen(true)
            }
          }}
          aria-pressed={historyOpen}
          title={t('scm.changes.historyOpenTitle')}
          data-testid="scm-history-open"
        >
          <History size={10} />
          {t('scm.changes.history')}
        </button>
        <span className="font-mono text-[9px] text-muted-foreground">
          {watchMode === 'watch'
            ? t('scm.changes.watched')
            : watchMode === 'poll'
              ? t('scm.changes.polling')
              : ''}
        </span>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-2 rounded-md border border-border px-2 text-[10.5px] hover:bg-muted disabled:opacity-40"
          onClick={refresh}
          disabled={loading}
          data-testid="review-refresh"
        >
          <RefreshCw size={10} className={loading ? 'animate-spin' : ''} />
          {t('scm.changes.refresh')}
        </button>
      </span>
    </div>
  )

  const operationBanner =
    mergeActive && mergeRecord !== null ? (
      <div
        className="shrink-0 border-b border-signal/40 bg-signal-weak px-2.5 py-1.5"
        data-testid="scm-operation-banner"
        data-merge-state={mergeRecord.state}
      >
        <div className="flex items-center gap-1.5 text-[10px] text-signal">
          <AlertTriangle size={10} />
          <strong className="tracking-wide">
            {t('scm.merge.banner', {
              source: mergeRecord.sourceBranch,
              target: mergeRecord.targetBranch
            })}
          </strong>
          <span className="text-foreground">
            {mergeRecord.state === 'running'
              ? t('scm.merge.running')
              : t('merge.conflictTitle')}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-1">
          <button
            type="button"
            className="inline-flex h-6 items-center rounded border border-border px-2 text-[10px] text-foreground hover:bg-card disabled:opacity-40"
            disabled={
              busy ||
              mergeRecord.state !== 'conflicted' ||
              operation !== 'merge' ||
              groups.conflicts.length > 0
            }
            title={
              groups.conflicts.length > 0
                ? t('scm.changes.continueBlocked')
                : mergeRecord.state !== 'conflicted' || operation !== 'merge'
                  ? t('scm.merge.continueBlocked')
                  : t('scm.merge.continueTitle', { target: mergeRecord.targetBranch })
            }
            data-testid="scm-operation-continue"
            onClick={() => void continueMerge()}
          >
            {t('scm.changes.continue')}
          </button>
          <button
            type="button"
            className="inline-flex h-6 items-center rounded border border-destructive/50 px-2 text-[10px] text-destructive hover:bg-destructive/10 disabled:opacity-40"
            disabled={busy}
            title={t('scm.merge.abortTitle', { target: mergeRecord.targetBranch })}
            data-testid="scm-operation-abort"
            onClick={() => void abortMerge()}
          >
            {t('scm.changes.abort')}
          </button>
          {groups.conflicts.length > 0 ? (
            <span className="ml-auto text-[9px] text-destructive">
              {tp('scm.changes.conflicts', groups.conflicts.length)}
            </span>
          ) : null}
        </div>
      </div>
    ) : operation !== null ? (
      <div
        className="shrink-0 border-b border-signal/40 bg-signal-weak px-2.5 py-1.5"
        data-testid="scm-operation-banner"
      >
        <div className="flex items-center gap-1.5 text-[10px] text-signal">
          <AlertTriangle size={10} />
          <strong className="uppercase tracking-wide">{operation}</strong>
          <span className="text-foreground">{t('scm.changes.inProgress')}</span>
        </div>
        <div className="mt-1 flex items-center gap-1">
          <button
            type="button"
            className="inline-flex h-6 items-center rounded border border-border px-2 text-[10px] text-foreground hover:bg-card disabled:opacity-40"
            disabled={busy || groups.conflicts.length > 0}
            title={
              groups.conflicts.length > 0
                ? t('scm.changes.continueBlocked')
                : t('scm.changes.continueTitle', { operation })
            }
            data-testid="scm-operation-continue"
            onClick={() => void continueOperation()}
          >
            {t('scm.changes.continue')}
          </button>
          <button
            type="button"
            className="inline-flex h-6 items-center rounded border border-destructive/50 px-2 text-[10px] text-destructive hover:bg-destructive/10 disabled:opacity-40"
            disabled={busy}
            title={t('scm.changes.abortTitle', { operation })}
            data-testid="scm-operation-abort"
            onClick={() => void abortOperation()}
          >
            {t('scm.changes.abort')}
          </button>
          {groups.conflicts.length > 0 ? (
            <span className="ml-auto text-[9px] text-destructive">
              {tp('scm.changes.conflicts', groups.conflicts.length)}
            </span>
          ) : null}
        </div>
      </div>
    ) : null

  const statusBlock =
    snapshot !== null ? (
      <div
        className="shrink-0 border-b border-border bg-card px-2.5 py-2"
        data-testid="changes-commitbar"
      >
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 items-baseline gap-2">
            <strong className="text-[11px] text-foreground" data-testid="staged-count">
              {t('scm.changes.staged', { count: stagedCount })}
            </strong>
            <span className="text-[10px] text-muted-foreground">
              {t('scm.changes.uncommitted', { count: uncommittedCount })}
            </span>
          </div>
          {isAgentHarness(harness) ? (
            <span
              className="ml-auto shrink-0"
              title={
                generation.disabledReason || t('scm.changes.generateTitle')
              }
            >
              {generation.status === 'generating' ? (
                <button
                  type="button"
                  className="inline-flex h-6 items-center gap-1 rounded border border-border px-1.5 text-[9.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={generation.cancel}
                  data-testid="scm-generate-cancel"
                >
                  <Loader2 size={9} className="animate-spin" />
                  {t('scm.changes.cancel')}
                </button>
              ) : (
                <button
                  type="button"
                  className="inline-flex h-6 items-center gap-1 rounded border border-info/40 bg-info-weak px-1.5 text-[9.5px] text-foreground hover:bg-info/15 disabled:opacity-40"
                  onClick={generation.generate}
                  disabled={!generation.canGenerate}
                  title={
                    generation.disabledReason || t('scm.changes.generateTitle')
                  }
                  data-testid="scm-generate-message"
                >
                  <Sparkles size={9} />
                  {t('scm.changes.generate')}
                </button>
              )}
            </span>
          ) : null}
        </div>
        {generation.note.length > 0 ? (
          <p className="mt-1 text-[9.5px] text-add" data-testid="scm-generate-note">
            {generation.note}
          </p>
        ) : null}
        {generation.error !== null ? (
          <p className="mt-1 text-[9.5px] text-destructive" data-testid="scm-generate-error">
            {generation.error}
          </p>
        ) : null}
        {protectedBranch ? (
          <p
            className="mt-1 rounded border border-signal-line bg-signal-weak px-1.5 py-1 text-[9.5px] text-signal"
            role="status"
            data-testid="scm-protected-branch"
          >
            {t('scm.changes.protected')}
          </p>
        ) : null}
        <textarea
          value={message}
          rows={3}
          placeholder={
            groups.conflicts.length > 0
              ? t('scm.changes.messageConflicts')
              : stagedCount === 0
                ? t('scm.changes.messageStageFirst')
                : t('scm.changes.messageStagedOnly')
          }
          className="mt-1.5 h-16 w-full min-w-0 resize-none rounded border border-border bg-transparent px-2 py-1 font-mono text-[11.5px] text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
          data-testid="git-commit-message"
          disabled={groups.conflicts.length > 0}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault()
              if (primary.disabled || commitBusy || busy || stagePending) return
              if (primary.kind === 'merge') {
                openMergePopover(
                  primary.target,
                  primary.locked,
                  anchorFor(primaryButtonRef.current)
                )
                return
              }
              runPrimary()
            }
          }}
        />
        {generation.status === 'replace' ? (
          <div
            className="mt-1.5 rounded border border-info/40 bg-info-weak px-2 py-1 text-[9.5px] text-foreground"
            data-testid="scm-generate-replace"
          >
<p className="truncate">{t('scm.changes.replacePrompt')}</p>
            <div className="mt-1 flex items-center gap-1">
              <button
                type="button"
                className="rounded border border-info/50 px-1.5 py-0.5 text-[9.5px] text-info hover:bg-info/15"
                onClick={generation.applyPending}
                data-testid="scm-generate-apply"
              >
                {t('scm.changes.replace')}
              </button>
              <button
                type="button"
                className="rounded border border-border px-1.5 py-0.5 text-[9.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={generation.dismissPending}
                data-testid="scm-generate-dismiss"
              >
                {t('scm.changes.keepDraft')}
              </button>
            </div>
          </div>
        ) : null}
        {partialStaged ? (
          <p className="mt-1 text-[9.5px] text-info">
            {t('scm.changes.partialStaged')}
          </p>
        ) : null}
        <div className="relative mt-1.5 flex items-center gap-1">
          <button
            ref={primaryButtonRef}
            type="button"
            className="inline-flex h-7 min-w-0 flex-1 items-center justify-center gap-1 rounded-md border border-add/50 bg-add-weak px-2 text-[11px] text-foreground hover:bg-add/20 disabled:opacity-40"
            onClick={() => {
              if (primary.kind === 'merge' && !primary.disabled) {
                openMergePopover(
                  primary.target,
                  primary.locked,
                  anchorFor(primaryButtonRef.current)
                )
                return
              }
              runPrimary()
            }}
            disabled={primary.disabled || commitBusy || busy || stagePending}
            title={primary.reason}
            data-testid="git-commit"
          >
            {commitBusy || busy ? (
              <Loader2 size={10} className="animate-spin" />
            ) : primary.kind === 'commit' ? (
              <GitCommitHorizontal size={10} />
            ) : primary.kind === 'merge' ? (
              <GitMerge size={10} />
            ) : (
              <ArrowUpRight size={10} />
            )}
            <span className="truncate">{primary.label}</span>
          </button>
          <button
            ref={menuButtonRef}
            type="button"
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t('scm.changes.actions')}
            aria-expanded={commitMenuOpen}
            title={t('scm.changes.actions')}
            data-testid="git-commit-menu-button"
            onClick={(event) => {
              setCommitMenuAnchor(anchorFor(event.currentTarget))
              setCommitMenuOpen((current) => !current)
            }}
          >
            <MoreHorizontal size={12} />
          </button>
        </div>
        <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
          {t('scm.changes.commitsOnly')} {primary.disabled ? primary.reason : ''}
        </p>
      </div>
    ) : loading ? (
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2.5 text-[10.5px] text-muted-foreground">
        <Loader2 size={11} className="animate-spin" />
        {t('scm.changes.reading')}
      </div>
    ) : (
      <div
        className="shrink-0 border-b border-border bg-card px-3 py-2.5 text-[10.5px] text-signal"
        data-testid="changes-git-unavailable"
      >
        {note || t('scm.changes.unavailable')}
      </div>
    )

  const discardBar =
    discardTargets !== null ? (
      <div
        className="flex shrink-0 flex-wrap items-center gap-2 border-b border-destructive/40 bg-destructive/10 px-3 py-1.5 text-[10.5px] text-destructive"
        data-testid="change-discard-confirm"
      >
        <AlertTriangle size={11} />
        <span className="min-w-0 flex-1">
          {t('scm.changes.discard', { label: discardLabel })}
        </span>
        <button
          type="button"
          className="rounded border border-destructive/60 px-2 py-0.5 text-[10.5px] text-destructive hover:bg-destructive/15 disabled:opacity-40"
          disabled={busy}
          data-testid="change-discard-yes"
          onClick={() => void confirmDiscard()}
        >
          {t('scm.changes.discardAction')}
        </button>
        <button
          type="button"
          className="rounded border border-border px-2 py-0.5 text-[10.5px] text-foreground hover:bg-muted"
          disabled={busy}
          data-testid="change-discard-cancel"
          onClick={cancelDiscard}
        >
          {t('common.cancel')}
        </button>
      </div>
    ) : null

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-testid="changes-panel"
      data-phase={loading ? 'loading' : snapshot === null ? 'error' : 'ready'}
      data-watch-mode={watchMode}
      data-session-id={sessionId}
      data-session-state={sessionState}
    >
      {header}
      {snapshot?.didHitLimit ? (
        <div
          className="flex items-start gap-1.5 border-b border-signal/40 bg-signal-weak px-3 py-1 text-[10.5px] leading-relaxed text-foreground"
          data-testid="changes-status-limit"
        >
          <AlertTriangle size={11} className="mt-0.5 shrink-0 text-signal" />
          <span>
            {t('scm.changes.tooMany', { count: snapshot.statusLength ?? 0 })}
          </span>
        </div>
      ) : null}
      {sendError ? (
        <div
          className="flex items-start gap-1.5 border-b border-destructive/40 bg-destructive/10 px-3 py-1 text-[10.5px] leading-relaxed text-destructive"
          data-testid="review-send-error"
        >
          <AlertTriangle size={11} className="mt-0.5 shrink-0" />
          <span>{t('scm.changes.noteKept', { error: sendError })}</span>
        </div>
      ) : null}
      {discardBar}
      <WorkingTreeView
        sessionId={sessionId}
        sessionState={sessionState}
        baseOid={baseOid}
        committed={committed}
        snapshot={snapshot}
        loading={loading}
        active={active}
        refreshToken={refreshToken}
        diffTick={diffTick}
        watchActive={watchMode === 'watch'}
        onStage={(path) => setPathStaged(path, true)}
        onUnstage={(path) => setPathStaged(path, false)}
        onStageEntries={(entries) => void setEntriesStaged(entries, true)}
        onUnstageEntries={(entries) => void setEntriesStaged(entries, false)}
        onDiscardEntries={(entries) => requestDiscard(entries)}
        onDiscard={(entry: WorkingTreeEntry) => requestDiscard([entry])}
        onApplyHunk={(path, patch, mode) => applyHunk(path, patch, mode)}
        onResolveConflict={(path, text) => resolveConflict(path, text)}
        onOpenPath={onOpenPath}
        onOpenTerminal={onOpenTerminal}
        sidebarHeader={
          <>
            {operationBanner}
            {statusBlock}
          </>
        }
        editorOverride={
          historyOpen ? (
            <ScmHistoryView
              sessionId={sessionId}
              baseOid={baseOid}
              notify={notify}
              onClose={() => {
                setHistoryOpen(false)
                setHistoryPath('')
              }}
              initialPath={historyPath}
              onChanged={refresh}
            />
          ) : null
        }
        comments={comments}
        onAddComment={onAddComment}
        onRemoveComment={onRemoveComment}
      />

      {commitMenuOpen && commitMenuAnchor !== null ? (
        <ContextMenu
          items={commitMenuItems}
          anchor={commitMenuAnchor}
          align="end"
          width={264}
          testId="git-commit-menu"
          ariaLabel={t('scm.changes.actions')}
          opener={menuButtonRef.current}
          onClose={() => setCommitMenuOpen(false)}
        />
      ) : null}

      {mergePopover !== null ? (
        <ScmMergePopover
          key={mergePopover.nonce}
          anchor={mergePopover.anchor}
          opener={primaryButtonRef.current ?? menuButtonRef.current}
          sourceBranch={snapshot?.branch ?? null}
          resolution={mergeTargets}
          initialTarget={mergePopover.target}
          lockTarget={mergePopover.lockTarget}
          clean={uncommittedCount === 0}
          onClose={() => setMergePopover(null)}
          onSubmit={startMerge}
        />
      ) : null}

      {pushPopover !== null ? (
        <ScmPushPopover
          key={pushPopover.nonce}
          anchor={pushPopover.anchor}
          opener={menuButtonRef.current}
          remotes={remotes}
          remotesLoading={remotesLoading}
          upstream={snapshot?.upstream ?? null}
          localBranch={snapshot?.branch ?? null}
          headOid={snapshot?.headOid ?? null}
          onClose={() => setPushPopover(null)}
          onSubmit={pushTo}
          onAddRemote={() => openRemoteSettings(true)}
          onManageRemotes={() => openRemoteSettings(false)}
        />
      ) : null}

      {remoteSettings !== null ? (
        <RepositorySettingsDialog
          key={remoteSettings.nonce}
          repoId={repoId}
          initialAdd={remoteSettings.add}
          onClose={closeRemoteSettings}
        />
      ) : null}

      {amendOpen ? (
        <AmendDialog
          message={message}
          hasStaged={stagedCount > 0}
          busy={amendBusy}
          onCancel={() => setAmendOpen(false)}
          onConfirm={() => void amend()}
        />
      ) : null}
    </div>
  )
}
