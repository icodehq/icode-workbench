/**
 * Keeps PTY resizes out of a live layout drag.
 *
 * xterm reports a new grid on every fit. During a seam drag the grid can change
 * many times; sending each one makes the shell redraw and steals frames from
 * the drag. Hold the reports, then send the settled grid once on release.
 *
 * DOM-free so the one-send invariant is testable in Node.
 */

export type TerminalGrid = { cols: number; rows: number }

type PanePtyResizeHoldOptions = {
  send: (grid: TerminalGrid) => void
  /** Ordinary coalescing window when no drag is active. */
  delayMs?: number
}

export class PanePtyResizeHold {
  private readonly send: (grid: TerminalGrid) => void
  private readonly delayMs: number
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: TerminalGrid | null = null
  private held = false
  private disposed = false

  constructor(options: PanePtyResizeHoldOptions) {
    this.send = options.send
    this.delayMs = options.delayMs ?? 50
  }

  get isHeld(): boolean {
    return this.held
  }

  /** Records the newest grid; sends it after the debounce when not held. */
  noteGrid(grid: TerminalGrid): void {
    if (this.disposed) return
    this.pending = { cols: grid.cols, rows: grid.rows }
    if (this.held) return
    this.arm()
  }

  begin(): void {
    if (this.disposed) return
    this.held = true
    this.clearTimer()
  }

  /**
   * Ends the hold. Sends the final grid exactly once, or nothing when the
   * post-drag fit could not measure a visible container.
   */
  finish(final: TerminalGrid | null): void {
    if (this.disposed) return
    this.held = false
    this.clearTimer()
    this.pending = null
    if (final !== null) this.send({ cols: final.cols, rows: final.rows })
  }

  dispose(): void {
    this.disposed = true
    this.held = false
    this.clearTimer()
    this.pending = null
  }

  private arm(): void {
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      const next = this.pending
      this.pending = null
      if (next !== null) this.send(next)
    }, this.delayMs)
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
