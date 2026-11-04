import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SCM_SETTINGS,
  SCM_SETTINGS_STORAGE_KEY,
  loadScmSettings,
  saveScmSettings,
  subscribeScmSettings,
  updateScmSettings,
  type ScmSettings
} from './scm-settings'

function memoryStorage(initial: Record<string, string> = {}): {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  values: Map<string, string>
} {
  const values = new Map(Object.entries(initial))
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SCM settings', () => {
  it('uses explicit defaults and preserves current product behaviour', () => {
    expect(DEFAULT_SCM_SETTINGS).toMatchObject({
      smartCommit: 'off',
      autoFetch: false,
      untrackedMode: 'separate',
      viewMode: 'list',
      sidebarWidth: 320,
      confirmForcePush: true,
      autoRefresh: true
    })
    expect(loadScmSettings(memoryStorage())).toEqual(DEFAULT_SCM_SETTINGS)
  })

  it('round-trips a partial object over the defaults and ignores unknown keys', () => {
    const storage = memoryStorage({
      [SCM_SETTINGS_STORAGE_KEY]: JSON.stringify({
        smartCommit: 'tracked',
        viewMode: 'tree',
        unknownSetting: true
      })
    })
    const loaded = loadScmSettings(storage)
    expect(loaded.smartCommit).toBe('tracked')
    expect(loaded.viewMode).toBe('tree')
    expect(loaded.autoFetch).toBe(false)
    expect(loaded).not.toHaveProperty('unknownSetting')
  })

  it('falls back safely on malformed JSON, invalid values or storage exceptions', () => {
    expect(
      loadScmSettings(memoryStorage({ [SCM_SETTINGS_STORAGE_KEY]: '{not json' }))
    ).toEqual(DEFAULT_SCM_SETTINGS)
    expect(
      loadScmSettings(
        memoryStorage({ [SCM_SETTINGS_STORAGE_KEY]: JSON.stringify({ smartCommit: 'sometimes' }) })
      )
    ).toEqual(DEFAULT_SCM_SETTINGS)
    expect(
      loadScmSettings({
        getItem: () => {
          throw new Error('denied')
        }
      })
    ).toEqual(DEFAULT_SCM_SETTINGS)
  })

  it('saves, notifies subscribers and returns false when storage fails', () => {
    const storage = memoryStorage()
    const listener = vi.fn()
    const unsubscribe = subscribeScmSettings(listener)
    const next = updateScmSettings(DEFAULT_SCM_SETTINGS, { autoFetch: true }, storage)
    expect(next.autoFetch).toBe(true)
    expect(JSON.parse(storage.values.get(SCM_SETTINGS_STORAGE_KEY)!)).toMatchObject({
      autoFetch: true
    })
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ autoFetch: true }))
    unsubscribe()
    saveScmSettings(next, storage)
    expect(listener).toHaveBeenCalledTimes(1)

    expect(
      saveScmSettings(next, {
        setItem: () => {
          throw new Error('quota')
        }
      })
    ).toBe(false)
  })

  it('re-validates an update rather than trusting a caller patch', () => {
    const current: ScmSettings = { ...DEFAULT_SCM_SETTINGS }
    expect(() =>
      updateScmSettings(current, { statusLimit: 5 }, memoryStorage())
    ).toThrow()
  })
})
