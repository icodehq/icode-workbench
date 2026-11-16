import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GripVertical, Loader2, Plus } from 'lucide-react'
import type { AppError } from '../../../../shared/domain/errors'
import { harnessLabel } from '../../../../shared/domain/harness'
import type { RepositorySummary, SessionSummary } from '../../../../shared/schemas/ipc'
import type { AgentSendResult } from '../../lib/agent-send'
import type { WorkbenchDraftStore } from '../../review/drafts'
import type { OpenFileRequest, ViewRequest } from '../../router/use-app-navigation'
import type { Notice, PendingAction } from '../../state/workspace'
import type { PendingCreate } from '../../state/pending-create'
import type { CreateSessionOutcome, CreateSessionRequest } from '../../state/use-workspace'
import SessionInspector from '../sessions/SessionInspector'
import SessionStatusStrip from '../sessions/SessionStatusStrip'
import SessionTabStrip from '../sessions/SessionTabStrip'
import { moveSessionTab, orderSessionTabIds } from '../sessions/session-tab-order'
import SessionWorkspace from '../SessionWorkspace'
import { useT } from '../../i18n/use-i18n'
import { useSessionSplit } from '../../state/use-session-split'
import { registerSplitCommand } from '../../state/split-commands'
import {
  dropZoneAt,
  leafSessionIds,
  type PaneDropZone,
  type SplitSide
} from '../../state/session-split'
import { isMacPlatform } from '../../lib/platform'
import { useElementWidth } from '../../lib/use-element-width'
import SplitTreeView from './SplitTreeView'

const PANE_DRAG_TYPE = 'application/x-icode-pane'

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
  onCreateSession: (input: CreateSessionRequest) => Promise<CreateSessionOutcome>
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
  onCreateSession,
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
  const creatingPane = useRef(false)
  const closeActiveRef = useRef<(() => void) | null>(null)
  const paneDragSource = useRef<string | null>(null)
  const [paneDrop, setPaneDrop] = useState<{
    targetId: string
    zone: PaneDropZone
  } | null>(null)
  const inspectorExpandedRef = useRef(!inspectorCollapsed)
  const autoCollapsedInspectorRef = useRef(false)

  useEffect(() => {
    inspectorExpandedRef.current = !inspectorCollapsed
  }, [inspectorCollapsed])
  const [paneRequest, setPaneRequest] = useState<{
    pane: 'changes' | 'files'
    nonce: number
  } | null>(null)
  /*
   * The row that holds the terminal and the inspector. The inspector's drag
   * bounds are measured against this space, not the window, so the sidebar and
   * split layout cannot leave the terminal under its floor.
   */
  const [surfaceRowRef, surfaceRowWidth] = useElementWidth<HTMLDivElement>()

  useEffect(() => {
    // Below 1280px the inspector yields room to the terminal; below 900px it
    // opens as an overlay instead of taking layout width.
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

  const orderedSessions = useMemo(() => {
    const byId = new Map(sessions.map((session) => [session.id, session]))
    return orderSessionTabIds(
      sessions.map((session) => session.id),
      tabOrder
    ).flatMap((id) => {
      const session = byId.get(id)
      return session === undefined ? [] : [session]
    })
  }, [sessions, tabOrder])
  const visibleSessions = useMemo(
    () =>
      orderedSessions.filter(
        (session) => !closedTabIds.has(session.id) || session.id === activeSession?.id
      ),
    [orderedSessions, closedTabIds, activeSession?.id]
  )
  const visibleSessionIds = useMemo(
    () => visibleSessions.map((session) => session.id),
    [visibleSessions]
  )
  const split = useSessionSplit({
    activeSessionId: activeSession?.id ?? null,
    visibleSessionIds,
    onSelectSession,
    storageKey: repo === null ? null : `icode:split:${repo.id}`
  })
  const { focus, toggleZoom, expectNewSession, cancelNewSession } = split

  const createBeside = useCallback(
    (side: SplitSide): void => {
      const anchor = activeSession
      if (anchor === null || creatingPane.current) return
      creatingPane.current = true
      expectNewSession(anchor.id, side)
      void onCreateSession({
        repoId: anchor.repoId,
        harness: anchor.harness,
        ...(anchor.worktree !== null ? { worktreeId: anchor.worktree.id } : {})
      })
        .then((outcome) => {
          if (!outcome.ok) {
            cancelNewSession()
            onError(outcome.error)
          }
        })
        .catch(() => {
          cancelNewSession()
        })
        .finally(() => {
          creatingPane.current = false
        })
    },
    [activeSession, cancelNewSession, expectNewSession, onCreateSession, onError]
  )

  const toggleSplit = useCallback((): void => {
    if (split.root !== null) {
      split.close()
      return
    }
    const anchor = activeSession
    if (anchor === null) return
    const hasUngrouped = visibleSessions.some(
      (session) => session.id !== anchor.id && !split.groupedSessionIds.has(session.id)
    )
    if (hasUngrouped) split.toggle()
    else createBeside('right')
  }, [activeSession, createBeside, split, visibleSessions])

  useEffect(() => {
    if (activeSession === null) return
    const sessionId = activeSession.id
    const hasSplit = split.root !== null
    const reason = hasSplit ? undefined : t('palette.splitNeedsSplit')
    const unregister = [
      registerSplitCommand('split.left', {
        sessionId,
        enabled: true,
        run: () => createBeside('left')
      }),
      registerSplitCommand('split.right', {
        sessionId,
        enabled: true,
        run: () => createBeside('right')
      }),
      registerSplitCommand('split.up', {
        sessionId,
        enabled: true,
        run: () => createBeside('up')
      }),
      registerSplitCommand('split.down', {
        sessionId,
        enabled: true,
        run: () => createBeside('down')
      }),
      registerSplitCommand('split.zoom', {
        sessionId,
        enabled: hasSplit,
        disabledReason: reason,
        run: toggleZoom
      }),
      registerSplitCommand('split.close', {
        sessionId,
        enabled: hasSplit,
        disabledReason: reason,
        run: split.close
      })
    ]
    return () => {
      for (const remove of unregister) remove()
    }
  }, [activeSession, createBeside, split.close, split.root, t, toggleZoom])

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
          return handle(() => focus(direction))
        }
        if (event.altKey) return
        if (event.shiftKey && !event.altKey && lower === 'enter') return handle(toggleZoom)
        if (event.shiftKey && !event.altKey && lower === 'w') {
          if (activeSession !== null) handle(() => closeActiveRef.current?.())
          return
        }
        if (event.shiftKey && !event.altKey && lower === 'd') {
          return handle(() => createBeside('down'))
        }
        if (!event.shiftKey && !event.altKey && lower === 'd') {
          return handle(() => createBeside('right'))
        }
        return
      }

      if (!event.ctrlKey || event.metaKey) return
      if (event.altKey && !event.shiftKey && direction !== null) {
        return handle(() => focus(direction))
      }
      if (!event.shiftKey || event.altKey) return
      if (lower === 'enter') return handle(toggleZoom)
      if (lower === 'w') {
        if (activeSession !== null) handle(() => closeActiveRef.current?.())
        return
      }
      if (lower === 'd') return handle(() => createBeside('right'))
      if (direction !== null) return handle(() => createBeside(direction))
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [activeSession, createBeside, focus, toggleZoom])

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
  const closeTab = (sessionId: string): void => {
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

  closeActiveRef.current = () => closeTab(activeSession.id)
  const closeTabsNotIn = (keepIds: readonly string[], fallbackId: string): void => {
    const kept = new Set(keepIds)
    if (!kept.has(activeSession.id)) onSelectSession(fallbackId)
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

  const splitRoot =
    split.root !== null && split.root.kind === 'split' ? split.root : null
  const splitLeafIds = splitRoot === null ? null : new Set(leafSessionIds(splitRoot))
  const zoomedSession =
    split.zoomedSessionId === null ? null : (sessionById.get(split.zoomedSessionId) ?? null)
  const dropZoneFor = (event: React.DragEvent<HTMLDivElement>): PaneDropZone => {
    const rect = event.currentTarget.getBoundingClientRect()
    return dropZoneAt(
      event.clientX - rect.left,
      event.clientY - rect.top,
      rect.width,
      rect.height
    )
  }
  const dropOverlayClass = (zone: PaneDropZone): string => {
    switch (zone) {
      case 'left':
        return 'inset-y-0 left-0 w-1/2'
      case 'right':
        return 'inset-y-0 right-0 w-1/2'
      case 'top':
        return 'inset-x-0 top-0 h-1/2'
      case 'bottom':
        return 'inset-x-0 bottom-0 h-1/2'
      case 'center':
        return 'inset-[30%]'
    }
  }
  const workspace = (target: SessionSummary, leafIds: Set<string> | null): React.JSX.Element => (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      onPointerDownCapture={(event) => {
        if (event.button !== 0) return
        if (target.id !== activeSession.id) onSelectSession(target.id)
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(PANE_DRAG_TYPE)) return
        const source = paneDragSource.current
        if (source === null) return
        if (source === target.id) {
          event.dataTransfer.dropEffect = 'none'
          return
        }
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        const zone = dropZoneFor(event)
        setPaneDrop((current) =>
          current !== null && current.targetId === target.id && current.zone === zone
            ? current
            : { targetId: target.id, zone }
        )
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setPaneDrop((current) =>
          current !== null && current.targetId === target.id ? null : current
        )
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes(PANE_DRAG_TYPE)) return
        const source = paneDragSource.current
        if (source === null) return
        event.preventDefault()
        const zone = paneDrop?.targetId === target.id ? paneDrop.zone : dropZoneFor(event)
        if (source !== target.id) split.dropPane(source, target.id, zone)
        paneDragSource.current = null
        setPaneDrop(null)
      }}
      data-testid="session-pane"
      data-session-id={target.id}
      data-active={target.id === activeSession.id}
    >
      <SessionWorkspace
        dragHandle={
          leafIds === null ? undefined : (
            <button
              type="button"
              className="inline-flex h-6 w-5 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground/60 hover:bg-muted hover:text-foreground active:cursor-grabbing"
              draggable
              aria-label={t('session.movePane')}
              title={t('session.movePane')}
              onDragStart={(event) => {
                paneDragSource.current = target.id
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData(PANE_DRAG_TYPE, target.id)
                event.dataTransfer.setData('text/plain', target.id)
                setPaneDrop(null)
              }}
              onDragEnd={() => {
                paneDragSource.current = null
                setPaneDrop(null)
              }}
              data-testid={`session-pane-handle-${target.id}`}
            >
              <GripVertical size={12} />
            </button>
          )
        }
        layout="split"
        hideHeader={focusActive}
        showBranch={leafIds === null}
        session={target}
        repo={repo}
        pending={pending[target.id] ?? null}
        panes={paneSessions.filter((candidate) => {
          if (leafIds === null) return true
          if (candidate.id === target.id) return true
          if (leafIds.has(candidate.id)) return false
          // Hidden tabs keep their terminals mounted in the focused pane.
          return target.id === activeSession.id
        })}
        worktreeShared={
          target.worktree !== null &&
          sessions.some(
            (candidate) =>
              candidate.id !== target.id &&
              candidate.worktree?.id === target.worktree?.id
          )
        }
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
      {paneDrop !== null && paneDrop.targetId === target.id ? (
        <div
          className={`pointer-events-none absolute z-10 rounded-sm border border-accent bg-accent/15 ${dropOverlayClass(paneDrop.zone)}`}
          data-testid="session-drop-preview"
          data-zone={paneDrop.zone}
        />
      ) : null}
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
          onSplitOn={split.splitOn}
          onSwapPanes={split.swapWithFocused}
          onCloseSplit={split.close}
          onToggleZoom={split.toggleZoom}
          zoomed={split.zoomedSessionId !== null}
          groupedSessionIds={split.groupedSessionIds}
          root={splitRoot}
        />
      ) : null}
      <div ref={surfaceRowRef} className="relative flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1">
          {splitRoot === null || zoomedSession !== null ? (
            workspace(zoomedSession ?? activeSession, splitRoot === null ? null : splitLeafIds)
          ) : (
            <SplitTreeView
              node={splitRoot}
              renderLeaf={(sessionId) => {
                const session = sessionById.get(sessionId)
                return session === undefined ? null : workspace(session, splitLeafIds)
              }}
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
                session={activeSession}
                refreshToken={refreshToken}
                openRequest={openRequest}
                onOpenRequestHandled={onClearOpenRequest}
                requestedPane={paneRequest}
                notify={notify}
                drafts={drafts}
                onSendToAgent={(text) => sendToAgent(text, activeSession)}
                onRecheck={() => onRecheckSession(activeSession.id)}
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
