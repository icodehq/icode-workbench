import { useEffect, useRef, useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import type { AppError } from '../../../../shared/domain/errors'
import { harnessLabel } from '../../../../shared/domain/harness'
import type { RepositorySummary, SessionSummary } from '../../../../shared/schemas/ipc'
import type { AgentSendResult } from '../../lib/agent-send'
import type { WorkbenchDraftStore } from '../../review/drafts'
import type { OpenFileRequest, ViewRequest } from '../../router/use-app-navigation'
import type { Notice, PendingAction } from '../../state/workspace'
import type { PendingCreate } from '../../state/pending-create'
import SessionInspector from '../sessions/SessionInspector'
import SessionStatusStrip from '../sessions/SessionStatusStrip'
import SessionTabStrip from '../sessions/SessionTabStrip'
import { moveSessionTab, orderSessionTabIds } from '../sessions/session-tab-order'
import SessionWorkspace from '../SessionWorkspace'
import { useT } from '../../i18n/use-i18n'

type Props = {
  repo: RepositorySummary | null
  sessions: SessionSummary[]
  activeSession: SessionSummary | null
  pendingCreate: PendingCreate | null
  pending: Record<string, PendingAction>
  focusActive: boolean
  paneSessions: SessionSummary[]
  refreshToken: number
  openRequest: OpenFileRequest | null
  viewRequest: ViewRequest | null
  drafts: WorkbenchDraftStore
  sendToAgent: (text: string, session: SessionSummary) => Promise<AgentSendResult>

  onSelectSession: (sessionId: string) => void
  onNewSession: () => void
  onRestartSession: (sessionId: string) => void
  onSleepSession: (sessionId: string) => void
  onWakeSession: (sessionId: string) => void
  onRecheckSession: (sessionId: string) => void
  onRemoveSession: (sessionId: string) => void
  onRecoverWorktree: (sessionId: string) => void
  onError: (error: AppError) => void
  notify: (notice: Notice) => void
  onClearOpenRequest: () => void
  onClearViewRequest: () => void
}

/**
 * The direct-session workspace. The project tree lives in the sidebar, the
 * direct-session tabs switch the center pane, and Changes/Files stay in the
 * persistent right inspector. Task attempts are routed elsewhere.
 */
export default function SessionsSurface({
  repo,
  sessions,
  activeSession,
  pendingCreate,
  pending,
  focusActive,
  paneSessions,
  refreshToken,
  openRequest,
  viewRequest,
  drafts,
  sendToAgent,
  onSelectSession,
  onNewSession,
  onRestartSession,
  onSleepSession,
  onWakeSession,
  onRecheckSession,
  onRemoveSession,
  onRecoverWorktree,
  onError,
  notify,
  onClearOpenRequest,
  onClearViewRequest
}: Props): React.JSX.Element {
  const t = useT()
  const [inspectorCollapsed, setInspectorCollapsed] = useState<boolean>(
    () => typeof window !== 'undefined' && window.innerWidth < 1120
  )
  const [narrowViewport, setNarrowViewport] = useState<boolean>(
    () => typeof window !== 'undefined' && window.innerWidth < 900
  )
  const [closedTabIds, setClosedTabIds] = useState<Set<string>>(() => new Set())
  const [tabOrder, setTabOrder] = useState<string[]>([])
  const [splitSessionId, setSplitSessionId] = useState<string | null>(null)
  const [focusedPane, setFocusedPane] = useState<'primary' | 'secondary'>('primary')
  const [splitRatio, setSplitRatio] = useState(0.5)
  const splitContainerRef = useRef<HTMLDivElement | null>(null)
  const splitRectRef = useRef<DOMRect | null>(null)
  const inspectorExpandedRef = useRef(!inspectorCollapsed)
  const autoCollapsedInspectorRef = useRef(false)

  useEffect(() => {
    inspectorExpandedRef.current = !inspectorCollapsed
  }, [inspectorCollapsed])
  const [paneRequest, setPaneRequest] = useState<{
    pane: 'changes' | 'files'
    nonce: number
  } | null>(null)

  useEffect(() => {
    // Below 1120px the inspector yields room to the terminal; below 900px it
    // opens as an overlay instead of taking layout width.
    const collapseMedia = window.matchMedia('(max-width: 1119px)')
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
    if (activeSession === null) return
    setClosedTabIds((current) => {
      if (!current.has(activeSession.id)) return current
      const next = new Set(current)
      next.delete(activeSession.id)
      return next
    })
  }, [activeSession?.id])

  useEffect(() => {
    const ids = new Set(sessions.map((session) => session.id))
    setClosedTabIds((current) => {
      const next = new Set([...current].filter((id) => ids.has(id)))
      return next.size === current.size ? current : next
    })
  }, [sessions])

  useEffect(() => {
    setFocusedPane('primary')
    setSplitSessionId((current) => (current === activeSession?.id ? null : current))
  }, [activeSession?.id])

  useEffect(() => {
    if (splitSessionId === null) return
    if (closedTabIds.has(splitSessionId) || !sessions.some((session) => session.id === splitSessionId)) {
      setSplitSessionId(null)
      setFocusedPane('primary')
    }
  }, [closedTabIds, sessions, splitSessionId])

  useEffect(() => {
    if (!viewRequest) return
    if (viewRequest.view !== 'terminal') {
      setInspectorCollapsed(false)
      setPaneRequest({ pane: viewRequest.view, nonce: Date.now() })
    }
    onClearViewRequest()
  }, [viewRequest, onClearViewRequest])

  useEffect(() => {
    if (!openRequest) return
    setInspectorCollapsed(false)
  }, [openRequest?.nonce])

  if (repo === null) return <></>

  if (activeSession === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="sessions-surface">
        {pendingCreate !== null ? (
          <PendingBar pending={pendingCreate} project={repo.displayName} />
        ) : null}
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
      </div>
    )
  }

  const sessionById = new Map(sessions.map((session) => [session.id, session]))
  const orderedSessions = orderSessionTabIds(
    sessions.map((session) => session.id),
    tabOrder
  ).flatMap((id) => {
    const session = sessionById.get(id)
    return session === undefined ? [] : [session]
  })
  const visibleSessions = orderedSessions.filter(
    (session) => !closedTabIds.has(session.id) || session.id === activeSession.id
  )
  const closeTab = (sessionId: string): void => {
    if (splitSessionId === sessionId) setSplitSessionId(null)
    if (sessionId === activeSession.id) {
      const next = visibleSessions.find((session) => session.id !== sessionId)
      if (next === undefined) return
      onSelectSession(next.id)
    }
    setClosedTabIds((current) => {
      const updated = new Set(current)
      updated.add(sessionId)
      return updated
    })
  }

  const closeTabsNotIn = (keepIds: readonly string[], fallbackId: string): void => {
    const kept = new Set(keepIds)
    if (!kept.has(activeSession.id)) onSelectSession(fallbackId)
    if (splitSessionId !== null && !kept.has(splitSessionId)) {
      setSplitSessionId(null)
      setFocusedPane('primary')
    }
    setClosedTabIds((current) => {
      const updated = new Set(current)
      for (const session of visibleSessions) {
        if (!kept.has(session.id)) updated.add(session.id)
      }
      return updated
    })
  }
  const closeOtherTabs = (sessionId: string): void => {
    closeTabsNotIn([sessionId], sessionId)
  }
  const closeTabsToRight = (sessionId: string): void => {
    const index = visibleSessions.findIndex((session) => session.id === sessionId)
    if (index < 0) return
    closeTabsNotIn(
      visibleSessions.slice(0, index + 1).map((session) => session.id),
      sessionId
    )
  }
  const reorderTabs = (sourceId: string, targetId: string): void => {
    setTabOrder(moveSessionTab(orderedSessions.map((session) => session.id), sourceId, targetId))
  }

  const secondarySession =
    splitSessionId === null || splitSessionId === activeSession.id
      ? null
      : (visibleSessions.find((session) => session.id === splitSessionId) ?? null)
  const inspectorSession =
    secondarySession !== null && focusedPane === 'secondary' ? secondarySession : activeSession
  const clearSplit = (): void => {
    setSplitSessionId(null)
    setFocusedPane('primary')
  }
  const toggleSplit = (): void => {
    if (secondarySession !== null) {
      clearSplit()
      return
    }
    const next = visibleSessions.find((session) => session.id !== activeSession.id)
    if (next) setSplitSessionId(next.id)
  }
  const splitOnSession = (sessionId: string): void => {
    if (sessionId === activeSession.id) {
      toggleSplit()
      return
    }
    setSplitSessionId(sessionId)
    setFocusedPane('primary')
  }
  const resizeSplit = (clientX: number): void => {
    const rect = splitRectRef.current
    if (rect === null || rect.width <= 0) return
    setSplitRatio(Math.min(0.8, Math.max(0.2, (clientX - rect.left) / rect.width)))
  }
  const beginSplitResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    const container = splitContainerRef.current
    if (container === null) return
    event.preventDefault()
    splitRectRef.current = container.getBoundingClientRect()
    event.currentTarget.setPointerCapture(event.pointerId)
    resizeSplit(event.clientX)
  }
  const endSplitResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    splitRectRef.current = null
  }
  const workspace = (target: SessionSummary, primary: boolean): React.JSX.Element => (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      onPointerDownCapture={() => setFocusedPane(primary ? 'primary' : 'secondary')}
    >
      <SessionWorkspace
        layout="split"
        hideHeader={focusActive}
        showBranch={secondarySession === null}
        session={target}
        repo={repo}
        pending={pending[target.id] ?? null}
        panes={paneSessions.filter((candidate) =>
          primary
            ? secondarySession === null || candidate.id !== secondarySession.id
            : candidate.id === target.id
        )}
        allowSleep
        refreshToken={refreshToken}
        openRequest={null}
        viewRequest={null}
        drafts={drafts}
        sessionsListHidden={false}
        onRestart={onRestartSession}
        onSleep={onSleepSession}
        onWake={onWakeSession}
        onRecheck={onRecheckSession}
        onRemove={onRemoveSession}
        onRecoverWorktree={onRecoverWorktree}
        onError={onError}
        notify={notify}
        onSendToAgent={(text) => sendToAgent(text, target)}
        onOpenRequestHandled={onClearOpenRequest}
        onRequestOpenInFiles={() => undefined}
        onViewRequestHandled={() => undefined}
      />
    </div>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="sessions-surface">
      {pendingCreate !== null ? (
        <PendingBar pending={pendingCreate} project={repo.displayName} />
      ) : null}
      {!focusActive ? (
        <SessionTabStrip
          sessions={visibleSessions}
          activeSessionId={activeSession.id}
          pending={pending}
          onSelect={onSelectSession}
          onClose={closeTab}
          onCloseOthers={closeOtherTabs}
          onCloseRight={closeTabsToRight}
          onReorder={reorderTabs}
          onSplit={toggleSplit}
          onSplitSession={splitOnSession}
          onUnsplit={clearSplit}
          splitActive={secondarySession !== null}
          splitSessionId={splitSessionId}
        />
      ) : null}
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <div ref={splitContainerRef} className="flex min-h-0 min-w-0 flex-1">
          <div
            className="flex min-h-0 min-w-0 flex-col"
            style={
              secondarySession === null
                ? { flexGrow: 1, flexBasis: 0 }
                : { flexGrow: 0, flexShrink: 0, flexBasis: `${splitRatio * 100}%` }
            }
          >
            {workspace(activeSession, true)}
          </div>
          {secondarySession !== null ? (
            <>
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={t('session.resizeSplit')}
                aria-valuenow={Math.round(splitRatio * 100)}
                aria-valuemin={20}
                aria-valuemax={80}
                tabIndex={0}
                className="w-[3px] shrink-0 cursor-col-resize bg-border/70 transition-colors hover:bg-accent/60 focus-visible:bg-accent focus-visible:outline-none"
                onPointerDown={beginSplitResize}
                onPointerMove={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    resizeSplit(event.clientX)
                  }
                }}
                onPointerUp={endSplitResize}
                onPointerCancel={endSplitResize}
                onLostPointerCapture={() => {
                  splitRectRef.current = null
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                  event.preventDefault()
                  setSplitRatio((current) =>
                    Math.min(0.8, Math.max(0.2, current + (event.key === 'ArrowRight' ? 0.02 : -0.02)))
                  )
                }}
                data-testid="session-split-divider"
              />
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                {workspace(secondarySession, false)}
              </div>
            </>
          ) : null}
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
                session={inspectorSession}
                repo={repo}
                refreshToken={refreshToken}
                openRequest={openRequest}
                onOpenRequestHandled={onClearOpenRequest}
                requestedPane={paneRequest}
                notify={notify}
                drafts={drafts}
                onSendToAgent={(text) => sendToAgent(text, inspectorSession)}
                onRecheck={() => onRecheckSession(inspectorSession.id)}
                onOpenTerminal={() => undefined}
                collapsed={inspectorCollapsed}
                onToggleCollapsed={() => setInspectorCollapsed((current) => !current)}
                overlay={narrowViewport}
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
          {t('newSession.startingBody', { project })}
        </p>
      </div>
    </div>
  )
}
