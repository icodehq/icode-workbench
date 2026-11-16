import { useEffect, useRef, useState, type RefObject } from 'react'

/**
 * Tracks an element's content width.
 *
 * The inspector's panes choose between a one-column and a two-column layout
 * from the space they actually have, not the window's — the same panel is
 * full-width in the tab layout and 640px in the split layout.
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
    const measure = (next: number): void => {
      setWidth((current) => (Math.abs(current - next) < 0.5 ? current : next))
    }
    measure(element.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') {
      const onResize = (): void => measure(element.getBoundingClientRect().width)
      window.addEventListener('resize', onResize)
      return () => window.removeEventListener('resize', onResize)
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry !== undefined) measure(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return [ref, width]
}
