export type TerminalSize = {
  cols: number
  rows: number
}

const STORAGE_KEY = 'ade.terminalSize'
const SAVE_DELAY_MS = 250

let cached: TerminalSize | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null

function valid(value: unknown): value is TerminalSize {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as { cols?: unknown; rows?: unknown }
  return (
    typeof candidate.cols === 'number' &&
    Number.isInteger(candidate.cols) &&
    candidate.cols >= 2 &&
    candidate.cols <= 1000 &&
    typeof candidate.rows === 'number' &&
    Number.isInteger(candidate.rows) &&
    candidate.rows >= 2 &&
    candidate.rows <= 1000
  )
}

/**
 * The last terminal grid the user actually worked in.
 *
 * New PTYs used to be created at a hardcoded 100x30 and then resized to the
 * real pane after attach, which made every new session visibly reflow. Reading
 * the last fitted size at create time keeps the first prompt stable.
 */
export function readTerminalSize(): TerminalSize | null {
  if (cached !== null) return cached
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (!valid(parsed)) return null
    cached = { cols: parsed.cols, rows: parsed.rows }
    return cached
  } catch {
    return null
  }
}

/**
 * Records the fitted grid. Storage is debounced because window dragging can
 * change the grid on every frame; the in-memory value serves the next session
 * immediately.
 */
export function rememberTerminalSize(size: TerminalSize): void {
  if (!valid(size)) return
  cached = { cols: size.cols, rows: size.rows }
  if (typeof window === 'undefined') return
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cached))
    } catch {
      // A disabled storage backend must not affect the terminal.
    }
  }, SAVE_DELAY_MS)
}
