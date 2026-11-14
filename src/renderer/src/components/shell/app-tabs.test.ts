import { describe, expect, it } from 'vitest'
import {
  closeAuxTab,
  isAuxTab,
  nextActiveAfterClose,
  openAuxTab,
  type AuxAppTab
} from './app-tabs'

describe('app tabs', () => {
  it('opens an auxiliary tab once and keeps order', () => {
    expect(openAuxTab([], 'mira')).toEqual(['mira'])
    expect(openAuxTab(['mira'], 'settings')).toEqual(['mira', 'settings'])
    expect(openAuxTab(['mira'], 'mira')).toEqual(['mira'])
  })

  it('closes only the requested tab', () => {
    expect(closeAuxTab(['mira', 'settings', 'schedules'], 'settings')).toEqual([
      'mira',
      'schedules'
    ])
  })

  it('returns to Sessions when the last tab closes', () => {
    expect(nextActiveAfterClose(['mira'], 'mira', 'mira')).toBe('sessions')
  })

  it('selects the neighbouring tab when the active one closes', () => {
    const tabs: AuxAppTab[] = ['mira', 'settings', 'schedules']
    expect(nextActiveAfterClose(tabs, 'settings', 'settings')).toBe('schedules')
    expect(nextActiveAfterClose(tabs, 'schedules', 'schedules')).toBe('settings')
    expect(nextActiveAfterClose(tabs, 'mira', 'mira')).toBe('settings')
  })

  it('does not change the active tab when closing a background tab', () => {
    const tabs: AuxAppTab[] = ['mira', 'settings']
    expect(nextActiveAfterClose(tabs, 'mira', 'settings')).toBe('settings')
  })

  it('distinguishes Sessions from auxiliary tabs', () => {
    expect(isAuxTab('sessions')).toBe(false)
    expect(isAuxTab('mira')).toBe(true)
    expect(isAuxTab('settings')).toBe(true)
    expect(isAuxTab('schedules')).toBe(true)
  })
})
