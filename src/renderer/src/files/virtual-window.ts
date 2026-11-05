/**
 * Fixed-height windowing for the Files tree.
 *
 * Rows are 28 px by contract; the inline editor keeps the same row height and
 * floats its validation note, so the window math stays exact. Spacers preserve
 * the scrollbar's real length while only the visible slice is mounted.
 */

export type VirtualWindow = {
  /** First mounted row index (inclusive). */
  start: number
  /** One past the last mounted row index. */
  end: number
  paddingTop: number
  paddingBottom: number
}

export const FILES_ROW_HEIGHT = 28
export const FILES_ROW_OVERSCAN = 8

export function computeVirtualWindow(input: {
  rowCount: number
  scrollTop: number
  viewportHeight: number
  rowHeight?: number
  overscan?: number
}): VirtualWindow {
  const rowCount = Math.max(0, Math.floor(input.rowCount))
  const rowHeight = Math.max(1, input.rowHeight ?? FILES_ROW_HEIGHT)
  const overscan = Math.max(0, input.overscan ?? FILES_ROW_OVERSCAN)
  const scrollTop = Math.max(0, input.scrollTop)
  const viewportHeight = Math.max(0, input.viewportHeight)
  if (rowCount === 0) {
    return { start: 0, end: 0, paddingTop: 0, paddingBottom: 0 }
  }
  const firstVisible = Math.floor(scrollTop / rowHeight)
  const visibleCount = Math.ceil(viewportHeight / rowHeight)
  const maxStart = Math.max(0, rowCount - visibleCount - overscan)
  const start = Math.min(maxStart, Math.max(0, firstVisible - overscan))
  const end = Math.min(rowCount, Math.max(start, firstVisible + visibleCount + overscan))
  return {
    start,
    end,
    paddingTop: start * rowHeight,
    paddingBottom: Math.max(0, (rowCount - end) * rowHeight)
  }
}

/** Scroll position that keeps `index` inside the viewport, nearest-edge first. */
export function scrollTopForRow(input: {
  index: number
  rowCount: number
  scrollTop: number
  viewportHeight: number
  rowHeight?: number
}): number {
  const rowHeight = Math.max(1, input.rowHeight ?? FILES_ROW_HEIGHT)
  const top = Math.max(0, input.index) * rowHeight
  const bottom = top + rowHeight
  if (top < input.scrollTop) return top
  if (bottom > input.scrollTop + input.viewportHeight) {
    return Math.max(0, bottom - input.viewportHeight)
  }
  return input.scrollTop
}
