import { useEffect, useRef, useState, type RefObject } from 'react'
import { isResizeActive, subscribeResizeActivity } from './resize-activity'

/**
 * Tracks an element's content width.
 *
 * The inspector's panes choose between a one-column and a two-column layout
 * from the space they actually have, not the window's — the same panel is
 * full-width in the tab layout and 640px in the split layout.
 *
 * While a panel seam is being dragged, width changes are marked dirty instead
 * of committing state. The heavy panes therefore re-render once when the drag
 * ends, not on every pointer frame; the one/two-column flip happens at release.
 */
export function useElementWidth<T extends HTMLElement>(): [
  RefObject<T | null>,
  number
] {
  const ref = useRef<T | null>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const element = ref.current
    if (element === null) return

    let frame: number | null = null
    let dirty = false
    let last = -1

    const apply = (next: number): void => {
      last = next
      setWidth((current) => (Math.abs(current - next) < 0.5 ? current : next))
    }

    const measure = (): void => {
      const next = element.getBoundingClientRect().width
      if (Math.abs(last - next) < 0.5) return
      apply(next)
    }

    const scheduleMeasure = (): void => {
      if (frame !== null) return
      frame = window.requestAnimationFrame(() => {
        frame = null
        if (isResizeActive()) {
          dirty = true
          return
        }
        dirty = false
        measure()
      })
    }

    const report = (next: number): void => {
      if (isResizeActive()) {
        dirty = true
        return
      }
      if (Math.abs(last - next) < 0.5) return
      apply(next)
    }

    const initial = element.getBoundingClientRect().width
    last = initial
    setWidth((current) => (Math.abs(current - initial) < 0.5 ? current : initial))

    // The drag ends after React commits the new width (onCommit runs first),
    // so this single measurement sees the settled layout.
    const unsubscribe = subscribeResizeActivity((active) => {
      if (active || !dirty) return
      dirty = false
      scheduleMeasure()
    })

    if (typeof ResizeObserver === 'undefined') {
      const onResize = (): void => {
        if (isResizeActive()) {
          dirty = true
          return
        }
        measure()
      }
      window.addEventListener('resize', onResize)
      return () => {
        if (frame !== null) window.cancelAnimationFrame(frame)
        unsubscribe()
        window.removeEventListener('resize', onResize)
      }
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry !== undefined) report(entry.contentRect.width)
    })
    observer.observe(element)
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      unsubscribe()
      observer.disconnect()
    }
  }, [])

  return [ref, width]
}
