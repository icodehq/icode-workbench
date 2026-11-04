import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  GitBranch,
  GitCommitHorizontal,
  History,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  TerminalSquare,
  Undo2
} from 'lucide-react'
import type { AgentSendResult } from '../lib/agent-send'
import type { Notice } from '../state/workspace'
import type { WorkingTreeEntry } from '../review/working-tree'
import { afterAgentSend, useWorkbenchDraft, type WorkbenchDraftStore } from '../review/drafts'
import { useScmController } from '../scm/use-scm-controller'
import { registerScmCommand, type ScmCommandId } from '../scm/scm-commands'
import AmendDialog from './AmendDialog'
import ScmHistoryView from './ScmHistoryView'
import type { LineComment } from './UnifiedDiffView'
import WorkingTreeView from './WorkingTreeView'

type Props = {
  sessionId: string
  sessionState: string
  /** Bumped by the global refresh action; reloads Git status. */
  refreshToken: number
  /** Bumped when the header branch menu changed the checkout. */
  gitRevision: number
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
  /** A Files request to open History for one path. */
  initialHistoryPath?: { path: string; nonce: number } | null
  onHistoryPathHandled?: () => void
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${String(count)} ${count === 1 ? singular : pluralForm}`
}

function MenuAction({
  label,
  children,
  disabled = false,
  title,
  testId,
  onClick
}: {
  label: string
  children: React.ReactNode
  disabled?: boolean
  title?: string
  testId?: string
  onClick?: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
      disabled={disabled}
      title={title}
      data-testid={testId}
      onClick={onClick}
    >
      {children}
      {label}
    </button>
  )
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
  refreshToken,
  gitRevision,
  active,
  notify,
  onOpenPath,
  onOpenTerminal,
  onSendToAgent,
  canSendToAgent,
  drafts,
  onChanged,
  initialHistoryPath = null,
  onHistoryPathHandled
}: Props): React.JSX.Element {
  const draft = useWorkbenchDraft(drafts, sessionId)
  const comments = draft.comments
  const controller = useScmController({
    sessionId,
    sessionState,
    active,
    refreshToken,
    gitRevision,
    notify,
    drafts,
    onChanged
  })
  const [sent, setSent] = useState(false)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [commitMenuOpen, setCommitMenuOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyPath, setHistoryPath] = useState('')

  useEffect(() => {
    setHistoryOpen(false)
    setHistoryPath('')
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
    continueOperation,
    abortOperation,
    commit,
    commitAll,
    runRemoteAction,
    fetchNow,
    amend,
    runPrimary
  } = controller

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
        primary.reason ?? 'No staged changes to commit',
        () => void commit(false)
      ),
      register(
        'git.commitAll',
        !protectedBranch &&
          groups.staged.length + groups.unstaged.length + groups.untracked.length > 0 &&
          idle,
        protectedBranch ? 'This branch is protected by Settings' : 'No changes to commit',
        () => void commitAll()
      ),
      register('git.refresh', true, '', refresh),
      register(
        'git.stageAll',
        changeEntries.length > 0 && !busy && !stagePending,
        'No unstaged changes to stage',
        () => void setEntriesStaged(changeEntries, true)
      ),
      register(
        'git.unstageAll',
        groups.staged.length > 0 && !busy && !stagePending,
        'No staged changes to unstage',
        () => void setEntriesStaged(groups.staged, false)
      ),
      register(
        'git.discardAll',
        discardable.length > 0 && !busy && !stagePending,
        'No changes to discard',
        () => requestDiscard(discardable)
      ),
      register(
        'git.fetch',
        snapshot !== null && snapshot.upstream !== null && !busy,
        'No upstream branch to fetch from',
        () => void fetchNow()
      ),
      register(
        'git.pull',
        snapshot !== null && snapshot.upstream !== null && !busy,
        'No upstream branch to pull from',
        () => void runRemoteAction('pull')
      ),
      register(
        'git.push',
        snapshot !== null && snapshot.upstream !== null && !busy,
        'No upstream branch to push to',
        () => void runRemoteAction('push')
      ),
      register(
        'git.sync',
        snapshot !== null && snapshot.upstream !== null && !busy,
        'No upstream branch to sync with',
        () => void runRemoteAction('sync')
      ),
      register(
        'git.publish',
        snapshot !== null && snapshot.upstream === null && snapshot.branch !== null && !busy,
        'This branch already has an upstream',
        () => void runRemoteAction('publish')
      ),
      register('git.viewHistory', snapshot !== null, 'Git state is unavailable', () =>
        setHistoryOpen(true)
      ),
      register(
        'git.continueOperation',
        operation !== null && !busy,
        'No merge, rebase or cherry-pick in progress',
        () => void continueOperation()
      ),
      register(
        'git.abortOperation',
        operation !== null && !busy,
        'No merge, rebase or cherry-pick in progress',
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
    fetchNow,
    groups,
    operation,
    primary,
    protectedBranch,
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
        message: error instanceof Error ? error.message : 'The terminal did not accept the notes.'
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
        : plural(discardTargets.length, 'changed path')

  const partialStaged = groups.staged.some((staged) =>
    groups.unstaged.some((unstaged) => unstaged.entry.path === staged.entry.path)
  )

  const header = (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card px-5">
      <span
        className="min-w-0 truncate text-[10.5px] text-muted-foreground"
        data-testid="review-count"
        title="Uncommitted Git state"
      >
        {workingSummary}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {sent ? (
          <span className="text-[10px] text-add" data-testid="review-notes-sent">
            Sent
          </span>
        ) : null}
        {comments.length > 0 ? (
          <span className="text-[10px] text-signal">{plural(comments.length, 'draft note')}</span>
        ) : null}
        <button
          type="button"
          className="inline-flex h-7 items-center gap-2 rounded-md border border-add/40 px-2 text-[10.5px] text-foreground hover:bg-add-weak disabled:opacity-40"
          onClick={() => void sendComments()}
          disabled={!canSendToAgent || comments.length === 0 || sending}
          data-testid="review-line-comments-send"
          title={
            canSendToAgent
              ? 'Send the line notes to the Agent terminal'
              : 'This session cannot receive notes.'
          }
        >
          {comments.length > 0 ? `Send ${plural(comments.length, 'note')}` : 'Send notes'}
        </button>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-2 rounded-md border border-border px-2 text-[10.5px] hover:bg-muted disabled:opacity-40"
          onClick={refresh}
          disabled={loading}
          data-testid="review-refresh"
        >
          <RefreshCw size={10} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </span>
    </div>
  )

  // Repository header: the one fact VS Code puts above the commit box. It is
  // compact because the tab header already carries the global summary.
  const repoHeader = (
    <div
      className="flex min-h-8 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-card px-2.5 py-1 text-[10.5px]"
      data-testid="scm-repo-header"
    >
      <GitBranch size={12} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate font-medium text-foreground">
        {snapshot?.branch ?? (loading ? 'Reading branch…' : 'No branch')}
      </span>
      {snapshot?.upstream ? (
        <span className="min-w-0 truncate font-mono text-[9px] text-muted-foreground">
          {snapshot.upstream}
        </span>
      ) : snapshot !== null ? (
        <span className="text-[9px] text-muted-foreground">no upstream</span>
      ) : null}
      {(snapshot?.ahead ?? 0) > 0 ? (
        <span
          className="inline-flex items-center gap-0.5 text-[9px] text-info"
          title="Commits to push"
          data-testid="scm-repo-ahead"
        >
          <ArrowUp size={9} />
          {String(snapshot?.ahead ?? 0)}
        </span>
      ) : null}
      {(snapshot?.behind ?? 0) > 0 ? (
        <span
          className="inline-flex items-center gap-0.5 text-[9px] text-signal"
          title="Commits to pull"
          data-testid="scm-repo-behind"
        >
          <ArrowDown size={9} />
          {String(snapshot?.behind ?? 0)}
        </span>
      ) : null}
      {operation ? (
        <span className="rounded-full border border-signal-line bg-signal-weak px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-signal">
          {operation}
        </span>
      ) : null}
      {groups.conflicts.length > 0 ? (
        <span className="inline-flex items-center gap-0.5 text-[9px] text-destructive">
          <AlertTriangle size={9} />
          {String(groups.conflicts.length)} conflict{groups.conflicts.length === 1 ? '' : 's'}
        </span>
      ) : null}
      <button
        type="button"
        className={`ml-auto inline-flex h-6 items-center gap-1 rounded border px-1.5 text-[9.5px] ${
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
        title="Browse commits in this worktree"
        data-testid="scm-history-open"
      >
        <History size={10} />
        History
      </button>
      <span className="font-mono text-[9px] text-muted-foreground">
        {watchMode === 'watch' ? 'watched' : watchMode === 'poll' ? 'polling' : ''}
      </span>
    </div>
  )

  const operationBanner =
    operation !== null ? (
      <div
        className="shrink-0 border-b border-signal/40 bg-signal-weak px-2.5 py-1.5"
        data-testid="scm-operation-banner"
      >
        <div className="flex items-center gap-1.5 text-[10px] text-signal">
          <AlertTriangle size={10} />
          <strong className="uppercase tracking-wide">{operation}</strong>
          <span className="text-foreground">in progress</span>
        </div>
        <div className="mt-1 flex items-center gap-1">
          <button
            type="button"
            className="inline-flex h-6 items-center rounded border border-border px-2 text-[10px] text-foreground hover:bg-card disabled:opacity-40"
            disabled={busy || groups.conflicts.length > 0}
            title={
              groups.conflicts.length > 0
                ? 'Resolve conflicts before continuing.'
                : `Continue the ${operation}.`
            }
            data-testid="scm-operation-continue"
            onClick={() => void continueOperation()}
          >
            Continue
          </button>
          <button
            type="button"
            className="inline-flex h-6 items-center rounded border border-destructive/50 px-2 text-[10px] text-destructive hover:bg-destructive/10 disabled:opacity-40"
            disabled={busy}
            title={`Abort the ${operation} and return to the previous state.`}
            data-testid="scm-operation-abort"
            onClick={() => void abortOperation()}
          >
            Abort
          </button>
          {groups.conflicts.length > 0 ? (
            <span className="ml-auto text-[9px] text-destructive">
              {groups.conflicts.length} conflict{groups.conflicts.length === 1 ? '' : 's'}
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
        <div className="flex items-baseline gap-2">
          <strong className="text-[11px] text-foreground" data-testid="staged-count">
            {String(stagedCount)} staged
          </strong>
          <span className="text-[10px] text-muted-foreground">
            {String(uncommittedCount)} uncommitted
          </span>
        </div>
        {protectedBranch ? (
          <p
            className="mt-1 rounded border border-signal-line bg-signal-weak px-1.5 py-1 text-[9.5px] text-signal"
            role="status"
            data-testid="scm-protected-branch"
          >
            This branch is protected by Settings. Commit and amend are disabled.
          </p>
        ) : null}
        <textarea
          value={message}
          rows={3}
          placeholder={
            groups.conflicts.length > 0
              ? 'Resolve conflicts before writing a commit message'
              : stagedCount === 0
                ? 'Commit message (stage files first)'
                : 'Commit message (staged files only)'
          }
          className="mt-1.5 h-16 w-full min-w-0 resize-none rounded border border-border bg-transparent px-2 py-1 font-mono text-[11.5px] text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
          data-testid="git-commit-message"
          disabled={groups.conflicts.length > 0}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault()
              if (!primary.disabled && !commitBusy && !busy && !stagePending) runPrimary()
            }
          }}
        />
        {partialStaged ? (
          <p className="mt-1 text-[9.5px] text-info">
            Only the staged side is committed for partially staged files.
          </p>
        ) : null}
        <div className="relative mt-1.5 flex items-center gap-1">
          <button
            type="button"
            className="inline-flex h-7 min-w-0 flex-1 items-center justify-center gap-1 rounded-md border border-add/50 bg-add-weak px-2 text-[11px] text-foreground hover:bg-add/20 disabled:opacity-40"
            onClick={runPrimary}
            disabled={primary.disabled || commitBusy || busy || stagePending}
            title={primary.reason}
            data-testid="git-commit"
          >
            {commitBusy || busy ? (
              <Loader2 size={10} className="animate-spin" />
            ) : primary.kind === 'commit' ? (
              <GitCommitHorizontal size={10} />
            ) : (
              <ArrowUpRight size={10} />
            )}
            <span className="truncate">{primary.label}</span>
          </button>
          <button
            type="button"
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Commit and remote actions"
            aria-expanded={commitMenuOpen}
            title="Commit and remote actions"
            data-testid="git-commit-menu-button"
            onClick={() => setCommitMenuOpen((current) => !current)}
          >
            <MoreHorizontal size={12} />
          </button>
          {commitMenuOpen ? (
            <div
              className="absolute right-0 top-8 z-30 w-64 rounded-md border border-border bg-card p-1 shadow-xl"
              role="menu"
              aria-label="Commit and remote actions"
              data-testid="git-commit-menu"
            >
              <MenuAction
                label="Amend last commit"
                disabled={!canAmend}
                title={
                  snapshot.headOid === null
                    ? 'Commit once before amending.'
                    : stagedCount === 0 && message.trim().length === 0
                      ? 'Stage a change or write a message first.'
                      : 'Rewrite the last local commit'
                }
                testId="git-amend"
                onClick={() => {
                  setCommitMenuOpen(false)
                  setAmendOpen(true)
                }}
              >
                <Undo2 size={10} />
              </MenuAction>
              <MenuAction
                label="Commit all changes"
                disabled={
                  message.trim().length === 0 ||
                  groups.conflicts.length > 0 ||
                  (stagedCount === 0 && groups.unstaged.length === 0) ||
                  commitBusy ||
                  busy ||
                  stagePending
                }
                title={
                  message.trim().length === 0
                    ? 'Write a commit message first.'
                    : groups.conflicts.length > 0
                      ? 'Resolve conflicts before committing.'
                      : stagedCount === 0 && groups.unstaged.length === 0
                        ? 'There are no tracked changes to commit.'
                        : 'Stage tracked changes and commit them together'
                }
                testId="git-commit-all"
                onClick={() => {
                  setCommitMenuOpen(false)
                  void commitAll()
                }}
              >
                <GitCommitHorizontal size={10} />
              </MenuAction>
              <MenuAction
                label="Commit & push"
                disabled={
                  primary.kind !== 'commit' ||
                  primary.disabled ||
                  !snapshot.upstream ||
                  commitBusy ||
                  stagePending
                }
                title={snapshot.upstream ? primary.reason : 'Set an upstream before pushing.'}
                testId="git-commit-push"
                onClick={() => {
                  setCommitMenuOpen(false)
                  void commit(true)
                }}
              >
                <ArrowUpRight size={10} />
              </MenuAction>
              <div className="my-1 border-t border-border" />
              <MenuAction
                label="Push"
                disabled={!snapshot.upstream || busy}
                title={snapshot.upstream ? 'Push the current branch' : 'Publish the branch first.'}
                testId="git-push"
                onClick={() => {
                  setCommitMenuOpen(false)
                  void runRemoteAction('push')
                }}
              >
                <ArrowUpRight size={10} />
              </MenuAction>
              <MenuAction
                label="Pull"
                disabled={!snapshot.upstream || busy}
                title={snapshot.upstream ? 'Pull with fast-forward only' : 'Publish the branch first.'}
                testId="git-pull"
                onClick={() => {
                  setCommitMenuOpen(false)
                  void runRemoteAction('pull')
                }}
              >
                <RefreshCw size={10} />
              </MenuAction>
              <MenuAction
                label="Publish branch"
                disabled={snapshot.upstream !== null && snapshot.upstream !== undefined}
                title={
                  snapshot.upstream
                    ? 'The branch is already published.'
                    : 'Set an upstream for this branch.'
                }
                testId="git-publish"
                onClick={() => {
                  setCommitMenuOpen(false)
                  void runRemoteAction('publish')
                }}
              >
                <ArrowUpRight size={10} />
              </MenuAction>
              <div className="my-1 border-t border-border" />
              <MenuAction
                label="Open Git in terminal"
                onClick={() => {
                  setCommitMenuOpen(false)
                  onOpenTerminal()
                }}
              >
                <TerminalSquare size={10} />
              </MenuAction>
            </div>
          ) : null}
        </div>
        <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
          Commits in this worktree only. {primary.disabled ? primary.reason : ''}
        </p>
      </div>
    ) : loading ? (
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2.5 text-[10.5px] text-muted-foreground">
        <Loader2 size={11} className="animate-spin" />
        Reading Git state…
      </div>
    ) : (
      <div
        className="shrink-0 border-b border-border bg-card px-3 py-2.5 text-[10.5px] text-signal"
        data-testid="changes-git-unavailable"
      >
        {note || 'Git state is unavailable, so staging and committing are disabled.'}
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
          Discard {discardLabel}? This changes the worktree and cannot be undone.
        </span>
        <button
          type="button"
          className="rounded border border-destructive/60 px-2 py-0.5 text-[10.5px] text-destructive hover:bg-destructive/15 disabled:opacity-40"
          disabled={busy}
          data-testid="change-discard-yes"
          onClick={() => void confirmDiscard()}
        >
          Discard
        </button>
        <button
          type="button"
          className="rounded border border-border px-2 py-0.5 text-[10.5px] text-foreground hover:bg-muted"
          disabled={busy}
          data-testid="change-discard-cancel"
          onClick={cancelDiscard}
        >
          Cancel
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
            Too many changes to list in full. Showing the first{' '}
            {String(snapshot.statusLength ?? 0)} paths; stage or commit some work, then
            refresh.
          </span>
        </div>
      ) : null}
      {sendError ? (
        <div
          className="flex items-start gap-1.5 border-b border-destructive/40 bg-destructive/10 px-3 py-1 text-[10.5px] leading-relaxed text-destructive"
          data-testid="review-send-error"
        >
          <AlertTriangle size={11} className="mt-0.5 shrink-0" />
          <span>The note draft was kept. {sendError}</span>
        </div>
      ) : null}
      {discardBar}
      <WorkingTreeView
        sessionId={sessionId}
        sessionState={sessionState}
        snapshot={snapshot}
        loading={loading}
        active={active}
        refreshToken={refreshToken}
        gitRevision={gitRevision + diffTick}
        watchActive={watchMode === 'watch'}
        onStage={(path) => setPathStaged(path, true)}
        onUnstage={(path) => setPathStaged(path, false)}
        onStageEntries={(entries) => void setEntriesStaged(entries, true)}
        onUnstageEntries={(entries) => void setEntriesStaged(entries, false)}
        onDiscardEntries={(entries) => requestDiscard(entries)}
        onDiscard={(entry: WorkingTreeEntry) => requestDiscard([entry])}
        onApplyHunk={(path, patch, mode) => applyHunk(path, patch, mode)}
        onResolveConflict={(path, text) => resolveConflict(path, text)}
        onNotify={notify}
        onStashChanged={() => {
          refresh()
          onChanged()
        }}
        onOpenPath={onOpenPath}
        onOpenTerminal={onOpenTerminal}
        sidebarHeader={
          <>
            {repoHeader}
            {operationBanner}
            {statusBlock}
          </>
        }
        editorOverride={
          historyOpen ? (
            <ScmHistoryView
              sessionId={sessionId}
              notify={notify}
              onClose={() => {
                setHistoryOpen(false)
                setHistoryPath('')
              }}
              branchPrefix={settings.branchPrefix}
              initialPath={historyPath}
              onChanged={refresh}
            />
          ) : null
        }
        comments={comments}
        onAddComment={onAddComment}
        onRemoveComment={onRemoveComment}
      />

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
