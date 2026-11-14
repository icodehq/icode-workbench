import { useEffect, useState } from 'react'
import { FileDiff, Files, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { isAgentHarness } from '../../../../shared/domain/harness'
import type { RepositorySummary, SessionSummary } from '../../../../shared/schemas/ipc'
import type { AgentSendResult } from '../../lib/agent-send'
import type { WorkbenchDraftStore } from '../../review/drafts'
import type { Notice } from '../../state/workspace'
import ChangesPanel from '../ChangesPanel'
import FilesPanel from '../FilesPanel'
import { useT } from '../../i18n/use-i18n'

type Pane = 'changes' | 'files'

type Props = {
  session: SessionSummary
  repo: RepositorySummary | null
  refreshToken: number
  openRequest: { path: string; line: number; nonce: number } | null
  onOpenRequestHandled: () => void
  requestedPane: { pane: Pane; nonce: number } | null
  notify: (notice: Notice) => void
  drafts: WorkbenchDraftStore
  onSendToAgent: (text: string) => Promise<AgentSendResult>
  onRecheck: () => void
  onOpenTerminal?: () => void
  collapsed: boolean
  onToggleCollapsed: () => void
  /** Narrow viewports render the inspector above the workspace, not beside it. */
  overlay?: boolean
}

/**
 * Persistent right-hand inspector for a direct session.
 *
 * Terminal stays in the center; Files and Changes live here. Both panes stay
 * mounted once visited, and collapse only hides the shell so editor state and
 * SCM polling survive.
 */
export default function SessionInspector({
  session,
  repo,
  refreshToken,
  openRequest,
  onOpenRequestHandled,
  requestedPane,
  notify,
  drafts,
  onSendToAgent,
  onRecheck,
  onOpenTerminal,
  collapsed,
  onToggleCollapsed,
  overlay = false
}: Props): React.JSX.Element {
  const t = useT()
  const [pane, setPane] = useState<Pane>('files')
  const [visited, setVisited] = useState<Set<Pane>>(() => new Set<Pane>(['files']))
  const [historyRequest, setHistoryRequest] = useState<{ path: string; nonce: number } | null>(
    null
  )
  const [fileRequest, setFileRequest] = useState<{
    path: string
    line: number
    nonce: number
  } | null>(null)

  const selectPane = (next: Pane): void => {
    setPane(next)
    setVisited((current) => {
      if (current.has(next)) return current
      const updated = new Set(current)
      updated.add(next)
      return updated
    })
  }

  useEffect(() => {
    if (!requestedPane) return
    selectPane(requestedPane.pane)
  }, [requestedPane?.nonce])

  useEffect(() => {
    if (!openRequest) return
    selectPane('files')
  }, [openRequest?.nonce])

  const worktree = session.worktree

  return (
    <aside
      className={`flex h-full shrink-0 flex-col border-l border-border bg-background ${
        collapsed
          ? 'w-9'
          : overlay
            ? 'w-[360px] max-w-[85vw] shadow-2xl'
            : 'w-[640px] max-w-[calc(100vw-420px)]'
      }`}
      aria-label={t('session.inspector')}
      data-testid="session-inspector"
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      {collapsed ? (
        <button
          type="button"
          className="flex h-full w-full flex-col items-center gap-2 pt-3 text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          onClick={onToggleCollapsed}
          aria-label={t('session.showInspector')}
          title={t('session.showInspector')}
          data-testid="inspector-expand"
        >
          <PanelLeftOpen size={13} className="rotate-180" />
          <span className="[writing-mode:vertical-rl] text-[8px] uppercase tracking-[0.12em]">
            {t('session.inspector')}
          </span>
        </button>
      ) : null}
      <div className={collapsed ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2">
            <div className="min-w-0 flex-1">
              <div className="text-[8px] uppercase tracking-[0.12em] text-muted-foreground">
                {t('session.inspector')}
              </div>
              <div className="truncate text-[10px] text-foreground" title={worktree?.path}>
                {repo?.displayName ?? t('worktree.workspace')}
                <span className="text-muted-foreground"> / </span>
                <span className="font-mono">
                  {worktree?.branch ?? t('worktree.primaryCheckout')}
                </span>
              </div>
            </div>
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={onToggleCollapsed}
              aria-label={t('session.hideInspector')}
              title={t('session.hideInspector')}
              data-testid="inspector-collapse"
            >
              <PanelLeftClose size={12} />
            </button>
          </div>

          <nav
            className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border px-2"
            role="tablist"
            aria-label={t('session.inspector')}
          >
            <button
              type="button"
              role="tab"
              aria-selected={pane === 'changes'}
              className={`inline-flex h-8 items-center gap-1.5 border-b-2 px-2 text-[10.5px] ${
                pane === 'changes'
                  ? 'border-accent text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => selectPane('changes')}
              data-testid="view-changes"
            >
              <FileDiff size={12} />
              {t('session.viewSourceControl')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={pane === 'files'}
              className={`inline-flex h-8 items-center gap-1.5 border-b-2 px-2 text-[10.5px] ${
                pane === 'files'
                  ? 'border-accent text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => selectPane('files')}
              data-testid="view-files"
            >
              <Files size={12} />
              {t('session.viewFiles')}
            </button>
          </nav>

          <div className="relative min-h-0 flex-1">
            <div
              className={`h-full min-h-0 ${pane === 'files' ? '' : 'hidden'}`}
              data-testid="files-view"
            >
              {visited.has('files') ? (
                <FilesPanel
                  sessionId={session.id}
                  refreshToken={refreshToken}
                  active={!collapsed && pane === 'files'}
                  notify={notify}
                  openRequest={fileRequest ?? openRequest}
                  onOpenRequestHandled={() => {
                    setFileRequest(null)
                    onOpenRequestHandled()
                  }}
                  onOpenHistory={(path) => {
                    setHistoryRequest({ path, nonce: Date.now() })
                    selectPane('changes')
                  }}
                  editorEngine="monaco"
                />
              ) : null}
            </div>
            <div
              className={`h-full min-h-0 ${pane === 'changes' ? '' : 'hidden'}`}
              data-testid="changes-view"
            >
              {visited.has('changes') ? (
                <ChangesPanel
                  sessionId={session.id}
                  sessionState={session.state}
                  repoId={session.repoId}
                  harness={session.harness}
                  baseOid={worktree?.baseOid ?? null}
                  refreshToken={refreshToken}
                  active={!collapsed && pane === 'changes'}
                  notify={notify}
                  onOpenPath={(path) => {
                    setFileRequest({ path, line: 1, nonce: Date.now() })
                    selectPane('files')
                  }}
                  onOpenTerminal={() => onOpenTerminal?.()}
                  onSendToAgent={onSendToAgent}
                  canSendToAgent={session.state === 'live' && isAgentHarness(session.harness)}
                  drafts={drafts}
                  onChanged={onRecheck}
                  initialHistoryPath={historyRequest}
                  onHistoryPathHandled={() => setHistoryRequest(null)}
                />
              ) : null}
            </div>
          </div>
      </div>
    </aside>
  )
}
