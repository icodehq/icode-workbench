import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MessageSquare, Plus } from 'lucide-react'
import type {
  BotChatPayload,
  BotNewHomeChatResult,
  BotSummaryPayload
} from '../../../../shared/schemas/bots'
import {
  ASSISTANT_PREVIOUS_HOME_TITLE,
  ASSISTANT_SIDE_CHAT_TITLE
} from '../../../../shared/domain/assistant'
import type { RepositorySummary } from '../../../../shared/schemas/ipc'
import type { TaskRecordPayload } from '../../../../shared/icode-api'
import {
  MODEL_HARNESSES,
  isHarnessSelectable,
  type HarnessDetection,
  type ModelHarness
} from '../../../../shared/domain/harness'
import type { Notice } from '../../state/workspace'
import {
  isChatTab,
  openFilesStore,
  useSessionFiles,
  type ChatTab
} from '../../files/open-files'
import { botWorkspaceKey, chatTabKey } from '../../workspace/workspace-key'
import { useWorkspaceSplit } from '../../state/use-workspace-split'
import {
  findPaneForTabKey,
  type SplitLeaf,
  type SplitSide
} from '../../state/workspace-split'
import WorkspaceSplitTreeView from '../sessions/WorkspaceSplitTreeView'
import type { AssistantTaskAction } from '../AssistantCardView'
import { useT } from '../../i18n/use-i18n'
import { callApi, errorNotice } from '../../lib/api'
import BotChatPane from './BotChatPane'
import BotHomeTabStrip from './BotHomeTabStrip'

function chatOrder(left: BotChatPayload, right: BotChatPayload): number {
  if (left.isHome !== right.isHome) return left.isHome ? -1 : 1
  return (right.lastMessageAt ?? right.createdAt) - (left.lastMessageAt ?? left.createdAt)
}

/** Server state is authoritative; a just-created chat may not be back yet. */
function mergeChats(
  current: readonly BotChatPayload[],
  incoming: readonly BotChatPayload[]
): BotChatPayload[] {
  const byId = new Map<string, BotChatPayload>()
  for (const chat of current) byId.set(chat.id, chat)
  for (const chat of incoming) byId.set(chat.id, chat)
  return [...byId.values()].sort(chatOrder)
}

/**
 * A bot's own workspace. Home is a pinned tab; every side chat is an ordinary
 * tab with the shared drag, pin and split behavior.
 */
export default function BotChatWorkspace({
  bot,
  repos,
  tasks,
  mentionBots,
  request,
  notify,
  onOpenTask,
  onTaskAction,
  onOpenHistory,
  onOpenSettings
}: {
  bot: BotSummaryPayload
  repos: RepositorySummary[]
  tasks: TaskRecordPayload[]
  mentionBots: BotSummaryPayload[]
  request: { botId: string; threadId: string; nonce: number } | null
  notify: (notice: Notice) => void
  onOpenTask: (taskId: string) => void
  onTaskAction: (action: AssistantTaskAction, taskId: string) => void
  onOpenHistory: () => void
  onOpenSettings: () => void
}): React.JSX.Element {
  const t = useT()
  const scopeKey = botWorkspaceKey(bot.id)
  const tabsState = useSessionFiles(scopeKey)
  const tabs = useMemo(
    () => tabsState.tabs.filter((tab): tab is ChatTab => isChatTab(tab)),
    [tabsState.tabs]
  )
  const [chats, setChats] = useState<BotChatPayload[]>([])
  const [harnesses, setHarnesses] = useState<HarnessDetection[]>([])
  const [creating, setCreating] = useState(false)
  const handledRequest = useRef<number | null>(null)
  const [dropPane, setDropPane] = useState<{
    paneId: string
    side: SplitSide | 'center'
  } | null>(null)

  const split = useWorkspaceSplit({
    workspaceKey: scopeKey,
    tabs,
    activeKey: tabsState.activeKey,
    activeSessionId: null,
    onActivateTabKey: (key) => openFilesStore.setActiveKey(scopeKey, key)
  })
  const splitRef = useRef(split)
  splitRef.current = split

  // Chats come from the main process; keep labels and unread counts in step
  // without polling. A side chat's first message arrives as a chat event.
  useEffect(() => {
    let cancelled = false
    let timer: number | null = null
    const load = async (): Promise<void> => {
      const result = await callApi<BotChatPayload[]>(window.icode.bots.chats({ botId: bot.id }))
      if (cancelled) return
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      setChats((current) => mergeChats(current, result.value))
    }
    const schedule = (): void => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        void load()
      }, 90)
    }
    void load()
    const off = window.icode.bots.onEvent((event) => {
      if (event.type === 'chat') {
        if (event.botId === bot.id) schedule()
        return
      }
      if (event.botId === null || event.botId === bot.id) schedule()
    })
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
      off()
    }
  }, [bot.id, notify])

  useEffect(() => {
    let cancelled = false
    void callApi<HarnessDetection[]>(window.icode.harness.list()).then((result) => {
      if (!cancelled && result.ok) setHarnesses(result.value)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const agents = useMemo(
    () =>
      MODEL_HARNESSES.map((harness) => ({
        harness,
        available: harnesses.some(
          (detection) => detection.harness === harness && isHarnessSelectable(detection)
        )
      })),
    [harnesses]
  )

  const chatForThread = useCallback(
    (threadId: string): BotChatPayload | null =>
      chats.find((chat) => chat.id === threadId) ?? null,
    [chats]
  )

  const openChatInPane = useCallback(
    (chat: BotChatPayload, paneId?: string) => {
      const key = chatTabKey(bot.id, chat.id)
      openFilesStore.openChat(
        scopeKey,
        {
          botId: bot.id,
          threadId: chat.id,
          isHome: chat.isHome,
          label: chat.title
        },
        { activate: false }
      )
      if (paneId === undefined) splitRef.current.activateTab(key)
      else splitRef.current.activateTabInPane(paneId, key)
    },
    [bot.id, scopeKey]
  )

  // Restore the bot's tabs once and make sure Home is always present.
  const chatsKey = chats
    .map((chat) => `${chat.id}:${chat.isHome ? '1' : '0'}`)
    .join('|')
  useEffect(() => {
    if (chats.length === 0) return
    let cancelled = false
    void openFilesStore.whenHydrated().then(() => {
      if (cancelled) return
      const valid = new Set(chats.map((chat) => chatTabKey(bot.id, chat.id)))
      openFilesStore.reconcileChats(scopeKey, valid)
      const home = chats.find((chat) => chat.isHome)
      if (home === undefined) return
      const homeKey = chatTabKey(bot.id, home.id)
      const current = openFilesStore.get(scopeKey)
      const currentChatTabs = current.tabs.filter(isChatTab)
      if (!currentChatTabs.some((tab) => tab.key === homeKey)) {
        openFilesStore.openChat(
          scopeKey,
          {
            botId: bot.id,
            threadId: home.id,
            isHome: true,
            label: home.title
          },
          { activate: currentChatTabs.length === 0 }
        )
      }
      const after = openFilesStore.get(scopeKey)
      if (after.activeKey === null) openFilesStore.setActiveKey(scopeKey, homeKey)
    })
    return () => {
      cancelled = true
    }
    // chatsKey is the stable identity; labels alone should not re-run reconcile.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id, scopeKey, chatsKey])

  // A side chat's first owner message names it; keep the tab title current.
  useEffect(() => {
    for (const tab of tabs) {
      const chat = chatForThread(tab.threadId)
      if (chat === null) continue
      if (chat.title !== tab.label) openFilesStore.setChatLabel(scopeKey, tab.key, chat.title)
    }
  }, [chatForThread, scopeKey, tabs])

  // The restored tab list may arrive after the split tree; show its active chat.
  useEffect(() => {
    if (tabs.length === 0) return
    const focused = splitRef.current.focusedTabKey
    if (focused !== null && tabs.some((tab) => tab.key === focused)) return
    const key = tabsState.activeKey ?? tabs[0]?.key
    if (key !== undefined) splitRef.current.activateTab(key)
  }, [tabs, tabsState.activeKey])

  // Session History or a notification can name one chat to open.
  useEffect(() => {
    if (request === null || request.botId !== bot.id) return
    if (handledRequest.current === request.nonce) return
    const chat = chats.find((entry) => entry.id === request.threadId)
    if (chat === undefined) return
    handledRequest.current = request.nonce
    openChatInPane(chat)
  }, [bot.id, chats, openChatInPane, request])

  const createChat = useCallback(
    async (harness?: ModelHarness): Promise<BotChatPayload | null> => {
    if (creating) return null
    setCreating(true)
    const result = await callApi<BotChatPayload>(
      window.icode.bots.createChat({
        botId: bot.id,
        ...(harness === undefined ? {} : { harness })
      })
    )
    setCreating(false)
    if (!result.ok) {
      notify(errorNotice(result.error))
      return null
    }
    setChats((current) => mergeChats(current, [result.value]))
    openChatInPane(result.value)
    return result.value
    },
    [bot.id, creating, notify, openChatInPane]
  )

  const newHomeChat = useCallback(async (): Promise<void> => {
    if (creating) return
    setCreating(true)
    const result = await callApi<BotNewHomeChatResult>(
      window.icode.bots.newHomeChat({ botId: bot.id })
    )
    setCreating(false)
    if (!result.ok) {
      notify(errorNotice(result.error))
      return
    }
    setChats((current) =>
      mergeChats(
        current.map((chat) =>
          chat.id === result.value.replacedThreadId ? { ...chat, isHome: false } : chat
        ),
        [result.value.thread]
      )
    )
    if (result.value.replacedThreadId !== null) {
      openFilesStore.removeChatTab(
        scopeKey,
        chatTabKey(bot.id, result.value.replacedThreadId)
      )
    }
    openChatInPane(result.value.thread)
  }, [bot.id, creating, notify, openChatInPane, scopeKey])

  const closeTab = (key: string): void => {
    openFilesStore.closeTab(scopeKey, key)
  }
  const closeOthers = (keepKey: string): void => {
    for (const tab of tabs) {
      if (tab.key === keepKey || tab.pinned === true || tab.isHome) continue
      openFilesStore.closeTab(scopeKey, tab.key)
    }
  }
  const closeAll = (): void => openFilesStore.closeAll(scopeKey)
  const splitWithTab = (key: string, side: SplitSide): void => {
    const tab = tabs.find((entry) => entry.key === key)
    if (tab !== undefined) {
      const chat = chatForThread(tab.threadId)
      if (chat !== null) openChatInPane(chat)
    }
    splitRef.current.splitWithTab(key, side)
  }
  const splitPane = (): void => splitRef.current.splitPane('right')
  const unsplit = (): void => splitRef.current.unsplit()
  const toggleZoom = (): void => splitRef.current.toggleZoom()
  const closePane = (key: string): void => {
    const pane = findPaneForTabKey(splitRef.current.root, key)
    if (pane !== null) splitRef.current.closePane(pane.paneId)
  }

  const unreadByThread = useMemo(() => {
    const map = new Map<string, number>()
    for (const chat of chats) map.set(chat.id, chat.unread)
    return map
  }, [chats])

  const labelForThread = (threadId: string): string => {
    const chat = chatForThread(threadId)
    if (chat === null) return t('bots.chat.untitled')
    if (chat.isHome) return t('bots.home.tab')
    if (chat.title === ASSISTANT_SIDE_CHAT_TITLE) return t('bots.chat.untitled')
    if (chat.title === ASSISTANT_PREVIOUS_HOME_TITLE) return t('bots.chat.previousHome')
    return chat.title
  }

  const displayedKeys = new Set(split.displayedTabKeys())
  const pickableChats = chats.filter(
    (chat) => !displayedKeys.has(chatTabKey(bot.id, chat.id))
  )
  const renderPicker = (leaf: SplitLeaf): React.JSX.Element => (
    <div
      className="flex h-full min-h-0 flex-col items-center justify-center gap-2 bg-background p-4"
      data-testid="bot-chat-pane-empty"
    >
      <p className="text-[11px] font-medium text-foreground">{t('bots.chat.noOpenChat')}</p>
      {pickableChats.length > 0 ? (
        <div className="flex w-full max-w-sm flex-col gap-1">
          {pickableChats.map((chat) => (
            <button
              key={chat.id}
              type="button"
              className="flex items-center gap-2 rounded border border-border bg-card px-2 py-1.5 text-left text-[11px] hover:bg-muted"
              onClick={() => openChatInPane(chat, leaf.paneId)}
              data-testid={`bot-chat-pick-${chat.id}`}
            >
              <MessageSquare size={10} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">
                {chat.isHome ? t('bots.home.tab') : chat.title}
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
    if (tab === undefined) return renderPicker(leaf)
    const chat = chatForThread(tab.threadId)
    return (
      <BotChatPane
        key={tab.threadId}
        bot={bot}
        threadId={tab.threadId}
        title={labelForThread(tab.threadId)}
        creating={creating}
        repos={repos}
        tasks={tasks}
        mentionBots={mentionBots}
        notify={notify}
        onOpenTask={onOpenTask}
        onTaskAction={onTaskAction}
        onOpenHistory={onOpenHistory}
        onOpenSettings={onOpenSettings}
        onNewChat={() => void createChat()}
        harness={chat?.harness ?? null}
      />
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="bot-home-workspace">
      <BotHomeTabStrip
        bot={bot}
        tabs={tabs}
        activeKey={split.focusedTabKey}
        unreadByThread={unreadByThread}
        agents={agents}
        creating={creating}
        splitActive={split.root.kind === 'split'}
        zoomed={split.zoomedPaneId !== null}
        onActivate={(key) => splitRef.current.activateTab(key)}
        onClose={closeTab}
        onCloseOthers={closeOthers}
        onCloseAll={closeAll}
        onClosePane={closePane}
        onPin={(key, pinned) => openFilesStore.setPinned(scopeKey, key, pinned)}
        onRename={(key, label) =>
          openFilesStore.setChatCustomLabel(scopeKey, key, label)
        }
        onColor={(key, color) => openFilesStore.setChatColor(scopeKey, key, color)}
        onReorder={(source, target) => openFilesStore.moveTab(scopeKey, source, target)}
        onSplitWithTab={splitWithTab}
        onSplit={splitPane}
        onUnsplit={unsplit}
        onToggleZoom={toggleZoom}
        onNewChat={(harness) => void createChat(harness)}
        onNewHomeChat={() => void newHomeChat()}
      />
      <div className="flex min-h-0 min-w-0 flex-1">
        {tabs.length === 0 ? (
          <div className="flex flex-1 items-center justify-center bg-background p-8">
            <button
              type="button"
              className="inline-flex h-7 items-center gap-1 rounded border border-border px-2 text-[10.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => void createChat()}
              data-testid="bot-chat-open-first"
            >
              <Plus size={10} /> {t('bots.home.newChat')}
            </button>
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
                  if (next instanceof Node && event.currentTarget.contains(next)) {
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
                data-testid={`bot-chat-pane-${leaf.paneId}`}
              >
                {renderPane(leaf)}
              </div>
            )}
            onResize={split.resize}
          />
        )}
      </div>
    </div>
  )
}
