import { useEffect } from 'react'
import { AlertCircle, AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, GitBranch, Info, RefreshCw, Server, TerminalSquare, X } from 'lucide-react'
import type { RuntimeInfo, TaskRecordPayload } from '../../../shared/ade-api'
import { hostLabel, hostStatus } from '../state/host-status'
import type { Notice, WorkspaceState } from '../state/workspace'
import { useScmStatusSummary } from '../scm/scm-status-store'
import { useEditorBlameStatus } from '../editor/editor-status-store'

type Props = {
  state: WorkspaceState
  tasks: TaskRecordPayload[]
  maxConcurrent: number
  runtime: RuntimeInfo | null
  projectLabel: string
  refreshing: boolean
  onRefresh: () => void
  onRetryHost: () => void
  notice: Notice | null
  onDismissNotice: () => void
  onFocusSourceControl?: () => void
}

/**
 * The status bar is the global truth surface: host state, harness availability,
 * global task slots and the total number of live PTYs. A project header never
 * repeats the slot number as if it were local.
 */
export default function StatusBar({
  state,
  tasks,
  maxConcurrent,
  runtime,
  projectLabel,
  refreshing,
  onRefresh,
  onRetryHost,
  notice,
  onDismissNotice,
  onFocusSourceControl
}: Props): React.JSX.Element {
  const gitSummary = useScmStatusSummary()
  const blame = useEditorBlameStatus()
  const host = hostStatus(state)
  const available = state.harnesses.filter((entry) => entry.state === 'available').length
  const slotCount = tasks.filter((task) =>
    ['dispatching', 'running', 'waiting'].includes(task.status)
  ).length
  const liveSessions = state.sessions.filter(
    (session) => session.state === 'live' || session.state === 'starting'
  ).length

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(onDismissNotice, notice.tone === 'error' ? 8000 : 4500)
    return () => window.clearTimeout(timer)
  }, [notice, onDismissNotice])

  const noticeTone = notice
    ? notice.tone === 'error'
      ? 'bg-destructive/10 text-destructive'
      : notice.tone === 'success'
        ? 'bg-add-weak text-add'
        : 'bg-info-weak text-info'
    : ''
  const NoticeIcon = notice?.tone === 'error' ? AlertCircle : notice?.tone === 'success' ? CheckCircle2 : Info

  return (
    <footer
      className="flex h-[27px] shrink-0 items-center gap-2 overflow-hidden border-t border-border bg-card px-3 text-[10px] text-muted-foreground"
      data-testid="statusbar"
    >
      <button
        type="button"
        className={`inline-flex shrink-0 items-center gap-1.5 rounded px-0.5 hover:bg-muted disabled:opacity-50 ${
          host === 'unreachable' ? 'text-signal' : ''
        }`}
        title={
          host === 'unreachable'
            ? 'Retry the terminal host connection'
            : 'Derived from host reconciliation of session state; click to refresh'
        }
        onClick={onRetryHost}
        disabled={refreshing}
        data-testid="host-status"
        data-host-status={host}
      >
        <Server size={11} />
        <span className="hidden sm:inline">{hostLabel(host)}</span>
        <span className="sm:hidden">{host === 'reachable' ? 'Host' : host === 'unreachable' ? 'Host down' : 'Host ?'}</span>
      </button>
      <span className="hidden shrink-0 items-center gap-1 sm:inline-flex" title="Available Harnesses" data-testid="harness-summary">
        {available}/{state.harnesses.length || 4} Harnesses
      </span>
      <span className="hidden shrink-0 text-border md:inline">|</span>
      {gitSummary ? (
        <button
          type="button"
          className="inline-flex min-w-0 shrink items-center gap-1 rounded px-0.5 hover:bg-muted"
          title={`${gitSummary.branch ?? 'Detached HEAD'}${gitSummary.upstream ? ` → ${gitSummary.upstream}` : ''} · ${String(gitSummary.staged)} staged · ${String(gitSummary.changed)} changed · ${String(gitSummary.untracked)} untracked`}
          onClick={onFocusSourceControl}
          data-testid="statusbar-branch"
          data-session-id={gitSummary.sessionId}
        >
          <GitBranch size={11} />
          <span className="max-w-[150px] truncate">{gitSummary.branch ?? 'Detached'}</span>
          {gitSummary.operation ? (
            <span className="rounded bg-signal-weak px-1 uppercase text-signal" title={`${gitSummary.operation} in progress`}>
              {gitSummary.operation}
            </span>
          ) : null}
          {gitSummary.conflicts > 0 ? (
            <span className="inline-flex items-center gap-0.5 text-signal" title={`${String(gitSummary.conflicts)} conflict(s)`}>
              <AlertTriangle size={10} />
              {gitSummary.conflicts}
            </span>
          ) : null}
          {gitSummary.ahead > 0 ? (
            <span className="inline-flex items-center gap-0.5" title={`${String(gitSummary.ahead)} ahead`}>
              <ArrowUp size={10} />
              {gitSummary.ahead}
            </span>
          ) : null}
          {gitSummary.behind > 0 ? (
            <span className="inline-flex items-center gap-0.5" title={`${String(gitSummary.behind)} behind`}>
              <ArrowDown size={10} />
              {gitSummary.behind}
            </span>
          ) : null}
        </button>
      ) : null}
      {blame ? (
        <span
          className="inline-flex min-w-0 shrink items-center gap-1 rounded px-0.5"
          title={`${blame.path}:${String(blame.line)} · ${blame.oid.slice(0, 8)} · ${
            blame.committed ? blame.author : 'Not committed yet'
          } · ${new Date(blame.authorTime * 1000).toLocaleString()}${blame.summary ? ` · ${blame.summary}` : ''}`}
          data-testid="statusbar-blame"
        >
          <span className="max-w-[120px] truncate text-foreground">
            {blame.committed ? blame.author : 'You'}
          </span>
          <span className="max-w-[180px] truncate">
            {blame.committed ? blame.summary : 'uncommitted'}
          </span>
        </span>
      ) : null}
      <span className="shrink-0" data-testid="task-slots">
        <span className="hidden md:inline">Global task slots </span>
        <span className="md:hidden">Global </span>
        {slotCount}/{maxConcurrent}
      </span>
      <span className="inline-flex shrink-0 items-center gap-1" data-testid="live-sessions">
        <TerminalSquare size={11} />
        {liveSessions}
        <span className="hidden md:inline"> live session{liveSessions === 1 ? '' : 's'}</span>
        <span className="md:hidden"> live</span>
      </span>
      {notice ? (
        <span
          className={`inline-flex min-w-0 max-w-[180px] shrink items-center gap-1 rounded px-1.5 py-0.5 text-[10px] min-[900px]:max-w-[440px] ${noticeTone}`}
          title={`${notice.message}${notice.detail ? ` — ${notice.detail}` : ''}`}
          data-testid="notice"
          data-tone={notice.tone}
        >
          <NoticeIcon size={11} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{notice.message}</span>
          <button
            type="button"
            className="shrink-0 rounded p-0.5 opacity-70 hover:bg-white/10 hover:opacity-100"
            onClick={onDismissNotice}
            aria-label="Dismiss notification"
          >
            <X size={10} />
          </button>
        </span>
      ) : null}
      <span className="ml-auto min-w-0 truncate text-[10px] text-muted-foreground" title={projectLabel}>
        {projectLabel}
      </span>
      <button
        type="button"
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
        onClick={onRefresh}
        disabled={refreshing}
        title="Refresh repositories, sessions, Harnesses and tasks"
        data-testid="refresh-all"
      >
        <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
      </button>
      <span
        className="hidden shrink-0 font-mono text-[9px] text-muted-foreground lg:inline"
        title={runtime ? `Electron ${runtime.electron ?? '?'} · Node ${runtime.node}` : undefined}
      >
        v{runtime?.appVersion ?? '0.1.0'}
      </span>
    </footer>
  )
}
