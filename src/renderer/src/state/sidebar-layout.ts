/**
 * Geometry rules and persistence for the workspace sidebar.
 *
 * Termio keeps its navigator between 240 and 400 points and remembers the
 * divider position across launches; the workspace sidebar follows the same
 * bounds, with the same double-click reset. Renderer-only state, so
 * localStorage is the persistence boundary.
 *
 */

export const SIDEBAR_WIDTH_KEY = 'icode.workspace.sidebar.width.v1'

/** Narrowest the workspace sidebar may be dragged. */
export const SIDEBAR_WIDTH_MIN = 240
/** First-launch width, and what a double-click on the seam restores. */
export const SIDEBAR_WIDTH_DEFAULT = 300
/** Widest the workspace sidebar may be dragged. */
export const SIDEBAR_WIDTH_MAX = 400


type ReadableStorage = Pick<Storage, 'getItem'>
type WritableStorage = Pick<Storage, 'setItem'>

function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function clampSidebarWidth(width: number): number {
  const rounded = Number.isFinite(width) ? Math.round(width) : SIDEBAR_WIDTH_DEFAULT
  return Math.min(Math.max(rounded, SIDEBAR_WIDTH_MIN), SIDEBAR_WIDTH_MAX)
}

export function loadSidebarWidth(
  storage: ReadableStorage | null = browserStorage()
): number {
  if (storage === null) return SIDEBAR_WIDTH_DEFAULT
  let raw: string | null
  try {
    raw = storage.getItem(SIDEBAR_WIDTH_KEY)
  } catch {
    return SIDEBAR_WIDTH_DEFAULT
  }
  if (raw === null) return SIDEBAR_WIDTH_DEFAULT
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? clampSidebarWidth(parsed) : SIDEBAR_WIDTH_DEFAULT
}

export function saveSidebarWidth(
  width: number,
  storage: WritableStorage | null = browserStorage()
): boolean {
  if (storage === null) return false
  try {
    storage.setItem(SIDEBAR_WIDTH_KEY, String(clampSidebarWidth(width)))
  } catch {
    return false
  }
  return true
}
