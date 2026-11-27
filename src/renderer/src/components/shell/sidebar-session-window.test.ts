import { describe, expect, it } from 'vitest'
import { resolveSessionWindow } from './sidebar-session-window'

const sessions = Array.from({ length: 100 }, (_, index) => ({ id: `session-${index}` }))
const manySessions = Array.from({ length: 200 }, (_, index) => ({
  id: `session-${index}`
}))

describe('resolveSessionWindow', () => {
  it('starts at the first batch when nothing is active', () => {
    const window = resolveSessionWindow(sessions, undefined, null, 80)

    expect(window.start).toBe(0)
    expect(window.end).toBe(80)
    expect(window.visible).toHaveLength(80)
    expect(window.hiddenBefore).toBe(0)
    expect(window.hiddenAfter).toBe(20)
  })

  it('keeps an active session in the first batch visible', () => {
    const window = resolveSessionWindow(sessions, undefined, 'session-4', 80)

    expect(window.start).toBe(0)
    expect(window.end).toBe(80)
    expect(window.hiddenBefore).toBe(0)
    expect(window.hiddenAfter).toBe(20)
  })

  it('shifts the window to end at an active session past the batch', () => {
    const window = resolveSessionWindow(sessions, undefined, 'session-90', 80)

    expect(window.start).toBe(11)
    expect(window.end).toBe(91)
    expect(window.visible.at(-1)?.id).toBe('session-90')
    expect(window.hiddenBefore).toBe(11)
    expect(window.hiddenAfter).toBe(9)
  })

  it('keeps the active last row visible at the end of a group', () => {
    const window = resolveSessionWindow(sessions, undefined, 'session-99', 80)

    expect(window.start).toBe(20)
    expect(window.end).toBe(100)
    expect(window.visible.at(-1)?.id).toBe('session-99')
    expect(window.hiddenBefore).toBe(20)
    expect(window.hiddenAfter).toBe(0)
  })

  it('honors a remembered window while the active row is inside it', () => {
    const window = resolveSessionWindow(
      manySessions,
      { start: 100, end: 180 },
      'session-120',
      80
    )

    expect(window.start).toBe(100)
    expect(window.end).toBe(180)
    expect(window.hiddenBefore).toBe(100)
    expect(window.hiddenAfter).toBe(20)
  })

  it('shifts a remembered window when the active row moves outside it', () => {
    const window = resolveSessionWindow(
      manySessions,
      { start: 0, end: 80 },
      'session-120',
      80
    )

    expect(window.start).toBe(41)
    expect(window.end).toBe(121)
    expect(window.visible.at(-1)?.id).toBe('session-120')
  })

  it('clamps a remembered window after the group shrinks', () => {
    const window = resolveSessionWindow(
      sessions.slice(0, 50),
      { start: 100, end: 180 },
      null,
      80
    )

    expect(window.start).toBe(49)
    expect(window.end).toBe(50)
    expect(window.visible).toHaveLength(1)
    expect(window.hiddenBefore).toBe(49)
    expect(window.hiddenAfter).toBe(0)
  })

  it('handles an empty group', () => {
    expect(resolveSessionWindow([], { start: 100, end: 180 }, 'missing', 80)).toMatchObject({
      start: 0,
      end: 0,
      visible: [],
      hiddenBefore: 0,
      hiddenAfter: 0
    })
  })
})
