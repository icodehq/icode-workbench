import { useEffect } from 'react'
import { AlertCircle, AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, GitBranch, Info, RefreshCw, Server, TerminalSquare, X } from 'lucide-react'
import type { RuntimeInfo, TaskRecordPayload } from '../../../shared/icode-api'
import type { RepoRemovalJobSummary } from '../../../shared/schemas/repo-removal'
import CleanupIndicator from './CleanupIndicator'
import { hostLabel, hostStatus } from '../state/host-status'
import type { Notice, WorkspaceState } from '../state/workspace'
import { useScmStatusSummary } from '../scm/scm-status-store'
import { useEditorBlameStatus } from '../editor/editor-status-store'
import { formatDateTime } from '../../../shared/i18n'
import { useLocale, useT, useTp } from '../i18n/use-i18n'

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
  cleanupJobs: RepoRemovalJobSummary[]
  onRetryRemoval: (jobId: string) => void
  onDiscardRemovalSnapshots: (jobId: string) => void
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
  cleanupJobs,
  onRetryRemoval,
  onDiscardRemovalSnapshots,
  onFocusSourceControl
}: Props): React.JSX.Element {
  const t = useT()
  const tp = useTp()
  const locale = useLocale()
  const gitSummary = useScmStatusSummary()
  const blame = useEditorBlameStatus()
  const host = hostStatus(state)
  const available = state.harnesses.filter((entry) => entry.state === 'available').length
  const slotCount = tasks.filter((task) =>
    ['dispatching', 'running', 'waiting'].includes(task.status)
  ).length
  const liveSessions = state.sessions.filter(
    (session) =>
      session.role !== 'supervisor' &&
      (session.state === 'live' || session.state === 'starting')
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
          host === 'unreachable' ? t('status.hostTooltipRetry') : t('status.hostTooltip')
        }
        onClick={onRetryHost}
        disabled={refreshing}
        data-testid="host-status"
        data-host-status={host}
      >
        <Server size={11} />
        <span className="hidden sm:inline">{hostLabel(host)}</span>
        <span className="sm:hidden">
          {host === 'reachable'
            ? t('host.short')
            : host === 'unreachable'
              ? t('host.shortDown')
              : t('host.shortUnknown')}
        </span>
      </button>
      <span className="hidden shrink-0 items-center gap-1 sm:inline-flex" title={t('status.harnessesTooltip')} data-testid="harness-summary">
        {t('status.harnessesCount', {
          available,
          total: state.harnesses.length || 4
        })}
      </span>
      <span className="hidden shrink-0 text-border md:inline">|</span>
      {gitSummary ? (
        <button
          type="button"
          className="inline-flex min-w-0 shrink items-center gap-1 rounded px-0.5 hover:bg-muted"
          title={t('status.gitTooltip', {
            branch: gitSummary.branch ?? t('status.detachedHead'),
            upstream: gitSummary.upstream ? ` → ${gitSummary.upstream}` : '',
            staged: gitSummary.staged,
            changed: gitSummary.changed,
            untracked: gitSummary.untracked
          })}
          onClick={onFocusSourceControl}
          data-testid="statusbar-branch"
          data-session-id={gitSummary.sessionId}
        >
          <GitBranch size={11} />
          <span className="max-w-[150px] truncate">{gitSummary.branch ?? t('status.detached')}</span>
          {gitSummary.operation ? (
            <span className="rounded bg-signal-weak px-1 uppercase text-signal" title={t('status.operationProgress', { operation: gitSummary.operation })}>
              {gitSummary.operation}
            </span>
          ) : null}
          {gitSummary.conflicts > 0 ? (
            <span className="inline-flex items-center gap-0.5 text-signal" title={tp('status.conflicts', gitSummary.conflicts)}>
              <AlertTriangle size={10} />
              {gitSummary.conflicts}
            </span>
          ) : null}
          {gitSummary.ahead > 0 ? (
            <span className="inline-flex items-center gap-0.5" title={tp('status.ahead', gitSummary.ahead)}>
              <ArrowUp size={10} />
              {gitSummary.ahead}
            </span>
          ) : null}
          {gitSummary.behind > 0 ? (
            <span className="inline-flex items-center gap-0.5" title={tp('status.behind', gitSummary.behind)}>
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
            blame.committed ? blame.author : t('status.notCommitted')
          } · ${formatDateTime(locale, blame.authorTime * 1000)}${blame.summary ? ` · ${blame.summary}` : ''}`}
          data-testid="statusbar-blame"
        >
          <span className="max-w-[120px] truncate text-foreground">
            {blame.committed ? blame.author : t('status.you')}
          </span>
          <span className="max-w-[180px] truncate">
            {blame.committed ? blame.summary : t('status.uncommitted')}
          </span>
        </span>
      ) : null}
      <span className="shrink-0" data-testid="task-slots">
        <span className="hidden md:inline">{t('status.globalTaskSlots')}</span>
        <span className="md:hidden">{t('status.global')}</span>
        {slotCount}/{maxConcurrent}
      </span>
      <span className="inline-flex shrink-0 items-center gap-1" data-testid="live-sessions">
        <TerminalSquare size={11} />
        <span className="hidden md:inline">
          {liveSessions}
          {tp('status.liveSessions', liveSessions)}
        </span>
        <span className="md:hidden">
          {liveSessions}
          {t('status.liveShort')}
        </span>
      </span>
      <CleanupIndicator
        jobs={cleanupJobs}
        onRetry={onRetryRemoval}
        onDiscard={onDiscardRemovalSnapshots}
      />
      {notice ? (
        <span
          className={`inline-flex min-w-0 max-w-[180px] shrink items-center gap-1 rounded px-1.5 py-0.5 text-[10px] min-[900px]:max-w-[440px] ${noticeTone}`}
          title={`${notice.message}${notice.detail ? ` — ${notice.detail}` : ''}`}
          data-testid="notice"
          data-tone={notice.tone}
        >
          <NoticeIcon size={11} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{notice.message}</span>
          {notice.action ? (
            <button
              type="button"
              className="shrink-0 rounded border border-white/20 px-1 py-0.5 text-[9.5px] font-medium hover:bg-white/10"
              data-testid="notice-action"
              onClick={() => {
                const action = notice.action
                onDismissNotice()
                action?.run()
              }}
            >
              {notice.action.label}
            </button>
          ) : null}
          <button
            type="button"
            className="shrink-0 rounded p-0.5 opacity-70 hover:bg-white/10 hover:opacity-100"
            onClick={onDismissNotice}
            aria-label={t('status.dismiss')}
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
        title={t('status.refreshTitle')}
        data-testid="refresh-all"
      >
        <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
      </button>
      <span
        className="hidden shrink-0 font-mono text-[9px] text-muted-foreground lg:inline"
        title={runtime ? t('status.electronTitle', { electron: runtime.electron ?? '?', node: runtime.node }) : undefined}
      >
        v{runtime?.appVersion ?? '—'}
      </span>
    </footer>
  )
}
