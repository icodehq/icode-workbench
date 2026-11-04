import { Plus } from 'lucide-react'
import type { AppError } from '../../../shared/domain/errors'
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
import ProjectSessionsList from '../components/ProjectSessionsList'
import SessionHost from '../features/sessions/SessionHost'

export type SessionsPageProps = {
  repo: RepositorySummary | null
  sessions: SessionSummary[]
  activeSession: SessionSummary | null
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
  if (repo === null) return <></>

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
          branches={branches}
          orphans={orphans}
          onSelectSession={onSelectSession}
          onNewSession={onNewSession}
          onRemoveBranch={onRemoveBranch}
          onCollapse={onCollapseSessions}
        />
      ) : null}
      <div className="flex min-w-0 flex-1">
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
        ) : (
          <div className="flex flex-1 items-center justify-center p-8">
            <div className="w-full max-w-md rounded-lg border border-border bg-card p-6">
              <h1 className="text-[14px] font-semibold">No direct sessions in {repo.displayName}</h1>
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                Direct sessions open a live terminal immediately. Tasks have their own list and do not
                appear here.
              </p>
              <button
                type="button"
                className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[11px] font-medium text-accent-ink hover:opacity-90"
                onClick={onNewSession}
                data-testid="empty-new-session"
              >
                <Plus size={12} />
                New session
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
