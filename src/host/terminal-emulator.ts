import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import type { TerminalSnapshot } from '../shared/host-protocol'

export const SCROLLBACK_LINES = 5000
/** Stop reading from the PTY above this much unparsed terminal input. */
export const EMULATOR_HIGH_WATER_BYTES = 1024 * 1024
export const EMULATOR_LOW_WATER_BYTES = 256 * 1024
/** Snapshots must fit comfortably inside the 4 MiB protocol frame. */
export const SNAPSHOT_MAX_BYTES = 3 * 1024 * 1024

export type Emulator = {
  write(data: string, onDrained?: () => void): void
  resize(cols: number, rows: number): void
  snapshot(seq: number): TerminalSnapshot
  /** Resolves once every write handed to xterm has been parsed. */
  whenIdle(): Promise<void>
  /** Bytes handed to xterm but not yet parsed. */
  pendingBytes(): number
  dispose(): void
}

/**
 * TerminalSnapshot.data is produced by the serialize addon, which emits the
 * alternate-screen transition (`?1049h`) as part of the stream. Writing that
 * stream into a fresh xterm reconstructs content, cursor, and screen type
 * (verified in terminal-emulator.test.ts).
 *
 * The addon restores the cursor with relative moves. When the source cursor sits
 * after a full-width row, those moves can land one column short, so an absolute
 * CUP is appended when the cursor is not in the wrap-pending column.
 */
function absoluteCursorSuffix(cols: number, rows: number, x: number, y: number): string {
  if (x >= cols) return ''
  const row = Math.min(Math.max(y + 1, 1), rows)
  const col = Math.min(Math.max(x + 1, 1), cols)
  return `\x1b[${row};${col}H`
}

export function createEmulator(cols: number, rows: number): Emulator {
  const terminal = new Terminal({
    cols,
    rows,
    scrollback: SCROLLBACK_LINES,
    allowProposedApi: true,
    convertEol: false
  })
  const serializer = new SerializeAddon()
  terminal.loadAddon(serializer)

  let pending = 0
  let disposed = false
  let truncated = false
  let atScrollbackCap = false
  let writesInFlight = 0
  const idleWaiters = new Set<() => void>()

  const settleIfIdle = (): void => {
    if (pending > 0 || writesInFlight > 0) return
    for (const resolve of idleWaiters) resolve()
    idleWaiters.clear()
  }

  return {
    write(data: string, onDrained?: () => void): void {
      if (disposed || data.length === 0) {
        onDrained?.()
        settleIfIdle()
        return
      }
      const bytes = Buffer.byteLength(data)
      // Any further scrollback after reaching the cap necessarily evicts a row.
      if (atScrollbackCap) truncated = true
      pending += bytes
      writesInFlight += 1
      terminal.write(data, () => {
        pending = Math.max(0, pending - bytes)
        writesInFlight = Math.max(0, writesInFlight - 1)
        // A retired emulator must not touch its disposed terminal buffer.
        if (disposed) {
          onDrained?.()
          settleIfIdle()
          return
        }
        // xterm caps baseY at scrollback and drops older rows silently. Reaching
        // the cap while more writes are queued means rows are already being lost.
        if (terminal.buffer.active.baseY >= SCROLLBACK_LINES) {
          atScrollbackCap = true
          if (writesInFlight > 0) truncated = true
        }
        onDrained?.()
        settleIfIdle()
      })
    },
    resize(nextCols: number, nextRows: number): void {
      if (disposed) return
      terminal.resize(nextCols, nextRows)
    },
    snapshot(seq: number): TerminalSnapshot {
      const buffer = terminal.buffer.active
      // Include scrollback so attach can restore earlier output, but keep the
      // frame within the protocol budget by reducing history before dimensions.
      let body = serializer.serialize({ scrollback: SCROLLBACK_LINES })
      let payloadTruncated = false
      for (const lines of [1000, 250, 0]) {
        if (Buffer.byteLength(body) <= SNAPSHOT_MAX_BYTES) break
        body = serializer.serialize({ scrollback: lines })
        payloadTruncated = true
      }
      const cursor = { x: buffer.cursorX, y: buffer.cursorY }
      const suffix = absoluteCursorSuffix(terminal.cols, terminal.rows, cursor.x, cursor.y)
      return {
        data: suffix.length > 0 ? `${body}${suffix}` : body,
        cols: terminal.cols,
        rows: terminal.rows,
        seq,
        alternateScreen: buffer.type === 'alternate',
        cursor,
        scrollbackLines: Math.min(buffer.baseY, SCROLLBACK_LINES),
        truncated: truncated || payloadTruncated
      }
    },
    whenIdle(): Promise<void> {
      if (pending === 0 && writesInFlight === 0) return Promise.resolve()
      return new Promise<void>((resolve) => {
        idleWaiters.add(resolve)
      })
    },
    pendingBytes: () => pending,
    dispose(): void {
      for (const resolve of idleWaiters) resolve()
      idleWaiters.clear()
      if (disposed) return
      disposed = true
      terminal.dispose()
    }
  }
}
