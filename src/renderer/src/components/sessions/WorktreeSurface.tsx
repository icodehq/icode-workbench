import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { AppError } from '../../../../shared/domain/errors'
import { harnessLabel } from '../../../../shared/domain/harness'
import type { RepositorySummary, SessionSummary } from '../../../../shared/schemas/ipc'
import type { AgentSendResult } from '../../lib/agent-send'
import type { WorkbenchDraftStore } from '../../review/drafts'
import {
  diffTabKey,
  isDirty,
  openFilesStore,
  tabKey,
  useSessionFiles,
  type DiffTabRequest
} from '../../files/open-files'
import {
  fileTabKey,
  sessionTabKey,
  workspaceKeyForSession
} from '../../workspace/workspace-key'
import {
  resolveWorkspaceOwner,
  workspaceDescriptorFor
} from '../../workspace/workspace-owner'
import type { OpenFileRequest, ViewRequest } from '../../router/use-app-navigation'
import type { Notice, PendingAction, RecoveryPhase } from '../../state/workspace'
import type { PendingCreate } from '../../state/pending-create'
import type { DirectSessionActions } from '../../state/session-actions'
import type { CreateSessionOutcome, CreateSessionRequest } from '../../state/use-workspace'
import { useWorkspaceSplit } from '../../state/use-workspace-split'
import {
  findPaneForTabKey,
  layoutSplit,
  type SplitLeaf,
  type SplitSide
} from '../../state/workspace-split'
import { registerSplitCommand } from '../../state/split-commands'
import { useT } from '../../i18n/use-i18n'
import { isMacPlatform } from '../../lib/platform'
import { useElementWidth } from '../../lib/use-element-width'
import SessionInspector from './SessionInspector'
import SessionStatusStrip from './SessionStatusStrip'
import SessionWorkspace from '../SessionWorkspace'
import { sessionStateLabelFor } from '../status'
import { SessionPaneActionsProvider, type SessionPaneActions } from './SessionPaneActions'
import { worktreeIsShared } from './session-menu'
import WorktreePane, {
  type PaneTabActions,
  type WorktreeTabRequest
} from './WorktreePane'
import WorktreeTabStrip from './WorktreeTabStrip'
import WorktreeFilesWatchHost from './WorktreeFilesWatchHost'
import WorkspaceSplitTreeView from './WorkspaceSplitTreeView'

export type NewSessionInitialCheckout =
  | { kind: 'default' }
  | { kind: 'worktree'; worktreeId: string }
  | null

export type WorktreeSurfaceProps = {
  repo: RepositorySummary
  sessions: SessionSummary[]
  activeSession: SessionSummary
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

/** The direct-session surface for the active worktree. */
export default function WorktreeSurface({
  repo,
  sessions,
  activeSession,
  pendingCreate,
  pending,
  recovery,
  focusActive,
  paneSessions,
  refreshToken,
  openRequest,
  viewRequest,
  drafts,
  sendToAgent,
  onSelectSession,
  onCreateSession,
  onNewSession,
  sessionActions,
  onError,
  notify,
  onClearOpenRequest,
  onClearViewRequest
}: WorktreeSurfaceProps): React.JSX.Element {
  const t = useT()
  const workspaceKey = workspaceKeyForSession(activeSession)
  const workspaceSessions = useMemo(
    () => sessions.filter((session) => workspaceKeyForSession(session) === workspaceKey),
    [sessions, workspaceKey]
  )
  const sessionById = useMemo(
    () => new Map(workspaceSessions.map((session) => [session.id, session])),
    [workspaceSessions]
  )
  const owner = useMemo(
    () =>
      resolveWorkspaceOwner({
        sessions: workspaceSessions,
        workspaceKey,
        activeSessionId: activeSession.id
      }) ?? activeSession,
    [activeSession, workspaceKey, workspaceSessions]
  )
  const descriptor = useMemo(
    () =>
      workspaceDescriptorFor({
        workspaceKey,
        repoId: repo.id,
        sessions: workspaceSessions
      }),
    [workspaceKey, repo.id, workspaceSessions]
  )

  const scopeState = useSessionFiles(workspaceKey)
  const tabs = scopeState.tabs
  const dirtyCount = tabs.reduce(
    (count, tab) => (tab.kind === 'file' && isDirty(tab) ? count + 1 : count),
    0
  )

  const split = useWorkspaceSplit({
    workspaceKey,
    tabs,
    activeKey: scopeState.activeKey ?? sessionTabKey(activeSession.id),
    activeSessionId: activeSession.id,
    onSelectSession
  })

  // Reconcile the worktree tab list with the live sessions for this worktree.
  useEffect(() => {
    openFilesStore.syncSessions(
      workspaceKey,
      workspaceSessions.map((session) => session.id)
    )
  }, [workspaceKey, workspaceSessions])

  // The pane's focused tab is the worktree's last-focused tab: keep the store's
  // active key in step so Files highlighting and editor actions follow it.
  useEffect(() => {
    const key = split.focusedTabKey
    if (key === null || !tabs.some((tab) => tabKey(tab) === key)) return
    openFilesStore.setActiveKey(workspaceKey, key)
  }, [split.focusedTabKey, tabs, workspaceKey])

  // On first paint (or a workspace switch), show the selected session when the
  // persisted split points at nothing valid.
  const seeded = useRef<string | null>(null)
  useEffect(() => {
    if (seeded.current === workspaceKey) return
    const focused = split.focusedTabKey
    // Hot exit may restore a file/diff tab; keep the user where they were.
    if (focused !== null && !focused.startsWith('session:')) {
      seeded.current = workspaceKey
      return
    }
    const key = sessionTabKey(activeSession.id)
    if (!tabs.some((tab) => tabKey(tab) === key)) return
    seeded.current = workspaceKey
    if (focused !== key) split.activateTab(key)
  }, [activeSession.id, split, tabs, workspaceKey])

  const [inspectorCollapsed, setInspectorCollapsed] = useState<boolean>(
    () => typeof window !== 'undefined' && window.innerWidth < 1120
  )
  const [narrowViewport, setNarrowViewport] = useState<boolean>(
    () => typeof window !== 'undefined' && window.innerWidth < 900
  )
  const [paneRequest, setPaneRequest] = useState<{
    pane: 'changes' | 'files' | 'search'
    nonce: number
  } | null>(null)
  const [historyRequest, setHistoryRequest] = useState<{
    path: string
    nonce: number
  } | null>(null)
  const [centerRequest, setCenterRequest] = useState<WorktreeTabRequest | null>(null)
  const [surfaceRowRef, surfaceRowWidth] = useElementWidth<HTMLDivElement>()
  const inspectorExpandedRef = useRef(!inspectorCollapsed)
  const autoCollapsedInspectorRef = useRef(false)

  useEffect(() => {
    inspectorExpandedRef.current = !inspectorCollapsed
  }, [inspectorCollapsed])

  useEffect(() => {
    const collapseMedia = window.matchMedia('(max-width: 1279px)')
    const collapse = (): void => {
      if (collapseMedia.matches) {
        if (inspectorExpandedRef.current) autoCollapsedInspectorRef.current = true
        setInspectorCollapsed(true)
        return
      }
      if (autoCollapsedInspectorRef.current) {
        autoCollapsedInspectorRef.current = false
        setInspectorCollapsed(false)
      }
    }
    const narrowMedia = window.matchMedia('(max-width: 899px)')
    const narrow = (): void => setNarrowViewport(narrowMedia.matches)
    collapse()
    narrow()
    collapseMedia.addEventListener('change', collapse)
    narrowMedia.addEventListener('change', narrow)
    return () => {
      collapseMedia.removeEventListener('change', collapse)
      narrowMedia.removeEventListener('change', narrow)
    }
  }, [])

  useEffect(() => {
    if (!viewRequest) return
    if (viewRequest.view !== 'terminal') {
      setInspectorCollapsed(false)
      setPaneRequest({ pane: viewRequest.view, nonce: Date.now() })
    }
    onClearViewRequest()
  }, [viewRequest, onClearViewRequest])

  const openFileInCenter = useCallback(
    (path: string, line: number, options?: { preview?: boolean }): void => {
      const preview = options?.preview ?? true
      const opened = openFilesStore.open(workspaceKey, path, {
        preview,
        replaceKey: split.focusedTabKey ?? undefined
      })
      const key = fileTabKey(path)
      split.activateTab(key)
      // The tab placeholder is created here; a pane owns the actual read. Tell
      // it to load when this click created the tab or a prior read failed.
      setCenterRequest({
        path,
        line,
        preview,
        load: opened.created || opened.tab.load !== 'ready',
        nonce: Date.now()
      })
    },
    [split, workspaceKey]
  )

  useEffect(() => {
    if (openRequest === null) return
    openFileInCenter(openRequest.path, openRequest.line, { preview: true })
    onClearOpenRequest()
  }, [openFileInCenter, onClearOpenRequest, openRequest])

  const openDiffInCenter = useCallback(
    (request: DiffTabRequest, options?: { preview?: boolean }): void => {
      const key = diffTabKey(request)
      openFilesStore.openDiff(workspaceKey, request, {
        preview: options?.preview ?? true,
        replaceKey: split.focusedTabKey ?? undefined
      })
      split.activateTab(key)
    },
    [split, workspaceKey]
  )

  const openHistoryInInspector = useCallback((path: string): void => {
    setInspectorCollapsed(false)
    setPaneRequest({ pane: 'changes', nonce: Date.now() })
    setHistoryRequest({ path, nonce: Date.now() })
  }, [])

  // Each pane owns the unsaved-close dialog and save path for its files. The
  // shared tab bar asks the pane showing the tab (or the focused pane) instead
  // of closing dirty buffers directly.
  const paneTabActions = useRef(new Map<string, PaneTabActions>())
  const registerTabActions = useCallback(
    (paneId: string, actions: PaneTabActions | null): void => {
      if (actions === null) paneTabActions.current.delete(paneId)
      else paneTabActions.current.set(paneId, actions)
    },
    []
  )
  const actionsForTab = useCallback(
    (key: string): PaneTabActions | undefined => {
      const pane = findPaneForTabKey(split.root, key)
      return paneTabActions.current.get(pane?.paneId ?? split.focusedPaneId)
    },
    [split.root, split.focusedPaneId]
  )
  const requestCloseTab = useCallback(
    (key: string): void => {
      const actions = actionsForTab(key)
      if (actions !== undefined) actions.requestClose(key)
      else openFilesStore.closeTab(workspaceKey, key)
    },
    [actionsForTab, workspaceKey]
  )

  const closeAllTabs = useCallback((): void => {
    const actions = paneTabActions.current.get(split.focusedPaneId)
    if (actions !== undefined) actions.requestCloseAll()
    else openFilesStore.closeAll(workspaceKey)
  }, [split.focusedPaneId, workspaceKey])

  const saveAllTabs = useCallback((): void => {
    const actions = paneTabActions.current.get(split.focusedPaneId)
    if (actions !== undefined) actions.saveAll()
  }, [split.focusedPaneId])

  const closeOtherTabs = useCallback(
    (keepKey: string): void => {
      for (const tab of tabs) {
        const key = tabKey(tab)
        if (key !== keepKey) requestCloseTab(key)
      }
    },
    [tabs, requestCloseTab]
  )

  const closeTabsRight = useCallback(
    (key: string): void => {
      const index = tabs.findIndex((tab) => tabKey(tab) === key)
      if (index < 0) return
      for (const tab of tabs.slice(index + 1)) requestCloseTab(tabKey(tab))
    },
    [tabs, requestCloseTab]
  )

  const splitWithTab = useCallback(
    (key: string, side: SplitSide): void => {
      if (split.focusedTabKey === key) split.splitPane(side)
      else split.splitWithTab(key, side)
    },
    [split]
  )

  const workspaceLabel = descriptor.isDefault
    ? `${t('sidebar.defaultCheckout')} · ${repo.currentBranch ?? '—'}`
    : (descriptor.worktreeBranch ?? descriptor.worktreePath ?? t('sidebar.workspaceGroup'))

  const paneActionsFor = (leaf: SplitLeaf): SessionPaneActions => ({
    split: (side: SplitSide) => split.splitPane(side),
    close: () => split.closePane(leaf.paneId),
    focus: () => split.focusPane(leaf.paneId),
    toggleZoom: split.toggleZoom,
    canSplit: true,
    canClose: split.root.kind === 'split',
    canZoom: split.root.kind === 'split'
  })

  const renderSession = useCallback(
    (session: SessionSummary, focused: boolean): React.JSX.Element => {
      const leaf = split.focusedPaneId
      return (
        <SessionPaneActionsProvider
          value={paneActionsFor({ kind: 'leaf', paneId: leaf, activeTabKey: sessionTabKey(session.id) })}
        >
          <SessionWorkspace
            contentOnly
            terminalActive={false}
            session={session}
            repo={repo}
            pending={pending[session.id] ?? null}
            recovery={recovery[session.id] ?? null}
            panes={paneSessions.filter((candidate) => candidate.id === session.id)}
            worktreeShared={worktreeIsShared(session, workspaceSessions)}
            allowSleep
            refreshToken={refreshToken}
            focused={focused}
            drafts={drafts}
            onRestart={sessionActions.restart}
            onResume={sessionActions.resume}
            onSleep={sessionActions.sleep}
            onWake={sessionActions.wake}
            onRecheck={sessionActions.recheck}
            onRemove={sessionActions.remove}
            onRecoverWorktree={sessionActions.recoverWorktree}
            onError={onError}
            notify={notify}
            onSendToAgent={(text) => sendToAgent(text, session)}
          />
        </SessionPaneActionsProvider>
      )
    },
    // The leaf is captured by paneActionsFor; the rest are stable app services.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drafts, notify, onError, paneSessions, pending, recovery, refreshToken, repo, sessionActions, sendToAgent, split, workspaceSessions]
  )

  const paneRects = useMemo(() => layoutSplit(split.root), [split.root])
  const displayedPaneByKey = useMemo(() => {
    const map = new Map<string, string>()
    for (const rect of paneRects) {
      if (rect.activeTabKey !== null) map.set(rect.activeTabKey, rect.paneId)
    }
    return map
  }, [paneRects])
  const renderedPanes = useMemo(
    () =>
      split.zoomedPaneId === null
        ? paneRects
        : paneRects.filter((rect) => rect.paneId === split.zoomedPaneId),
    [paneRects, split.zoomedPaneId]
  )
  const renderedTabKeys = useMemo(
    () =>
      new Set(
        renderedPanes
          .map((rect) => rect.activeTabKey)
          .filter((key): key is string => key !== null)
      ),
    [renderedPanes]
  )

  const renderPane = (leaf: SplitLeaf): React.JSX.Element => (
    <WorktreePane
      key={leaf.paneId}
      leaf={leaf}
      tabs={tabs}
      sessions={sessionById}
      scopeKey={workspaceKey}
      ownerSessionId={owner.id}
      ownerSessionState={owner.state}
      refreshToken={refreshToken}
      drafts={drafts}
      notify={notify}
      focused={leaf.paneId === split.focusedPaneId}
      splitActive={split.root.kind === 'split'}
      request={leaf.paneId === split.focusedPaneId ? centerRequest : null}
      onRequestHandled={() => setCenterRequest(null)}
      onFocus={() => split.focusPane(leaf.paneId)}
      onClosePane={() => split.closePane(leaf.paneId)}
      onPickTab={(key) => split.activateTabInPane(leaf.paneId, key)}
      onNewAgent={() =>
        onNewSession(
          descriptor.isDefault
            ? { kind: 'default' }
            : descriptor.worktreeId === null
              ? null
              : { kind: 'worktree', worktreeId: descriptor.worktreeId }
        )
      }
      onNewTerminal={() => {
        void onCreateSession({
          repoId: repo.id,
          harness: 'shell',
          ...(descriptor.isDefault
            ? { checkout: 'default' as const }
            : descriptor.worktreeId === null
              ? { checkout: 'default' as const }
              : { worktreeId: descriptor.worktreeId })
        })
      }}
      onOpenHistory={openHistoryInInspector}
      onTabActions={registerTabActions}
      renderSession={(session, focused) => {
        const actions = paneActionsFor(leaf)
        return (
          <SessionPaneActionsProvider value={actions}>
            <SessionWorkspace
              contentOnly
              session={session}
              repo={repo}
              pending={pending[session.id] ?? null}
              recovery={recovery[session.id] ?? null}
              panes={paneSessions.filter((candidate) => candidate.id === session.id)}
              worktreeShared={worktreeIsShared(session, workspaceSessions)}
              allowSleep
              refreshToken={refreshToken}
              focused={focused}
              terminalActive={focused}
              drafts={drafts}
              onRestart={sessionActions.restart}
              onResume={sessionActions.resume}
              onSleep={sessionActions.sleep}
              onWake={sessionActions.wake}
              onRecheck={sessionActions.recheck}
              onRemove={sessionActions.remove}
              onRecoverWorktree={sessionActions.recoverWorktree}
              onError={onError}
              notify={notify}
              onSendToAgent={(text) => sendToAgent(text, session)}
            />
          </SessionPaneActionsProvider>
        )
      }}
    />
  )

  useEffect(() => {
    const unregister = [
      registerSplitCommand('split.left', {
        sessionId: activeSession.id,
        enabled: true,
        run: () => split.splitPane('left')
      }),
      registerSplitCommand('split.right', {
        sessionId: activeSession.id,
        enabled: true,
        run: () => split.splitPane('right')
      }),
      registerSplitCommand('split.up', {
        sessionId: activeSession.id,
        enabled: true,
        run: () => split.splitPane('up')
      }),
      registerSplitCommand('split.down', {
        sessionId: activeSession.id,
        enabled: true,
        run: () => split.splitPane('down')
      }),
      registerSplitCommand('split.zoom', {
        sessionId: activeSession.id,
        enabled: split.root.kind === 'split',
        run: split.toggleZoom
      }),
      registerSplitCommand('split.close', {
        sessionId: activeSession.id,
        enabled: split.root.kind === 'split',
        run: split.unsplit
      })
    ]
    return () => {
      for (const remove of unregister) remove()
    }
  }, [activeSession.id, split])

  useEffect(() => {
    const isMac = isMacPlatform()
    const directionFor = (key: string): SplitSide | null =>
      key === 'ArrowLeft'
        ? 'left'
        : key === 'ArrowRight'
          ? 'right'
          : key === 'ArrowUp'
            ? 'up'
            : key === 'ArrowDown'
              ? 'down'
              : null
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return
      if (event.target instanceof Element) {
        if (event.target.closest('.monaco-editor')) return
        if (event.target.closest('input, textarea, [contenteditable="true"], [role="dialog"]')) {
          return
        }
      }
      const key = event.key
      const lower = key.toLowerCase()
      const direction = directionFor(key)
      const handle = (action: () => void): void => {
        event.preventDefault()
        event.stopPropagation()
        action()
      }
      if (isMac) {
        if (!event.metaKey || event.ctrlKey) return
        if (event.altKey && !event.shiftKey && direction !== null) {
          return handle(() => split.focus(direction))
        }
        if (event.altKey) return
        if (event.shiftKey && !event.altKey && lower === 'enter') return handle(split.toggleZoom)
        if (event.shiftKey && !event.altKey && lower === 'w') {
          if (split.focusedTabKey !== null) {
            handle(() => requestCloseTab(split.focusedTabKey!))
          }
          return
        }
        if (event.shiftKey && !event.altKey && lower === 'd') return handle(() => split.splitPane('down'))
        if (!event.shiftKey && !event.altKey && lower === 'd') return handle(() => split.splitPane('right'))
        return
      }
      if (!event.ctrlKey || event.metaKey) return
      if (event.altKey && !event.shiftKey && direction !== null) {
        return handle(() => split.focus(direction))
      }
      if (!event.shiftKey || event.altKey) return
      if (lower === 'enter') return handle(split.toggleZoom)
      if (lower === 'w') {
        if (split.focusedTabKey !== null) {
          handle(() => requestCloseTab(split.focusedTabKey!))
        }
        return
      }
      if (lower === 'd') return handle(() => split.splitPane('right'))
      if (direction !== null) return handle(() => split.splitPane(direction))
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [split, requestCloseTab])

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="sessions-surface">
      {/*
       * The session header retired with the worktree bar. Keep the same
       * observable session truth for assistive tech and existing probes.
       */}
      <div className="sr-only" aria-hidden="true" data-testid="session-status-mirror">
        <span
          data-testid="session-state"
          data-state={activeSession.state}
          data-sleeping={String(activeSession.sleeping === true)}
          data-authority={activeSession.authority}
          data-reason={activeSession.reason}
        >
          {sessionStateLabelFor(activeSession, pending[activeSession.id] ?? null)}
        </span>
        <span data-testid="session-title">{activeSession.title}</span>
        <span
          data-testid="session-activity"
          data-activity={activeSession.activity?.state ?? 'unknown'}
          data-activity-tool={activeSession.activity?.toolName ?? ''}
          data-activity-unread={String(activeSession.activity?.unread ?? false)}
        />
        <span data-testid="session-incarnation">{activeSession.incarnationId ?? ''}</span>
      </div>
      <WorktreeFilesWatchHost workspaceKey={workspaceKey} ownerSessionId={owner.id} />
      {pendingCreate !== null ? (
        <PendingBar pending={pendingCreate} project={repo.displayName} />
      ) : null}
      {!focusActive ? (
        <WorktreeTabStrip
          workspaceKey={workspaceKey}
          workspaceLabel={workspaceLabel}
          workspaceKind={descriptor.isDefault ? 'default' : 'worktree'}
          tabs={tabs}
          sessions={sessionById}
          focusedTabKey={split.focusedTabKey}
          displayedPaneByKey={displayedPaneByKey}
          focusedPaneId={split.focusedPaneId}
          pending={pending}
          dirtyCount={dirtyCount}
          splitActive={split.root.kind === 'split'}
          zoomed={split.zoomedPaneId !== null}
          onActivate={split.activateTab}
          onClose={requestCloseTab}
          onPin={(key) => openFilesStore.pin(workspaceKey, key)}
          onReorder={(source, target) => openFilesStore.moveTab(workspaceKey, source, target)}
          onCloseAll={closeAllTabs}
          onSaveAll={saveAllTabs}
          onNewAgent={() =>
            onNewSession(
              descriptor.isDefault
                ? { kind: 'default' }
                : descriptor.worktreeId === null
                  ? null
                  : { kind: 'worktree', worktreeId: descriptor.worktreeId }
            )
          }
          onNewTerminal={() => {
            void onCreateSession({
              repoId: repo.id,
              harness: 'shell',
              ...(descriptor.isDefault
                ? { checkout: 'default' as const }
                : descriptor.worktreeId === null
                  ? { checkout: 'default' as const }
                  : { worktreeId: descriptor.worktreeId })
            })
          }}
          onSplit={() =>
            split.root.kind === 'split' ? split.unsplit() : split.splitPane('right')
          }
          onToggleZoom={split.toggleZoom}
          onCloseOthers={closeOtherTabs}
          onCloseRight={closeTabsRight}
          onSplitWithTab={splitWithTab}
          onUnsplit={split.unsplit}
        />
      ) : null}
      <div ref={surfaceRowRef} className="relative flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1">
          {split.zoomedPaneId !== null ? (
            (() => {
              const zoomed = paneRects.find((rect) => rect.paneId === split.zoomedPaneId)
              return zoomed === undefined ? null : renderPane({
                kind: 'leaf',
                paneId: zoomed.paneId,
                activeTabKey: zoomed.activeTabKey
              })
            })()
          ) : (
            <WorkspaceSplitTreeView
              node={split.root}
              renderLeaf={renderPane}
              onResize={split.resize}
            />
          )}
        </div>
        {!focusActive ? (
          <>
            {narrowViewport && !inspectorCollapsed ? (
              <button
                type="button"
                className="absolute inset-0 z-20 bg-black/40"
                onClick={() => setInspectorCollapsed(true)}
                aria-label={t('session.hideInspector')}
                data-testid="inspector-scrim"
              />
            ) : null}
            <div
              className={
                narrowViewport && !inspectorCollapsed
                  ? 'absolute inset-y-0 right-0 z-30 flex'
                  : 'flex'
              }
            >
              <SessionInspector
                session={owner}
                scopeKey={workspaceKey}
                refreshToken={refreshToken}
                requestedPane={paneRequest}
                historyRequest={historyRequest}
                onHistoryRequestHandled={() => setHistoryRequest(null)}
                onOpenFile={openFileInCenter}
                onOpenDiff={openDiffInCenter}
                onOpenHistory={openHistoryInInspector}
                notify={notify}
                drafts={drafts}
                onSendToAgent={(text) => sendToAgent(text, owner)}
                onRecheck={() => sessionActions.recheck(owner.id)}
                onOpenTerminal={() => undefined}
                collapsed={inspectorCollapsed}
                onToggleCollapsed={() => setInspectorCollapsed((current) => !current)}
                overlay={narrowViewport}
                availableWidth={surfaceRowWidth}
              />
            </div>
          </>
        ) : null}
      </div>
      {!focusActive ? (
        <SessionStatusStrip
          onOpenSourceControl={() => {
            setInspectorCollapsed(false)
            setPaneRequest({ pane: 'changes', nonce: Date.now() })
          }}
        />
      ) : null}
      {/* Sessions outside this worktree (or hidden tabs in it) stay mounted so
          their PTY attachments and xterm state survive a worktree switch. */}
      {sessions
        .filter((session) => !renderedTabKeys.has(sessionTabKey(session.id)))
        .map((session) => (
          <div key={session.id} className="hidden" aria-hidden="true">
            {renderSession(session, false)}
          </div>
        ))}
    </div>
  )
}

function PendingBar({
  pending,
  project
}: {
  pending: PendingCreate
  project: string
}): React.JSX.Element {
  const t = useT()
  return (
    <div
      className="flex shrink-0 items-start gap-2 border-b border-signal-line bg-signal-weak px-4 py-2 text-[11px] text-signal"
      data-testid="pending-session-panel"
      data-harness={pending.harness}
      data-repo-id={pending.repoId}
      role="status"
      aria-live="polite"
    >
      <Loader2 size={12} className="mt-0.5 shrink-0 animate-spin" />
      <div className="min-w-0">
        <p className="font-medium">
          {t('newSession.starting', { harness: harnessLabel(pending.harness) })}
        </p>
        <p className="mt-0.5 truncate text-[10.5px] opacity-80">
          {t(
            pending.request.checkout === 'default'
              ? 'newSession.startingDefaultBody'
              : 'newSession.startingBody',
            { project }
          )}
        </p>
      </div>
    </div>
  )
}
