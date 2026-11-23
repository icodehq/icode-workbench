/**
 * Geometry rules and persistence for the workspace sidebar.
 *
 * Termio keeps its navigator between 240 and 400 points and remembers the
 * divider position across launches; the workspace sidebar follows the same
 * bounds, with the same double-click reset. Renderer-only state, so
 * localStorage is the persistence boundary.
 *
 * The vertical split between the Projects pane and the Tasks pane is also
 * renderer-only. The Tasks height is stored in pixels, like the width; the
 * rendered value is clamped to the space the sidebar can spare, while the
 * stored preference stays intact so growing the window restores it.
 */

export const SIDEBAR_WIDTH_KEY = 'icode.workspace.sidebar.width.v1'
export const SIDEBAR_TASKS_HEIGHT_KEY = 'icode.workspace.sidebar.tasksHeight.v1'

/** Narrowest the workspace sidebar may be dragged. */
export const SIDEBAR_WIDTH_MIN = 240
/** First-launch width, and what a double-click on the seam restores. */
export const SIDEBAR_WIDTH_DEFAULT = 300
/** Widest the workspace sidebar may be dragged. */
export const SIDEBAR_WIDTH_MAX = 400

/** Narrowest the expanded Tasks pane may be dragged: header plus one row. */
export const SIDEBAR_TASKS_MIN = 96
/** Smallest the Projects pane keeps when the Tasks pane is expanded. */
export const SIDEBAR_PROJECTS_MIN = 140
/** Storage sanity bound; the rendered maximum is the space the split spares. */
export const SIDEBAR_TASKS_HEIGHT_MAX = 2400
/** Height of the draggable seam between the two panes. */
export const SIDEBAR_SECTION_SEAM = 3

type ReadableStorage = Pick<Storage, 'getItem'>
type WritableStorage = Pick<Storage, 'setItem'>
type RemovableStorage = Pick<Storage, 'setItem' | 'removeItem'>

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

/**
 * Fits a preferred Tasks height into what the split can spare. The preference
 * is kept intact in storage; only the rendered height is clamped, so shrinking
 * a window and growing it again restores the height the user chose.
 */
export function sidebarTasksMax(availableSplit: number): number {
  const split = Number.isFinite(availableSplit) ? Math.floor(availableSplit) : 0
  const widest = split - SIDEBAR_PROJECTS_MIN - SIDEBAR_SECTION_SEAM
  return Math.max(SIDEBAR_TASKS_MIN, Math.min(SIDEBAR_TASKS_HEIGHT_MAX, widest))
}

export function clampSidebarTasksHeight(
  height: number,
  availableSplit: number
): number {
  const rounded = Number.isFinite(height) ? Math.round(height) : SIDEBAR_TASKS_MIN
  return Math.min(Math.max(rounded, SIDEBAR_TASKS_MIN), sidebarTasksMax(availableSplit))
}

/** Null means the Tasks pane is content-sized, as it is before the first drag. */
export function loadSidebarTasksHeight(
  storage: ReadableStorage | null = browserStorage()
): number | null {
  if (storage === null) return null
  let raw: string | null
  try {
    raw = storage.getItem(SIDEBAR_TASKS_HEIGHT_KEY)
  } catch {
    return null
  }
  if (raw === null) return null
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return null
  return Math.min(
    Math.max(Math.round(parsed), SIDEBAR_TASKS_MIN),
    SIDEBAR_TASKS_HEIGHT_MAX
  )
}

/** Passing null clears the preference and returns the pane to content-sized. */
export function saveSidebarTasksHeight(
  height: number | null,
  storage: RemovableStorage | null = browserStorage()
): boolean {
  if (storage === null) return false
  try {
    if (height === null) {
      storage.removeItem(SIDEBAR_TASKS_HEIGHT_KEY)
    } else {
      const clamped = Math.min(
        Math.max(Math.round(height), SIDEBAR_TASKS_MIN),
        SIDEBAR_TASKS_HEIGHT_MAX
      )
      storage.setItem(SIDEBAR_TASKS_HEIGHT_KEY, String(clamped))
    }
  } catch {
    return false
  }
  return true
}
