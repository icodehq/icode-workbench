import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Archive,
  Bell,
  BellMinus,
  BellOff,
  BellRing,
  Check,
  ChevronDown,
  ChevronRight,
  History,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  Trash2,
  Users,
  X
} from 'lucide-react'
import type { BotsWorkspaceState } from '../../state/use-bots'
import { groupLatestThread } from '../../../../shared/domain/group'
import type { TaskRecordPayload } from '../../../../shared/icode-api'
import type { Notice } from '../../state/workspace'
import AssistantAvatar from '../AssistantAvatar'
import ContextMenu, { type MenuAnchor } from '../ContextMenu'
import { taskAttention } from '../task-status'
import { NewBotDialog } from './NewBotDialog'
import { NewGroupDialog } from './NewGroupDialog'
import GroupSettingsDialog from './GroupSettingsDialog'
import BotSettingsDialog from './BotSettingsDialog'
import BotsHistoryDialog from './BotsHistoryDialog'
import { moveRowId, orderByStoredIds } from '../../lib/row-order'
import { usePanelResize } from '../../lib/use-panel-resize'
import {
  botsSearchSegments,
  matchBotsSearchFields,
  matchBotsSearchText
} from '../../lib/bots-search'
import { useT } from '../../i18n/use-i18n'
import {
  arrangeBotsRows,
  countActiveBotsFilters,
  loadBotsSidebarView,
  saveBotsSidebarView,
  type BotsRowFacts,
  type BotsSidebarView
} from '../../state/bots-sidebar-view'

const ROW_ORDER_KEY = 'icode.bots.row-order.v1'
const SECTION_HEIGHT_KEY = 'icode.bots.section-height.v1'
const SECTION_HEIGHT_MIN = 96
const DRAG_TYPE = 'application/x-icode-bot-row'

function readOrder(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key)
    const parsed: unknown = raw === null ? [] : JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : []
  } catch {
    return []
  }
}

function writeOrder(key: string, ids: readonly string[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(ids))
  } catch {
    // A blocked storage is only a lost preference.
  }
}

function clampSectionHeight(value: number): number {
  const viewport =
    typeof window === 'undefined' ? 720 : Math.max(SECTION_HEIGHT_MIN, window.innerHeight * 0.65)
  return Math.round(Math.min(Math.max(value, SECTION_HEIGHT_MIN), viewport))
}

function loadSectionHeight(): number | null {
  try {
    const raw = window.localStorage.getItem(SECTION_HEIGHT_KEY)
    if (raw === null) return null
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? clampSectionHeight(parsed) : null
  } catch {
    return null
  }
}

function saveSectionHeight(height: number | null): void {
  try {
    if (height === null) window.localStorage.removeItem(SECTION_HEIGHT_KEY)
    else window.localStorage.setItem(SECTION_HEIGHT_KEY, String(height))
  } catch {
    // A blocked storage is only a lost preference.
  }
}

type Group = BotsWorkspaceState['groups'][number]
type Bot = BotsWorkspaceState['bots'][number]

/** Groups and bots share one manual order. */
type Row =
  | { kind: 'group'; key: string; group: Group }
  | { kind: 'bot'; key: string; bot: Bot }

type DropTarget = { key: string; after: boolean }

type ViewRow = Row & BotsRowFacts

type HoverCardState = { row: ViewRow; left: number; top: number }

function HighlightedName({ text, query }: { text: string; query: string }): React.JSX.Element {
  return (
    <>
      {botsSearchSegments(text, query).map((part, index) =>
        part.marked ? (
          <mark key={index} className="rounded-sm bg-signal-weak text-signal">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        )
      )}
    </>
  )
}

type RowMenu = {
  kind: 'group' | 'bot'
  id: string
  x: number
  y: number
  returnFocus: HTMLElement | null
}

type RenamingRow = {
  kind: 'group' | 'bot'
  id: string
  key: string
  draft: string
}

/** The Bots roster in the main sidebar, above Projects. */
export default function BotsSidebarSection({
  state,
  tasks,
  notify,
  onOpenGroup,
  onOpenBot
}: {
  state: BotsWorkspaceState
  tasks: TaskRecordPayload[]
  notify: (notice: Notice) => void
  onOpenGroup: (groupId: string, threadId?: string) => void
  onOpenBot: (botId: string) => void
}): React.JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(true)
  const [menuOpen, setMenuOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [dialog, setDialog] = useState<'bot' | 'group' | null>(null)
  const [query, setQuery] = useState('')
  const [rowOrder, setRowOrder] = useState<string[]>(() => readOrder(ROW_ORDER_KEY))
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const [sectionHeight, setSectionHeight] = useState<number | null>(() => loadSectionHeight())
  const [rowMenu, setRowMenu] = useState<RowMenu | null>(null)
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [editingBotId, setEditingBotId] = useState<string | null>(null)
  const [view, setView] = useState<BotsSidebarView>(() => loadBotsSidebarView())
  const [viewMenu, setViewMenu] = useState<{
    anchor: MenuAnchor
    returnFocus: HTMLElement | null
  } | null>(null)
  const [hover, setHover] = useState<HoverCardState | null>(null)
  const [renaming, setRenaming] = useState<RenamingRow | null>(null)
  const hoverTimer = useRef<number | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  useEffect(
    () => () => {
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current)
    },
    []
  )
  const { handleProps } = usePanelResize({
    kind: 'split',
    panelRef: listRef,
    axis: 'y',
    clamp: clampSectionHeight,
    disabled: !open,
    onCommit: (value) => {
      const next = clampSectionHeight(value)
      setSectionHeight(next)
      saveSectionHeight(next)
    }
  })
  const selected = state.selected
  const needs = useMemo(() => {
    const groups = new Map<string, number>()
    const bots = new Map<string, number>()
    for (const task of tasks) {
      if (taskAttention(task) === null) continue
      if (task.groupId !== null && task.groupId !== undefined) {
        groups.set(task.groupId, (groups.get(task.groupId) ?? 0) + 1)
      }
      if (task.botId !== null && task.botId !== undefined) {
        bots.set(task.botId, (bots.get(task.botId) ?? 0) + 1)
      }
    }
    return { groups, bots }
  }, [tasks])
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const rows = useMemo<Row[]>(
    () => [
      ...state.groups.map((group) => ({
        kind: 'group' as const,
        key: `group:${group.id}`,
        group
      })),
      ...state.bots.map((bot) => ({
        kind: 'bot' as const,
        key: `bot:${bot.id}`,
        bot
      }))
    ],
    [state.bots, state.groups]
  )
  const orderedRows = useMemo(
    () => orderByStoredIds(rows, rowOrder, (row) => row.key),
    [rowOrder, rows]
  )
  const botsById = useMemo(
    () => new Map(state.bots.map((bot) => [bot.id, bot])),
    [state.bots]
  )
  const viewRows = useMemo<ViewRow[]>(
    () =>
      orderedRows.map((row) => ({
        ...row,
        name: row.kind === 'group' ? row.group.name : row.bot.name,
        paused: row.kind === 'bot' && row.bot.pausedAt !== null,
        needs:
          row.kind === 'group'
            ? (needs.groups.get(row.group.id) ?? 0)
            : (needs.bots.get(row.bot.id) ?? 0),
        unread:
          row.kind === 'group' ? state.groupHomeUnread(row.group) : row.bot.unread,
        working: row.kind === 'bot' && row.bot.status === 'working',
        sleeping:
          row.kind === 'bot' &&
          (row.bot.status === 'idle' || row.bot.status === 'offline') &&
          row.bot.activeTaskCount === 0 &&
          row.bot.reviewCount === 0 &&
          row.bot.unread === 0 &&
          (needs.bots.get(row.bot.id) ?? 0) === 0,
        activityAt:
          row.kind === 'group'
            ? Math.max(0, ...row.group.threads.map((thread) => thread.latestAt ?? 0))
            : (row.bot.lastActivityAt ?? 0)
      })),
    [needs, orderedRows, state.groupHomeUnread]
  )
  const arrangedRows = useMemo(() => arrangeBotsRows(viewRows, view), [view, viewRows])
  const filteredRows = useMemo(
    () =>
      normalizedQuery.length === 0
        ? arrangedRows
        : arrangedRows.filter((row) =>
            row.kind === 'group'
              ? matchBotsSearchFields([row.group.name], query)
              : matchBotsSearchFields([row.bot.name, row.bot.role], query)
          ),
    [arrangedRows, normalizedQuery, query]
  )
  const hiddenPausedMatches = useMemo(() => {
    if (!view.hidePaused || normalizedQuery.length === 0) return 0
    return state.bots.filter(
      (bot) =>
        bot.pausedAt !== null &&
        (matchBotsSearchText(bot.name, query) || matchBotsSearchText(bot.role, query))
    ).length
  }, [normalizedQuery, query, state.bots, view.hidePaused])
  const updateView = (patch: Partial<BotsSidebarView>): void => {
    setView((current) => {
      const next = { ...current, ...patch }
      saveBotsSidebarView(next)
      return next
    })
  }
  const reorder = (sourceKey: string, targetKey: string, after: boolean): void => {
    if (view.sortBy !== 'manual' || sourceKey === targetKey) return
    const next = moveRowId(
      orderedRows.map((row) => row.key),
      sourceKey,
      targetKey,
      after
    )
    setRowOrder(next)
    writeOrder(ROW_ORDER_KEY, next)
  }
  const cancelHover = (): void => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
    setHover(null)
  }
  const scheduleHover = (row: ViewRow, element: HTMLElement): void => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current)
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null
      const rect = element.getBoundingClientRect()
      setHover({
        row,
        left: Math.min(rect.right + 8, window.innerWidth - 300),
        top: Math.max(8, Math.min(rect.top, window.innerHeight - 190))
      })
    }, 320)
  }
  const beginDrag = (key: string) => (event: React.DragEvent<HTMLDivElement>) => {
    cancelHover()
    event.dataTransfer.setData(DRAG_TYPE, key)
    event.dataTransfer.effectAllowed = 'move'
  }
  const dragOverRow = (key: string) => (event: React.DragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes(DRAG_TYPE)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    setDropTarget({ key, after: event.clientY > rect.top + rect.height / 2 })
  }
  const dropOnRow = (key: string) => (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const sourceKey = event.dataTransfer.getData(DRAG_TYPE)
    if (sourceKey.length === 0) return
    const after = dropTarget !== null && dropTarget.key === key ? dropTarget.after : false
    setDropTarget(null)
    reorder(sourceKey, key, after)
  }
  const openRowMenuFromKey =
    (kind: 'group' | 'bot', id: string) => (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect()
      setRowMenu({
        kind,
        id,
        x: rect.left + 8,
        y: rect.bottom - 4,
        returnFocus: event.currentTarget
      })
    }
  const membersOf = (group: Group): Bot[] =>
    group.memberBotIds.flatMap((id) => {
      const member = botsById.get(id)
      return member === undefined ? [] : [member]
    })
  const menuGroup =
    rowMenu?.kind === 'group'
      ? (state.groups.find((group) => group.id === rowMenu.id) ?? null)
      : null
  const menuBot =
    rowMenu?.kind === 'bot' ? (botsById.get(rowMenu.id) ?? null) : null
  const editingGroup =
    editingGroupId === null
      ? null
      : (state.groups.find((group) => group.id === editingGroupId) ?? null)
  const editingBot = editingBotId === null ? null : (botsById.get(editingBotId) ?? null)
  const startRenaming = (kind: 'group' | 'bot', id: string, name: string): void => {
    cancelHover()
    setRowMenu(null)
    setRenaming({ kind, id, key: `${kind}:${id}`, draft: name })
  }
  const commitRenaming = async (): Promise<void> => {
    const current = renaming
    if (current === null) return
    const name = current.draft.trim()
    setRenaming(null)
    if (name.length === 0) return
    if (current.kind === 'group') {
      const group = state.groups.find((entry) => entry.id === current.id)
      if (group !== undefined && group.name !== name) {
        await state.updateGroup({ groupId: group.id, revision: group.revision, name })
      }
    } else {
      const bot = botsById.get(current.id)
      if (bot !== undefined && bot.name !== name) {
        await state.updateBot({ botId: bot.id, name })
      }
    }
  }
  const botActivity = (bot: Bot): string => {
    if (bot.pausedAt !== null) return t('bots.paused')
    if (bot.reviewCount > 0) return t('bots.activity.review', { count: bot.reviewCount })
    if (bot.activeTaskCount > 0) return t('bots.activity.tasks', { count: bot.activeTaskCount })
    if (bot.unread > 0) return t('bots.activity.unread', { count: bot.unread })
    return bot.role
  }

  return (
    <section className="mb-2 border-b border-border/70 pb-2" data-testid="sidebar-bots">
      <div className="relative flex h-8 items-center gap-1 px-1">
        <button
          type="button"
          className="inline-flex h-6 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => {
            cancelHover()
            setOpen((current) => !current)
          }}
          aria-expanded={open}
          aria-label={t('bots.label')}
        >
          {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        </button>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground hover:text-foreground"
          onClick={() => {
            cancelHover()
            setOpen((current) => !current)
          }}
        >
          {t('bots.label')}
          {state.unread > 0 ? (
            <span className="rounded-full bg-signal-weak px-1 text-[9px] font-medium text-signal">
              {state.unread > 9 ? '9+' : state.unread}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => setHistoryOpen(true)}
          aria-label={t('bots.history.title')}
          title={t('bots.history.title')}
          data-testid="sidebar-bots-history"
        >
          <History size={11} />
        </button>
        <button
          type="button"
          className="relative inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            setViewMenu({
              anchor: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
              returnFocus: event.currentTarget
            })
          }}
          aria-label={t('bots.options.title')}
          aria-haspopup="menu"
          aria-expanded={viewMenu !== null}
          data-testid="sidebar-bots-options"
        >
          <SlidersHorizontal size={11} />
          {countActiveBotsFilters(view) > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-signal px-0.5 text-[8px] font-semibold leading-none text-signal-ink">
              {countActiveBotsFilters(view)}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => setMenuOpen((current) => !current)}
          aria-label={t('bots.newGroup')}
          data-testid="sidebar-bots-new"
        >
          <Plus size={12} />
        </button>
        {menuOpen ? (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-1 top-full z-30 mt-0.5 w-40 rounded-md border border-border bg-card py-1 shadow-xl">
              <button
                type="button"
                className="block w-full px-2.5 py-1.5 text-left text-[11px] hover:bg-muted"
                onClick={() => {
                  setMenuOpen(false)
                  setDialog('bot')
                }}
                data-testid="sidebar-bots-new-bot"
              >
                {t('bots.newBot')}
              </button>
              <button
                type="button"
                className="block w-full px-2.5 py-1.5 text-left text-[11px] hover:bg-muted"
                onClick={() => {
                  setMenuOpen(false)
                  setDialog('group')
                }}
                data-testid="sidebar-bots-new-group"
              >
                {t('bots.newGroup')}
              </button>
            </div>
          </>
        ) : null}
      </div>

      {!open && arrangedRows.length > 0 ? (
        <div
          className="flex items-center gap-1 overflow-hidden px-1 pb-1"
          data-testid="sidebar-bots-collapsed-preview"
        >
          {arrangedRows.slice(0, 7).map((row) => {
            const member = row.kind === 'group' ? membersOf(row.group)[0] : row.bot
            const label =
              row.kind === 'group'
                ? `${row.group.name} · ${String(row.group.memberBotIds.length)} members`
                : `${row.bot.name} · ${botActivity(row.bot)}`
            return (
              <button
                key={row.key}
                type="button"
                className={`relative rounded-full ${row.unread > 0 ? 'ring-2 ring-signal' : ''}`}
                title={label}
                aria-label={label}
                onClick={() => {
                  setOpen(true)
                  if (row.kind === 'group') onOpenGroup(row.group.id)
                  else onOpenBot(row.bot.id)
                }}
                data-testid={`sidebar-bots-preview-${row.key.replace(':', '-')}`}
              >
                {member === undefined ? (
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-accent/12 text-accent">
                    <Users size={10} />
                  </span>
                ) : (
                  <AssistantAvatar
                    name={member.name}
                    status={member.status}
                    size="sm"
                    color={member.avatarColor}
                    image={member.avatarImage}
                    mascot={member.avatarMascot}
                    outfit={member.avatarOutfit}
                  />
                )}
                {row.needs > 0 ? (
                  <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-signal" />
                ) : null}
              </button>
            )
          })}
          {arrangedRows.length > 7 ? (
            <span className="text-[9px] text-muted-foreground">+{arrangedRows.length - 7}</span>
          ) : null}
        </div>
      ) : null}

      {open ? (
        <div
          ref={listRef}
          className={`${
            sectionHeight === null ? 'max-h-[42vh]' : 'max-h-[calc(100vh-240px)]'
          } space-y-0.5 overflow-y-auto`}
          style={sectionHeight === null ? undefined : { height: `${String(sectionHeight)}px` }}
          onScroll={cancelHover}
          data-testid="sidebar-bots-list"
        >
          <div className="sticky top-0 z-10 flex h-6 items-center gap-1 rounded border border-border bg-background px-1.5">
            <Search size={10} className="shrink-0 text-muted-foreground" />
            <input
              className="min-w-0 flex-1 bg-transparent text-[10.5px] text-foreground outline-none placeholder:text-muted-foreground"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('bots.search')}
              data-testid="sidebar-bots-search"
            />
            {query.length > 0 ? (
              <button
                type="button"
                className="shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => setQuery('')}
                aria-label={t('common.close')}
              >
                <X size={9} />
              </button>
            ) : null}
          </div>
          {hiddenPausedMatches > 0 ? (
            <p className="px-2 py-1 text-[9.5px] text-muted-foreground">
              {t('bots.hiddenPausedMatches', { count: hiddenPausedMatches })}
            </p>
          ) : null}

          {filteredRows.map((row) => {
            if (renaming !== null && renaming.key === row.key) {
              return (
                <div key={row.key} className="relative rounded-md">
                  <div className="flex min-h-9 w-full items-center gap-2 rounded-md bg-sel px-1.5 py-1">
                    {row.kind === 'group' ? (
                      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/12 text-accent">
                        <Users size={11} />
                      </span>
                    ) : (
                      <AssistantAvatar
                        name={row.bot.name}
                        status={row.bot.status}
                        size="sm"
                        color={row.bot.avatarColor}
                        image={row.bot.avatarImage}
                      mascot={row.bot.avatarMascot}
                      outfit={row.bot.avatarOutfit}
                      />
                    )}
                    <input
                      className="h-6 min-w-0 flex-1 rounded border border-line-strong bg-background px-1.5 text-[12px] text-foreground outline-none"
                      value={renaming.draft}
                      autoFocus
                      maxLength={60}
                      onFocus={(event) => event.currentTarget.select()}
                      onChange={(event) =>
                        setRenaming((current) =>
                          current === null ? current : { ...current, draft: event.target.value }
                        )
                      }
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          void commitRenaming()
                        } else if (event.key === 'Escape') {
                          event.preventDefault()
                          setRenaming(null)
                        }
                      }}
                      onBlur={() => setRenaming(null)}
                      data-testid={`bots-rename-${row.key.replace(':', '-')}`}
                    />
                  </div>
                </div>
              )
            }
            const over = dropTarget?.key === row.key ? dropTarget : null
            const members = row.kind === 'group' ? membersOf(row.group) : null
            return (
              <div
                key={row.key}
                className="relative rounded-md"
                draggable={normalizedQuery.length === 0 && view.sortBy === 'manual'}
                onMouseEnter={(event) => scheduleHover(row, event.currentTarget)}
                onMouseLeave={cancelHover}
                onDragStart={beginDrag(row.key)}
                onDragOver={dragOverRow(row.key)}
                onDragLeave={() =>
                  setDropTarget((current) => (current?.key === row.key ? null : current))
                }
                onDrop={dropOnRow(row.key)}
                onDragEnd={() => setDropTarget(null)}
              >
                {over !== null ? (
                  <span
                    className={`pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded bg-accent ${
                      over.after ? '-bottom-0.5' : '-top-0.5'
                    }`}
                  />
                ) : null}
                {row.kind === 'group' ? (
                  <button
                    type="button"
                    className={`flex min-h-9 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left ${
                      selected?.kind === 'group' && selected.groupId === row.group.id
                        ? 'bg-sel text-foreground shadow-[inset_2px_0_0_var(--icode-accent)]'
                        : 'text-muted-foreground hover:bg-hover hover:text-foreground'
                    }${over !== null ? ' bg-accent/10' : ''}`}
                    onClick={() => {
                      cancelHover()
                      onOpenGroup(row.group.id)
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      cancelHover()
                      setRowMenu({
                        kind: 'group',
                        id: row.group.id,
                        x: event.clientX,
                        y: event.clientY,
                        returnFocus: event.currentTarget
                      })
                    }}
                    onKeyDown={openRowMenuFromKey('group', row.group.id)}
                    aria-haspopup="menu"
                    data-testid={`sidebar-bots-group-${row.group.id}`}
                  >
                    {members !== null && members.length > 0 ? (
                      <span className="flex shrink-0 -space-x-2">
                        {members.slice(0, 2).map((member) => (
                          <span key={member.id} className="rounded-full ring-2 ring-card">
                            <AssistantAvatar
                              name={member.name}
                              status={member.status}
                              size="sm"
                              color={member.avatarColor}
                              image={member.avatarImage}
                    mascot={member.avatarMascot}
                    outfit={member.avatarOutfit}
                            />
                          </span>
                        ))}
                        {members.length > 2 ? (
                          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[8px] font-medium text-muted-foreground ring-2 ring-card">
                            +{members.length - 2}
                          </span>
                        ) : null}
                      </span>
                    ) : (
                      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/12 text-accent">
                        <Users size={11} />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block truncate text-[12px] ${
                          row.unread > 0 ? 'font-medium text-foreground' : ''
                        }`}
                      >
                        <HighlightedName text={row.group.name} query={query} />
                      </span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {groupLatestThread(row.group)?.latestText ??
                          t('bots.room.members', { count: row.group.memberBotIds.length })}
                      </span>
                    </span>
                    {row.group.mutedAt !== null ? (
                      <BellOff size={9} className="shrink-0 text-muted-foreground" />
                    ) : null}
                    {needs.groups.get(row.group.id) ? (
                      <span className="rounded bg-signal-weak px-1 text-[9px] font-medium text-signal">
                        {needs.groups.get(row.group.id)}
                      </span>
                    ) : null}
                    {row.unread > 0 ? (
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-signal"
                        title={t('bots.unread', { count: row.unread })}
                        data-testid={`sidebar-bots-group-unread-${row.group.id}`}
                      />
                    ) : null}
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`flex min-h-9 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left ${
                      selected?.kind === 'bot' && selected.botId === row.bot.id
                        ? 'bg-sel text-foreground shadow-[inset_2px_0_0_var(--icode-accent)]'
                        : 'text-muted-foreground hover:bg-hover hover:text-foreground'
                    }${over !== null ? ' bg-accent/10' : ''}`}
                    onClick={() => {
                      cancelHover()
                      onOpenBot(row.bot.id)
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      cancelHover()
                      setRowMenu({
                        kind: 'bot',
                        id: row.bot.id,
                        x: event.clientX,
                        y: event.clientY,
                        returnFocus: event.currentTarget
                      })
                    }}
                    onKeyDown={openRowMenuFromKey('bot', row.bot.id)}
                    aria-haspopup="menu"
                    data-testid={`sidebar-bots-bot-${row.bot.id}`}
                  >
                    <AssistantAvatar
                      name={row.bot.name}
                      status={row.bot.status}
                      size="sm"
                      color={row.bot.avatarColor}
                      image={row.bot.avatarImage}
                      mascot={row.bot.avatarMascot}
                      outfit={row.bot.avatarOutfit}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block truncate text-[12px] ${
                          row.bot.unread > 0 ? 'font-medium text-foreground' : ''
                        }`}
                      >
                        <HighlightedName text={row.bot.name} query={query} />
                      </span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {botActivity(row.bot)}
                      </span>
                    </span>
                    {row.bot.status === 'working' ? (
                      <span className="text-[8.5px] text-info">●</span>
                    ) : null}
                    {needs.bots.get(row.bot.id) ? (
                      <span className="rounded bg-signal-weak px-1 text-[9px] font-medium text-signal">
                        {needs.bots.get(row.bot.id)}
                      </span>
                    ) : null}
                    {row.bot.unread > 0 ? (
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-signal"
                        title={t('bots.unread', { count: row.bot.unread })}
                      />
                    ) : null}
                  </button>
                )}
              </div>
            )
          })}

          {rows.length === 0 && !state.loading ? (
            <div className="mx-0.5 my-1 rounded-md border border-dashed border-border px-2 py-2">
              <p className="text-[10.5px] leading-relaxed text-muted-foreground">
                {t('bots.empty.body')}
              </p>
              <button
                type="button"
                className="mt-1.5 inline-flex h-6 items-center gap-1 rounded border border-border px-1.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => setDialog('bot')}
                data-testid="sidebar-bots-empty-new"
              >
                <Plus size={9} /> {t('bots.newBot')}
              </button>
            </div>
          ) : null}
          {(normalizedQuery.length > 0 && filteredRows.length === 0) ||
          (arrangedRows.length === 0 && rows.length > 0 && !state.loading) ? (
            <p className="px-2 py-2 text-[10.5px] text-muted-foreground">{t('bots.noMatches')}</p>
          ) : null}
        </div>
      ) : null}
      {open ? (
        <div
          {...handleProps}
          role="separator"
          tabIndex={0}
          aria-orientation="horizontal"
          aria-label={t('bots.resize')}
          aria-valuenow={sectionHeight ?? SECTION_HEIGHT_MIN}
          className="group -mx-1 mt-0.5 flex h-2 cursor-row-resize touch-none items-center px-1 outline-none focus-visible:bg-ring/10"
          data-testid="sidebar-bots-resize"
          onDoubleClick={() => {
            setSectionHeight(null)
            saveSectionHeight(null)
          }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
            event.preventDefault()
            const current = listRef.current?.offsetHeight ?? sectionHeight ?? SECTION_HEIGHT_MIN
            const next = clampSectionHeight(current + (event.key === 'ArrowDown' ? 16 : -16))
            if (listRef.current !== null) listRef.current.style.height = `${String(next)}px`
            setSectionHeight(next)
            saveSectionHeight(next)
          }}
        >
          <span className="h-px w-full bg-transparent group-hover:bg-line" />
        </div>
      ) : null}

      {dialog === 'bot' ? (
        <NewBotDialog
          state={state}
          onCreated={(bot) => onOpenBot(bot.id)}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'group' ? (
        <NewGroupDialog
          state={state}
          onCreated={(group) => onOpenGroup(group.id)}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {rowMenu !== null ? (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          returnFocus={rowMenu.returnFocus}
          ariaLabel={t('bots.rowMenu')}
          testId="bots-row-menu"
          onClose={() => setRowMenu(null)}
          items={
            menuGroup !== null
              ? [
                  {
                    id: 'group-rename',
                    label: t('bots.row.rename'),
                    icon: <Pencil size={11} />,
                    onSelect: () => startRenaming('group', menuGroup.id, menuGroup.name)
                  },
                  {
                    id: 'group-settings',
                    label: t('bots.groupSettings.title'),
                    icon: <Settings size={11} />,
                    onSelect: () => setEditingGroupId(menuGroup.id)
                  },
                  {
                    id: 'group-read',
                    label:
                      state.groupHomeUnread(menuGroup) > 0
                        ? t('bots.row.markRead')
                        : t('bots.row.markUnread'),
                    icon:
                      state.groupHomeUnread(menuGroup) > 0 ? (
                        <BellOff size={11} />
                      ) : (
                        <Bell size={11} />
                      ),
                    onSelect: () => {
                      state.setGroupHomeRead(
                        menuGroup.id,
                        state.groupHomeUnread(menuGroup) === 0
                      )
                    }
                  },
                  {
                    id: 'group-muted',
                    label:
                      menuGroup.mutedAt === null
                        ? t('bots.row.mute')
                        : t('bots.row.unmute'),
                    icon:
                      menuGroup.mutedAt === null ? (
                        <BellMinus size={11} />
                      ) : (
                        <BellRing size={11} />
                      ),
                    onSelect: () => {
                      void state.setGroupMuted(
                        menuGroup.id,
                        menuGroup.mutedAt === null
                      )
                    }
                  },
                  {
                    id: 'group-delete',
                    label: t('bots.deleteGroup'),
                    icon: <Trash2 size={11} />,
                    danger: true,
                    separatorBefore: true,
                    onSelect: () => {
                      if (
                        !window.confirm(t('bots.deleteGroupConfirm', { name: menuGroup.name }))
                      ) {
                        return
                      }
                      void state.deleteGroup(menuGroup.id)
                    }
                  }
                ]
              : menuBot !== null
                ? [
                    {
                      id: 'bot-rename',
                      label: t('bots.row.rename'),
                      icon: <Pencil size={11} />,
                      onSelect: () => startRenaming('bot', menuBot.id, menuBot.name)
                    },
                    {
                      id: 'bot-settings',
                      label: t('bot.settings.title'),
                      icon: <Settings size={11} />,
                      onSelect: () => setEditingBotId(menuBot.id)
                    },
                    {
                      id: 'bot-pause',
                      label: menuBot.pausedAt === null ? t('bots.pause') : t('bots.resume'),
                      icon: menuBot.pausedAt === null ? <Pause size={11} /> : <Play size={11} />,
                      onSelect: () => {
                        void state.setPaused(menuBot.id, menuBot.pausedAt === null)
                      }
                    },
                    {
                      id: 'bot-read',
                      label:
                        menuBot.unread > 0
                          ? t('bots.row.markRead')
                          : t('bots.row.markUnread'),
                      icon: menuBot.unread > 0 ? <BellOff size={11} /> : <Bell size={11} />,
                      onSelect: () => {
                        void state.setBotRead(menuBot.id, menuBot.unread === 0)
                      }
                    },
                    {
                      id: 'bot-notifications',
                      label: menuBot.notificationsEnabled
                        ? t('bots.row.mute')
                        : t('bots.row.unmute'),
                      icon: menuBot.notificationsEnabled ? (
                        <BellMinus size={11} />
                      ) : (
                        <BellRing size={11} />
                      ),
                      onSelect: () => {
                        void state.setBotNotifications(
                          menuBot.id,
                          !menuBot.notificationsEnabled
                        )
                      }
                    },
                    {
                      id: 'bot-archive',
                      label: t('bots.archive'),
                      icon: <Archive size={11} />,
                      danger: true,
                      separatorBefore: true,
                      onSelect: () => {
                        if (!window.confirm(t('bots.archiveConfirm', { name: menuBot.name }))) {
                          return
                        }
                        void state.archiveBot(menuBot.id)
                      }
                    }
                  ]
                : []
          }
        />
      ) : null}
      {viewMenu !== null ? (
        <ContextMenu
          anchor={viewMenu.anchor}
          returnFocus={viewMenu.returnFocus}
          ariaLabel={t('bots.options.title')}
          testId="bots-options-menu"
          onClose={() => setViewMenu(null)}
          items={[
            {
              id: 'sort-manual',
              label: t('bots.options.sortManual'),
              icon: view.sortBy === 'manual' ? <Check size={11} /> : undefined,
              onSelect: () => updateView({ sortBy: 'manual' })
            },
            {
              id: 'sort-smart',
              label: t('bots.options.sortSmart'),
              icon: view.sortBy === 'smart' ? <Check size={11} /> : undefined,
              onSelect: () => updateView({ sortBy: 'smart' })
            },
            {
              id: 'sort-recent',
              label: t('bots.options.sortRecent'),
              icon: view.sortBy === 'recent' ? <Check size={11} /> : undefined,
              onSelect: () => updateView({ sortBy: 'recent' })
            },
            {
              id: 'sort-name',
              label: t('bots.options.sortName'),
              icon: view.sortBy === 'name' ? <Check size={11} /> : undefined,
              onSelect: () => updateView({ sortBy: 'name' })
            },
            {
              id: 'hide-paused',
              label: t('bots.options.hidePaused'),
              icon: view.hidePaused ? <Check size={11} /> : undefined,
              separatorBefore: true,
              onSelect: () => updateView({ hidePaused: !view.hidePaused })
            },
            {
              id: 'hide-sleeping',
              label: t('bots.options.hideSleeping'),
              icon: view.hideSleeping ? <Check size={11} /> : undefined,
              onSelect: () => updateView({ hideSleeping: !view.hideSleeping })
            }
          ]}
        />
      ) : null}
      {hover !== null
        ? createPortal(
            <div
              className="pointer-events-none fixed z-[110] w-72 rounded-lg border border-border bg-card p-3 shadow-2xl"
              style={{ left: hover.left, top: hover.top }}
              data-testid="bots-hover-card"
            >
              {hover.row.kind === 'group' ? (
                <>
                  <div className="flex items-center gap-1.5 text-[12px] font-semibold text-foreground">
                    <Users size={12} className="shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate">{hover.row.group.name}</span>
                  </div>
                  <div className="mt-2 space-y-1">
                    {membersOf(hover.row.group)
                      .slice(0, 6)
                      .map((member) => (
                        <div key={member.id} className="flex items-center gap-1.5 text-[10.5px]">
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
                          <span className="truncate text-muted-foreground">{member.role}</span>
                        </div>
                      ))}
                  </div>
                  <p className="mt-2 line-clamp-3 text-[10px] leading-relaxed text-muted-foreground">
                    {groupLatestThread(hover.row.group)?.latestText ??
                      t('bots.room.members', { count: hover.row.group.memberBotIds.length })}
                  </p>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-1.5">
                    <AssistantAvatar
                      name={hover.row.bot.name}
                      status={hover.row.bot.status}
                      size="sm"
                      color={hover.row.bot.avatarColor}
                      image={hover.row.bot.avatarImage}
                      mascot={hover.row.bot.avatarMascot}
                      outfit={hover.row.bot.avatarOutfit}
                    />
                    <div className="min-w-0">
                      <div className="truncate text-[12px] font-semibold text-foreground">
                        {hover.row.bot.name}
                      </div>
                      <div className="truncate text-[10px] text-muted-foreground">
                        {hover.row.bot.role}
                      </div>
                    </div>
                  </div>
                  {botActivity(hover.row.bot) !== hover.row.bot.role ? (
                    <p className="mt-2 text-[10.5px] text-muted-foreground">
                      {botActivity(hover.row.bot)}
                    </p>
                  ) : null}
                  {hover.row.bot.groupIds.length > 0 ? (
                    <p className="mt-1 line-clamp-2 text-[10px] text-muted-foreground">
                      {state.groups
                        .filter(
                          (group) =>
                            hover.row.kind === 'bot' &&
                            hover.row.bot.groupIds.includes(group.id)
                        )
                        .map((group) => group.name)
                        .join(', ')}
                    </p>
                  ) : null}
                </>
              )}
            </div>,
            document.body
          )
        : null}
      {editingGroup !== null ? (
        <GroupSettingsDialog
          group={editingGroup}
          bots={state.bots}
          onUpdateGroup={state.updateGroup}
          onArchive={() => state.archiveGroup(editingGroup.id)}
          onDelete={() => state.deleteGroup(editingGroup.id)}
          onClose={() => setEditingGroupId(null)}
        />
      ) : null}
      {editingBot !== null ? (
        <BotSettingsDialog
          bot={editingBot}
          state={state}
          groups={state.groups.filter((group) => group.memberBotIds.includes(editingBot.id))}
          notify={notify}
          onClose={() => setEditingBotId(null)}
        />
      ) : null}
      {historyOpen ? (
        <BotsHistoryDialog
          groups={state.groups}
          onOpenGroup={(groupId, threadId) => {
            setHistoryOpen(false)
            onOpenGroup(groupId, threadId)
          }}
          onClose={() => setHistoryOpen(false)}
        />
      ) : null}
    </section>
  )
}
