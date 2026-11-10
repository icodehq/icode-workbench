import { Loader2, Plus } from 'lucide-react'
import type { AppError } from '../../../shared/domain/errors'
import { harnessLabel } from '../../../shared/domain/harness'
import type {
  OrphanedHostSession,
  OwnedBranchSummary,
  RepositorySummary,
  SessionSummary
} from '../../../shared/schemas/ipc'
import type { AgentSendResult } from '../lib/agent-send'
import type { WorkbenchDraftStore } from '../review/drafts'
import type { OpenFileRequest, ViewRequest } from '../router/use-app-navigation'
import type { Notice, PendingAction } from '../state/workspace'
import {
  pendingCreateForRepo,
  type PendingCreate
} from '../state/pending-create'
import ProjectSessionsList from '../components/ProjectSessionsList'
import SessionHost from '../components/SessionHost'
import { useT } from '../i18n/use-i18n'

export type SessionsPageProps = {
  repo: RepositorySummary | null
  sessions: SessionSummary[]
  activeSession: SessionSummary | null
  /** Presentation-only create in flight for this window; never a SessionSummary. */
  pendingCreate: PendingCreate | null
  pending: Record<string, PendingAction>
  branches: OwnedBranchSummary[]
  orphans: OrphanedHostSession[]
  sessionsListOpen: boolean
  focusActive: boolean

  onSelectSession: (sessionId: string) => void
  onNewSession: () => void
  onRemoveBranch: (branch: string) => void
  onCollapseSessions: () => void
  onShowSessionsList: () => void

  paneSessions: SessionSummary[]
  refreshToken: number
  openRequest: OpenFileRequest | null
  viewRequest: ViewRequest | null
  drafts: WorkbenchDraftStore
  sendToAgent: (text: string, session: SessionSummary) => Promise<AgentSendResult>

  onRestartSession: (sessionId: string) => void
  onSleepSession: (sessionId: string) => void
  onWakeSession: (sessionId: string) => void
  onRecheckSession: (sessionId: string) => void
  onRemoveSession: (sessionId: string) => void
  onRecoverWorktree: (sessionId: string) => void
  onError: (error: AppError) => void
  notify: (notice: Notice) => void

  onClearOpenRequest: () => void
  onRequestOpenInFiles: (path: string, line: number) => void
  onClearViewRequest: () => void
}

export default function SessionsPage({
  repo,
  sessions,
  activeSession,
  pendingCreate,
  pending,
  branches,
  orphans,
  sessionsListOpen,
  focusActive,
  onSelectSession,
  onNewSession,
  onRemoveBranch,
  onCollapseSessions,
  onShowSessionsList,
  paneSessions,
  refreshToken,
  openRequest,
  viewRequest,
  drafts,
  sendToAgent,
  onRestartSession,
  onSleepSession,
  onWakeSession,
  onRecheckSession,
  onRemoveSession,
  onRecoverWorktree,
  onError,
  notify,
  onClearOpenRequest,
  onRequestOpenInFiles,
  onClearViewRequest
}: SessionsPageProps): React.JSX.Element {
  const t = useT()
  if (repo === null) return <></>

  const pendingForRepo = pendingCreateForRepo(pendingCreate, repo.id)
  const showSessionsList =
    activeSession === null || (sessionsListOpen && !focusActive)
  const sessionsListHidden = !sessionsListOpen && !focusActive

  return (
    <div className="flex min-h-0 flex-1 max-[900px]:flex-col">
      {showSessionsList ? (
        <ProjectSessionsList
          repo={repo}
          sessions={sessions}
          activeSessionId={activeSession?.id ?? null}
          pending={pending}
          pendingCreate={pendingForRepo}
          branches={branches}
          orphans={orphans}
          onSelectSession={onSelectSession}
          onNewSession={onNewSession}
          onRemoveBranch={onRemoveBranch}
          onCollapse={onCollapseSessions}
        />
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {pendingForRepo !== null && activeSession !== null ? (
          <PendingCreateSurface
            pending={pendingForRepo}
            project={repo.displayName}
            compact
          />
        ) : null}
        {activeSession !== null ? (
          <SessionHost
            session={activeSession}
            repo={repo}
            pending={pending[activeSession.id] ?? null}
            panes={paneSessions}
            allowSleep
            refreshToken={refreshToken}
            openRequest={openRequest}
            viewRequest={viewRequest}
            drafts={drafts}
            sessionsListHidden={sessionsListHidden}
            onShowSessionsList={sessionsListHidden ? onShowSessionsList : undefined}
            onRestart={onRestartSession}
            onSleep={onSleepSession}
            onWake={onWakeSession}
            onRecheck={onRecheckSession}
            onRemove={onRemoveSession}
            onRecoverWorktree={onRecoverWorktree}
            onError={onError}
            notify={notify}
            onSendToAgent={(text) => sendToAgent(text, activeSession)}
            onClearOpenRequest={onClearOpenRequest}
            onRequestOpenInFiles={onRequestOpenInFiles}
            onClearViewRequest={onClearViewRequest}
          />
        ) : pendingForRepo !== null ? (
          <div className="flex flex-1 items-center justify-center p-8">
            <PendingCreateSurface
              pending={pendingForRepo}
              project={repo.displayName}
              compact={false}
            />
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center p-8">
            <div className="w-full max-w-md rounded-lg border border-border bg-card p-6">
              <h1 className="text-[14px] font-semibold">
                {t('sessions.empty.title', { project: repo.displayName })}
              </h1>
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                {t('sessions.empty.body')}
              </p>
              <button
                type="button"
                className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[11px] font-medium text-accent-ink hover:opacity-90"
                onClick={onNewSession}
                data-testid="empty-new-session"
              >
                <Plus size={12} />
                {t('sessions.newSession')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The create-in-flight surface.
 *
 * It is deliberately not a `SessionSummary`: no id exists yet, and a synthetic
 * row would flow into selection, pane mounting and localStorage. This panel is
 * the only feedback until the real session arrives; the main process emits it
 * over the ordinary session state event.
 */
function PendingCreateSurface({
  pending,
  project,
  compact
}: {
  pending: PendingCreate
  project: string
  compact: boolean
}): React.JSX.Element {
  const t = useT()
  return (
    <div
      className={
        compact
          ? 'flex items-start gap-2 border-b border-signal-line bg-signal-weak px-4 py-2 text-[11px] text-signal'
          : 'w-full max-w-md rounded-lg border border-border bg-card p-6'
      }
      data-testid="pending-session-panel"
      data-harness={pending.harness}
      data-repo-id={pending.repoId}
      role="status"
      aria-live="polite"
    >
      <Loader2
        size={compact ? 12 : 16}
        className={`shrink-0 animate-spin ${compact ? 'mt-0.5' : 'mt-0.5 text-signal'}`}
      />
      <div className="min-w-0">
        <p className={compact ? 'font-medium' : 'text-[14px] font-semibold'}>
          {t('newSession.starting', { harness: harnessLabel(pending.harness) })}
        </p>
        <p
          className={
            compact
              ? 'mt-0.5 text-[10.5px] opacity-80'
              : 'mt-2 text-[11px] leading-relaxed text-muted-foreground'
          }
        >
          {t('newSession.startingBody', { project })}
        </p>
        <p
          className={
            compact
              ? 'mt-0.5 truncate text-[10px] opacity-70'
              : 'mt-1 truncate text-[10.5px] text-muted-foreground'
          }
        >
          {pending.title}
        </p>
      </div>
    </div>
  )
}
