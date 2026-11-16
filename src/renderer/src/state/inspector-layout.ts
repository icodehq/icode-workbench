/**
 * Layout constants and persistence for the right-hand inspector.
 *
 * The inspector is a master–detail surface, the way Termio's right panel is:
 * a list (file tree or changed files) and a detail (editor or diff) share the
 * panel, and the detail only sits beside the list once the panel is wide
 * enough. Below that width the detail covers the list, so neither column is
 * ever squeezed into half a panel.
 *
 * The width is renderer-only state, so localStorage is the persistence
 * boundary. Values are clamped on load and on every drag; the viewport clamp
 * leaves `INSPECTOR_TERMINAL_MIN` for the terminal beside the inspector.
 */

export const INSPECTOR_WIDTH_KEY = 'icode.inspector.width.v1'

/** Narrowest the inspector may be dragged while expanded. */
export const INSPECTOR_WIDTH_MIN = 360
/** Width a first launch gets, and what a double-click on the seam restores. */
export const INSPECTOR_WIDTH_DEFAULT = 640
/** Widest the inspector may be dragged, however large the window. */
export const INSPECTOR_WIDTH_MAX = 1000
/** Room the terminal keeps when the inspector sits beside it. */
export const INSPECTOR_TERMINAL_MIN = 420

/**
 * Panel width at which the list and the detail sit side by side. Below this
 * the detail covers the list; the list stays mounted underneath, and closing
 * the detail brings it back.
 */
export const INSPECTOR_TWO_COLUMN_MIN = 760

/** Width of the file-tree column when the inspector is in two-column mode. */
export const FILES_LIST_WIDTH = 288

type ReadableStorage = Pick<Storage, 'getItem'>
type WritableStorage = Pick<Storage, 'setItem'>

function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/**
 * Fits a preferred width into what the window can spare. The preference is
 * kept intact in storage; only the width rendered is clamped, so shrinking a
 * window and growing it again restores the width the user chose.
 */
export function clampInspectorWidth(width: number, viewportWidth: number): number {
  const widest = Math.max(
    INSPECTOR_WIDTH_MIN,
    Math.min(INSPECTOR_WIDTH_MAX, Math.floor(viewportWidth) - INSPECTOR_TERMINAL_MIN)
  )
  const rounded = Number.isFinite(width) ? Math.round(width) : INSPECTOR_WIDTH_DEFAULT
  return Math.min(Math.max(rounded, INSPECTOR_WIDTH_MIN), widest)
}

export function loadInspectorWidth(
  storage: ReadableStorage | null = browserStorage()
): number {
  if (storage === null) return INSPECTOR_WIDTH_DEFAULT
  let raw: string | null
  try {
    raw = storage.getItem(INSPECTOR_WIDTH_KEY)
  } catch {
    return INSPECTOR_WIDTH_DEFAULT
  }
  if (raw === null) return INSPECTOR_WIDTH_DEFAULT
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return INSPECTOR_WIDTH_DEFAULT
  return Math.min(Math.max(Math.round(parsed), INSPECTOR_WIDTH_MIN), INSPECTOR_WIDTH_MAX)
}

export function saveInspectorWidth(
  width: number,
  storage: WritableStorage | null = browserStorage()
): boolean {
  if (storage === null) return false
  try {
    storage.setItem(INSPECTOR_WIDTH_KEY, String(Math.round(width)))
  } catch {
    return false
  }
  return true
}
