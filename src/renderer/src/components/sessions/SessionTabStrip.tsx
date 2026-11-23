import { useRef, useState, type ReactNode } from 'react'
import type { SessionSummary } from '../../../../shared/schemas/ipc'
import type { PendingAction } from '../../state/workspace'
import {
  ArrowDown,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowUp,
  Columns2,
  Maximize2,
  Minimize2,
  Rows2,
  X
} from 'lucide-react'
import ContextMenu, { type ContextMenuItem, type MenuAnchor } from '../ContextMenu'
import { sessionStateDotClass } from '../status'
import { useT } from '../../i18n/use-i18n'
import { isMacPlatform } from '../../lib/platform'
import { containsSession, type SplitNode, type SplitSide } from '../../state/session-split'

type Props = {
  sessions: SessionSummary[]
  activeSessionId: string | null
  pending: Record<string, PendingAction>
  onSelect: (sessionId: string) => void
  onClose: (sessionId: string) => void
  onCloseOthers?: (sessionId: string) => void
  onCloseRight?: (sessionId: string) => void
  onReorder?: (sourceId: string, targetId: string) => void
  onSplit?: () => void
  onSplitOn?: (side: SplitSide, sessionId: string) => void
  onSwapPanes?: (sessionId: string) => void
  onCloseSplit?: () => void
  onToggleZoom?: () => void
  zoomed?: boolean
  groupedSessionIds?: ReadonlySet<string>
  root?: SplitNode | null
}

type TabMenuState = {
  sessionId: string
  anchor: MenuAnchor
  opener: HTMLElement
}

/**
 * Direct-session tabs. A task attempt never appears here; it is opened inside
 * its TaskWorkbench. The strip is a view switcher, not an app tab strip.
 *
 * Tabs behave like browser tabs: right-click (or Shift+F10) opens a context
 * menu, and dragging a tab onto another moves it to that slot.
 */
export default function SessionTabStrip({
  sessions,
  activeSessionId,
  pending,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseRight,
  onReorder,
  onSplit,
  onSplitOn,
  onSwapPanes,
  onCloseSplit,
  onToggleZoom,
  zoomed = false,
  groupedSessionIds,
  root = null
}: Props): React.JSX.Element | null {
  const t = useT()
  const mac = isMacPlatform()
  const splitActive = root !== null && root.kind === 'split'
  const splitShortcut = (side: SplitSide): string | undefined => {
    if (mac) return side === 'right' ? '⌘D' : side === 'down' ? '⇧⌘D' : undefined
    return side === 'right'
      ? 'Ctrl+Shift+D'
      : side === 'left'
        ? 'Ctrl+Shift+←'
        : side === 'up'
          ? 'Ctrl+Shift+↑'
          : 'Ctrl+Shift+↓'
  }
  const [menu, setMenu] = useState<TabMenuState | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  /*
   * The drag source must be readable synchronously from dragover/drop. React
   * state set in dragstart is not guaranteed to be committed while the native
   * drag loop is running, so dragover would see null, skip preventDefault and
   * the drop would never land. The ref is the gate; the state is only paint.
   */
  const draggingIdRef = useRef<string | null>(null)

  if (sessions.length === 0) return null

  const moveFocus = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const tabs = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')
    )
    const index = tabs.indexOf(document.activeElement as HTMLElement)
    if (index < 0) return
    event.preventDefault()
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
    const target = tabs[next]
    target?.focus()
    const id = target?.getAttribute('data-session-id')
    if (id) onSelect(id)
  }

  const menuSession =
    menu === null ? null : (sessions.find((session) => session.id === menu.sessionId) ?? null)
  const menuIndex = menuSession === null ? -1 : sessions.indexOf(menuSession)

  const menuInTree =
    menuSession !== null &&
    root !== null &&
    root.kind === 'split' &&
    containsSession(root, menuSession.id)
  const menuGrouped =
    menuSession !== null && (groupedSessionIds?.has(menuSession.id) ?? false)
  const menuIsActive = menuSession !== null && menuSession.id === activeSessionId

  const splitItems: ContextMenuItem[] = []
  if (
    menuSession !== null &&
    onSplitOn !== undefined &&
    (sessions.length > 1 || splitActive)
  ) {
    const splittingSelf = menuIsActive
    const reason = splittingSelf ? t('session.splitNeedsOther') : undefined
    const actions: Array<{
      side: SplitSide
      splitLabel: string
      moveLabel: string
      icon: ReactNode
    }> = [
      {
        side: 'left',
        splitLabel: t('session.splitLeft'),
        moveLabel: t('session.moveLeft'),
        icon: menuGrouped ? <ArrowLeft size={12} /> : <Columns2 size={12} />
      },
      {
        side: 'right',
        splitLabel: t('session.splitRight'),
        moveLabel: t('session.moveRight'),
        icon: menuGrouped ? <ArrowRight size={12} /> : <Columns2 size={12} />
      },
      {
        side: 'up',
        splitLabel: t('session.splitUp'),
        moveLabel: t('session.moveUp'),
        icon: menuGrouped ? <ArrowUp size={12} /> : <Rows2 size={12} />
      },
      {
        side: 'down',
        splitLabel: t('session.splitDown'),
        moveLabel: t('session.moveDown'),
        icon: menuGrouped ? <ArrowDown size={12} /> : <Rows2 size={12} />
      }
    ]
    splitItems.push(
      ...actions.map((action, index) => ({
        id: `${menuGrouped ? 'move' : 'split'}-${action.side}`,
        label: menuGrouped ? action.moveLabel : action.splitLabel,
        icon: action.icon,
        disabled: splittingSelf,
        reason,
        shortcut: menuGrouped ? undefined : splitShortcut(action.side),
        separatorBefore: index === 0,
        testId: `session-tab-menu-${menuGrouped ? 'move' : 'split'}-${action.side}`,
        onSelect: () => onSplitOn(action.side, menuSession.id)
      }))
    )
    if (splitActive && menuInTree) {
      splitItems.push(
        {
          id: 'swap-panes',
          label: t('session.swapPanes'),
          icon: <ArrowLeftRight size={12} />,
          disabled: !menuInTree || menuIsActive || onSwapPanes === undefined,
          separatorBefore: true,
          testId: 'session-tab-menu-swap',
          onSelect: () => onSwapPanes?.(menuSession.id)
        },
        {
          id: 'unsplit',
          label: t('session.unsplit'),
          icon: <Columns2 size={12} />,
          disabled: onCloseSplit === undefined,
          testId: 'session-tab-menu-unsplit',
          onSelect: () => onCloseSplit?.()
        }
      )
    }
  }

  const menuItems: ContextMenuItem[] = menuSession === null
    ? []
    : [
        {
          id: 'close',
          label: t('session.close'),
          icon: <X size={12} />,
          disabled: sessions.length <= 1,
          shortcut: mac ? '⇧⌘W' : 'Ctrl+Shift+W',
          testId: 'session-tab-menu-close',
          onSelect: () => onClose(menuSession.id)
        },
        {
          id: 'close-others',
          label: t('session.closeOthers'),
          disabled: sessions.length <= 1 || onCloseOthers === undefined,
          testId: 'session-tab-menu-close-others',
          onSelect: () => onCloseOthers?.(menuSession.id)
        },
        {
          id: 'close-right',
          label: t('session.closeRight'),
          disabled: menuIndex >= sessions.length - 1 || onCloseRight === undefined,
          testId: 'session-tab-menu-close-right',
          onSelect: () => onCloseRight?.(menuSession.id)
        },
        ...splitItems
      ]

  const openMenu = (
    sessionId: string,
    opener: HTMLElement,
    position: { clientX: number; clientY: number }
  ): void => {
    const rect = opener.getBoundingClientRect()
    setMenu({
      sessionId,
      opener,
      anchor:
        position.clientX === 0 && position.clientY === 0
          ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
          : {
              left: position.clientX,
              right: position.clientX,
              top: position.clientY,
              bottom: position.clientY
            }
    })
  }

  const resetDrag = (): void => {
    draggingIdRef.current = null
    setDraggingId(null)
    setDropTargetId(null)
  }

  return (
    <>
      <nav
        className="icode-titlebar window-chrome-safe flex h-9 shrink-0 items-stretch gap-1 overflow-x-auto border-b border-border bg-card px-2"
        role="tablist"
        aria-label={t('session.tabs')}
        onKeyDown={moveFocus}
        data-testid="session-tabs"
      >
        {sessions.map((session) => {
          const active = session.id === activeSessionId
          const dragged = draggingId === session.id
          const dropTarget = dropTargetId === session.id
          return (
            <div
              key={session.id}
              className={`flex h-9 shrink-0 items-center rounded-sm ${
                dropTarget ? 'ring-1 ring-inset ring-accent/70' : ''
              }`}
              onContextMenu={(event) => {
                event.preventDefault()
                const opener =
                  event.target instanceof Element
                    ? (event.target.closest('button') ?? event.currentTarget)
                    : event.currentTarget
                openMenu(session.id, opener, event)
              }}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                draggable={onReorder !== undefined}
                className={`inline-flex h-9 max-w-[190px] items-center gap-1.5 border-b-2 px-2.5 text-[11px] ${
                  active
                    ? 'border-accent text-foreground'
                    : 'border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                } ${dragged ? 'opacity-50' : ''}`}
                onClick={() => onSelect(session.id)}
                onKeyDown={(event) => {
                  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                    event.preventDefault()
                    openMenu(session.id, event.currentTarget, { clientX: 0, clientY: 0 })
                  }
                }}
                onDragStart={(event) => {
                  draggingIdRef.current = session.id
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', session.id)
                  setDraggingId(session.id)
                }}
                onDragOver={(event) => {
                  const sourceId = draggingIdRef.current
                  if (sourceId === null || sourceId === session.id) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  setDropTargetId(session.id)
                }}
                onDragLeave={(event) => {
                  if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
                  setDropTargetId((current) => (current === session.id ? null : current))
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  const sourceId = draggingIdRef.current
                  if (sourceId !== null && sourceId !== session.id) {
                    onReorder?.(sourceId, session.id)
                  }
                  resetDrag()
                }}
                onDragEnd={resetDrag}
                title={session.title}
                data-session-id={session.id}
                data-testid={`session-tab-${session.id}`}
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${sessionStateDotClass(
                    session,
                    pending[session.id] ?? null
                  )}`}
                />
                <span className="min-w-0 truncate">{session.title}</span>
                {groupedSessionIds?.has(session.id) ? (
                  <Columns2
                    size={9}
                    className="shrink-0 text-muted-foreground/60"
                    aria-hidden="true"
                  />
                ) : null}
              </button>
              {sessions.length > 1 ? (
                <button
                  type="button"
                  className="ml-0.5 inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => onClose(session.id)}
                  aria-label={t('session.closeTab', { title: session.title })}
                  title={t('session.closeTab', { title: session.title })}
                  data-testid={`session-tab-close-${session.id}`}
                >
                  <X size={10} />
                </button>
              ) : null}
            </div>
          )
        })}
        {(onSplit !== undefined && (sessions.length > 1 || splitActive)) ||
        (splitActive && onToggleZoom !== undefined) ? (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {onSplit !== undefined && (sessions.length > 1 || splitActive) ? (
              <button
                type="button"
                className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground ${
                  splitActive ? 'bg-accent-weak text-accent' : ''
                }`}
                onClick={onSplit}
                aria-pressed={splitActive}
                aria-label={splitActive ? t('session.unsplit') : t('session.split')}
                title={splitActive ? t('session.unsplit') : t('session.split')}
                data-testid="session-split-toggle"
              >
                <Columns2 size={12} />
              </button>
            ) : null}
            {splitActive && onToggleZoom !== undefined ? (
              <button
                type="button"
                className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground ${
                  zoomed ? 'bg-accent-weak text-accent' : ''
                }`}
                onClick={onToggleZoom}
                aria-pressed={zoomed}
                aria-label={zoomed ? t('session.unzoom') : t('session.zoom')}
                title={`${zoomed ? t('session.unzoom') : t('session.zoom')} (${
                  mac ? '⇧⌘↩' : 'Ctrl+Shift+Enter'
                })`}
                data-testid="session-zoom-toggle"
              >
                {zoomed ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
              </button>
            ) : null}
          </div>
        ) : null}
      </nav>
      {menu !== null && menuSession !== null ? (
        <ContextMenu
          items={menuItems}
          ariaLabel={t('session.tabMenu')}
          testId="session-tab-menu"
          width={210}
          anchor={menu.anchor}
          returnFocus={menu.opener}
          opener={menu.opener}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </>
  )
}
