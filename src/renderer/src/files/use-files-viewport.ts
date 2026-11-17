import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TreeRow } from './selection'
import { scrollTopForRow } from './virtual-window'

export type FilesViewport = { scrollTop: number; height: number; rowsTop: number }

export function useFilesViewport(rows: TreeRow[]) {
  const [viewport, setViewport] = useState<FilesViewport>({
    scrollTop: 0,
    height: 600,
    rowsTop: 0
  })
  const treeScrollRef = useRef<HTMLDivElement | null>(null)
  const rowsContainerRef = useRef<HTMLDivElement | null>(null)
  const rowsRef = useRef<TreeRow[]>([])
  const viewportRef = useRef(viewport)
  const restoreScroll = useRef<number | null>(null)
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  rowsRef.current = rows
  viewportRef.current = viewport

  const scrollRowIndexIntoView = useCallback((index: number): void => {
    const element = treeScrollRef.current
    if (element === null) return
    const rowsTop = viewportRef.current.rowsTop
    const localScroll = Math.max(0, element.scrollTop - rowsTop)
    const next = scrollTopForRow({
      index,
      rowCount: Math.max(index + 1, rowsRef.current.length),
      scrollTop: localScroll,
      viewportHeight: element.clientHeight
    })
    element.scrollTop = Math.max(0, rowsTop + next)
  }, [])

  const focusRowElement = useCallback((path: string, attempt = 0): void => {
    const element = rowRefs.current.get(path)
    if (element !== undefined) {
      element.focus({ preventScroll: true })
      return
    }
    if (attempt >= 12) return
    window.setTimeout(() => focusRowElement(path, attempt + 1), 16)
  }, [])

  useLayoutEffect(() => {
    const element = treeScrollRef.current
    if (element === null) return
    const height = element.clientHeight
    const rowsTop = rowsContainerRef.current?.offsetTop ?? 0
    setViewport((current) =>
      current.height === height && current.rowsTop === rowsTop
        ? current
        : { ...current, height, rowsTop }
    )
  })

  useEffect(() => {
    const element = treeScrollRef.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const rowsTop = rowsContainerRef.current?.offsetTop ?? 0
      const height = element.clientHeight
      setViewport((current) =>
        current.height === height && current.rowsTop === rowsTop
          ? current
          : { ...current, height, rowsTop }
      )
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return {
    treeScrollRef,
    rowsContainerRef,
    rowRefs,
    rowsRef,
    viewport,
    setViewport,
    restoreScroll,
    scrollRowIndexIntoView,
    focusRowElement
  }
}
