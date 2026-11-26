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
    expect(openAuxTab([], 'bots')).toEqual(['bots'])
    expect(openAuxTab(['bots'], 'settings')).toEqual(['bots', 'settings'])
    expect(openAuxTab(['bots'], 'bots')).toEqual(['bots'])
  })

  it('closes only the requested tab', () => {
    expect(closeAuxTab(['bots', 'settings', 'schedules'], 'settings')).toEqual([
      'bots',
      'schedules'
    ])
  })

  it('returns to Sessions when the last tab closes', () => {
    expect(nextActiveAfterClose(['bots'], 'bots', 'bots')).toBe('sessions')
  })

  it('selects the neighbouring tab when the active one closes', () => {
    const tabs: AuxAppTab[] = ['bots', 'settings', 'schedules']
    expect(nextActiveAfterClose(tabs, 'settings', 'settings')).toBe('schedules')
    expect(nextActiveAfterClose(tabs, 'schedules', 'schedules')).toBe('settings')
    expect(nextActiveAfterClose(tabs, 'bots', 'bots')).toBe('settings')
  })

  it('does not change the active tab when closing a background tab', () => {
    const tabs: AuxAppTab[] = ['bots', 'settings']
    expect(nextActiveAfterClose(tabs, 'bots', 'settings')).toBe('settings')
  })

  it('distinguishes Sessions from auxiliary tabs', () => {
    expect(isAuxTab('sessions')).toBe(false)
    expect(isAuxTab('bots')).toBe(true)
    expect(isAuxTab('settings')).toBe(true)
    expect(isAuxTab('schedules')).toBe(true)
  })
})
