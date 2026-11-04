import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GitStatusWatcherService,
  shouldIgnoreWatchPath,
  type WatchEvent,
  type WatchFactory,
  type WatchTarget
} from './status-watcher'

const target: WatchTarget = { worktreePath: '/repo', gitDir: '/repo/.git' }

function fakeFactory(): {
  factory: WatchFactory
  fire: (event: WatchEvent) => void
  fail: (error: unknown) => void
  closes: () => number
} {
  let onEvent: ((event: WatchEvent) => void) | null = null
  let onError: ((error: unknown) => void) | null = null
  let closes = 0
  return {
    factory: (_roots, options) => {
      onEvent = options.onEvent
      onError = options.onError
      return {
        close: async () => {
          closes += 1
        }
      }
    },
    fire: (event) => onEvent?.(event),
    fail: (error) => onError?.(error),
    closes: () => closes
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('shouldIgnoreWatchPath', () => {
  it('ignores dependency trees, .git internals and lock files', () => {
    expect(shouldIgnoreWatchPath('/repo/node_modules/pkg/index.js', target)).toBe(true)
    expect(shouldIgnoreWatchPath('/repo/.venv/lib/python.py', target)).toBe(true)
    expect(shouldIgnoreWatchPath('/repo/.git/index', target)).toBe(false)
    expect(shouldIgnoreWatchPath('/repo/.git/objects/ab/cdef', target)).toBe(true)
    expect(shouldIgnoreWatchPath('/repo/.git/logs/HEAD', target)).toBe(true)
    expect(shouldIgnoreWatchPath('/repo/.git/index.lock', target)).toBe(true)
    expect(shouldIgnoreWatchPath('/repo/.git/watchman-cookie', target)).toBe(true)
    expect(shouldIgnoreWatchPath('/repo/src/a.ts', target)).toBe(false)
    expect(shouldIgnoreWatchPath('/repo/.git/index', target)).toBe(false)
    expect(shouldIgnoreWatchPath('/repo/.git/MERGE_HEAD', target)).toBe(false)
    expect(shouldIgnoreWatchPath('/outside/a.ts', target)).toBe(false)
  })
})

describe('GitStatusWatcherService', () => {
  it('returns unsupported-target so the renderer can keep polling', async () => {
    const service = new GitStatusWatcherService({
      resolveTarget: async () => null,
      factory: fakeFactory().factory
    })
    await expect(service.setActive('s1', true)).resolves.toEqual({
      watching: false,
      reason: 'unsupported-target'
    })
  })

  it('coalesces a burst into one event and reports relative paths', async () => {
    vi.useFakeTimers()
    const fake = fakeFactory()
    const service = new GitStatusWatcherService({
      resolveTarget: async () => target,
      factory: fake.factory,
      debounceMs: 800
    })
    const events: unknown[] = []
    service.subscribe((event) => events.push(event))
    expect(await service.setActive('s1', true)).toEqual({ watching: true })

    fake.fire({ type: 'change', path: '/repo/src/a.ts' })
    fake.fire({ type: 'change', path: '/repo/src/b.ts' })
    vi.advanceTimersByTime(799)
    expect(events).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(events).toEqual([
      {
        sessionId: 's1',
        revision: 1,
        changedPaths: ['src/a.ts', 'src/b.ts'],
        overflow: false,
        metadataChanged: false
      }
    ])
  })

  it('marks Git-metadata changes without adding a worktree path', async () => {
    vi.useFakeTimers()
    const fake = fakeFactory()
    const service = new GitStatusWatcherService({
      resolveTarget: async () => target,
      factory: fake.factory
    })
    const events: Array<{ metadataChanged: boolean; changedPaths: string[] }> = []
    service.subscribe((event) => events.push(event))
    await service.setActive('s1', true)
    fake.fire({ type: 'change', path: '/repo/.git/index' })
    vi.advanceTimersByTime(800)
    expect(events[0]).toMatchObject({ metadataChanged: true, changedPaths: [] })
  })

  it('caps a large burst and sets overflow', async () => {
    vi.useFakeTimers()
    const fake = fakeFactory()
    const service = new GitStatusWatcherService({
      resolveTarget: async () => target,
      factory: fake.factory,
      maxPaths: 3
    })
    const events: Array<{ changedPaths: string[]; overflow: boolean }> = []
    service.subscribe((event) => events.push(event))
    await service.setActive('s1', true)
    for (let index = 0; index < 6; index += 1) {
      fake.fire({ type: 'change', path: `/repo/src/${String(index)}.ts` })
    }
    vi.advanceTimersByTime(800)
    expect(events).toHaveLength(1)
    expect(events[0]?.changedPaths).toHaveLength(3)
    expect(events[0]?.overflow).toBe(true)
  })

  it('stops the OS watcher when the panel becomes inactive', async () => {
    vi.useFakeTimers()
    const fake = fakeFactory()
    const service = new GitStatusWatcherService({
      resolveTarget: async () => target,
      factory: fake.factory
    })
    const events: unknown[] = []
    service.subscribe((event) => events.push(event))
    await service.setActive('s1', true)
    fake.fire({ type: 'change', path: '/repo/src/a.ts' })
    await service.setActive('s1', false)
    vi.advanceTimersByTime(2000)
    expect(events).toHaveLength(0)
    expect(fake.closes()).toBe(1)
  })

  it('reports a failed watcher so the renderer can fall back', async () => {
    vi.useFakeTimers()
    const fake = fakeFactory()
    const service = new GitStatusWatcherService({
      resolveTarget: async () => target,
      factory: fake.factory
    })
    const events: Array<{ failed?: boolean }> = []
    service.subscribe((event) => events.push(event))
    await service.setActive('s1', true)
    fake.fail(new Error('watch failed'))
    expect(events[0]?.failed).toBe(true)
    await vi.runAllTimersAsync()
    expect(service.activeSessions()).toEqual([])
  })
})
