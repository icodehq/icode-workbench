import type { AppError } from '../../../../shared/domain/errors'
import type { RepositorySummary, SessionSummary } from '../../../../shared/schemas/ipc'
import type { AgentSendResult } from '../../lib/agent-send'
import type { WorkbenchDraftStore } from '../../review/drafts'
import type { OpenFileRequest, ViewRequest } from '../../router/use-app-navigation'
import type { Notice, PendingAction } from '../../state/workspace'
import SessionWorkspace from '../../components/SessionWorkspace'

type Props = {
  session: SessionSummary
  repo: RepositorySummary | null
  pending: PendingAction | null
  panes: SessionSummary[]
  allowSleep?: boolean
  refreshToken: number
  openRequest: OpenFileRequest | null
  viewRequest: ViewRequest | null
  drafts: WorkbenchDraftStore
  sessionsListHidden?: boolean
  onShowSessionsList?: () => void
  onRestart: (sessionId: string) => void
  onSleep: (sessionId: string) => void
  onWake: (sessionId: string) => void
  onRecheck: (sessionId: string) => void
  onRemove: (sessionId: string) => void
  onRecoverWorktree: (sessionId: string) => void
  onError: (error: AppError) => void
  notify: (notice: Notice) => void
  onSendToAgent: (text: string) => Promise<AgentSendResult>
  onClearOpenRequest: () => void
  onRequestOpenInFiles: (path: string, line: number) => void
  onClearViewRequest: () => void
}

/**
 * Wires a session to the workspace UI.
 *
 * It owns no application state: the session, pane pool, requests, drafts and
 * every action stay with their existing owners.
 */
export default function SessionHost({
  session,
  repo,
  pending,
  panes,
  allowSleep,
  refreshToken,
  openRequest,
  viewRequest,
  drafts,
  sessionsListHidden,
  onShowSessionsList,
  onRestart,
  onSleep,
  onWake,
  onRecheck,
  onRemove,
  onRecoverWorktree,
  onError,
  notify,
  onSendToAgent,
  onClearOpenRequest,
  onRequestOpenInFiles,
  onClearViewRequest
}: Props): React.JSX.Element {
  return (
    <SessionWorkspace
      session={session}
      repo={repo}
      pending={pending}
      panes={panes}
      onRestart={onRestart}
      onSleep={onSleep}
      onWake={onWake}
      allowSleep={allowSleep}
      onRecheck={onRecheck}
      onRemove={onRemove}
      onRecoverWorktree={onRecoverWorktree}
      onError={onError}
      notify={notify}
      refreshToken={refreshToken}
      openRequest={openRequest}
      onOpenRequestHandled={onClearOpenRequest}
      onSendToAgent={onSendToAgent}
      drafts={drafts}
      onRequestOpenInFiles={onRequestOpenInFiles}
      viewRequest={viewRequest}
      onViewRequestHandled={onClearViewRequest}
      sessionsListHidden={sessionsListHidden}
      onShowSessionsList={onShowSessionsList}
    />
  )
}
