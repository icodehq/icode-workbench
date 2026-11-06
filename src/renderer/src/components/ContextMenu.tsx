/**
 * One anchored menu used by Projects, Source Control, and Files. It is a DOM
 * portal so a table/list overflow cannot clip it, clamps against the viewport,
 * returns focus to the opener, and is fully keyboard operable.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  menuPosition,
  type MenuAnchor,
  type MenuPosition
} from './context-menu-position'

export type { MenuAnchor } from './context-menu-position'

export type ContextMenuItem = {
  id: string
  label: string
  icon?: ReactNode
  shortcut?: string
  disabled?: boolean
  /** Shown as a title and accessible description when disabled. */
  reason?: string
  danger?: boolean
  separatorBefore?: boolean
  /** Stable selector for real-Electron smoke coverage. */
  testId?: string
  onSelect: () => void
}

type Props = {
  items: readonly ContextMenuItem[]
  ariaLabel?: string
  /** Kept configurable so Projects, Source Control, and Files have distinct selectors. */
  testId?: string
  /** Width in px. Defaults to the wider Source Control/Files menu. */
  width?: number
  /** Cursor position; used when `anchor` is absent. */
  x?: number
  y?: number
  /** Trigger rect; when present the menu aligns to it and may flip above. */
  anchor?: MenuAnchor
  align?: 'start' | 'end'
  /** Focus returns here on close. Defaults to the element focused at open. */
  returnFocus?: HTMLElement | null
  /** Element that opened the menu; pointer-downs inside it must not dismiss. */
  opener?: HTMLElement | null
  onClose: () => void
}

const DEFAULT_MENU_WIDTH = 248
const MAX_MENU_HEIGHT = 480
const MARGIN = 8
const GAP = 4

export default function ContextMenu({
  items,
  ariaLabel = 'Actions',
  testId = 'context-menu',
  width = DEFAULT_MENU_WIDTH,
  x,
  y,
  anchor,
  align = 'start',
  returnFocus,
  opener,
  onClose
}: Props): React.JSX.Element {
  const menu = useRef<HTMLDivElement | null>(null)
  const restoreFocusTo = useRef<HTMLElement | null>(returnFocus ?? null)
  const [position, setPosition] = useState<MenuPosition>(() => ({
    left:
      anchor === undefined ? (x ?? MARGIN) : align === 'end' ? anchor.right - width : anchor.left,
    top: anchor === undefined ? (y ?? MARGIN) : anchor.bottom + GAP,
    placement: 'below'
  }))

  useLayoutEffect(() => {
    const element = menu.current
    if (!element) return
    if (restoreFocusTo.current === null) {
      restoreFocusTo.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null
    }
    setPosition(
      menuPosition({
        x: x ?? MARGIN,
        y: y ?? MARGIN,
        width,
        height: element.offsetHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        anchor,
        align,
        margin: MARGIN,
        gap: GAP
      })
    )
    const first = element.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')
    first?.focus({ preventScroll: true })
  }, [x, y, width, align, anchor?.left, anchor?.right, anchor?.top, anchor?.bottom])

  useEffect(() => {
    if (returnFocus !== undefined && returnFocus !== null) restoreFocusTo.current = returnFocus
  }, [returnFocus])

  useLayoutEffect(() => {
    return () => restoreFocusTo.current?.focus()
  }, [])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return
      if (menu.current?.contains(event.target) === true) return
      if (opener?.contains(event.target) === true) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (!menu.current) return
      const entries = [...menu.current.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')]
      if (entries.length === 0) return
      const current = entries.indexOf(document.activeElement as HTMLElement)
      const focus = (index: number): void => {
        entries[(index + entries.length) % entries.length]?.focus()
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        focus(current + 1)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        focus(current - 1)
      } else if (event.key === 'Home') {
        event.preventDefault()
        focus(0)
      } else if (event.key === 'End') {
        event.preventDefault()
        focus(entries.length - 1)
      } else if (event.key === 'Tab') {
        // A context menu is a modal menu; Tab keeps focus inside it.
        event.preventDefault()
        focus(current + (event.shiftKey ? -1 : 1))
      }
    }
    const onScroll = (event: Event): void => {
      // Internal overflow scrolling is how a tall menu is read; it must not close.
      if (event.target instanceof Node && menu.current?.contains(event.target) === true) return
      onClose()
    }
    const dismiss = (): void => onClose()
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [onClose, opener])

  return createPortal(
    <div
      ref={menu}
      className="icode-floating-surface fixed z-[120] overflow-y-auto overflow-x-hidden overscroll-contain p-1 text-foreground"
      style={{
        left: position.left,
        top: position.top,
        width,
        maxWidth: 'calc(100vw - 16px)',
        maxHeight: `min(${MAX_MENU_HEIGHT}px, calc(100vh - 16px))`,
        transformOrigin: `${position.placement === 'above' ? 'bottom' : 'top'} ${
          anchor !== undefined && align === 'end' ? 'right' : 'left'
        }`
      }}
      role="menu"
      aria-label={ariaLabel}
      data-testid={testId}
    >
      {items.map((item) => (
        <div key={item.id}>
          {item.separatorBefore ? <div className="my-1 h-px bg-line" role="separator" /> : null}
          <button
            type="button"
            role="menuitem"
            aria-disabled={item.disabled === true}
            disabled={item.disabled}
            title={item.disabled ? item.reason : undefined}
            data-testid={item.testId}
            className={`flex min-h-6 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[11px] leading-4 ${
              item.danger
                ? 'text-destructive hover:bg-destructive/10 disabled:text-muted-foreground'
                : 'text-foreground hover:bg-menu-hover disabled:text-muted-foreground'
            } disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent`}
            onClick={() => {
              if (item.disabled) return
              onClose()
              item.onSelect()
            }}
          >
            <span
              className={`flex w-3.5 shrink-0 items-center justify-center ${
                item.danger && item.disabled !== true ? 'text-destructive' : 'text-muted-foreground'
              }`}
            >
              {item.icon}
            </span>
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.shortcut ? (
              <span className="shrink-0 font-mono text-[9px] text-muted-foreground">{item.shortcut}</span>
            ) : null}
          </button>
        </div>
      ))}
    </div>,
    document.body
  )
}
