import { useState } from 'react'
import {
  AlertTriangle,
  FileDiff,
  Files,
  GitBranch,
  Loader2,
  RefreshCw,
  RotateCcw,
  Square,
  TerminalSquare,
  Trash2
} from 'lucide-react'
import type { AppError } from '../../../shared/domain/errors'
import type {
  RepositorySummary,
  SessionSummary,
  WorktreeSummary
} from '../../../shared/schemas/ipc'
import type { Notice, PendingAction } from '../state/workspace'
import TerminalPane from './TerminalPane'
import ChangesPanel from './ChangesPanel'
import FilesPanel from './FilesPanel'
import GitPanel from './GitPanel'
import { useSessionReview } from '../review/use-session-review'
import {
  activityDotClass,
  activityLabel,
  activityTone,
  activityTooltip,
  authorityNote,
  harnessName,
  sessionStateLabel,
  shortId,
  stateDotClass,
  stateTextClass
} from './status'

type Props = {
  session: SessionSummary
  repo: RepositorySummary | null
  pending: PendingAction | null
  panes: SessionSummary[]
  onStop: (sessionId: string) => void
  onRestart: (sessionId: string) => void
  onRecheck: (sessionId: string) => void
  onRemove: (sessionId: string) => void
  onRecoverWorktree: (sessionId: string) => void
  onError: (error: AppError) => void
  /** Shared notice channel for the tools panels. */
  notify: (notice: Notice) => void
  /** Bumped by the global refresh action; every tools panel reloads. */
  refreshToken: number
  /** A file opened from outside the panel (search hit, quick open). */
  openRequest: { path: string; line: number; nonce: number } | null
  onOpenRequestHandled: () => void
  /** Sends review feedback to the Agent's terminal. */
  onSendToAgent: (text: string) => void
  /** Asks the shell to open a file in the Files tab (Git list, review). */
  onRequestOpenInFiles: (path: string, line: number) => void
}

const WORKTREE_STATUS_LABEL: Record<WorktreeSummary['status'], string> = {
  creating: 'Creating worktree',
  incomplete: 'Worktree incomplete',
  'ready-to-start': 'Worktree ready',
  active: 'Worktree active',
  missing: 'Worktree missing',
  inconsistent: 'Worktree inconsistent',
  failed: 'Worktree failed'
}

const WORKTREE_STATUS_TONE: Record<WorktreeSummary['status'], string> = {
  creating: 'text-amber-400',
  incomplete: 'text-amber-400',
  'ready-to-start': 'text-muted-foreground',
  active: 'text-emerald-400',
  missing: 'text-destructive',
  inconsistent: 'text-destructive',
  failed: 'text-destructive'
}

function worktreeBlocksTerminal(worktree: WorktreeSummary | null): boolean {
  return worktree !== null && (worktree.status === 'missing' || worktree.status === 'inconsistent')
}

function WorktreePanel({
  session,
  worktree,
  onRecheck,
  onRecover,
  onRemove
}: {
  session: SessionSummary
  worktree: WorktreeSummary
  onRecheck: () => void
  onRecover: () => void
  onRemove: () => void
}): React.JSX.Element {
  const missing = worktree.status === 'missing'
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-background p-6">
      <div className="w-full max-w-lg rounded-lg border border-destructive/40 bg-card p-5">
        <div className="flex items-center gap-2">
          <AlertTriangle size={14} className="text-destructive" />
          <h2 className="text-[13px] font-semibold">
            {missing ? 'This worktree is missing' : 'This worktree is inconsistent'}
          </h2>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {missing
            ? 'ADE will not fall back to the primary checkout. The branch still holds committed work; you can re-create the checkout from it.'
            : 'Git does not recognise this directory as the recorded worktree. ADE will not start a terminal or delete anything until this is resolved.'}
        </p>
        <dl className="mt-3 space-y-1 rounded-md border border-border bg-background px-3 py-2 font-mono text-[10px] text-muted-foreground">
          <div>
            branch <span className="text-foreground">{worktree.branch}</span>
          </div>
          <div className="break-all">
            path <span className="text-foreground">{worktree.path}</span>
          </div>
          <div>
            baseline <span className="text-foreground">{worktree.baseOid.slice(0, 12)}</span>
          </div>
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          {missing ? (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] hover:bg-muted"
              onClick={onRecover}
              data-testid="worktree-recover"
            >
              <GitBranch size={12} />
              Re-create from branch
            </button>
          ) : null}
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] hover:bg-muted"
            onClick={onRecheck}
            data-testid="worktree-recheck"
          >
            <RefreshCw size={12} />
            Check host
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] text-muted-foreground hover:bg-muted"
            onClick={onRemove}
            data-testid="worktree-remove"
          >
            <Trash2 size={12} />
            Remove session…
          </button>
        </div>
        <p className="mt-3 text-[10px] text-muted-foreground">
          Session state: {session.state}. {authorityNote(session)}
        </p>
      </div>
    </div>
  )
}

function paneActive(session: SessionSummary, candidate: SessionSummary): boolean {
  if (session.id !== candidate.id) return false
  if (session.incarnationId === null) return candidate.incarnationId === null
  return session.incarnationId === candidate.incarnationId
}

function StatePanel({
  session,
  onRestart,
  onRecheck
}: {
  session: SessionSummary
  onRestart: () => void
  onRecheck: () => void
}): React.JSX.Element {
  const live = session.state === 'live' || session.state === 'starting'
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-background p-6">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-5">
        <div className="flex items-center gap-2">
          {live ? (
            <Loader2 size={14} className="animate-spin text-muted-foreground" />
          ) : session.state === 'failed' ? (
            <AlertTriangle size={14} className="text-destructive" />
          ) : (
            <span className={`h-2 w-2 rounded-full ${stateDotClass(session.state, null)}`} />
          )}
          <h2 className="text-[13px] font-semibold">
            {live
              ? 'Attaching to the terminal…'
              : session.state === 'exited'
                ? 'This session has exited'
                : session.state === 'failed'
                  ? 'This session failed'
                  : 'Terminal state unavailable'}
          </h2>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {live
            ? 'ADE is connecting to the existing process. It never starts a replacement for a live session.'
            : authorityNote(session)}
        </p>
        {session.error ? (
          <p className="mt-2 break-words rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 font-mono text-[10px] leading-relaxed text-red-200">
            {session.error.message}
            {session.error.detail ? ` — ${session.error.detail}` : ''}
          </p>
        ) : null}
        {session.exitCode !== null && !live ? (
          <p className="mt-2 text-[10px] text-muted-foreground">
            Exit code <span className="font-mono">{session.exitCode}</span>
          </p>
        ) : null}
        {!live ? (
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] hover:bg-muted"
              onClick={onRestart}
              data-testid="state-restart"
            >
              <RotateCcw size={12} />
              Restart session
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] hover:bg-muted"
              onClick={onRecheck}
              data-testid="state-recheck"
            >
              <RefreshCw size={12} />
              Check host
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default function SessionWorkspace({
  session,
  repo,
  pending,
  panes,
  onStop,
  onRestart,
  onRecheck,
  onRemove,
  onRecoverWorktree,
  onError,
  notify,
  refreshToken,
  openRequest,
  onOpenRequestHandled,
  onSendToAgent,
  onRequestOpenInFiles
}: Props): React.JSX.Element {
  const worktree = session.worktree
  const blocked = worktreeBlocksTerminal(worktree)
  // The view survives re-renders but resets when the active session changes.
  const [view, setView] = useState<'terminal' | 'changes' | 'files' | 'git'>('terminal')
  const [viewSessionId, setViewSessionId] = useState(session.id)
  if (viewSessionId !== session.id) {
    setViewSessionId(session.id)
    setView('terminal')
  }
  const review = useSessionReview(session.id, view === 'changes', session.state)
  const activity = session.activity
  const activePane = !blocked && panes.some((candidate) => paneActive(session, candidate))
  const canStop = (session.state === 'live' || session.state === 'starting') && pending === null
  const canRestart = pending === null && !blocked

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-[12px] font-semibold" data-testid="session-title">
              {session.title}
            </h1>
            <span
              className={`inline-flex items-center gap-1 text-[9px] ${stateTextClass(session.state)}`}
              data-testid="session-state"
              data-state={session.state}
              data-authority={session.authority}
              data-reason={session.reason}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${stateDotClass(session.state, pending)}`} />
              {sessionStateLabel(session.state, pending)}
            </span>
            <span
              className={`inline-flex items-center gap-1 text-[9px] ${activityTone(activity)}${
                activity?.state === 'waiting' ? ' rounded bg-amber-500/10 px-1.5 py-0.5' : ''
              }`}
              title={activityTooltip(activity)}
              data-testid="session-activity"
              data-activity={activity?.state ?? 'unknown'}
              data-activity-tool={activity?.toolName ?? ''}
              data-activity-unread={String(activity?.unread ?? false)}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${activityDotClass(activity)}`} />
              {activity && activity.state !== 'unknown' ? activityLabel(activity) : 'Activity unknown'}
            </span>
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[9px] text-muted-foreground">
            <span>
              {repo?.target.kind === 'wsl' && session.harness === 'shell'
                ? `WSL terminal · ${repo.target.distro}`
                : repo?.target.kind === 'wsl'
                  ? `${harnessName(session.harness)} · in ${repo.target.distro}`
                  : harnessName(session.harness)}
            </span>
            <span className="text-border">|</span>
            <span className="truncate" title={repo?.path}>
              {repo?.displayName ?? 'Unknown repository'}
              {repo?.currentBranch ? ` · ${repo.currentBranch}` : ''}
            </span>
            {worktree ? (
              <>
                <span className="text-border">|</span>
                <span
                  className={`inline-flex items-center gap-1 ${WORKTREE_STATUS_TONE[worktree.status]}`}
                  title={`${WORKTREE_STATUS_LABEL[worktree.status]} · ${worktree.path}`}
                  data-testid="session-worktree"
                  data-worktree-status={worktree.status}
                  data-worktree-branch={worktree.branch}
                >
                  <GitBranch size={9} />
                  {worktree.branch}
                </span>
              </>
            ) : (
              <>
                <span className="text-border">|</span>
                <span title="Registered before worktree isolation existed">
                  primary checkout
                </span>
              </>
            )}
            <span className="text-border">|</span>
            <span title="PTY incarnation owned by the terminal host">
              incarnation{' '}
              <span className="font-mono" data-testid="session-incarnation">
                {shortId(session.incarnationId)}
              </span>
            </span>
            <span className="hidden truncate text-border xl:inline">|</span>
            <span className="hidden truncate xl:inline" title={authorityNote(session)}>
              {authorityNote(session)}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <div
            className="mr-1 flex items-center rounded-md border border-border p-0.5"
            role="tablist"
            aria-label="Session view"
          >
            <button
              type="button"
              role="tab"
              aria-selected={view === 'terminal'}
              className={`inline-flex h-6 items-center gap-1 rounded px-2 text-[10px] ${
                view === 'terminal'
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setView('terminal')}
              data-testid="view-terminal"
            >
              <TerminalSquare size={10} />
              Terminal
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'changes'}
              className={`inline-flex h-6 items-center gap-1 rounded px-2 text-[10px] ${
                view === 'changes'
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setView('changes')}
              data-testid="view-changes"
            >
              <FileDiff size={10} />
              Changes
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'files'}
              className={`inline-flex h-6 items-center gap-1 rounded px-2 text-[10px] ${
                view === 'files'
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setView('files')}
              data-testid="view-files"
            >
              <Files size={10} />
              Files
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'git'}
              className={`inline-flex h-6 items-center gap-1 rounded px-2 text-[10px] ${
                view === 'git'
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setView('git')}
              data-testid="view-git"
            >
              <GitBranch size={10} />
              Git
            </button>
          </div>
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[10px] hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => onRestart(session.id)}
            disabled={!canRestart}
            title="Stop the process and start a new incarnation"
            data-testid="restart-session"
          >
            <RotateCcw size={11} />
            {pending === 'restarting' ? 'Restarting…' : 'Restart'}
          </button>
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[10px] hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => onStop(session.id)}
            disabled={!canStop}
            title="Request the terminal host to terminate this session"
            data-testid="stop-session"
          >
            <Square size={10} />
            {pending === 'stopping' ? 'Stopping…' : 'Stop'}
          </button>
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => onRemove(session.id)}
            disabled={pending !== null}
            title="Remove the session; a clean worktree is deleted and its branch retained"
            data-testid="remove-session"
          >
            <Trash2 size={10} />
            Remove
          </button>
        </div>
      </header>

      <div className={`relative min-h-0 flex-1 bg-background ${view === 'terminal' ? '' : 'hidden'}`}>
        {panes.map((candidate) => (
          <TerminalPane
            key={`${candidate.id}:${candidate.incarnationId ?? 'pending'}`}
            session={candidate}
            active={paneActive(session, candidate)}
            onError={onError}
          />
        ))}
        {!activePane && worktree && (blocked || worktree.status === 'failed') ? (
          <WorktreePanel
            session={session}
            worktree={worktree}
            onRecheck={() => onRecheck(session.id)}
            onRecover={() => onRecoverWorktree(session.id)}
            onRemove={() => onRemove(session.id)}
          />
        ) : !activePane ? (
          <StatePanel
            session={session}
            onRestart={() => onRestart(session.id)}
            onRecheck={() => onRecheck(session.id)}
          />
        ) : null}
      </div>

      {view === 'files' ? (
        <div className="flex min-h-0 flex-1" data-testid="files-view">
          <FilesPanel
            sessionId={session.id}
            refreshToken={refreshToken}
            notify={notify}
            openRequest={openRequest}
            onOpenRequestHandled={onOpenRequestHandled}
          />
        </div>
      ) : null}

      {view === 'git' ? (
        <div className="flex min-h-0 flex-1" data-testid="git-view">
          <GitPanel
            sessionId={session.id}
            refreshToken={refreshToken}
            notify={notify}
            onOpenPath={(path) => {
              setView('files')
              onRequestOpenInFiles(path, 1)
            }}
            onChanged={() => onRecheck(session.id)}
          />
        </div>
      ) : null}

      {view === 'changes' ? (
        <div className="min-h-0 flex-1" data-testid="changes-view">
          <ChangesPanel
            review={review}
            sessionId={session.id}
            sessionState={session.state}
            worktreeBranch={worktree?.branch ?? null}
            baselineOid={worktree?.baseOid ?? null}
            onSendToAgent={onSendToAgent}
            canSendToAgent={session.state === 'live'}
          />
        </div>
      ) : null}
    </section>
  )
}
