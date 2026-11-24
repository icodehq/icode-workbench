import { Plus } from 'lucide-react'
import type { AppError } from '../../../../shared/domain/errors'
import type { RepositorySummary, SessionSummary } from '../../../../shared/schemas/ipc'
import type { AgentSendResult } from '../../lib/agent-send'
import type { WorkbenchDraftStore } from '../../review/drafts'
import type { OpenFileRequest, ViewRequest } from '../../router/use-app-navigation'
import type { Notice, PendingAction, RecoveryPhase } from '../../state/workspace'
import type { PendingCreate } from '../../state/pending-create'
import type { DirectSessionActions } from '../../state/session-actions'
import type { CreateSessionOutcome, CreateSessionRequest } from '../../state/use-workspace'
import { useT } from '../../i18n/use-i18n'
import WorktreeSurface, { type NewSessionInitialCheckout } from './WorktreeSurface'

type Props = {
  repo: RepositorySummary | null
  sessions: SessionSummary[]
  activeSession: SessionSummary | null
  pendingCreate: PendingCreate | null
  pending: Record<string, PendingAction>
  recovery: Record<string, RecoveryPhase>
  focusActive: boolean
  paneSessions: SessionSummary[]
  refreshToken: number
  openRequest: OpenFileRequest | null
  viewRequest: ViewRequest | null
  drafts: WorkbenchDraftStore
  sendToAgent: (text: string, session: SessionSummary) => Promise<AgentSendResult>
  onSelectSession: (sessionId: string) => void
  onCreateSession: (input: CreateSessionRequest) => Promise<CreateSessionOutcome>
  onNewSession: (initialCheckout?: NewSessionInitialCheckout) => void
  sessionActions: DirectSessionActions
  onError: (error: AppError) => void
  notify: (notice: Notice) => void
  onClearOpenRequest: () => void
  onClearViewRequest: () => void
}

/**
 * The direct-session surface. A project without sessions keeps the existing
 * start card; everything else renders the active worktree's tab list, panes and
 * inspector.
 */
export default function SessionsSurface(props: Props): React.JSX.Element {
  const t = useT()
  const { repo, activeSession } = props

  if (repo === null) return <></>

  if (activeSession === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="sessions-surface">
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
              onClick={() => props.onNewSession()}
              data-testid="empty-new-session"
            >
              <Plus size={12} />
              {t('sessions.newSession')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return <WorktreeSurface {...props} repo={repo} activeSession={activeSession} />
}
