import { describe, expect, it } from 'vitest'
import {
  arrangeBotsRows,
  countActiveBotsFilters,
  loadBotsSidebarView,
  normalizeBotsSidebarView,
  saveBotsSidebarView,
  BOTS_SIDEBAR_VIEW_KEY,
  type BotsRowFacts
} from './bots-sidebar-view'

function row(overrides: Partial<BotsRowFacts> & Pick<BotsRowFacts, 'key' | 'kind' | 'name'>): BotsRowFacts {
  return {
    paused: false,
    needs: 0,
    unread: 0,
    working: false,
    sleeping: false,
    activityAt: 0,
    ...overrides
  }
}

describe('bots sidebar view', () => {
  it('normalizes missing and unknown preferences', () => {
    expect(normalizeBotsSidebarView(null)).toEqual({
      sortBy: 'manual',
      hidePaused: false,
      hideSleeping: false
    })
    expect(normalizeBotsSidebarView({ sortBy: 'other', hidePaused: 'yes' })).toEqual({
      sortBy: 'manual',
      hidePaused: false,
      hideSleeping: false
    })
    expect(
      normalizeBotsSidebarView({ sortBy: 'name', hidePaused: true, hideSleeping: true })
    ).toEqual({
      sortBy: 'name',
      hidePaused: true,
      hideSleeping: true
    })
  })

  it('loads and saves through storage', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value)
    }
    saveBotsSidebarView({ sortBy: 'smart', hidePaused: true, hideSleeping: false }, storage)
    expect(values.get(BOTS_SIDEBAR_VIEW_KEY)).toBe(
      '{"sortBy":"smart","hidePaused":true,"hideSleeping":false}'
    )
    expect(loadBotsSidebarView(storage)).toEqual({
      sortBy: 'smart',
      hidePaused: true,
      hideSleeping: false
    })
  })

  it('keeps manual order and filters paused bots without losing that order', () => {
    const rows = [
      row({ key: 'a', kind: 'bot', name: 'Alpha' }),
      row({ key: 'b', kind: 'bot', name: 'Beta', paused: true }),
      row({ key: 'c', kind: 'group', name: 'Core' })
    ]
    expect(
      arrangeBotsRows(rows, { sortBy: 'manual', hidePaused: true, hideSleeping: false }).map((entry) => entry.key)
    ).toEqual(['a', 'c'])
  })

  it('orders agent activity by needs, working, unread, then recency', () => {
    const rows = [
      row({ key: 'quiet', kind: 'bot', name: 'Quiet' }),
      row({ key: 'needs', kind: 'group', name: 'Needs', needs: 2 }),
      row({ key: 'working', kind: 'bot', name: 'Working', working: true }),
      row({ key: 'unread', kind: 'bot', name: 'Unread', unread: 1 })
    ]
    expect(
      arrangeBotsRows(rows, { sortBy: 'smart', hidePaused: false, hideSleeping: false }).map((entry) => entry.key)
    ).toEqual(['needs', 'working', 'unread', 'quiet'])
  })

  it('hides sleeping bots but keeps groups and active bots', () => {
    const rows = [
      row({ key: 'sleep', kind: 'bot', name: 'Sleep', sleeping: true }),
      row({ key: 'group', kind: 'group', name: 'Group', sleeping: true }),
      row({ key: 'active', kind: 'bot', name: 'Active' })
    ]
    expect(
      arrangeBotsRows(rows, { sortBy: 'manual', hidePaused: false, hideSleeping: true }).map(
        (entry) => entry.key
      )
    ).toEqual(['group', 'active'])
  })

  it('orders recent activity first', () => {
    const rows = [
      row({ key: 'old', kind: 'bot', name: 'Old', activityAt: 10 }),
      row({ key: 'new', kind: 'group', name: 'New', activityAt: 30 }),
      row({ key: 'never', kind: 'bot', name: 'Never', activityAt: 0 })
    ]
    expect(
      arrangeBotsRows(rows, { sortBy: 'recent', hidePaused: false, hideSleeping: false }).map((entry) => entry.key)
    ).toEqual(['new', 'old', 'never'])
  })

  it('orders names case-insensitively', () => {
    const rows = [
      row({ key: 'b', kind: 'bot', name: 'beta' }),
      row({ key: 'a', kind: 'group', name: 'Alpha' })
    ]
    expect(
      arrangeBotsRows(rows, { sortBy: 'name', hidePaused: false, hideSleeping: false }).map((entry) => entry.key)
    ).toEqual(['a', 'b'])
  })

  it('counts active filters', () => {
    expect(countActiveBotsFilters({ sortBy: 'manual', hidePaused: false, hideSleeping: false })).toBe(0)
    expect(countActiveBotsFilters({ sortBy: 'name', hidePaused: true, hideSleeping: false })).toBe(1)
  })
})
