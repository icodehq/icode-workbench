import { useState } from 'react'
import type { SessionSummary } from '../../../../shared/schemas/ipc'
import type { PendingAction } from '../../state/workspace'
import { Columns2, X } from 'lucide-react'
import ContextMenu, { type ContextMenuItem, type MenuAnchor } from '../ContextMenu'
import { sessionStateDotClass } from '../status'
import { useT } from '../../i18n/use-i18n'

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
  onSplitSession?: (sessionId: string) => void
  onUnsplit?: () => void
  splitActive?: boolean
  splitSessionId?: string | null
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
  onSplitSession,
  onUnsplit,
  splitActive = false,
  splitSessionId = null
}: Props): React.JSX.Element | null {
  const t = useT()
  const [menu, setMenu] = useState<TabMenuState | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)

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

  const menuItems: ContextMenuItem[] = menuSession === null
    ? []
    : [
        {
          id: 'close',
          label: t('session.close'),
          icon: <X size={12} />,
          disabled: sessions.length <= 1,
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
        ...(onSplitSession !== undefined && sessions.length > 1
          ? [
              {
                id: 'split',
                label:
                  splitSessionId === menuSession.id ? t('session.unsplit') : t('session.splitRight'),
                icon: <Columns2 size={12} />,
                separatorBefore: true,
                testId: 'session-tab-menu-split',
                onSelect: () => {
                  if (splitSessionId === menuSession.id) onUnsplit?.()
                  else onSplitSession(menuSession.id)
                }
              } satisfies ContextMenuItem
            ]
          : [])
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
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', session.id)
                  setDraggingId(session.id)
                }}
                onDragOver={(event) => {
                  if (draggingId === null || draggingId === session.id) return
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
                  if (draggingId !== null && draggingId !== session.id) {
                    onReorder?.(draggingId, session.id)
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
        {onSplit !== undefined && (sessions.length > 1 || splitActive) ? (
          <button
            type="button"
            className={`ml-auto inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground ${
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
