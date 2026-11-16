import { useEffect, useRef, useState } from 'react'
import { FileDiff, Files, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react'
import { isAgentHarness } from '../../../../shared/domain/harness'
import type { SessionSummary } from '../../../../shared/schemas/ipc'
import type { AgentSendResult } from '../../lib/agent-send'
import type { WorkbenchDraftStore } from '../../review/drafts'
import type { Notice } from '../../state/workspace'
import {
  INSPECTOR_WIDTH_DEFAULT,
  clampInspectorWidth,
  loadInspectorWidth,
  saveInspectorWidth
} from '../../state/inspector-layout'
import ChangesPanel from '../ChangesPanel'
import FilesPanel from '../FilesPanel'
import FilesSearchPanel from '../FilesSearchPanel'
import { useT } from '../../i18n/use-i18n'

type Pane = 'changes' | 'files' | 'search'

type Props = {
  session: SessionSummary
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
 *
 * One row carries the pane switch and collapse control: the old eyebrow +
 * repo/branch header only repeated what the session header already shows.
 * The left edge is a drag seam, and the width is remembered, so the panel can
 * grow when a diff or an editor needs the room.
 */
export default function SessionInspector({
  session,
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
  const paneMemory = useRef(new Map<string, Pane>())
  const [visited, setVisited] = useState<Set<Pane>>(() => new Set<Pane>(['files']))
  const [filesReloadToken, setFilesReloadToken] = useState(0)
  const [historyRequest, setHistoryRequest] = useState<{ path: string; nonce: number } | null>(
    null
  )
  const [fileRequest, setFileRequest] = useState<{
    path: string
    line: number
    nonce: number
  } | null>(null)

  const [preferredWidth, setPreferredWidth] = useState<number>(() => loadInspectorWidth())
  const preferredRef = useRef(preferredWidth)
  const [viewportWidth, setViewportWidth] = useState<number>(() =>
    typeof window === 'undefined' ? 1600 : window.innerWidth
  )
  const [resizing, setResizing] = useState(false)
  const resizeAnchor = useRef<{ startX: number; startWidth: number } | null>(null)

  useEffect(() => {
    preferredRef.current = preferredWidth
  }, [preferredWidth])

  useEffect(() => {
    const onResize = (): void => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const width = overlay
    ? Math.min(360, Math.round(viewportWidth * 0.85))
    : clampInspectorWidth(preferredWidth, viewportWidth)

  const setWidth = (next: number): void => {
    preferredRef.current = next
    setPreferredWidth(next)
  }

  const beginResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (collapsed || overlay) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    resizeAnchor.current = { startX: event.clientX, startWidth: width }
    setResizing(true)
  }

  const moveResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    const anchor = resizeAnchor.current
    if (anchor === null) return
    // The inspector sits on the right, so dragging its leading seam left
    // widens it.
    setWidth(
      clampInspectorWidth(anchor.startWidth - (event.clientX - anchor.startX), viewportWidth)
    )
  }

  const endResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (resizeAnchor.current === null) return
    resizeAnchor.current = null
    setResizing(false)
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // The pointer release may already have happened.
    }
    saveInspectorWidth(preferredRef.current)
  }

  const nudgeWidth = (delta: number): void => {
    const next = clampInspectorWidth(preferredRef.current + delta, viewportWidth)
    setWidth(next)
    saveInspectorWidth(next)
  }

  const resetWidth = (): void => {
    const next = clampInspectorWidth(INSPECTOR_WIDTH_DEFAULT, viewportWidth)
    setWidth(next)
    saveInspectorWidth(next)
  }

  const selectPane = (next: Pane): void => {
    paneMemory.current.set(session.id, next)
    setPane(next)
    setVisited((current) => {
      if (current.has(next)) return current
      const updated = new Set(current)
      updated.add(next)
      return updated
    })
  }

  // Termio gives each session its own inspector pane back; do the same. Open
  // files are already per session in the open-files store.
  useEffect(() => {
    const remembered = paneMemory.current.get(session.id) ?? 'files'
    setPane(remembered)
    setVisited((current) => {
      if (current.has(remembered)) return current
      const updated = new Set(current)
      updated.add(remembered)
      return updated
    })
  }, [session.id])

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
      className={`relative flex h-full shrink-0 flex-col border-l border-border bg-background ${
        collapsed ? 'w-9' : ''
      } ${resizing ? 'select-none' : ''} ${overlay && !collapsed ? 'shadow-2xl' : ''}`}
      style={collapsed ? undefined : { width: `${String(width)}px`, maxWidth: '85vw' }}
      aria-label={t('session.inspector')}
      data-testid="session-inspector"
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      {!collapsed && !overlay ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('session.resizeInspector')}
          title={t('session.resizeInspector')}
          tabIndex={0}
          className="absolute inset-y-0 left-0 z-20 w-1.5 cursor-col-resize bg-transparent hover:bg-accent/40 focus-visible:bg-signal focus-visible:outline-none"
          data-testid="inspector-resizer"
          onPointerDown={beginResize}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onDoubleClick={resetWidth}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') {
              event.preventDefault()
              nudgeWidth(16)
            } else if (event.key === 'ArrowRight') {
              event.preventDefault()
              nudgeWidth(-16)
            }
          }}
        />
      ) : null}

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
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-1.5">
          <nav
            className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
            role="tablist"
            aria-label={t('session.inspector')}
          >
            <button
              type="button"
              role="tab"
              aria-selected={pane === 'files'}
              className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded px-2 text-[10.5px] ${
                pane === 'files'
                  ? 'bg-accent/15 text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              }`}
              onClick={() => selectPane('files')}
              data-testid="view-files"
            >
              <Files size={12} />
              {t('session.viewFiles')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={pane === 'search'}
              className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded px-2 text-[10.5px] ${
                pane === 'search'
                  ? 'bg-accent/15 text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              }`}
              onClick={() => selectPane('search')}
              data-testid="view-search"
            >
              <Search size={12} />
              {t('session.viewSearch')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={pane === 'changes'}
              className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded px-2 text-[10.5px] ${
                pane === 'changes'
                  ? 'bg-accent/15 text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              }`}
              onClick={() => selectPane('changes')}
              data-testid="view-changes"
            >
              <FileDiff size={12} />
              {t('session.viewSourceControl')}
            </button>
          </nav>
          <button
            type="button"
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onToggleCollapsed}
            aria-label={t('session.hideInspector')}
            title={t('session.hideInspector')}
            data-testid="inspector-collapse"
          >
            <PanelLeftClose size={12} />
          </button>
        </div>

        <div className="relative min-h-0 flex-1">
          <div
            className={`h-full min-h-0 ${pane === 'files' ? '' : 'hidden'}`}
            data-testid="files-view"
          >
            {visited.has('files') ? (
              <FilesPanel
                sessionId={session.id}
                refreshToken={refreshToken + filesReloadToken}
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
            className={`h-full min-h-0 ${pane === 'search' ? '' : 'hidden'}`}
            data-testid="search-view"
          >
            {visited.has('search') ? (
              <FilesSearchPanel
                key={session.id}
                sessionId={session.id}
                active={!collapsed && pane === 'search'}
                notify={notify}
                onOpenPath={(path, line) => {
                  setFileRequest({ path, line, nonce: Date.now() })
                  selectPane('files')
                }}
                onReplaced={() => setFilesReloadToken((value) => value + 1)}
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
