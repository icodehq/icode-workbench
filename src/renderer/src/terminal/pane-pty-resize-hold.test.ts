import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PanePtyResizeHold, type TerminalGrid } from './pane-pty-resize-hold'

describe('PanePtyResizeHold', () => {
  let sent: TerminalGrid[]

  beforeEach(() => {
    vi.useFakeTimers()
    sent = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces ordinary grid reports into the newest one', () => {
    const hold = new PanePtyResizeHold({ send: (grid) => sent.push(grid) })

    hold.noteGrid({ cols: 80, rows: 24 })
    hold.noteGrid({ cols: 90, rows: 30 })
    vi.advanceTimersByTime(49)
    expect(sent).toEqual([])

    vi.advanceTimersByTime(1)
    expect(sent).toEqual([{ cols: 90, rows: 30 }])
  })

  it('sends nothing while a drag holds the grid', () => {
    const hold = new PanePtyResizeHold({ send: (grid) => sent.push(grid) })

    hold.noteGrid({ cols: 80, rows: 24 })
    vi.advanceTimersByTime(50)
    sent.length = 0

    hold.begin()
    for (let cols = 81; cols <= 140; cols += 1) {
      hold.noteGrid({ cols, rows: 24 })
      vi.advanceTimersByTime(16)
    }
    expect(sent).toEqual([])
  })

  it('sends the final grid exactly once when the hold ends', () => {
    const hold = new PanePtyResizeHold({ send: (grid) => sent.push(grid) })

    hold.begin()
    hold.noteGrid({ cols: 100, rows: 30 })
    hold.noteGrid({ cols: 120, rows: 30 })
    vi.advanceTimersByTime(1000)
    expect(sent).toEqual([])

    hold.finish({ cols: 132, rows: 30 })
    expect(sent).toEqual([{ cols: 132, rows: 30 }])

    vi.advanceTimersByTime(1000)
    expect(sent).toEqual([{ cols: 132, rows: 30 }])
  })

  it('cancels a pending ordinary send when a drag begins', () => {
    const hold = new PanePtyResizeHold({ send: (grid) => sent.push(grid) })

    hold.noteGrid({ cols: 80, rows: 24 })
    hold.begin()
    vi.advanceTimersByTime(100)
    expect(sent).toEqual([])

    hold.finish({ cols: 84, rows: 24 })
    expect(sent).toEqual([{ cols: 84, rows: 24 }])
  })

  it('ends the hold without sending when the final fit could not measure', () => {
    const hold = new PanePtyResizeHold({ send: (grid) => sent.push(grid) })

    hold.begin()
    hold.noteGrid({ cols: 100, rows: 30 })
    hold.finish(null)
    vi.advanceTimersByTime(1000)
    expect(sent).toEqual([])
    expect(hold.isHeld).toBe(false)
  })

  it('ignores reports and sends after disposal', () => {
    const hold = new PanePtyResizeHold({ send: (grid) => sent.push(grid) })

    hold.noteGrid({ cols: 80, rows: 24 })
    hold.dispose()
    vi.advanceTimersByTime(1000)
    hold.noteGrid({ cols: 90, rows: 30 })
    hold.finish({ cols: 100, rows: 30 })
    vi.advanceTimersByTime(1000)
    expect(sent).toEqual([])
  })
})
