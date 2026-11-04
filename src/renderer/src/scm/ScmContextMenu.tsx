/**
 * One anchored menu for Source Control rows, groups, folders and repository
 * actions. It is a DOM portal so a table/list overflow cannot clip it, clamps
 * against the viewport, returns focus to the opener, and is fully keyboard
 * operable.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export type ScmMenuItem = {
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
  x: number
  y: number
  items: readonly ScmMenuItem[]
  ariaLabel?: string
  onClose: () => void
}

const MENU_WIDTH = 248
const MARGIN = 8

export default function ScmContextMenu({
  x,
  y,
  items,
  ariaLabel = 'Actions',
  onClose
}: Props): React.JSX.Element {
  const menu = useRef<HTMLDivElement | null>(null)
  const restoreFocus = useRef<HTMLElement | null>(null)
  const [position, setPosition] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const element = menu.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const left = Math.min(Math.max(MARGIN, x), Math.max(MARGIN, window.innerWidth - MENU_WIDTH - MARGIN))
    const top = Math.min(
      Math.max(MARGIN, y),
      Math.max(MARGIN, window.innerHeight - rect.height - MARGIN)
    )
    setPosition({ left, top })
    const first = element.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')
    first?.focus()
    return () => {
      restoreFocus.current?.focus()
    }
  }, [x, y])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || menu.current?.contains(event.target)) return
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
    const dismiss = (): void => onClose()
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={menu}
      className="fixed z-[120] w-[248px] overflow-hidden rounded-md border border-line-strong bg-overlay p-1 shadow-[var(--ade-shadow-overlay)]"
      style={{ left: position.left, top: position.top }}
      role="menu"
      aria-label={ariaLabel}
      data-testid="scm-context-menu"
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
            className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] ${
              item.danger
                ? 'text-destructive hover:bg-destructive/10 disabled:text-muted-foreground'
                : 'text-foreground hover:bg-muted disabled:text-muted-foreground'
            } disabled:cursor-not-allowed disabled:opacity-50`}
            onClick={() => {
              if (item.disabled) return
              onClose()
              item.onSelect()
            }}
          >
            <span className="flex w-3.5 shrink-0 items-center justify-center text-muted-foreground">
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
