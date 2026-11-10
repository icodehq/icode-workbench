import { describe, expect, it } from 'vitest'
import type { HarnessDetectionResult } from './harness-detector'
import { createDetectionResultCache } from './detection-result-cache'

function detection(
  state: HarnessDetectionResult['state'],
  harness: HarnessDetectionResult['harness'] = 'claude'
): HarnessDetectionResult {
  return {
    state,
    harness,
    version: state === 'available' ? '1.2.3' : null,
    resolvedPath: state === 'available' ? '/usr/local/bin/claude' : null,
    diagnostics: {
      resolvedPath: state === 'available' ? '/usr/local/bin/claude' : null,
      outcome: state === 'available' ? 'exited' : 'spawn_error',
      exitCode: null,
      signal: null,
      stdoutTail: '',
      stderrTail: '',
      durationMs: 0,
      observedAt: 0,
      attempts: 1
    },
    command: null
  } as HarnessDetectionResult
}

describe('detection result cache', () => {
  it('returns an entry until the TTL expires', () => {
    let now = 0
    const cache = createDetectionResultCache({ ttlMs: 100, now: () => now })
    const available = detection('available')
    cache.set('key', available)
    expect(cache.get('key')).toBe(available)
    now = 99
    expect(cache.get('key')).toBe(available)
    now = 100
    expect(cache.get('key')).toBeNull()
  })

  it('never caches a detection failure', () => {
    const cache = createDetectionResultCache()
    cache.set('key', detection('detection_failed'))
    expect(cache.get('key')).toBeNull()
  })

  it('does not cache an unavailable answer forever', () => {
    let now = 0
    const cache = createDetectionResultCache({ ttlMs: 50, now: () => now })
    const unavailable = detection('unavailable')
    cache.set('key', unavailable)
    expect(cache.get('key')).toBe(unavailable)
    now = 50
    expect(cache.get('key')).toBeNull()
  })

  it('invalidates by prefix or entirely', () => {
    const cache = createDetectionResultCache()
    cache.set('a:1', detection('available'))
    cache.set('a:2', detection('available'))
    cache.set('b:1', detection('available'))
    cache.invalidate('a:')
    expect(cache.get('a:1')).toBeNull()
    expect(cache.get('a:2')).toBeNull()
    expect(cache.get('b:1')).not.toBeNull()
    cache.invalidate()
    expect(cache.get('b:1')).toBeNull()
  })
})
