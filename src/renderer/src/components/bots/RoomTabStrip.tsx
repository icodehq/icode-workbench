import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Columns2,
  Loader2,
  Maximize2,
  Minimize2,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Users,
  X
} from 'lucide-react'
import type { BotSummaryPayload } from '../../../../shared/schemas/bots'
import type { GroupSummaryPayload, GroupThreadPayload } from '../../../../shared/schemas/groups'
import type { RoomTab } from '../../files/open-files'
import {
  groupThreadDisplayLabel,
  groupThreadLabel
} from '../../../../shared/domain/group'
import type { SplitSide } from '../../state/workspace-split'
import { useT } from '../../i18n/use-i18n'
import AssistantAvatar from '../AssistantAvatar'
import ContextMenu, {
  type ContextMenuItem,
  type MenuAnchor
} from '../ContextMenu'

function tabTestId(key: string): string {
  return `room-tab-${key.replace(/:/g, '-')}`
}

const ROOM_TAB_COLORS = [
  { key: 'red', value: '#ef4444' },
  { key: 'orange', value: '#f97316' },
  { key: 'yellow', value: '#eab308' },
  { key: 'green', value: '#22c55e' },
  { key: 'blue', value: '#3b82f6' },
  { key: 'purple', value: '#a855f7' }
] as const

/** The center tab strip of one group workspace: rooms, pin, drag, split. */
export default function RoomTabStrip({
  group,
  members,
  tabs,
  threads,
  activeKey,
  splitActive,
  zoomed,
  creatingThread,
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
  onNewThread
}: {
  group: GroupSummaryPayload
  members: readonly BotSummaryPayload[]
  tabs: readonly RoomTab[]
  threads: readonly GroupThreadPayload[]
  activeKey: string | null
  splitActive: boolean
  zoomed: boolean
  creatingThread: boolean
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
  onNewThread: () => void
}): React.JSX.Element {
  const t = useT()
  const dragging = useRef<string | null>(null)
  const hoverTimer = useRef<number | null>(null)
  const [draggingKey, setDraggingKey] = useState<string | null>(null)
  const [dropKey, setDropKey] = useState<string | null>(null)
  const [newAnchor, setNewAnchor] = useState<MenuAnchor | null>(null)
  const [renaming, setRenaming] = useState<{ key: string; draft: string } | null>(null)
  const [hover, setHover] = useState<{ key: string; left: number; top: number } | null>(
    null
  )
  const [menu, setMenu] = useState<{
    key: string
    x: number
    y: number
    opener: HTMLElement
  } | null>(null)

  useEffect(
    () => () => {
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current)
    },
    []
  )

  const labelFor = (tab: RoomTab): string => {
    if (tab.customLabel !== undefined) return tab.customLabel
    if (tab.label !== undefined) return tab.label
    const thread = threads.find((entry) => entry.id === tab.threadId)
    return thread === null || thread === undefined
      ? groupThreadLabel(
          group.name,
          { title: tab.threadId, isDefault: tab.isDefault },
          t('bots.thread.untitled')
        )
      : groupThreadDisplayLabel(
          group.name,
          thread,
          group.threads,
          t('bots.thread.untitled')
        )
  }

  const cancelHover = (): void => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
    setHover(null)
  }

  const scheduleHover = (tab: RoomTab, element: HTMLElement): void => {
    cancelHover()
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null
      if (dragging.current !== null) return
      const rect = element.getBoundingClientRect()
      setHover({
        key: tab.key,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 300)),
        top: Math.min(rect.bottom + 6, window.innerHeight - 240)
      })
    }, 320)
  }

  const commitRename = (): void => {
    if (renaming === null) return
    const label = renaming.draft.trim()
    onRename(renaming.key, label.length === 0 ? undefined : label)
    setRenaming(null)
  }

  const menuTab = menu === null ? null : (tabs.find((tab) => tab.key === menu.key) ?? null)
  const closeSide = (key: string, side: 'left' | 'right'): void => {
    const index = tabs.findIndex((tab) => tab.key === key)
    if (index < 0) return
    const targets = side === 'left' ? tabs.slice(0, index) : tabs.slice(index + 1)
    for (const tab of targets) {
      if (tab.pinned === true) continue
      onClose(tab.key)
    }
  }

  const colorName = (key: (typeof ROOM_TAB_COLORS)[number]['key']): string => {
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

  const menuItems: ContextMenuItem[] =
    menuTab === null
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
            icon:
              menuTab.pinned === true ? <PinOff size={11} /> : <Pin size={11} />,
            onSelect: () => onPin(menuTab.key, menuTab.pinned !== true)
          },
          {
            id: 'close',
            label: t('session.close'),
            icon: <X size={11} />,
            disabled: menuTab.pinned === true,
            onSelect: () => onClose(menuTab.key)
          },
          {
            id: 'close-others',
            label: t('session.closeOthers'),
            disabled: tabs.length <= 1,
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
            disabled: tabs.every((tab) => tab.pinned === true),
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
          ...ROOM_TAB_COLORS.map((color, index) => ({
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
        aria-label={t('bots.room.threads')}
        data-testid="room-tabs"
        onScroll={cancelHover}
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
          const thread =
            threads.find((entry) => entry.id === tab.threadId) ?? null
          const label = labelFor(tab)
          const testId = tabTestId(tab.key)
          const active = tab.key === activeKey
          const isDragged = draggingKey === tab.key
          const isDropTarget = dropKey === tab.key
          const activeRename =
            renaming !== null && renaming.key === tab.key ? renaming : null
          return (
            <div
              key={tab.key}
              className={`flex h-9 shrink-0 items-center rounded-sm ${
                isDropTarget ? 'ring-1 ring-inset ring-accent/70' : ''
              }`}
            >
              {activeRename !== null ? (
                <input
                  className="h-7 w-[160px] rounded border border-line-strong bg-background px-1.5 text-[11.5px] text-foreground outline-none"
                  value={activeRename.draft}
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
                  data-testid="room-tab-rename"
                />
              ) : (
              <button
                type="button"
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                draggable
                className={`inline-flex h-9 max-w-[220px] items-center gap-1.5 border-b-2 px-2.5 text-[11.5px] ${
                  active
                    ? 'border-accent text-foreground'
                    : 'border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                } ${isDragged ? 'opacity-50' : ''}`}
                onClick={() => onActivate(tab.key)}
                onDoubleClick={() => onPin(tab.key, tab.pinned !== true)}
                onMouseEnter={(event) => scheduleHover(tab, event.currentTarget)}
                onMouseLeave={cancelHover}
                onContextMenu={(event) => {
                  event.preventDefault()
                  cancelHover()
                  setMenu({
                    key: tab.key,
                    x: event.clientX,
                    y: event.clientY,
                    opener: event.currentTarget
                  })
                }}
                onDragStart={(event) => {
                  cancelHover()
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
                {tab.pinned === true ? (
                  <Pin size={9} className="shrink-0 text-accent" />
                ) : null}
                <span className="min-w-0 truncate">{label}</span>
                {thread !== null && thread.unread > 0 ? (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-signal"
                    title={t('bots.unread', { count: thread.unread })}
                    data-testid={`${testId}-unread`}
                  />
                ) : null}
              </button>
              )}
              {tab.pinned === true ? null : (
                <button
                  type="button"
                  className="ml-0.5 inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => onClose(tab.key)}
                  aria-label={t('session.close')}
                  title={t('session.close')}
                  data-testid={`${testId}-close`}
                >
                  <X size={11} />
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
            disabled={creatingThread}
            aria-label={t('bots.room.newThread')}
            aria-haspopup="menu"
            aria-expanded={newAnchor !== null}
            title={t('bots.room.newThread')}
            data-testid="room-tabs-new"
          >
            {creatingThread ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Plus size={14} />
            )}
          </button>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            className={`${
              splitActive ? 'inline-flex' : 'hidden xl:inline-flex'
            } h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground ${
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
            data-testid="room-tabs-split"
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
              data-testid="room-tabs-zoom"
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
          ariaLabel={t('bots.room.threads')}
          testId="room-tab-menu"
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
              id: 'new-thread',
              label: `${t('bots.room.newThreadIn', { name: group.name })} — ${t('bots.room.newThreadStartsFresh')}`,
              icon: <Plus size={11} />,
              testId: 'room-tabs-new-item',
              onSelect: () => {
                setNewAnchor(null)
                onNewThread()
              }
            }
          ]}
          ariaLabel={t('bots.room.newThread')}
          testId="room-tabs-new-menu"
          width={260}
          onClose={() => setNewAnchor(null)}
        />
      ) : null}
      {hover !== null
        ? (() => {
            const tab = tabs.find((entry) => entry.key === hover.key)
            if (tab === undefined) return null
            const thread = threads.find((entry) => entry.id === tab.threadId)
            return createPortal(
              <div
                className="pointer-events-none fixed z-[110] w-72 rounded-lg border border-border bg-card p-3 shadow-2xl"
                style={{ left: hover.left, top: hover.top }}
                data-testid="room-tab-hover"
              >
                <div className="flex items-center gap-1.5 text-[12px] font-semibold text-foreground">
                  <Users size={12} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate">{labelFor(tab)}</span>
                  {thread !== undefined && thread.unread > 0 ? (
                    <span className="ml-auto rounded-full bg-signal-weak px-1 text-[9px] font-medium text-signal">
                      {thread.unread > 9 ? '9+' : thread.unread}
                    </span>
                  ) : null}
                </div>
                <div className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                  {group.name}
                </div>
                <div className="mt-2 space-y-1">
                  {members.slice(0, 6).map((member) => (
                    <div
                      key={member.id}
                      className="flex items-center gap-1.5 text-[11.5px]"
                    >
                      <AssistantAvatar
                        name={member.name}
                        status={member.status}
                        size="sm"
                        color={member.avatarColor}
                        image={member.avatarImage}
                        mascot={member.avatarMascot}
                        outfit={member.avatarOutfit}
                      />
                      <span className="min-w-0 flex-1 truncate text-foreground">
                        {member.name}
                      </span>
                      <span className="truncate text-muted-foreground">
                        {member.role}
                      </span>
                    </div>
                  ))}
                </div>
                {thread?.latestText !== null && thread?.latestText !== undefined ? (
                  <p className="mt-2 line-clamp-2 text-[11.5px] leading-relaxed text-muted-foreground">
                    {thread.latestText}
                  </p>
                ) : null}
              </div>,
              document.body
            )
          })()
        : null}
    </>
  )
}
