import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { menuPosition, type MenuAnchor } from './context-menu-position'

type Props = {
  anchor: MenuAnchor | null
  ariaLabel: string
  testId?: string
  width?: number
  opener?: HTMLElement | null
  onClose: () => void
  children: ReactNode
}

const MARGIN = 8
const GAP = 4
const DEFAULT_WIDTH = 288

/**
 * A small non-modal popover for forms, anchored to a trigger.
 *
 * `ContextMenu` renders menu items only, so the SCM merge/push pickers use this
 * shell instead. Dismissal matches the shared menu: outside pointerdown,
 * Escape, resize and outside scroll.
 */
export default function AnchoredPopover({
  anchor,
  ariaLabel,
  testId,
  width = DEFAULT_WIDTH,
  opener,
  onClose,
  children
}: Props): React.JSX.Element {
  const panel = useRef<HTMLDivElement | null>(null)
  const returnFocusTo = useRef<HTMLElement | null>(null)
  const [position, setPosition] = useState(() => ({
    left: anchor === null ? MARGIN : Math.max(MARGIN, anchor.right - width),
    top: anchor === null ? MARGIN : anchor.bottom + GAP
  }))

  useLayoutEffect(() => {
    const element = panel.current
    if (element === null) return
    if (returnFocusTo.current === null) {
      returnFocusTo.current =
        opener ??
        (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    }
    setPosition(
      menuPosition({
        x: MARGIN,
        y: MARGIN,
        width,
        height: element.offsetHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        ...(anchor === null ? {} : { anchor }),
        align: 'end',
        margin: MARGIN,
        gap: GAP
      })
    )
    const first = element.querySelector<HTMLElement>(
      'select:not(:disabled), input:not(:disabled), textarea:not(:disabled), button:not([aria-disabled="true"]):not(:disabled)'
    )
    first?.focus({ preventScroll: true })
  }, [anchor?.left, anchor?.right, anchor?.top, anchor?.bottom, width])

  useEffect(() => {
    return () => returnFocusTo.current?.focus()
  }, [])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return
      if (panel.current?.contains(event.target) === true) return
      if (opener?.contains(event.target) === true) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    const onScroll = (event: Event): void => {
      if (event.target instanceof Node && panel.current?.contains(event.target) === true) return
      onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', onClose)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [onClose, opener])

  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label={ariaLabel}
      data-testid={testId}
      className="icode-floating-surface fixed z-[120] overflow-y-auto overflow-x-hidden overscroll-contain text-foreground"
      style={{
        left: position.left,
        top: position.top,
        width,
        maxWidth: 'calc(100vw - 16px)',
        maxHeight: 'min(520px, calc(100vh - 16px))'
      }}
    >
      {children}
    </div>,
    document.body
  )
}
