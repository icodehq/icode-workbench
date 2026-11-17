import { useEffect, useRef, useState } from 'react'
import {
  FILES_LIST_WIDTH_MAX,
  FILES_LIST_WIDTH_MIN,
  saveFilesSettings,
  type FilesSettings
} from './files-settings'
import { useElementWidth } from '../lib/use-element-width'
import { usePanelResize } from '../lib/use-panel-resize'
import { INSPECTOR_TWO_COLUMN_MIN } from '../state/inspector-layout'

export function useFilesLayout(input: {
  active: boolean
  detailOpen: boolean
  settings: FilesSettings
}) {
  const { active, detailOpen, settings } = input
  const [panelRef, panelWidth] = useElementWidth<HTMLDivElement>()
  const [listHidden, setListHidden] = useState(false)
  const [detailDismissed, setDetailDismissed] = useState(false)
  const [detailMaximized, setDetailMaximized] = useState(false)
  const detailVisible = detailOpen && !detailDismissed
  const twoColumnAvailable = panelWidth >= INSPECTOR_TWO_COLUMN_MIN
  const twoColumn = twoColumnAvailable && detailVisible && !listHidden

  const [listWidth, setListWidth] = useState(settings.listWidth)
  const listWidthRef = useRef(settings.listWidth)
  const listRef = useRef<HTMLDivElement | null>(null)
  // Leave the editor at least 260px when the tree is beside it.
  const maxListWidth = Math.max(
    FILES_LIST_WIDTH_MIN,
    Math.min(FILES_LIST_WIDTH_MAX, panelWidth - 260)
  )
  const effectiveListWidth = Math.max(
    FILES_LIST_WIDTH_MIN,
    Math.min(listWidth, maxListWidth)
  )

  useEffect(() => {
    setListWidth(settings.listWidth)
    listWidthRef.current = settings.listWidth
  }, [settings.listWidth])

  useEffect(() => {
    if (detailOpen) return
    setDetailDismissed(false)
    setDetailMaximized(false)
  }, [detailOpen])

  useEffect(() => {
    if (!active || (!detailMaximized && !detailVisible)) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const target = event.target
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, select, [contenteditable="true"]') !== null
      ) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      if (detailMaximized) setDetailMaximized(false)
      else setDetailDismissed(true)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active, detailMaximized, detailVisible])

  const persistListWidth = (next: number): void => {
    const clamped = Math.max(
      FILES_LIST_WIDTH_MIN,
      Math.min(FILES_LIST_WIDTH_MAX, Math.round(next))
    )
    setListWidth(clamped)
    listWidthRef.current = clamped
    saveFilesSettings({ ...settings, listWidth: clamped })
  }

  const { handleProps } = usePanelResize({
    kind: 'files-list',
    panelRef: listRef,
    getStartValue: () => effectiveListWidth,
    clamp: (candidate) =>
      Math.max(FILES_LIST_WIDTH_MIN, Math.min(maxListWidth, candidate)),
    direction: 1,
    axis: 'x',
    disabled: !twoColumn,
    cursor: 'col-resize',
    onCommit: persistListWidth
  })

  return {
    panelRef,
    listRef,
    listWidthRef,
    effectiveListWidth,
    listHidden,
    setListHidden,
    detailDismissed,
    setDetailDismissed,
    detailMaximized,
    setDetailMaximized,
    detailVisible,
    twoColumnAvailable,
    twoColumn,
    persistListWidth,
    handleProps
  }
}
