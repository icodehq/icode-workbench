import { describe, expect, it, vi } from 'vitest'
import { presentWindow, type PresentableWindow } from './window-present'

function fakeWindow(options: { destroyed?: boolean; minimized?: boolean } = {}): {
  window: PresentableWindow
  calls: string[]
  restore: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
} {
  const calls: string[] = []
  const restore = vi.fn(() => {
    calls.push('restore')
  })
  const show = vi.fn(() => {
    calls.push('show')
  })
  const focus = vi.fn(() => {
    calls.push('focus')
  })
  return {
    window: {
      isDestroyed: () => options.destroyed ?? false,
      isMinimized: () => options.minimized ?? false,
      restore,
      show,
      focus
    },
    calls,
    restore,
    show,
    focus
  }
}

describe('presentWindow', () => {
  it('does nothing for a destroyed window', () => {
    const fake = fakeWindow({ destroyed: true })
    expect(presentWindow(fake.window)).toBe(false)
    expect(fake.restore).not.toHaveBeenCalled()
    expect(fake.show).not.toHaveBeenCalled()
    expect(fake.focus).not.toHaveBeenCalled()
  })

  it('restores a minimized window before showing and focusing it', () => {
    const fake = fakeWindow({ minimized: true })
    expect(presentWindow(fake.window)).toBe(true)
    expect(fake.calls).toEqual(['restore', 'show', 'focus'])
  })

  it('shows and focuses a visible window without restoring it', () => {
    const fake = fakeWindow()
    expect(presentWindow(fake.window)).toBe(true)
    expect(fake.calls).toEqual(['show', 'focus'])
    expect(fake.restore).not.toHaveBeenCalled()
  })
})
