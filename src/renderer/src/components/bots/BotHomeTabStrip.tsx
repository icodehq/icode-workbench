import { useRef, useState } from 'react'
import {
  Columns2,
  Copy,
  Home,
  Loader2,
  Maximize2,
  Minimize2,
  Pencil,
  Pin,
  PinOff,
  Plus,
  X
} from 'lucide-react'
import type { BotSummaryPayload } from '../../../../shared/schemas/bots'
import { harnessLabel, type ModelHarness } from '../../../../shared/domain/harness'
import {
  ASSISTANT_PREVIOUS_HOME_TITLE,
  ASSISTANT_SIDE_CHAT_TITLE
} from '../../../../shared/domain/assistant'
import type { ChatTab } from '../../files/open-files'
import type { SplitSide } from '../../state/workspace-split'
import { useT } from '../../i18n/use-i18n'
import AssistantAvatar from '../AssistantAvatar'
import ContextMenu, {
  type ContextMenuItem,
  type MenuAnchor
} from '../ContextMenu'

function tabTestId(tab: ChatTab): string {
  return tab.isHome ? 'bot-home-tab' : `bot-chat-tab-${tab.threadId}`
}

const CHAT_TAB_COLORS = [
  { key: 'red', value: '#ef4444' },
  { key: 'orange', value: '#f97316' },
  { key: 'yellow', value: '#eab308' },
  { key: 'green', value: '#22c55e' },
  { key: 'blue', value: '#3b82f6' },
  { key: 'purple', value: '#a855f7' }
] as const

/**
 * The tab strip of a bot's own workspace: its pinned Home chat and every open
 * side chat, with the same pin, drag and split controls as other workspaces.
 */
export default function BotHomeTabStrip({
  bot,
  tabs,
  activeKey,
  unreadByThread,
  agents,
  creating,
  splitActive,
  zoomed,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseAll,
  onClosePane,
  onPin,
  onRename,
  onColor,
  onReorder,
  onSplitWithTab,
  onSplit,
  onUnsplit,
  onToggleZoom,
  onNewChat,
  onNewHomeChat
}: {
  bot: BotSummaryPayload
  tabs: readonly ChatTab[]
  activeKey: string | null
  unreadByThread: ReadonlyMap<string, number>
  agents: readonly { harness: ModelHarness; available: boolean }[]
  creating: boolean
  splitActive: boolean
  zoomed: boolean
  onActivate: (key: string) => void
  onClose: (key: string) => void
  onCloseOthers: (key: string) => void
  onCloseAll: () => void
  onClosePane: (key: string) => void
  onPin: (key: string, pinned: boolean) => void
  onRename: (key: string, label: string | undefined) => void
  onColor: (key: string, color: string | undefined) => void
  onReorder: (sourceKey: string, targetKey: string) => void
  onSplitWithTab: (key: string, side: SplitSide) => void
  onSplit: () => void
  onUnsplit: () => void
  onToggleZoom: () => void
  onNewChat: (harness?: ModelHarness) => void
  onNewHomeChat: () => void
}): React.JSX.Element {
  const t = useT()
  const dragging = useRef<string | null>(null)
  const [draggingKey, setDraggingKey] = useState<string | null>(null)
  const [dropKey, setDropKey] = useState<string | null>(null)
  const [newAnchor, setNewAnchor] = useState<MenuAnchor | null>(null)
  const [renaming, setRenaming] = useState<{ key: string; draft: string } | null>(null)
  const [menu, setMenu] = useState<{
    key: string
    x: number
    y: number
    opener: HTMLElement
  } | null>(null)

  const labelFor = (tab: ChatTab): string => {
    if (tab.customLabel !== undefined) return tab.customLabel
    if (tab.isHome) return t('bots.home.tab')
    if (tab.label === ASSISTANT_SIDE_CHAT_TITLE) return t('bots.chat.untitled')
    if (tab.label === ASSISTANT_PREVIOUS_HOME_TITLE) return t('bots.chat.previousHome')
    return tab.label
  }

  const commitRename = (): void => {
    if (renaming === null) return
    const label = renaming.draft.trim()
    onRename(renaming.key, label.length === 0 ? undefined : label)
    setRenaming(null)
  }

  const colorName = (key: (typeof CHAT_TAB_COLORS)[number]['key']): string => {
    switch (key) {
      case 'red':
        return t('bots.tab.color.red')
      case 'orange':
        return t('bots.tab.color.orange')
      case 'yellow':
        return t('bots.tab.color.yellow')
      case 'green':
        return t('bots.tab.color.green')
      case 'blue':
        return t('bots.tab.color.blue')
      case 'purple':
        return t('bots.tab.color.purple')
    }
  }

  const menuTab = menu === null ? null : (tabs.find((tab) => tab.key === menu.key) ?? null)
  const closeSide = (key: string, side: 'left' | 'right'): void => {
    const index = tabs.findIndex((tab) => tab.key === key)
    if (index < 0) return
    const targets = side === 'left' ? tabs.slice(0, index) : tabs.slice(index + 1)
    for (const tab of targets) {
      if (tab.pinned === true || tab.isHome) continue
      onClose(tab.key)
    }
  }

  const menuItems: ContextMenuItem[] =
    menuTab === null || menuTab.isHome
      ? []
      : [
          {
            id: 'rename',
            label: t('bots.row.rename'),
            icon: <Pencil size={11} />,
            onSelect: () => {
              const current = tabs.find((tab) => tab.key === menuTab.key)
              if (current !== undefined) {
                setRenaming({ key: current.key, draft: labelFor(current) })
              }
            }
          },
          {
            id: 'pin',
            label: menuTab.pinned === true ? t('bots.tab.unpin') : t('bots.tab.pin'),
            icon: menuTab.pinned === true ? <PinOff size={11} /> : <Pin size={11} />,
            onSelect: () => onPin(menuTab.key, menuTab.pinned !== true)
          },
          {
            id: 'close',
            label: t('session.close'),
            icon: <X size={11} />,
            onSelect: () => onClose(menuTab.key)
          },
          {
            id: 'copy-id',
            label: t('bots.tab.copyId'),
            icon: <Copy size={11} />,
            onSelect: () => {
              void navigator.clipboard?.writeText(menuTab.key).catch(() => undefined)
            }
          },
          {
            id: 'close-others',
            label: t('session.closeOthers'),
            disabled: tabs.filter((tab) => !tab.isHome).length <= 1,
            onSelect: () => onCloseOthers(menuTab.key)
          },
          {
            id: 'close-left',
            label: t('session.closeLeft'),
            disabled: menuTab.key === tabs[0]?.key,
            onSelect: () => closeSide(menuTab.key, 'left')
          },
          {
            id: 'close-right',
            label: t('session.closeRight'),
            disabled: menuTab.key === tabs.at(-1)?.key,
            onSelect: () => closeSide(menuTab.key, 'right')
          },
          {
            id: 'close-all',
            label: t('files.toolbar.closeAll'),
            disabled: tabs.every((tab) => tab.isHome || tab.pinned === true),
            onSelect: onCloseAll
          },
          ...(splitActive
            ? [
                {
                  id: 'close-pane',
                  label: t('session.closeSplitPane'),
                  onSelect: () => onClosePane(menuTab.key)
                }
              ]
            : []),
          ...CHAT_TAB_COLORS.map((color, index) => ({
            id: `color-${color.key}`,
            label: colorName(color.key),
            icon: (
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: color.value }}
              />
            ),
            separatorBefore: index === 0,
            onSelect: () => onColor(menuTab.key, color.value)
          })),
          ...(menuTab.color === undefined
            ? []
            : [
                {
                  id: 'color-clear',
                  label: t('bots.tab.color.clear'),
                  onSelect: () => onColor(menuTab.key, undefined)
                }
              ]),
          {
            id: 'split-left',
            label: t('session.splitLeft'),
            icon: <Columns2 size={11} />,
            separatorBefore: true,
            disabled: tabs.length <= 1,
            onSelect: () => onSplitWithTab(menuTab.key, 'left')
          },
          {
            id: 'split-right',
            label: t('session.splitRight'),
            icon: <Columns2 size={11} />,
            disabled: tabs.length <= 1,
            onSelect: () => onSplitWithTab(menuTab.key, 'right')
          },
          {
            id: 'split-up',
            label: t('session.splitUp'),
            icon: <Columns2 size={11} />,
            disabled: tabs.length <= 1,
            onSelect: () => onSplitWithTab(menuTab.key, 'up')
          },
          {
            id: 'split-down',
            label: t('session.splitDown'),
            icon: <Columns2 size={11} />,
            disabled: tabs.length <= 1,
            onSelect: () => onSplitWithTab(menuTab.key, 'down')
          },
          ...(splitActive
            ? [
                {
                  id: 'unsplit',
                  label: t('session.unsplit'),
                  separatorBefore: true,
                  onSelect: onUnsplit
                }
              ]
            : [])
        ]

  return (
    <>
      <nav
        className="icode-titlebar window-chrome-safe flex h-9 shrink-0 items-stretch gap-1 overflow-x-auto border-b border-border bg-card px-2"
        role="tablist"
        aria-label={t('bots.home.tab')}
        data-testid="bot-home-tabs"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          const buttons = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')
          )
          const index = buttons.indexOf(document.activeElement as HTMLElement)
          if (index < 0) return
          event.preventDefault()
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? buttons.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) %
                  buttons.length
          const target = buttons[next]
          target?.focus()
          target?.click()
        }}
      >
        {tabs.map((tab) => {
          const label = labelFor(tab)
          const testId = tabTestId(tab)
          const active = tab.key === activeKey
          const isDragged = draggingKey === tab.key
          const isDropTarget = dropKey === tab.key
          const unread = unreadByThread.get(tab.threadId) ?? 0
          return (
            <div
              key={tab.key}
              className={`flex h-9 shrink-0 items-center rounded-sm ${
                isDropTarget ? 'ring-1 ring-inset ring-accent/70' : ''
              }`}
            >
              {renaming !== null && renaming.key === tab.key ? (
                <input
                  className="h-7 w-[160px] rounded border border-line-strong bg-background px-1.5 text-[11px] text-foreground outline-none"
                  value={renaming.draft}
                  autoFocus
                  maxLength={80}
                  onChange={(event) =>
                    setRenaming({ key: tab.key, draft: event.target.value })
                  }
                  onClick={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                  onBlur={commitRename}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      commitRename()
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      setRenaming(null)
                    }
                  }}
                  data-testid="bot-chat-rename"
                />
              ) : (
              <button
                type="button"
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                draggable={!tab.isHome}
                className={`inline-flex h-9 max-w-[220px] items-center gap-1.5 border-b-2 px-2.5 text-[11px] ${
                  active
                    ? 'border-accent text-foreground'
                    : 'border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                } ${isDragged ? 'opacity-50' : ''}`}
                onClick={() => onActivate(tab.key)}
                onContextMenu={(event) => {
                  if (tab.isHome) return
                  event.preventDefault()
                  setMenu({
                    key: tab.key,
                    x: event.clientX,
                    y: event.clientY,
                    opener: event.currentTarget
                  })
                }}
                onDragStart={(event) => {
                  if (tab.isHome) return
                  dragging.current = tab.key
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', tab.key)
                  setDraggingKey(tab.key)
                }}
                onDragOver={(event) => {
                  const source = dragging.current
                  if (source === null || source === tab.key) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  setDropKey(tab.key)
                }}
                onDragLeave={() =>
                  setDropKey((current) => (current === tab.key ? null : current))
                }
                onDrop={(event) => {
                  event.preventDefault()
                  const source = dragging.current
                  if (source !== null && source !== tab.key) onReorder(source, tab.key)
                  dragging.current = null
                  setDraggingKey(null)
                  setDropKey(null)
                }}
                onDragEnd={() => {
                  dragging.current = null
                  setDraggingKey(null)
                  setDropKey(null)
                }}
                title={label}
                data-tab-key={tab.key}
                data-testid={testId}
              >
                {tab.color !== undefined ? (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: tab.color }}
                    data-testid={`${testId}-color`}
                  />
                ) : null}
                {tab.isHome ? (
                  <AssistantAvatar
                    name={bot.name}
                    status={bot.status}
                    size="sm"
                    color={bot.avatarColor}
                    image={bot.avatarImage}
                    mascot={bot.avatarMascot}
                    outfit={bot.avatarOutfit}
                  />
                ) : null}
                {tab.pinned === true && !tab.isHome ? (
                  <Pin size={9} className="shrink-0 text-accent" />
                ) : null}
                <span className="min-w-0 truncate">{label}</span>
                {unread > 0 ? (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-signal"
                    title={t('bots.unread', { count: unread })}
                    data-testid={`${testId}-unread`}
                  />
                ) : null}
              </button>
              )}
              {tab.isHome || tab.pinned === true ? null : (
                <button
                  type="button"
                  className="ml-0.5 inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => onClose(tab.key)}
                  aria-label={t('session.close')}
                  title={t('session.close')}
                  data-testid={`bot-chat-close-${tab.threadId}`}
                >
                  <X size={10} />
                </button>
              )}
            </div>
          )
        })}

        <div className="relative flex h-9 shrink-0 items-center">
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              setNewAnchor({
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom: rect.bottom
              })
            }}
            disabled={creating}
            aria-label={t('bots.home.newChat')}
            aria-haspopup="menu"
            aria-expanded={newAnchor !== null}
            title={t('bots.home.newChat')}
            data-testid="bot-chat-new"
          >
            {creating ? <Loader2 size={13} className="animate-spin" /> : <Plus size={14} />}
          </button>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground ${
              splitActive ? 'bg-accent-weak text-accent' : ''
            }`}
            onClick={splitActive ? onUnsplit : onSplit}
            disabled={!splitActive && tabs.length < 2}
            aria-pressed={splitActive}
            aria-label={splitActive ? t('session.unsplit') : t('session.split')}
            title={
              !splitActive && tabs.length < 2
                ? t('session.splitNeedsOther')
                : splitActive
                  ? t('session.unsplit')
                  : t('session.split')
            }
            data-testid="bot-chat-split"
          >
            <Columns2 size={12} />
          </button>
          {splitActive ? (
            <button
              type="button"
              className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground ${
                zoomed ? 'bg-accent-weak text-accent' : ''
              }`}
              onClick={onToggleZoom}
              aria-pressed={zoomed}
              aria-label={zoomed ? t('session.unzoom') : t('session.zoom')}
              title={zoomed ? t('session.unzoom') : t('session.zoom')}
              data-testid="bot-chat-zoom"
            >
              {zoomed ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
            </button>
          ) : null}
        </div>
      </nav>
      {menu !== null && menuTab !== null ? (
        <ContextMenu
          items={menuItems}
          x={menu.x}
          y={menu.y}
          returnFocus={menu.opener}
          opener={menu.opener}
          ariaLabel={t('bots.home.tab')}
          testId="bot-chat-menu"
          width={190}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {newAnchor !== null ? (
        <ContextMenu
          anchor={newAnchor}
          align="start"
          items={[
            {
              id: 'new-home-chat',
              label: `${t('bots.newHomeChat.action')} — ${t('bots.newHomeChat.hint')}`,
              icon: <Home size={11} />,
              testId: 'bot-new-home-chat-item',
              onSelect: () => {
                setNewAnchor(null)
                onNewHomeChat()
              }
            },
            {
              id: 'side-chats-label',
              kind: 'hint',
              label: t('bots.sideChatsWith', { name: bot.name }),
              separatorBefore: true,
              onSelect: () => undefined
            },
            ...agents.map(({ harness, available }) => ({
              id: `new-${harness}`,
              label: t('bots.newAgentChat', { agent: harnessLabel(harness) }),
              icon: <Plus size={11} />,
              disabled: !available,
              ...(available
                ? {}
                : { reason: t('bots.chat.agentUnavailable') }),
              testId: `bot-chat-new-${harness}`,
              onSelect: () => {
                setNewAnchor(null)
                onNewChat(harness)
              }
            }))
          ]}
          ariaLabel={t('bots.home.newChat')}
          testId="bot-chat-new-menu"
          width={240}
          onClose={() => setNewAnchor(null)}
        />
      ) : null}
    </>
  )
}
