import { useCallback, useEffect, useRef, useState } from 'react'
import { isResizeActive, subscribeResizeActivity } from './resize-activity'

/**
 * Tracks an element's content width or height.
 *
 * The inspector's panes choose between a one-column and a two-column layout
 * from the space they actually have, not the window's — the same panel is
 * full-width in the tab layout and 640px in the split layout. The session row
 * that bounds the inspector also mounts later than its parent, so the hook
 * returns a callback ref: the observer starts whenever the element attaches,
 * not only on the component's first effect.
 *
 * While a panel seam is being dragged, size changes are marked dirty instead
 * of committing state. The heavy panes therefore re-render once when the drag
 * ends, not on every pointer frame; the one/two-column flip happens at release.
 */
export function useElementSize<T extends HTMLElement>(
  axis: 'width' | 'height'
): [(element: T | null) => void, number] {
  const [size, setSize] = useState(0)
  const cleanupRef = useRef<(() => void) | null>(null)

  const setElement = useCallback(
    (element: T | null) => {
      cleanupRef.current?.()
      cleanupRef.current = null
      if (element === null) return

      let frame: number | null = null
      let dirty = false
      const read = (): number => {
        const rect = element.getBoundingClientRect()
        return axis === 'width' ? rect.width : rect.height
      }
      let last = read()
      setSize((current) => (Math.abs(current - last) < 0.5 ? current : last))

      const apply = (next: number): void => {
        last = next
        setSize((current) => (Math.abs(current - next) < 0.5 ? current : next))
      }

      const measure = (): void => {
        const next = read()
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

      // The drag ends after React commits the new size (onCommit runs first),
      // so this single measurement sees the settled layout.
      const unsubscribe = subscribeResizeActivity((active) => {
        if (active || !dirty) return
        dirty = false
        scheduleMeasure()
      })

      let disconnect: () => void
      if (typeof ResizeObserver === 'undefined') {
        const onResize = (): void => {
          if (isResizeActive()) {
            dirty = true
            return
          }
          measure()
        }
        window.addEventListener('resize', onResize)
        disconnect = () => window.removeEventListener('resize', onResize)
      } else {
        const observer = new ResizeObserver((entries) => {
          const entry = entries[0]
          if (entry !== undefined) report(entry.contentRect[axis])
        })
        observer.observe(element)
        disconnect = () => observer.disconnect()
      }

      cleanupRef.current = () => {
        if (frame !== null) window.cancelAnimationFrame(frame)
        unsubscribe()
        disconnect()
      }
    },
    [axis]
  )

  // A ref callback normally detaches with null on unmount; this is the safety
  // net for hosts that unmount the whole subtree without detaching first.
  useEffect(() => {
    return () => {
      cleanupRef.current?.()
      cleanupRef.current = null
    }
  }, [])

  return [setElement, size]
}

/** Width-only convenience over `useElementSize`. */
export function useElementWidth<T extends HTMLElement>(): [
  (element: T | null) => void,
  number
] {
  return useElementSize<T>('width')
}

/** Height-only convenience over `useElementSize`. */
export function useElementHeight<T extends HTMLElement>(): [
  (element: T | null) => void,
  number
] {
  return useElementSize<T>('height')
}
