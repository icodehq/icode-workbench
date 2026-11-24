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
import { usePanelResize } from '../../lib/use-panel-resize'
import ChangesPanel from '../ChangesPanel'
import FilesPanel from '../FilesPanel'
import FilesSearchPanel from '../FilesSearchPanel'
import type { DiffTabRequest } from '../../files/open-files'
import { useT } from '../../i18n/use-i18n'

type Pane = 'changes' | 'files' | 'search'

type Props = {
  session: SessionSummary
  /** Worktree scope for the Files tree; defaults to the session. */
  scopeKey?: string
  refreshToken: number
  requestedPane: { pane: Pane; nonce: number } | null
  /** History requested from the tree menu or the center editor. */
  historyRequest?: { path: string; nonce: number } | null
  onHistoryRequestHandled?: () => void
  /** Opens a file as a center preview tab. */
  onOpenFile: (path: string, line: number, options?: { preview?: boolean }) => void
  /** Opens a diff as a center tab. */
  onOpenDiff: (request: DiffTabRequest, options?: { preview?: boolean }) => void
  /** Opens Source Control History filtered to a file. */
  onOpenHistory: (path: string) => void
  notify: (notice: Notice) => void
  drafts: WorkbenchDraftStore
  onSendToAgent: (text: string) => Promise<AgentSendResult>
  onRecheck: () => void
  onOpenTerminal?: () => void
  collapsed: boolean
  onToggleCollapsed: () => void
  /** Narrow viewports render the inspector above the workspace, not beside it. */
  overlay?: boolean
  /** Width of the row holding the terminal and this inspector. */
  availableWidth?: number
}

/**
 * Persistent right-hand navigator for a direct session.
 *
 * Files, Search and Source Control are lists here; the terminal, file editor
 * and diffs share the center tab surface. Panes stay mounted once visited, and
 * collapse only hides the shell so SCM polling and the tree survive.
 *
 * One row carries the pane switch and collapse control: the old eyebrow +
 * repo/branch header only repeated what the session header already shows.
 * The left edge is a drag seam, and the width is remembered.
 */
export default function SessionInspector({
  session,
  scopeKey = session.id,
  refreshToken,
  requestedPane,
  historyRequest = null,
  onHistoryRequestHandled,
  onOpenFile,
  onOpenDiff,
  onOpenHistory,
  notify,
  drafts,
  onSendToAgent,
  onRecheck,
  onOpenTerminal,
  collapsed,
  onToggleCollapsed,
  overlay = false,
  availableWidth
}: Props): React.JSX.Element {
  const t = useT()
  const [pane, setPane] = useState<Pane>('files')
  const paneMemory = useRef(new Map<string, Pane>())
  const [visited, setVisited] = useState<Set<Pane>>(() => new Set<Pane>(['files']))
  const [filesReloadToken, setFilesReloadToken] = useState(0)

  const [preferredWidth, setPreferredWidth] = useState<number>(() => loadInspectorWidth())
  const preferredRef = useRef(preferredWidth)
  const [viewportWidth, setViewportWidth] = useState<number>(() =>
    typeof window === 'undefined' ? 1600 : window.innerWidth
  )
  const asideRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    preferredRef.current = preferredWidth
  }, [preferredWidth])

  useEffect(() => {
    const onResize = (): void => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Before the row has been measured, fall back to the window. Once measured,
  // the row is the real budget: the sidebar and split layout are excluded.
  const layoutWidth =
    availableWidth !== undefined && availableWidth > 0 ? availableWidth : viewportWidth
  const width = overlay
    ? Math.min(360, Math.round(viewportWidth * 0.85))
    : clampInspectorWidth(preferredWidth, layoutWidth)

  const setWidth = (next: number): void => {
    preferredRef.current = next
    setPreferredWidth(next)
  }

  const { handleProps } = usePanelResize({
    kind: 'inspector',
    panelRef: asideRef,
    getStartValue: () => width,
    clamp: (candidate) => clampInspectorWidth(candidate, layoutWidth),
    direction: -1,
    axis: 'x',
    disabled: collapsed || overlay,
    cursor: 'col-resize',
    onCommit: (next) => {
      setWidth(next)
      saveInspectorWidth(next)
    }
  })

  const nudgeWidth = (delta: number): void => {
    const next = clampInspectorWidth(preferredRef.current + delta, layoutWidth)
    setWidth(next)
    saveInspectorWidth(next)
  }

  const resetWidth = (): void => {
    const next = clampInspectorWidth(INSPECTOR_WIDTH_DEFAULT, layoutWidth)
    setWidth(next)
    saveInspectorWidth(next)
  }

  const selectPane = (next: Pane): void => {
    paneMemory.current.set(scopeKey, next)
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
    const remembered = paneMemory.current.get(scopeKey) ?? 'files'
    setPane(remembered)
    setVisited((current) => {
      if (current.has(remembered)) return current
      const updated = new Set(current)
      updated.add(remembered)
      return updated
    })
  }, [scopeKey])

  useEffect(() => {
    if (!requestedPane) return
    selectPane(requestedPane.pane)
  }, [requestedPane?.nonce])

  const worktree = session.worktree

  return (
    <aside
      ref={asideRef}
      className={`relative flex h-full shrink-0 flex-col border-l border-border bg-background ${
        collapsed ? 'w-9' : ''
      } ${overlay && !collapsed ? 'shadow-2xl' : ''}`}
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
          {...handleProps}
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
                scopeKey={scopeKey}
                refreshToken={refreshToken + filesReloadToken}
                active={!collapsed && pane === 'files'}
                notify={notify}
                listOnly
                onOpenFile={onOpenFile}
                onOpenHistory={(path) => {
                  onOpenHistory(path)
                  selectPane('changes')
                }}
              />
            ) : null}
          </div>
          <div
            className={`h-full min-h-0 ${pane === 'search' ? '' : 'hidden'}`}
            data-testid="search-view"
          >
            {visited.has('search') ? (
              <FilesSearchPanel
                key={scopeKey}
                sessionId={session.id}
                active={!collapsed && pane === 'search'}
                notify={notify}
                onOpenPath={(path, line) => {
                  onOpenFile(path, line, { preview: true })
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
                scopeKey={scopeKey}
                sessionState={session.state}
                repoId={session.repoId}
                harness={session.harness}
                baseOid={worktree?.baseOid ?? null}
                repositoryScope={worktree === null}
                refreshToken={refreshToken}
                active={!collapsed && pane === 'changes'}
                notify={notify}
                onOpenPath={(path) => {
                  onOpenFile(path, 1, { preview: true })
                }}
                onOpenTerminal={() => onOpenTerminal?.()}
                onSendToAgent={onSendToAgent}
                canSendToAgent={
                  worktree !== null && session.state === 'live' && isAgentHarness(session.harness)
                }
                drafts={drafts}
                onChanged={onRecheck}
                initialHistoryPath={historyRequest}
                onHistoryPathHandled={() => onHistoryRequestHandled?.()}
                presentation="list"
                onOpenDiff={onOpenDiff}
              />
            ) : null}
          </div>
        </div>
      </div>
    </aside>
  )
}
