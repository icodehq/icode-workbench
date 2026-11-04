import { describe, expect, it } from 'vitest'
import { autoFetchDelayMs } from './auto-fetch'

describe('auto-fetch pacing', () => {
  it('uses the configured interval and clamps it to 30–3600 seconds', () => {
    expect(autoFetchDelayMs(180, 0)).toBe(180_000)
    expect(autoFetchDelayMs(5, 0)).toBe(30_000)
    expect(autoFetchDelayMs(9999, 0)).toBe(3_600_000)
  })

  it('backs off by doubling up to eight times the interval', () => {
    expect(autoFetchDelayMs(30, 1)).toBe(60_000)
    expect(autoFetchDelayMs(30, 2)).toBe(120_000)
    expect(autoFetchDelayMs(30, 3)).toBe(240_000)
    expect(autoFetchDelayMs(30, 8)).toBe(240_000)
  })
})
