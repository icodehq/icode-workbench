import { describe, expect, it } from 'vitest'
import {
  applyTheme,
  getResolvedTheme,
  getThemePreference,
  resolveTheme,
  subscribeTheme
} from './apply-theme'

describe('appearance preference', () => {
  it('resolves System from the OS and lets an explicit choice win', () => {
    expect(resolveTheme(false)).toBe('light')
    expect(resolveTheme(false, 'system')).toBe('dark')
    expect(resolveTheme(true, 'system')).toBe('light')
    expect(resolveTheme(false, 'light')).toBe('light')
    expect(resolveTheme(true, 'dark')).toBe('dark')
  })

  it('defaults to Light when storage is unavailable', () => {
    expect(getThemePreference()).toBe('light')
  })

  it('reads the resolved attribute rather than re-querying the OS', () => {
    expect(getResolvedTheme({ dataset: { theme: 'light' } } as unknown as HTMLElement)).toBe(
      'light'
    )
    expect(getResolvedTheme({ dataset: { theme: 'dark' } } as unknown as HTMLElement)).toBe(
      'dark'
    )
    expect(getResolvedTheme(null)).toBe('dark')
  })

  it('notifies subscribers only when the applied theme changes', () => {
    let changes = 0
    const off = subscribeTheme(() => {
      changes += 1
    })
    const root = { dataset: {} } as unknown as HTMLElement
    applyTheme('dark', root)
    applyTheme('dark', root)
    applyTheme('light', root)
    expect(root.dataset.theme).toBe('light')
    expect(changes).toBe(2)
    off()
    applyTheme('dark', root)
    expect(changes).toBe(2)
  })
})
