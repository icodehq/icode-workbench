import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'icode.terminalSize'

function storage(initial: Record<string, string> = {}): {
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

async function loadModule(): Promise<
  typeof import('./terminal-size')
> {
  vi.resetModules()
  return import('./terminal-size')
}

describe('terminal size memory', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('reads a valid persisted grid and rejects malformed values', async () => {
    const local = storage({ [STORAGE_KEY]: JSON.stringify({ cols: 132, rows: 43 }) })
    vi.stubGlobal('window', { localStorage: local, innerWidth: 1180 })
    const first = await loadModule()
    expect(first.readTerminalSize()).toEqual({ cols: 132, rows: 43 })

    local.values.set(STORAGE_KEY, JSON.stringify({ cols: 0, rows: 43 }))
    const second = await loadModule()
    expect(second.readTerminalSize()).toBeNull()
  })

  it('returns the last fitted grid immediately and persists it after the debounce', async () => {
    const local = storage()
    vi.stubGlobal('window', { localStorage: local, innerWidth: 1180 })
    const module = await loadModule()

    module.rememberTerminalSize({ cols: 120, rows: 40 })
    expect(module.readTerminalSize()).toEqual({ cols: 120, rows: 40 })
    expect(local.values.has(STORAGE_KEY)).toBe(false)

    vi.advanceTimersByTime(250)
    expect(JSON.parse(local.values.get(STORAGE_KEY) ?? 'null')).toEqual({
      cols: 120,
      rows: 40
    })
  })
})
