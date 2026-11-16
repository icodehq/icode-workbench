import { useLayoutEffect, useRef, type CSSProperties, type RefObject } from 'react'
import { beginResizeActivity, type ResizeActivityKind } from './resize-activity'
import { valueFromPointer } from './resize-math'

/**
 * The shared drag engine for every resizable seam.
 *
 * Live geometry never enters React state: pointer moves are coalesced into one
 * animation frame and written straight to the DOM. React (and persistence) is
 * committed once, on release. That keeps a drag from re-rendering the panel's
 * whole subtree per frame and lets the terminal pipeline defer its own work.
 */

export type PanelResizeOptions = {
  kind: ResizeActivityKind
  /** The element whose size changes. */
  panelRef: RefObject<HTMLElement | null>
  /** Read once on pointerdown; defaults to the panel's measured size. */
  getStartValue?: () => number
  /** Value units per pointer pixel; defaults to 1. Split drags pass 1 / span. */
  getScale?: () => number
  clamp: (candidate: number) => number
  direction?: 1 | -1
  axis?: 'x' | 'y'
  /** Defaults to writing `style.width` (or `height` for the y axis). */
  apply?: (value: number) => void
  /** Called on every applied frame; update aria/data attributes here. */
  onLive?: (value: number) => void
  /** Called exactly once on release/cancel with the final clamped value. */
  onCommit: (value: number) => void
  disabled?: boolean
  cursor?: string
  /** Full-window scrim; defaults to true. */
  overlay?: boolean
}

export type PanelResizeHandleProps = {
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void
  onLostPointerCapture: (event: React.PointerEvent<HTMLElement>) => void
  style: CSSProperties
}

type DragListeners = {
  move: (event: PointerEvent) => void
  up: (event: PointerEvent) => void
  cancel: (event: PointerEvent) => void
  blur: () => void
  visibility: () => void
}

type DragState = {
  pointerId: number
  startPointer: number
  pointer: number
  startValue: number
  scale: number
  handle: HTMLElement
  overlay: HTMLDivElement | null
  previousBodyCursor: string
  endActivity: () => void
  listeners: DragListeners
  frame: number | null
  timer: ReturnType<typeof setTimeout> | null
  completed: boolean
}

const HANDLE_STYLE: CSSProperties = { touchAction: 'none' }
const BODY_CLASS = 'icode-resizing'
const EPSILON = 0.01

function measurePanel(panel: HTMLElement | null, axis: 'x' | 'y'): number {
  if (panel === null) return Number.NaN
  const rect = panel.getBoundingClientRect()
  return axis === 'x' ? rect.width : rect.height
}

function createOverlay(cursor: string): HTMLDivElement {
  const overlay = document.createElement('div')
  overlay.className = 'icode-resize-overlay'
  overlay.setAttribute('aria-hidden', 'true')
  overlay.style.cursor = cursor
  document.body.appendChild(overlay)
  return overlay
}

export function usePanelResize(options: PanelResizeOptions): {
  handleProps: PanelResizeHandleProps
  lastValueRef: RefObject<number | null>
} {
  const optionsRef = useRef(options)
  optionsRef.current = options
  const lastValueRef = useRef<number | null>(null)
  const dragRef = useRef<DragState | null>(null)

  const applyValue = (value: number): void => {
    const current = optionsRef.current
    if (current.apply !== undefined) {
      current.apply(value)
    } else {
      const panel = current.panelRef.current
      if (panel !== null) {
        if ((current.axis ?? 'x') === 'x') panel.style.width = `${value}px`
        else panel.style.height = `${value}px`
      }
    }
    current.onLive?.(value)
  }

  const computeValue = (drag: DragState): number => {
    const current = optionsRef.current
    return current.clamp(
      valueFromPointer({
        startValue: drag.startValue,
        startPointer: drag.startPointer,
        pointer: drag.pointer,
        direction: current.direction ?? 1,
        scale: drag.scale
      })
    )
  }

  const flush = (drag: DragState): void => {
    if (drag.completed) return
    const next = computeValue(drag)
    if (
      lastValueRef.current !== null &&
      Math.abs(lastValueRef.current - next) < EPSILON
    ) {
      return
    }
    lastValueRef.current = next
    applyValue(next)
  }

  const requestFrame = (drag: DragState): void => {
    if (drag.completed || drag.frame !== null || drag.timer !== null) return
    const run = (): void => {
      drag.frame = null
      drag.timer = null
      flush(drag)
    }
    // rAF is paused in a hidden window; a timeout keeps the drag responsive.
    if (typeof document !== 'undefined' && document.hidden) {
      drag.timer = setTimeout(run, 0)
    } else {
      drag.frame = window.requestAnimationFrame(run)
    }
  }

  const settle = (drag: DragState, commit: boolean): void => {
    if (drag.completed) return
    drag.completed = true
    if (dragRef.current === drag) dragRef.current = null

    if (drag.frame !== null) window.cancelAnimationFrame(drag.frame)
    if (drag.timer !== null) clearTimeout(drag.timer)
    drag.frame = null
    drag.timer = null

    let finalValue: number | null = null
    if (commit) {
      // Flush the last pointer position synchronously, even if the frame that
      // would have handled it never ran.
      finalValue = computeValue(drag)
      if (
        lastValueRef.current === null ||
        Math.abs(lastValueRef.current - finalValue) >= EPSILON
      ) {
        lastValueRef.current = finalValue
        applyValue(finalValue)
      }
    }

    try {
      if (drag.handle.hasPointerCapture(drag.pointerId)) {
        drag.handle.releasePointerCapture(drag.pointerId)
      }
    } catch {
      // The capture may already have been released by the browser.
    }
    window.removeEventListener('pointermove', drag.listeners.move)
    window.removeEventListener('pointerup', drag.listeners.up)
    window.removeEventListener('pointercancel', drag.listeners.cancel)
    window.removeEventListener('blur', drag.listeners.blur)
    document.removeEventListener('visibilitychange', drag.listeners.visibility)
    delete drag.handle.dataset.resizing
    document.body.classList.remove(BODY_CLASS)
    document.body.style.cursor = drag.previousBodyCursor
    if (drag.overlay !== null) {
      // Leave the scrim through the trailing click so releasing over a
      // terminal does not focus or activate it.
      const overlay = drag.overlay
      setTimeout(() => overlay.remove(), 0)
    }

    // The activity hold must end even if a surface's commit handler throws;
    // a leaked hold would keep every terminal's PTY resize frozen.
    try {
      if (commit && finalValue !== null) optionsRef.current.onCommit(finalValue)
    } finally {
      drag.endActivity()
    }
  }

  const onPointerDown = (event: React.PointerEvent<HTMLElement>): void => {
    const current = optionsRef.current
    if (current.disabled === true || dragRef.current !== null) return
    if (event.button !== 0 || !event.isPrimary) return
    event.preventDefault()

    const axis = current.axis ?? 'x'
    const startValue =
      current.getStartValue !== undefined
        ? current.getStartValue()
        : measurePanel(current.panelRef.current, axis)
    const scale = current.getScale !== undefined ? current.getScale() : 1
    if (!Number.isFinite(startValue) || !Number.isFinite(scale) || scale === 0) {
      return
    }

    const handle = event.currentTarget
    const pointer = axis === 'x' ? event.clientX : event.clientY
    const cursor = current.cursor ?? (axis === 'x' ? 'col-resize' : 'row-resize')
    const endActivity = beginResizeActivity(current.kind)
    const previousBodyCursor = document.body.style.cursor
    const overlay = current.overlay === false ? null : createOverlay(cursor)

    document.body.classList.add(BODY_CLASS)
    document.body.style.cursor = cursor
    handle.dataset.resizing = 'true'
    try {
      handle.setPointerCapture(event.pointerId)
    } catch {
      // Window listeners still track the drag without capture.
    }

    const drag: DragState = {
      pointerId: event.pointerId,
      startPointer: pointer,
      pointer,
      startValue,
      scale,
      handle,
      overlay,
      previousBodyCursor,
      endActivity,
      listeners: {
        move: () => undefined,
        up: () => undefined,
        cancel: () => undefined,
        blur: () => undefined,
        visibility: () => undefined
      },
      frame: null,
      timer: null,
      completed: false
    }

    const coordinate = (next: PointerEvent): number =>
      axis === 'x' ? next.clientX : next.clientY

    drag.listeners = {
      move: (next) => {
        if (next.pointerId !== drag.pointerId) return
        drag.pointer = coordinate(next)
        requestFrame(drag)
      },
      up: (next) => {
        if (next.pointerId !== drag.pointerId) return
        drag.pointer = coordinate(next)
        settle(drag, true)
      },
      cancel: (next) => {
        if (next.pointerId !== drag.pointerId) return
        settle(drag, true)
      },
      blur: () => settle(drag, true),
      visibility: () => {
        if (document.hidden) settle(drag, true)
      }
    }

    dragRef.current = drag
    window.addEventListener('pointermove', drag.listeners.move)
    window.addEventListener('pointerup', drag.listeners.up)
    window.addEventListener('pointercancel', drag.listeners.cancel)
    window.addEventListener('blur', drag.listeners.blur)
    document.addEventListener('visibilitychange', drag.listeners.visibility)
  }

  const onLostPointerCapture = (event: React.PointerEvent<HTMLElement>): void => {
    const drag = dragRef.current
    if (drag === null || drag.completed || event.pointerId !== drag.pointerId) return
    settle(drag, true)
  }

  // Unrelated renders during a drag must not undo the direct DOM writes.
  useLayoutEffect(() => {
    const drag = dragRef.current
    const value = lastValueRef.current
    if (drag === null || drag.completed || value === null) return
    applyValue(value)
  })

  // Unmounting mid-drag drops the unsaved value, as the old handlers did, but
  // always releases the activity hold so terminals cannot stay frozen.
  useLayoutEffect(() => {
    return () => {
      const drag = dragRef.current
      if (drag !== null) settle(drag, false)
    }
  }, [])

  const handleProps: PanelResizeHandleProps = {
    onPointerDown,
    onLostPointerCapture,
    style: HANDLE_STYLE
  }

  return { handleProps, lastValueRef }
}
