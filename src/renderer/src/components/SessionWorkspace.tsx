import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  FileDiff,
  Files,
  GitBranch,
  GitMerge,
  Loader2,
  PanelLeftOpen,
  RefreshCw,
  RotateCcw,
  TerminalSquare,
  Trash2,
  Upload
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
import type { Notice, PendingAction } from '../state/workspace'
import TerminalPane from './TerminalPane'
import ChangesPanel from './ChangesPanel'
import FilesPanel from './FilesPanel'
import MergeDialog from './MergeDialog'
import PushDialog from './PushDialog'
import RemoveSessionDialog from './RemoveSessionDialog'
import SessionActionsMenu from './SessionActionsMenu'
import SleepSessionDialog from './SleepSessionDialog'
import SessionDetailsDrawer from './SessionDetailsDrawer'
import { translate } from '../i18n/i18n-store'
import { useLocale, useT } from '../i18n/use-i18n'
import { useFilesDirtyCount } from '../files/open-files'
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
  panes: SessionSummary[]
  onRestart: (sessionId: string) => void
  onSleep?: (sessionId: string) => void
  onWake?: (sessionId: string) => void
  /** Direct sessions support hibernate; task sessions remain scheduler-owned. */
  allowSleep?: boolean
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
  onSendToAgent: (text: string) => Promise<AgentSendResult>
  /** Review notes, feedback and commit message, keyed by session. */
  drafts: WorkbenchDraftStore
  /** Asks the shell to open a file in the Files tab (Git list, review). */
  onRequestOpenInFiles: (path: string, line: number) => void
  /**
   * A view another surface asked for (a task's Changes button).
   *
   * `nonce` makes repeating the same request observable, so clicking "Changes"
   * twice still lands on Changes rather than being ignored as unchanged.
   */
  viewRequest: { view: 'terminal' | 'changes' | 'files'; nonce: number } | null
  onViewRequestHandled: () => void
  /** Shows a labelled restore control only while the Sessions column is hidden. */
  sessionsListHidden?: boolean
  onShowSessionsList?: () => void
}

function worktreeStatusLabel(status: WorktreeSummary['status']): string {
  switch (status) {
    case 'creating':
      return translate('worktree.label.creating')
    case 'incomplete':
      return translate('worktree.label.incomplete')
    case 'ready-to-start':
      return translate('worktree.label.ready')
    case 'active':
      return translate('worktree.label.active')
    case 'missing':
      return translate('worktree.label.missing')
    case 'inconsistent':
      return translate('worktree.label.inconsistent')
    case 'failed':
      return translate('worktree.label.failed')
  }
}

const WORKTREE_STATUS_TONE: Record<WorktreeSummary['status'], string> = {
  creating: 'text-signal',
  incomplete: 'text-signal',
  'ready-to-start': 'text-muted-foreground',
  active: 'text-add',
  missing: 'text-destructive',
  inconsistent: 'text-destructive',
  failed: 'text-destructive'
}

function worktreeBlocksTerminal(worktree: WorktreeSummary | null): boolean {
  return worktree !== null && (worktree.status === 'missing' || worktree.status === 'inconsistent')
}

function hostUnavailable(session: SessionSummary): boolean {
  return (
    session.authority === 'unreachable' ||
    session.reason === 'host_unreachable' ||
    session.reason === 'host_unreachable_history'
  )
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
  const t = useT()
  const missing = worktree.status === 'missing'
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-background p-6">
      <div className="w-full max-w-lg rounded-lg border border-destructive/40 bg-card p-5">
        <div className="flex items-center gap-2">
          <AlertTriangle size={14} className="text-destructive" />
          <h2 className="text-[13px] font-semibold">
            {missing ? t('worktree.missingTitle') : t('worktree.inconsistentTitle')}
          </h2>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {missing ? t('worktree.missingBody') : t('worktree.inconsistentBody')}
        </p>
        <dl className="mt-3 space-y-1 rounded-md border border-border bg-background px-3 py-2 font-mono text-[10px] text-muted-foreground">
          <div>
            {t('worktree.branch')} <span className="text-foreground">{worktree.branch}</span>
          </div>
          <div className="break-all">
            {t('worktree.path')} <span className="text-foreground">{worktree.path}</span>
          </div>
          <div>
            {t('worktree.baseline')} <span className="text-foreground">{worktree.baseOid.slice(0, 12)}</span>
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
              {t('worktree.recreate')}
            </button>
          ) : null}
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] hover:bg-muted"
            onClick={onRecheck}
            data-testid="worktree-recheck"
          >
            <RefreshCw size={12} />
            {t('worktree.checkHost')}
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] text-muted-foreground hover:bg-muted"
            onClick={onRemove}
            data-testid="worktree-remove"
          >
            <Trash2 size={12} />
            {t('worktree.removeSession')}
          </button>
        </div>
        <p className="mt-3 text-[10px] text-muted-foreground">
          {t('worktree.sessionState', {
            state: session.state,
            note: authorityNote(session)
          })}
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

export function StatePanel({
  session,
  onRestart,
  onRecheck
}: {
  session: SessionSummary
  onRestart: () => void
  onRecheck: () => void
}): React.JSX.Element {
  const t = useT()
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
              ? t('session.statePanel.attaching')
              : session.state === 'exited'
                ? t('session.statePanel.exited')
                : session.state === 'failed'
                  ? t('session.statePanel.failed')
                  : t('session.statePanel.unavailable')}
          </h2>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {live ? t('session.statePanel.attachingBody') : authorityNote(session)}
        </p>
        {session.error ? (
          <p className="mt-2 break-words rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 font-mono text-[10px] leading-relaxed text-destructive">
            {session.error.message}
            {session.error.detail ? ` — ${session.error.detail}` : ''}
          </p>
        ) : null}
        {session.exitCode !== null && !live ? (
          <p className="mt-2 text-[10px] text-muted-foreground">
            {t('session.exitCode', { code: session.exitCode })}
          </p>
        ) : null}
        {!live ? (
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
              onClick={onRestart}
              disabled={hostUnavailable(session)}
              title={
                hostUnavailable(session)
                  ? t('session.hostUnreachable')
                  : t('session.restartDescription')
              }
              data-testid="state-restart"
            >
              <RotateCcw size={12} />
              {t('session.restartButton')}
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] hover:bg-muted"
              onClick={onRecheck}
              data-testid="state-recheck"
            >
              <RefreshCw size={12} />
              {t('worktree.checkHost')}
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
  onRestart,
  onSleep,
  onWake,
  allowSleep = false,
  onRecheck,
  onRemove,
  onRecoverWorktree,
  onError,
  notify,
  refreshToken,
  openRequest,
  onOpenRequestHandled,
  onSendToAgent,
  drafts,
  onRequestOpenInFiles,
  viewRequest,
  onViewRequestHandled,
  sessionsListHidden = false,
  onShowSessionsList
}: Props): React.JSX.Element {
  const t = useT()
  const locale = useLocale()
  const worktree = session.worktree
  const unsavedFiles = useFilesDirtyCount(session.id)
  const blocked = worktreeBlocksTerminal(worktree)
  // The view survives re-renders but resets when the active session changes.
  const [view, setView] = useState<'terminal' | 'changes' | 'files'>('terminal')
  const [historyRequest, setHistoryRequest] = useState<{ path: string; nonce: number } | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [sleepOpen, setSleepOpen] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [pushOpen, setPushOpen] = useState(false)

  useEffect(() => {
    setDetailsOpen(false)
  }, [session.id])

  useEffect(() => {
    if (!viewRequest) return
    setView(viewRequest.view)
    onViewRequestHandled()
  }, [viewRequest, onViewRequestHandled])
  const [viewSessionId, setViewSessionId] = useState(session.id)
  if (viewSessionId !== session.id) {
    setViewSessionId(session.id)
    setView('terminal')
    setHistoryRequest(null)
  }
  const activity = session.activity
  // Unknown is an absence of evidence, not a state worth occupying the compact
  // header with. Details explains why it is absent.
  const knownActivity = isKnownActivity(activity) ? activity : null
  const activePane = !blocked && panes.some((candidate) => paneActive(session, candidate))
  const sleeping = session.sleeping === true
  const live = session.state === 'live'
  const canSleep = allowSleep && live && !sleeping && pending === null
  const canWake = allowSleep && sleeping && pending === null
  const sleepDisabledReason =
    pending !== null
      ? t('session.actionPending')
      : t('session.onlyLiveCanSleep')
  const canRestart = pending === null && !blocked && !hostUnavailable(session)
  const restartReason =
    pending === 'restarting'
      ? t('session.restartInProgress')
      : hostUnavailable(session)
        ? t('session.hostUnreachable')
        : blocked
          ? t('session.worktreeBlocked')
          : t('session.restartDescription')

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-border bg-background" data-testid="session-header">
        <div className="flex h-12 items-center gap-2 px-3">
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
            {knownActivity === null ? null : <span className="h-3 w-px shrink-0 bg-border" />}
            {worktree ? (
              <span
                className={`inline-flex min-w-0 max-w-[176px] shrink items-center ${WORKTREE_STATUS_TONE[worktree.status]}`}
                title={`${worktreeStatusLabel(worktree.status)} · ${worktree.path}`}
                data-testid="session-worktree"
                data-worktree-status={worktree.status}
                data-worktree-branch={worktree.branch}
              >
                <GitBranch size={11} className="shrink-0" />
                <span
                  className="min-w-0 truncate font-mono text-[10.5px]"
                  title={`${worktreeStatusLabel(worktree.status)} · ${worktree.branch} · ${worktree.path}`}
                >
                  {worktree.branch}
                </span>
              </span>
            ) : (
              <span
                className="shrink-0 text-[10.5px] text-muted-foreground"
                title={t('worktree.registeredTitle')}
              >
                {t('worktree.primaryCheckout')}
              </span>
            )}
            {/*
             * The compact header shows the branch because it is an action. The
             * rest of the metadata stays in Session details; this screen-reader
             * copy keeps it available without spending a second row.
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

          <div
            className="flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-muted/30 p-0.5"
            role="tablist"
            aria-label={t('session.view')}
          >
            <button
              type="button"
              role="tab"
              aria-selected={view === 'terminal'}
              aria-label={t('session.viewTerminal')}
              title={t('session.viewTerminal')}
              className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded px-2 text-[11px] ${
                view === 'terminal'
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setView('terminal')}
              data-testid="view-terminal"
            >
              <TerminalSquare size={13} />
              <span className="hidden xl:inline">{t('session.viewTerminal')}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'changes'}
              aria-label={t('session.viewSourceControl')}
              title={t('session.viewSourceControl')}
              className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded px-2 text-[11px] ${
                view === 'changes'
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setView('changes')}
              data-testid="view-changes"
            >
              <FileDiff size={13} />
              <span className="hidden xl:inline">{t('session.viewSourceControl')}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'files'}
              aria-label={t('session.viewFiles')}
              title={t('session.viewFiles')}
              className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded px-2 text-[11px] ${
                view === 'files'
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setView('files')}
              data-testid="view-files"
            >
              <Files size={13} />
              <span className="hidden xl:inline">{t('session.viewFiles')}</span>
            </button>
          </div>

          {sessionsListHidden && onShowSessionsList !== undefined ? (
            <button
              type="button"
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={onShowSessionsList}
              title={t('session.showSessions')}
              data-testid="show-sessions-list"
            >
              <PanelLeftOpen size={12} />
              {t('session.sessions')}
            </button>
          ) : null}

          <button
            type="button"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => setMergeOpen(true)}
            disabled={worktree === null || pending !== null}
            title={t('merge.actionTitle')}
            data-testid="session-merge"
          >
            <GitMerge size={12} />
            <span className="hidden lg:inline">{t('merge.action')}</span>
          </button>
          <button
            type="button"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => setPushOpen(true)}
            disabled={worktree === null || pending !== null}
            title={t('push.actionTitle')}
            data-testid="session-push"
          >
            <Upload size={12} />
            <span className="hidden lg:inline">{t('push.action')}</span>
          </button>

          <SessionActionsMenu
            live={allowSleep && live}
            sleeping={allowSleep && sleeping}
            canSleep={canSleep}
            canWake={canWake}
            wakeDescription={wakeDescription(session.harness, locale)}
            sleepDisabledReason={sleepDisabledReason}
            restartDisabled={!canRestart}
            restartReason={restartReason}
            removeDisabled={pending !== null}
            removeReason={
              pending !== null ? t('session.actionPending') : t('session.removeReason')
            }
            onDetails={() => setDetailsOpen(true)}
            onSleep={() => setSleepOpen(true)}
            onWake={() => onWake?.(session.id)}
            onRestart={() => onRestart(session.id)}
            onRemove={() => setRemoveOpen(true)}
          />
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
            onRemove={() => setRemoveOpen(true)}
          />
        ) : !activePane ? (
          <StatePanel
            session={session}
            onRestart={() => onRestart(session.id)}
            onRecheck={() => onRecheck(session.id)}
          />
        ) : null}
      </div>

      <div
        className={`flex min-h-0 flex-1 ${view === 'files' ? '' : 'hidden'}`}
        data-testid="files-view"
      >
        <FilesPanel
          sessionId={session.id}
          refreshToken={refreshToken}
          active={view === 'files'}
          notify={notify}
          openRequest={openRequest}
          onOpenRequestHandled={onOpenRequestHandled}
          onOpenHistory={(path) => {
            setHistoryRequest({ path, nonce: Date.now() })
            setView('changes')
          }}
          editorEngine="monaco"
        />
      </div>

      <div
        className={`min-h-0 flex-1 ${view === 'changes' ? '' : 'hidden'}`}
        data-testid="changes-view"
      >
        <ChangesPanel
          sessionId={session.id}
          sessionState={session.state}
          harness={session.harness}
          baseOid={worktree?.baseOid ?? null}
          refreshToken={refreshToken}
          active={view === 'changes'}
          notify={notify}
          onOpenPath={(path) => {
            setView('files')
            onRequestOpenInFiles(path, 1)
          }}
          onOpenTerminal={() => setView('terminal')}
          onSendToAgent={onSendToAgent}
          canSendToAgent={session.state === 'live' && isAgentHarness(session.harness)}
          drafts={drafts}
          onChanged={() => onRecheck(session.id)}
          initialHistoryPath={historyRequest}
          onHistoryPathHandled={() => setHistoryRequest(null)}
        />
      </div>

      {mergeOpen ? (
        <MergeDialog
          session={session}
          onClose={() => setMergeOpen(false)}
          onMerged={() => {
            setMergeOpen(false)
            notify({
              tone: 'success',
              message: translate('merge.mergedNotice', { branch: worktree?.branch ?? '' })
            })
            onRecheck(session.id)
          }}
          onConflicted={() => {
            setView('changes')
            notify({ tone: 'info', message: translate('merge.conflictNotice') })
          }}
        />
      ) : null}

      {pushOpen ? (
        <PushDialog
          session={session}
          onClose={() => setPushOpen(false)}
          onPushed={(upstream) => {
            setPushOpen(false)
            notify({
              tone: 'success',
              message: translate('push.success', { upstream })
            })
            onRecheck(session.id)
          }}
        />
      ) : null}

      {detailsOpen ? (
        <SessionDetailsDrawer
          session={session}
          repo={repo}
          notify={notify}
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
          onClose={() => setRemoveOpen(false)}
          onConfirm={() => {
            setRemoveOpen(false)
            onRemove(session.id)
          }}
        />
      ) : null}
    </section>
  )
}
