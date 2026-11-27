import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MessageSquare, Plus } from 'lucide-react'
import type { BotSummaryPayload } from '../../../../shared/schemas/bots'
import type { GroupSummaryPayload, GroupThreadPayload } from '../../../../shared/schemas/groups'
import type { RepositorySummary } from '../../../../shared/schemas/ipc'
import { groupThreadIsUntitled } from '../../../../shared/domain/group'
import type { Notice } from '../../state/workspace'
import type { BotsWorkspaceState } from '../../state/use-bots'
import {
  isRoomTab,
  openFilesStore,
  tabKey,
  useSessionFiles,
  type RoomTab
} from '../../files/open-files'
import {
  groupWorkspaceKey,
  roomTabKey,
  roomTabParts
} from '../../workspace/workspace-key'
import {
  clearWorkspaceSplit,
  useWorkspaceSplit
} from '../../state/use-workspace-split'
import {
  isRoomWorkspaceEmpty,
  setRoomWorkspaceEmpty
} from '../../state/room-workspace-empty'
import {
  findPaneForTabKey,
  type SplitLeaf,
  type SplitSide
} from '../../state/workspace-split'
import WorkspaceSplitTreeView from '../sessions/WorkspaceSplitTreeView'
import type { AssistantTaskAction } from '../AssistantCardView'
import { useWindowAttention } from '../../lib/window-attention'
import { useT } from '../../i18n/use-i18n'
import GroupWorkspaceHeader from './GroupWorkspaceHeader'
import GroupRoomPage from './GroupRoomPage'
import GroupSettingsDialog from './GroupSettingsDialog'
import GroupNeedsDock from './GroupNeedsDock'
import ItemsRail from './ItemsRail'
import RoomTabStrip from './RoomTabStrip'

/** The center workspace of one bot group: its rooms as tabs and split panes. */
export default function GroupWorkspaceSurface({
  state,
  group,
  repos,
  notify,
  onOpenTask,
  onOpenSession,
  onTaskAction
}: {
  state: BotsWorkspaceState
  group: GroupSummaryPayload
  repos: RepositorySummary[]
  notify: (notice: Notice) => void
  onOpenTask: (taskId: string) => void
  onOpenSession: (sessionId: string) => void
  onTaskAction: (action: AssistantTaskAction, taskId: string) => void
}): React.JSX.Element {
  const t = useT()
  const scopeKey = groupWorkspaceKey(group.id)
  const tabsState = useSessionFiles(scopeKey)
  const tabs = useMemo(
    () => tabsState.tabs.filter((tab): tab is RoomTab => isRoomTab(tab)),
    [tabsState.tabs]
  )
  const members = useMemo(
    () =>
      group.memberBotIds
        .map((botId) => state.bots.find((bot) => bot.id === botId))
        .filter((bot): bot is BotSummaryPayload => bot !== undefined),
    [group.memberBotIds, state.bots]
  )
  const defaultThread = useMemo(
    () => group.threads.find((thread) => thread.isDefault) ?? group.threads[0] ?? null,
    [group.threads]
  )
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [creatingThread, setCreatingThread] = useState(false)
  const [dropPane, setDropPane] = useState<{
    paneId: string
    side: SplitSide | 'center'
  } | null>(null)
  const attended = useWindowAttention()

  const threadForRoomKey = useCallback(
    (key: string | null): GroupThreadPayload | null => {
      if (key === null) return null
      const parts = roomTabParts(key)
      if (parts === null || parts.groupId !== group.id) return null
      return (
        group.threads.find((thread) =>
          parts.threadId === null ? thread.isDefault : thread.id === parts.threadId
        ) ?? null
      )
    },
    [group.id, group.threads]
  )

  const split = useWorkspaceSplit({
    workspaceKey: scopeKey,
    tabs,
    activeKey: tabsState.activeKey,
    activeSessionId: null,
    onActivateTabKey: (key) => {
      openFilesStore.setActiveKey(scopeKey, key)
      const thread = threadForRoomKey(key)
      if (thread !== null) state.selectThread(thread.id)
    }
  })
  const splitRef = useRef(split)
  splitRef.current = split
  const requestedRef = useRef(state.thread)
  requestedRef.current = state.thread
  const groupRef = useRef(group)
  groupRef.current = group
  const defaultThreadRef = useRef(defaultThread)
  defaultThreadRef.current = defaultThread

  const openRoomInPane = useCallback(
    (thread: GroupThreadPayload, paneId?: string) => {
      const key = roomTabKey(group.id, thread.id, thread.isDefault)
      setRoomWorkspaceEmpty(scopeKey, false)
      openFilesStore.openRoom(
        scopeKey,
        {
          groupId: group.id,
          threadId: thread.id,
          isDefault: thread.isDefault,
          ...(thread.isDefault
            ? { label: group.name }
            : groupThreadIsUntitled(thread)
              ? {}
              : { label: thread.title })
        },
        { activate: false }
      )
      if (paneId === undefined) splitRef.current.activateTab(key)
      else splitRef.current.activateTabInPane(paneId, key)
      state.selectThread(thread.id)
    },
    [group.id, scopeKey, state]
  )

  // Restore this group's rooms once; an explicitly empty strip stays empty.
  useEffect(() => {
    let cancelled = false
    void openFilesStore.whenHydrated().then(() => {
      if (cancelled) return
      const currentGroup = groupRef.current
      const validKeys = new Set(
        currentGroup.threads.map((thread) =>
          roomTabKey(currentGroup.id, thread.id, thread.isDefault)
        )
      )
      openFilesStore.reconcileRooms(scopeKey, validKeys)
      const current = openFilesStore.get(scopeKey)
      if (isRoomWorkspaceEmpty(scopeKey)) {
        // The owner closed every room; a crash may have left stale tabs behind.
        if (current.tabs.length > 0) openFilesStore.clearScope(scopeKey)
        return
      }
      if (current.tabs.length === 0) {
        const requested = requestedRef.current
        const thread =
          requested !== null && requested.groupId === currentGroup.id
            ? requested
            : defaultThreadRef.current
        if (thread !== null) {
          openFilesStore.openRoom(
            scopeKey,
            {
              groupId: currentGroup.id,
              threadId: thread.id,
              isDefault: thread.isDefault,
              ...(thread.isDefault
                ? { label: currentGroup.name }
                : groupThreadIsUntitled(thread)
                  ? {}
                  : { label: thread.title })
            },
            { activate: true }
          )
        }
      } else {
        setRoomWorkspaceEmpty(scopeKey, false)
        if (current.activeKey === null) {
          const first = current.tabs[0]
          if (first !== undefined) openFilesStore.setActiveKey(scopeKey, tabKey(first))
        }
      }
    })
    return () => {
      cancelled = true
    }
  }, [scopeKey])

  // Reconcile when a thread disappears or the roster refreshes.
  const threadKeyList = group.threads
    .map((thread) => `${thread.id}:${thread.isDefault ? '1' : '0'}`)
    .join('|')
  useEffect(() => {
    openFilesStore.reconcileRooms(
      scopeKey,
      new Set(
        group.threads.map((thread) =>
          roomTabKey(group.id, thread.id, thread.isDefault)
        )
      )
    )
  }, [group.id, group.threads, scopeKey, threadKeyList])

  // A sidebar row or a notification asked for one room; show its tab. A
  // background selection refresh does not send a request, so restore wins.
  const roomRequest = state.roomRequest
  useEffect(() => {
    if (roomRequest === null || roomRequest.groupId !== group.id) return
    let cancelled = false
    void openFilesStore.whenHydrated().then(() => {
      if (cancelled) return
      const thread = groupRef.current.threads.find(
        (entry) => entry.id === roomRequest.threadId
      )
      if (thread === undefined) return
      const key = roomTabKey(group.id, thread.id, thread.isDefault)
      const current = openFilesStore.get(scopeKey)
      if (!current.tabs.some((tab) => tabKey(tab) === key)) {
        openFilesStore.openRoom(
          scopeKey,
          {
            groupId: group.id,
            threadId: thread.id,
            isDefault: thread.isDefault,
            ...(thread.isDefault
              ? { label: group.name }
              : groupThreadIsUntitled(thread)
                ? {}
                : { label: thread.title })
          },
          { activate: true }
        )
      }
      splitRef.current.activateTab(key)
    })
    return () => {
      cancelled = true
    }
  }, [group.id, roomRequest, scopeKey])

  // A room's captured label only follows a thread's first title, never a rename.
  useEffect(() => {
    for (const tab of tabs) {
      const thread = group.threads.find((entry) => entry.id === tab.threadId)
      if (thread === undefined) continue
      if (tab.isDefault) {
        if (tab.label === undefined) {
          openFilesStore.setRoomLabel(scopeKey, tab.key, group.name)
        }
        continue
      }
      if (groupThreadIsUntitled(thread)) continue
      if (tab.label !== thread.title) {
        openFilesStore.setRoomLabel(scopeKey, tab.key, thread.title)
      }
    }
  }, [group.name, group.threads, scopeKey, tabs])

  // The restored tab list may arrive after the split tree; show its active room.
  useEffect(() => {
    if (tabs.length === 0) return
    const focused = splitRef.current.focusedTabKey
    if (focused !== null && tabs.some((tab) => tab.key === focused)) return
    const key = tabsState.activeKey ?? tabs[0]?.key
    if (key !== undefined) splitRef.current.activateTab(key)
  }, [tabs, tabsState.activeKey])

  const activeThread = threadForRoomKey(split.focusedTabKey)
  const activeThreadId = activeThread?.id ?? null
  useEffect(() => {
    if (activeThreadId === null) return
    if (
      state.selected?.kind === 'group' &&
      state.selected.groupId === group.id &&
      state.selected.threadId === activeThreadId
    ) {
      return
    }
    state.selectThread(activeThreadId)
  }, [activeThreadId, group.id, state])

  const createThread = useCallback(async (): Promise<GroupThreadPayload | null> => {
    if (creatingThread) return null
    setCreatingThread(true)
    const thread = await state.createThread(group.id)
    setCreatingThread(false)
    if (thread !== null) openRoomInPane(thread)
    return thread
  }, [creatingThread, group.id, openRoomInPane, state])

  const closeTab = (key: string): void => {
    openFilesStore.closeTab(scopeKey, key)
    if (openFilesStore.get(scopeKey).tabs.length === 0) {
      setRoomWorkspaceEmpty(scopeKey, true)
    }
  }
  const closeOthers = (keepKey: string): void => {
    for (const tab of tabs) {
      if (tab.key === keepKey || tab.pinned === true) continue
      openFilesStore.closeTab(scopeKey, tab.key)
    }
  }
  const closeAll = (): void => {
    openFilesStore.closeAll(scopeKey)
    if (openFilesStore.get(scopeKey).tabs.length === 0) {
      setRoomWorkspaceEmpty(scopeKey, true)
    }
  }
  const splitWithTab = (key: string, side: SplitSide): void => {
    const thread = threadForRoomKey(key)
    if (thread !== null) openRoomInPane(thread)
    splitRef.current.splitWithTab(key, side)
  }
  const splitPane = (): void => splitRef.current.splitPane('right')
  const unsplit = (): void => splitRef.current.unsplit()
  const toggleZoom = (): void => splitRef.current.toggleZoom()
  const closePane = (key: string): void => {
    const pane = findPaneForTabKey(splitRef.current.root, key)
    if (pane !== null) splitRef.current.closePane(pane.paneId)
  }

  const deleteGroup = async (): Promise<boolean> => {
    const deleted = await state.deleteGroup(group.id)
    if (deleted) {
      openFilesStore.clearScope(scopeKey)
      clearWorkspaceSplit(scopeKey)
      setRoomWorkspaceEmpty(scopeKey, false)
    }
    return deleted
  }

  const displayedRoomKeys = new Set(split.displayedTabKeys())
  const pickableThreads = group.threads.filter(
    (thread) =>
      !displayedRoomKeys.has(roomTabKey(group.id, thread.id, thread.isDefault))
  )
  const renderPicker = (leaf: SplitLeaf): React.JSX.Element => (
    <div
      className="flex h-full min-h-0 flex-col items-center justify-center gap-2 bg-background p-4"
      data-testid="room-pane-empty"
    >
      <p className="text-[11px] font-medium text-foreground">
        {t('bots.room.noOpenRoom')}
      </p>
      {pickableThreads.length > 0 ? (
        <div className="flex w-full max-w-sm flex-col gap-1">
          {pickableThreads.map((thread) => (
            <button
              key={thread.id}
              type="button"
              className="flex items-center gap-2 rounded border border-border bg-card px-2 py-1.5 text-left text-[11px] hover:bg-muted"
              onClick={() => openRoomInPane(thread, leaf.paneId)}
              data-testid={`room-pick-${thread.id}`}
            >
              <MessageSquare size={10} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">
                {thread.isDefault ? group.name : thread.title}
              </span>
              <Plus size={10} className="shrink-0 text-muted-foreground" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )

  const dropSideAt = (
    event: React.DragEvent<HTMLElement>
  ): SplitSide | 'center' => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = rect.width <= 0 ? 0.5 : (event.clientX - rect.left) / rect.width
    const y = rect.height <= 0 ? 0.5 : (event.clientY - rect.top) / rect.height
    const center = 0.3
    if (x > center && x < 1 - center && y > center && y < 1 - center) {
      return 'center'
    }
    const edges: Array<{ side: SplitSide; distance: number }> = [
      { side: 'left', distance: x },
      { side: 'right', distance: 1 - x },
      { side: 'up', distance: y },
      { side: 'down', distance: 1 - y }
    ]
    edges.sort((left, right) => left.distance - right.distance)
    return edges[0]?.side ?? 'center'
  }

  const renderPane = (leaf: SplitLeaf): React.JSX.Element => {
    const tab = tabs.find((entry) => entry.key === leaf.activeTabKey)
    const thread = tab === undefined ? null : threadForRoomKey(tab.key)
    if (tab === undefined || thread === null) return renderPicker(leaf)
    return (
      <GroupRoomPage
        key={thread.id}
        group={group}
        thread={thread}
        bots={state.bots}
        repos={repos}
        notify={notify}
        visible
        attended={attended}
        onOpenTask={onOpenTask}
        onTaskAction={onTaskAction}
        onNewThread={() => void createThread()}
        onOpenSettings={() => setSettingsOpen(true)}
      />
    )
  }

  return (
    <div className="flex h-full min-h-0 bg-background" data-testid="bots-room">
      <div className="flex min-w-0 flex-1 flex-col">
        <GroupWorkspaceHeader
          group={group}
          members={members}
          activeThreadId={activeThreadId}
          creatingThread={creatingThread}
          onOpenThread={openRoomInPane}
          onNewThread={() => void createThread()}
          onUpdateGroup={state.updateGroup}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <RoomTabStrip
          group={group}
          members={members}
          tabs={tabs}
          threads={group.threads}
          activeKey={split.focusedTabKey}
          splitActive={split.root.kind === 'split'}
          zoomed={split.zoomedPaneId !== null}
          creatingThread={creatingThread}
          onActivate={(key) => {
            splitRef.current.activateTab(key)
          }}
          onClose={closeTab}
          onCloseOthers={closeOthers}
          onCloseAll={closeAll}
          onClosePane={closePane}
          onPin={(key, pinned) => openFilesStore.setPinned(scopeKey, key, pinned)}
          onRename={(key, label) =>
            openFilesStore.setRoomCustomLabel(scopeKey, key, label)
          }
          onColor={(key, color) => openFilesStore.setRoomColor(scopeKey, key, color)}
          onReorder={(source, target) => openFilesStore.moveTab(scopeKey, source, target)}
          onSplitWithTab={splitWithTab}
          onSplit={splitPane}
          onUnsplit={unsplit}
          onToggleZoom={toggleZoom}
          onNewThread={() => void createThread()}
        />
        <div className="flex min-h-0 min-w-0 flex-1">
          {tabs.length === 0 ? (
            <div
              className="flex flex-1 items-center justify-center bg-background p-8"
              data-testid="bots-room-empty"
            >
              <div className="max-w-sm rounded-lg border border-dashed border-border p-5 text-center">
                <MessageSquare size={18} className="mx-auto text-muted-foreground" />
                <p className="mt-2 text-[12px] font-medium">{t('bots.room.noOpenRoom')}</p>
                <button
                  type="button"
                  className="mt-3 inline-flex h-7 items-center gap-1 rounded border border-border px-2 text-[10.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => {
                    if (defaultThread !== null) openRoomInPane(defaultThread)
                  }}
                  data-testid="bots-room-open-original"
                >
                  <Plus size={10} /> {t('bots.room.thread')}
                </button>
              </div>
            </div>
          ) : (
            <WorkspaceSplitTreeView
              node={split.root}
              renderLeaf={(leaf) => (
                <div
                  className={`flex h-full min-h-0 min-w-0 flex-1 ${
                    dropPane?.paneId === leaf.paneId
                      ? 'ring-2 ring-inset ring-accent/60'
                      : ''
                  }`}
                  onDragOver={(event) => {
                    if (!Array.from(event.dataTransfer.types).includes('text/plain')) {
                      return
                    }
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    setDropPane({ paneId: leaf.paneId, side: dropSideAt(event) })
                  }}
                  onDragLeave={(event) => {
                    const next = event.relatedTarget
                    if (
                      next instanceof Node &&
                      event.currentTarget.contains(next)
                    ) {
                      return
                    }
                    setDropPane((current) =>
                      current?.paneId === leaf.paneId ? null : current
                    )
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    const key = event.dataTransfer.getData('text/plain')
                    const side = dropSideAt(event)
                    setDropPane(null)
                    if (!tabs.some((tab) => tab.key === key)) return
                    splitRef.current.placeTabInPane(key, leaf.paneId, side)
                  }}
                  data-testid={`room-pane-${leaf.paneId}`}
                >
                  {renderPane(leaf)}
                </div>
              )}
              onResize={split.resize}
            />
          )}
        </div>
        <GroupNeedsDock
          group={group}
          notify={notify}
          onOpenTask={onOpenTask}
          onOpenSession={onOpenSession}
          onTaskAction={onTaskAction}
        />
      </div>
      <ItemsRail
        filter={{ groupId: group.id }}
        members={members}
        notify={notify}
        onOpenTask={onOpenTask}
        onTaskAction={onTaskAction}
      />
      {settingsOpen ? (
        <GroupSettingsDialog
          group={group}
          bots={state.bots}
          onUpdateGroup={state.updateGroup}
          onArchive={() => state.archiveGroup(group.id)}
          onDelete={deleteGroup}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </div>
  )
}
