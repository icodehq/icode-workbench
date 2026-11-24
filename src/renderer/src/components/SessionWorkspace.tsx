import { useEffect, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Trash2
} from 'lucide-react'
import type { AppError } from '../../../shared/domain/errors'
import { isAgentHarness } from '../../../shared/domain/harness'
import { wakeDescription } from '../../../shared/domain/session-sleep'
import type {
  RepositorySummary,
  SessionSummary,
  WorktreeSummary
} from '../../../shared/schemas/ipc'
import type { AgentSendResult } from '../lib/agent-send'
import type { WorkbenchDraftStore } from '../review/drafts'
import type { Notice, PendingAction, RecoveryPhase } from '../state/workspace'
import type {
  SessionRemovalOptions,
  WorktreeRecoveryOptions
} from '../state/session-actions'
import TerminalPane from './TerminalPane'
import RemoveSessionDialog from './RemoveSessionDialog'
import SessionActionsMenu from './SessionActionsMenu'
import SleepSessionDialog from './SleepSessionDialog'
import SessionDetailsDrawer from './SessionDetailsDrawer'
import SessionCenterTabs from './sessions/SessionCenterTabs'
import SessionFilesWatchHost from './sessions/SessionFilesWatchHost'
import {
  hostUnavailable,
  sessionActionState,
  worktreeBlocksTerminal
} from './sessions/session-menu'
import { useLocale, useT } from '../i18n/use-i18n'
import { useFilesDirtyCount } from '../files/open-files'
import type { DiffTabRequest } from '../files/open-files'
import {
  activityDotClass,
  activityLabel,
  activityTone,
  activityTooltip,
  authorityNote,
  harnessName,
  isKnownActivity,
  sessionStateLabelFor,
  sessionStateDotClass,
  sessionStatePillClass,
  shortId,
  stateDotClass
} from './status'

type Props = {
  session: SessionSummary
  repo: RepositorySummary | null
  pending: PendingAction | null
  /** Transient checkout progress reported by the main process. */
  recovery?: RecoveryPhase | null
  panes: SessionSummary[]
  onRestart: (sessionId: string) => void
  /**
   * Continue a non-live session's captured harness conversation.
   *
   * Absent on surfaces that own continuation elsewhere, such as a task attempt.
   */
  onResume?: (sessionId: string) => void
  onSleep?: (sessionId: string) => void
  onWake?: (sessionId: string) => void
  /** Direct sessions support hibernate; task sessions remain scheduler-owned. */
  allowSleep?: boolean
  onRecheck: (sessionId: string) => void
  onRemove: (sessionId: string, options?: SessionRemovalOptions) => void
  onRecoverWorktree: (sessionId: string, options?: WorktreeRecoveryOptions) => void
  onError: (error: AppError) => void
  /** Shared notice channel for the tools panels. */
  notify: (notice: Notice) => void
  /** Bumped by the global refresh action; every tools panel reloads. */
  refreshToken: number
  /** A one-shot file request routed to the center editor. */
  centerRequest?: { path: string; line: number; nonce: number; preview?: boolean } | null
  onCenterRequestHandled?: () => void
  /** A one-shot diff tab request from the Changes list. */
  diffRequest?: {
    sessionId: string
    request: DiffTabRequest
    preview: boolean
    nonce: number
  } | null
  onDiffRequestHandled?: () => void
  /** Opens Source Control History filtered to the open file. */
  onOpenHistory?: (path: string) => void
  /** Sends review feedback to the Agent's terminal. */
  onSendToAgent: (text: string) => Promise<AgentSendResult>
  /** Review notes, feedback and commit message, keyed by session. */
  drafts: WorkbenchDraftStore
  /** True while this session's pane is the focused one. */
  focused?: boolean
  /** Focus mode drops the session header so only the terminal remains. */
  hideHeader?: boolean
  /** Renders only the terminal/state content; the worktree pane owns the chrome. */
  contentOnly?: boolean
  /** Hidden worktree hosts keep a terminal mounted without marking it active. */
  terminalActive?: boolean
  /** Split panes render a drag affordance at the start of their header. */
  dragHandle?: ReactNode
  /** Another session runs in this session's worktree, so removal only detaches. */
  worktreeShared?: boolean
}

/** Transient progress while a checkout is checked, repaired, or started. */
export function SessionProgressPanel({
  phase
}: {
  phase: RecoveryPhase
}): React.JSX.Element {
  const t = useT()
  const message =
    phase === 'checking'
      ? t('session.recovery.checking')
      : phase === 'repairing'
        ? t('session.recovery.repairing')
        : t('session.recovery.starting')
  return (
    <div
      className="absolute inset-0 z-10 flex items-center justify-center bg-background p-6"
      data-testid="session-recovery"
      data-recovery-phase={phase}
    >
      <span className="inline-flex items-center gap-2 text-[12px] text-muted-foreground">
        <Loader2 size={14} className="animate-spin" />
        {message}
      </span>
    </div>
  )
}

/**
 * The only blocking session panel.
 *
 * It appears after automatic repair has exhausted its options, so it never
 * blames Git for a process failure. Technical evidence stays collapsed.
 */
export function SessionProblemPanel({
  session,
  worktree,
  onRetry,
  onRemove,
  onStartFresh
}: {
  session: SessionSummary
  worktree: WorktreeSummary | null
  onRetry: () => void
  onRemove: () => void
  onStartFresh: () => void
}): React.JSX.Element {
  const t = useT()
  const startFresh = worktree?.error?.code === 'WORKTREE_UNRECOVERABLE'
  const error = session.error ?? worktree?.error ?? null
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-background p-6">
      <div
        className="w-full max-w-md rounded-lg border border-border bg-card p-5"
        data-testid="session-problem"
      >
        <div className="flex items-center gap-2">
          <AlertTriangle size={14} className="text-destructive" />
          <h2 className="text-[13px] font-semibold">{t('session.problem.title')}</h2>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {t('session.problem.body')}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] hover:bg-muted"
            onClick={onRetry}
            data-testid="session-problem-retry"
          >
            <RotateCcw size={12} />
            {t('session.problem.retry')}
          </button>
          {startFresh ? (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] hover:bg-muted"
              onClick={onStartFresh}
              data-testid="session-problem-fresh"
            >
              <Play size={12} />
              {t('session.problem.freshWorkspace')}
            </button>
          ) : null}
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] text-muted-foreground hover:bg-muted"
            onClick={onRemove}
            data-testid="session-problem-remove"
          >
            <Trash2 size={12} />
            {t('session.problem.remove')}
          </button>
        </div>
        <details className="mt-3 text-[10px] text-muted-foreground">
          <summary className="cursor-pointer select-none">
            {t('session.problem.technical')}
          </summary>
          <dl className="mt-2 space-y-1 rounded-md border border-border bg-background px-3 py-2 font-mono text-[10px]">
            <div className="break-all">
              {t('session.technical.session')}{' '}
              <span className="text-foreground">{session.id}</span>
            </div>
            {error ? (
              <div className="break-all">
                {t('session.technical.error')}{' '}
                <span className="text-destructive">
                  {error.message}
                  {error.detail ? ` — ${error.detail}` : ''}
                </span>
              </div>
            ) : null}
            {worktree ? (
              <>
                <div className="break-all">
                  {t('session.technical.path')}{' '}
                  <span className="text-foreground">{worktree.path}</span>
                </div>
                <div>
                  {t('session.technical.branch')}{' '}
                  <span className="text-foreground">{worktree.branch}</span>
                </div>
                <div>
                  {t('session.technical.baseline')}{' '}
                  <span className="text-foreground">{worktree.baseOid.slice(0, 12)}</span>
                </div>
              </>
            ) : null}
          </dl>
        </details>
      </div>
    </div>
  )
}

function paneActive(session: SessionSummary, candidate: SessionSummary): boolean {
  if (session.id !== candidate.id) return false
  if (session.incarnationId === null) return candidate.incarnationId === null
  return session.incarnationId === candidate.incarnationId
}

export function StatePanel({
  session,
  onRestart,
  onResume,
  onRecheck
}: {
  session: SessionSummary
  onRestart: () => void
  onResume?: () => void
  onRecheck: () => void
}): React.JSX.Element {
  const t = useT()
  const live = session.state === 'live' || session.state === 'starting'
  const unreachable = hostUnavailable(session)
  // An unreachable Host is the reason the panel is here; name it in the visible
  // copy instead of leaving that only in the collapsed technical details.
  const body = unreachable
    ? authorityNote(session)
    : live
      ? t('session.statePanel.attachingBody')
      : session.state === 'exited'
        ? t('session.statePanel.stoppedBody')
        : session.state === 'unavailable'
          ? t('session.statePanel.unavailableBody')
          : t('session.problem.body')
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
              ? t('session.statePanel.attaching')
              : session.state === 'exited'
                ? t('session.statePanel.exited')
                : session.state === 'failed'
                  ? t('session.statePanel.failed')
                  : t('session.statePanel.unavailable')}
          </h2>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{body}</p>
        {!live ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {onResume !== undefined && session.resumable === true ? (
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                onClick={onResume}
                disabled={unreachable}
                title={
                  unreachable
                    ? t('session.hostUnreachable')
                    : t('session.resumeDescription')
                }
                data-testid="state-resume"
              >
                <Play size={12} />
                {t('session.resumeButton')}
              </button>
            ) : null}
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] hover:bg-muted"
              onClick={unreachable ? onRecheck : onRestart}
              data-testid={unreachable ? 'state-reconnect' : 'state-restart'}
            >
              {unreachable ? <RefreshCw size={12} /> : <RotateCcw size={12} />}
              {unreachable ? t('session.problem.retry') : t('session.restartButton')}
            </button>
          </div>
        ) : null}
        <details className="mt-3 text-[10px] text-muted-foreground">
          <summary className="cursor-pointer select-none">
            {t('session.problem.technical')}
          </summary>
          <div className="mt-2 space-y-1 rounded-md border border-border bg-background px-3 py-2">
            <p>{authorityNote(session)}</p>
            {session.error ? (
              <p className="break-words font-mono text-destructive">
                {session.error.message}
                {session.error.detail ? ` — ${session.error.detail}` : ''}
              </p>
            ) : null}
            {session.exitCode !== null && !live ? (
              <p>{t('session.exitCode', { code: session.exitCode })}</p>
            ) : null}
          </div>
        </details>
      </div>
    </div>
  )
}

export default function SessionWorkspace({
  session,
  repo,
  pending,
  recovery = null,
  panes,
  onRestart,
  onResume,
  onSleep,
  onWake,
  allowSleep = false,
  onRecheck,
  onRemove,
  onRecoverWorktree,
  onError,
  notify,
  refreshToken,
  centerRequest = null,
  onCenterRequestHandled,
  diffRequest = null,
  onDiffRequestHandled,
  onOpenHistory,
  drafts,
  focused = true,
  hideHeader = false,
  contentOnly = false,
  terminalActive = true,
  dragHandle,
  worktreeShared = false
}: Props): React.JSX.Element {
  const t = useT()
  const locale = useLocale()
  const worktree = session.worktree
  const unsavedFiles = useFilesDirtyCount(session.id)
  const blocked = worktreeBlocksTerminal(worktree)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [sleepOpen, setSleepOpen] = useState(false)
  // A quick check should not flash a progress panel; a real repair should.
  const [progressVisible, setProgressVisible] = useState(false)
  const recovering = recovery !== null

  useEffect(() => {
    if (!recovering) {
      setProgressVisible(false)
      return
    }
    const timer = setTimeout(() => setProgressVisible(true), 300)
    return () => clearTimeout(timer)
  }, [recovering])

  useEffect(() => {
    setDetailsOpen(false)
  }, [session.id])

  const activity = session.activity
  // Unknown is an absence of evidence, not a state worth occupying the compact
  // header with. Details explains why it is absent.
  const knownActivity = isKnownActivity(activity) ? activity : null
  const activePane = !blocked && panes.some((candidate) => paneActive(session, candidate))
  const actions = sessionActionState(session, pending, allowSleep)
  const terminalView = (
    <div className="relative min-h-0 flex-1 bg-background" data-testid="terminal-view">
      {panes.map((candidate) => (
        <TerminalPane
          key={`${candidate.id}:${candidate.incarnationId ?? 'pending'}`}
          session={candidate}
          active={terminalActive && paneActive(session, candidate)}
          onError={onError}
        />
      ))}
      {!activePane && recovery !== null && progressVisible ? (
        <SessionProgressPanel phase={recovery} />
      ) : !activePane && worktree && (blocked || worktree.status === 'failed') ? (
        <SessionProblemPanel
          session={session}
          worktree={worktree}
          onRetry={() => onRestart(session.id)}
          onRemove={() => setRemoveOpen(true)}
          onStartFresh={() =>
            onRecoverWorktree(session.id, { keepExistingAsAside: true })
          }
        />
      ) : !activePane ? (
        <StatePanel
          session={session}
          onRestart={() => onRestart(session.id)}
          onResume={onResume === undefined ? undefined : () => onResume(session.id)}
          onRecheck={() => onRecheck(session.id)}
        />
      ) : null}
    </div>
  )

  if (contentOnly) {
    return (
      <section
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        data-testid="session-pane"
        data-session-id={session.id}
      >
        {terminalView}
      </section>
    )
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      {hideHeader ? null : (
      <header
        className="icode-titlebar shrink-0 border-b border-border bg-background"
        data-testid="session-header"
      >
        <div className="flex h-12 items-center gap-2 px-3">
          {dragHandle}
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
            <h1
              className="min-w-0 flex-1 truncate text-[15px] font-semibold leading-none tracking-[-0.01em]"
              data-testid="session-title"
            >
              {session.title}
            </h1>
            {session.role === 'supervisor' ? (
              <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-wide text-accent">
                Supervisor
              </span>
            ) : null}
            <span
              className={`inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border px-1.5 text-[10px] font-medium ${sessionStatePillClass(session, pending)}`}
              data-testid="session-state"
              data-state={session.state}
              data-sleeping={String(session.sleeping === true)}
              data-authority={session.authority}
              data-reason={session.reason}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${sessionStateDotClass(session, pending)}`} />
              {sessionStateLabelFor(session, pending)}
            </span>
            <span
              className={`min-w-0 shrink-0 items-center gap-1 text-[10.5px] ${activityTone(activity)} ${
                knownActivity === null ? 'hidden' : 'inline-flex'
              }`}
              title={knownActivity === null ? undefined : activityTooltip(knownActivity)}
              data-testid="session-activity"
              data-activity={activity?.state ?? 'unknown'}
              data-activity-tool={activity?.toolName ?? ''}
              data-activity-unread={String(activity?.unread ?? false)}
            >
              {knownActivity === null ? null : (
                <>
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityDotClass(knownActivity)}`}
                  />
                  <span className="hidden max-w-[110px] truncate md:inline">
                    {activityLabel(knownActivity)}
                  </span>
                </>
              )}
            </span>
            {activity && activity.subagents.length > 0 ? (
              <span
                className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-1.5 text-[10px] text-muted-foreground"
                data-testid="session-subagents"
                data-count={activity.subagents.length}
                title={activity.subagents.map((child) => child.label).join('\n')}
              >
                {t('activity.subagentsCount', { count: activity.subagents.length })}
              </span>
            ) : null}
            {/*
             * Branch, path and baseline are not header material: they are Git
             * implementation details. Session details carries them for support.
             */}
            <span
              className="sr-only"
              title={t('worktree.incarnationTitle')}
            >
              {t('worktree.incarnation')}{' '}
              <span className="font-mono" data-testid="session-incarnation">
                {shortId(session.incarnationId)}
              </span>
            </span>
            <span className="sr-only" title={authorityNote(session)}>
              {authorityNote(session)}
            </span>
            <span className="sr-only">
              {t('worktree.summary', {
                project: repo?.displayName ?? t('worktree.workspace'),
                harness:
                  repo?.target.kind === 'wsl'
                    ? t('worktree.harnessInDistro', {
                        harness: harnessName(session.harness),
                        distro: repo.target.distro
                      })
                    : harnessName(session.harness),
                base: worktree?.baseOid.slice(0, 7) ?? '—'
              })}
            </span>
          </div>

          <SessionActionsMenu
            state={actions}
            allowSleep={allowSleep}
            wakeDescription={wakeDescription(session.harness, locale)}
            sleepDisabledReason={t('session.onlyLiveCanSleep')}
            resumeReason={t('session.resumeDescription')}
            restartReason={t('session.restartDescription')}
            removeReason={t('session.removeReason')}
            onDetails={() => setDetailsOpen(true)}
            onSleep={() => setSleepOpen(true)}
            onWake={() => onWake?.(session.id)}
            onResume={() => onResume?.(session.id)}
            onRestart={() => onRestart(session.id)}
            onRemove={() => setRemoveOpen(true)}
          />
        </div>
      </header>
      )}

      {session.worktree === null && isAgentHarness(session.harness) ? (
        <div
          className="flex shrink-0 items-start gap-2 border-b border-signal-line bg-signal-weak px-4 py-1.5 text-[10.5px] text-signal"
          data-testid="default-checkout-warning"
        >
          <AlertTriangle size={11} className="mt-0.5 shrink-0" />
          <span>{t('session.defaultCheckoutWarning')}</span>
        </div>
      ) : null}

      <SessionFilesWatchHost sessionId={session.id} />

      <SessionCenterTabs
        sessionId={session.id}
        refreshToken={refreshToken}
        notify={notify}
        focused={focused}
        hideStrip={hideHeader}
        request={centerRequest}
        onRequestHandled={onCenterRequestHandled ?? (() => undefined)}
        diffRequest={diffRequest}
        onDiffRequestHandled={onDiffRequestHandled ?? (() => undefined)}
        onOpenHistory={onOpenHistory}
        drafts={drafts}
        sessionState={session.state}
        terminal={terminalView}
      />

      {detailsOpen ? (
        <SessionDetailsDrawer
          session={session}
          repo={repo}
          onClose={() => setDetailsOpen(false)}
        />
      ) : null}

      {sleepOpen ? (
        <SleepSessionDialog
          session={session}
          onClose={() => setSleepOpen(false)}
          onConfirm={() => {
            setSleepOpen(false)
            onSleep?.(session.id)
          }}
        />
      ) : null}

      {removeOpen ? (
        <RemoveSessionDialog
          session={session}
          unsavedCount={unsavedFiles}
          sharedWorktree={worktreeShared}
          onClose={() => setRemoveOpen(false)}
          onConfirm={(deleteBranch) => {
            setRemoveOpen(false)
            onRemove(session.id, { deleteBranch })
          }}
        />
      ) : null}
    </section>
  )
}
