import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SerializedWatchSpec } from '../../shared/watch-protocol'
import type {
  WatchClient,
  WatchEvent,
  WatchSubscribeResult,
  WatchSubscriptionHandlers
} from '../watch/watch-client'
import {
  GitStatusWatcherService,
  shouldIgnoreWatchPath,
  type WatchTarget
} from './status-watcher'

const target: WatchTarget = { worktreePath: '/repo', gitDir: '/repo/.git' }

function fakeClient(): {
  client: WatchClient
  specs: SerializedWatchSpec[]
  unsubscribed: string[]
  setSubscribeResult: (result: WatchSubscribeResult) => void
  fire: (sessionId: string, event: WatchEvent) => void
  overflow: (sessionId: string) => void
  ready: (sessionId: string) => void
  fail: (sessionId: string) => void
} {
  const handlers = new Map<string, WatchSubscriptionHandlers>()
  const specs: SerializedWatchSpec[] = []
  const unsubscribed: string[] = []
  let subscribeResult: WatchSubscribeResult = { ok: true, backend: 'chokidar' }
  return {
    client: {
      async subscribe(spec, next) {
        specs.push(spec)
        if (subscribeResult.ok) handlers.set(spec.id, next)
        return subscribeResult
      },
      async updateRoots() {
        return { ok: true, bound: 0, missing: [] }
      },
      async unsubscribe(id) {
        unsubscribed.push(id)
        handlers.delete(id)
      },
      stats: () => ({
        running: true,
        pid: 1,
        backend: 'chokidar',
        subscriptions: handlers.size,
        watches: 0,
        roots: 0,
        restarts: 0,
        fused: false
      })
    },
    specs,
    unsubscribed,
    setSubscribeResult: (result) => {
      subscribeResult = result
    },
    fire: (sessionId, event) => handlers.get(`git:${sessionId}`)?.onEvents([event]),
    overflow: (sessionId) => handlers.get(`git:${sessionId}`)?.onOverflow(),
    ready: (sessionId) => handlers.get(`git:${sessionId}`)?.onReady(),
    fail: (sessionId) => handlers.get(`git:${sessionId}`)?.onError(new Error('watch failed'))
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

  it('ignores generated directories below a package directory', () => {
    // `client/node_modules` is one level below the checkout root in a monorepo;
    // it must not be watched file by file.
    expect(shouldIgnoreWatchPath('/repo/client/node_modules/pkg/index.js', target)).toBe(true)
    expect(shouldIgnoreWatchPath('/repo/client/node_modules', target)).toBe(true)
    expect(shouldIgnoreWatchPath('/repo/packages/app/.next/cache/x', target)).toBe(true)
    expect(shouldIgnoreWatchPath('/repo/client/src/index.ts', target)).toBe(false)
  })
})

describe('GitStatusWatcherService', () => {
  it('returns unsupported-target so the renderer can keep polling', async () => {
    const fake = fakeClient()
    const service = new GitStatusWatcherService({
      resolveTarget: async () => null,
      client: fake.client
    })
    await expect(service.setActive('s1', true)).resolves.toEqual({
      watching: false,
      reason: 'unsupported-target'
    })
    expect(fake.specs).toHaveLength(0)
  })

  it('sends a recursive spec covering the worktree and Git directory', async () => {
    const fake = fakeClient()
    const service = new GitStatusWatcherService({
      resolveTarget: async () => target,
      client: fake.client
    })
    await service.setActive('s1', true)
    expect(fake.specs[0]).toMatchObject({
      kind: 'recursive',
      id: 'git:s1',
      roots: ['/repo', '/repo/.git'],
      worktreePath: '/repo',
      git: { worktreePath: '/repo', gitDir: '/repo/.git' }
    })
    expect(fake.specs[0]?.ignore.skipDirectories).toContain('node_modules')
  })

  it('coalesces a burst into one event and reports relative paths', async () => {
    vi.useFakeTimers()
    const fake = fakeClient()
    const service = new GitStatusWatcherService({
      resolveTarget: async () => target,
      client: fake.client,
      debounceMs: 800
    })
    const events: unknown[] = []
    service.subscribe((event) => events.push(event))
    expect(await service.setActive('s1', true)).toEqual({ watching: true })

    fake.fire('s1', { type: 'change', path: '/repo/src/a.ts' })
    fake.fire('s1', { type: 'change', path: '/repo/src/b.ts' })
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
    const fake = fakeClient()
    const service = new GitStatusWatcherService({
      resolveTarget: async () => target,
      client: fake.client
    })
    const events: Array<{ metadataChanged: boolean; changedPaths: string[] }> = []
    service.subscribe((event) => events.push(event))
    await service.setActive('s1', true)
    fake.fire('s1', { type: 'change', path: '/repo/.git/index' })
    vi.advanceTimersByTime(800)
    expect(events[0]).toMatchObject({ metadataChanged: true, changedPaths: [] })
  })

  it('treats a ready scan as one metadata read', async () => {
    vi.useFakeTimers()
    const fake = fakeClient()
    const service = new GitStatusWatcherService({
      resolveTarget: async () => target,
      client: fake.client
    })
    const events: Array<{ metadataChanged: boolean }> = []
    service.subscribe((event) => events.push(event))
    await service.setActive('s1', true)
    fake.ready('s1')
    vi.advanceTimersByTime(800)
    expect(events[0]).toMatchObject({ metadataChanged: true, changedPaths: [] })
  })

  it('caps a large burst and sets overflow', async () => {
    vi.useFakeTimers()
    const fake = fakeClient()
    const service = new GitStatusWatcherService({
      resolveTarget: async () => target,
      client: fake.client,
      maxPaths: 3
    })
    const events: Array<{ changedPaths: string[]; overflow: boolean }> = []
    service.subscribe((event) => events.push(event))
    await service.setActive('s1', true)
    for (let index = 0; index < 6; index += 1) {
      fake.fire('s1', { type: 'change', path: `/repo/src/${String(index)}.ts` })
    }
    vi.advanceTimersByTime(800)
    expect(events).toHaveLength(1)
    expect(events[0]?.changedPaths).toHaveLength(3)
    expect(events[0]?.overflow).toBe(true)
  })

  it('stops watching when the panel becomes inactive', async () => {
    vi.useFakeTimers()
    const fake = fakeClient()
    const service = new GitStatusWatcherService({
      resolveTarget: async () => target,
      client: fake.client
    })
    const events: unknown[] = []
    service.subscribe((event) => events.push(event))
    await service.setActive('s1', true)
    fake.fire('s1', { type: 'change', path: '/repo/src/a.ts' })
    await service.setActive('s1', false)
    vi.advanceTimersByTime(2000)
    expect(events).toHaveLength(0)
    expect(fake.unsubscribed).toEqual(['git:s1'])
  })

  it('keeps sessions in one checkout independent', async () => {
    vi.useFakeTimers()
    const fake = fakeClient()
    const service = new GitStatusWatcherService({
      resolveTarget: async () => target,
      client: fake.client,
      debounceMs: 800
    })
    const events: Array<{ sessionId: string; changedPaths: string[] }> = []
    service.subscribe((event) => events.push(event))

    await service.setActive('s1', true)
    await service.setActive('s2', true)
    expect(fake.specs.map((spec) => spec.id)).toEqual(['git:s1', 'git:s2'])

    fake.fire('s1', { type: 'change', path: '/repo/src/a.ts' })
    fake.fire('s2', { type: 'change', path: '/repo/src/b.ts' })
    vi.advanceTimersByTime(800)
    expect(events.map((event) => [event.sessionId, event.changedPaths])).toEqual([
      ['s1', ['src/a.ts']],
      ['s2', ['src/b.ts']]
    ])
  })

  it('reports a failed watcher so the renderer can fall back', async () => {
    vi.useFakeTimers()
    const fake = fakeClient()
    const service = new GitStatusWatcherService({
      resolveTarget: async () => target,
      client: fake.client
    })
    const events: Array<{ failed?: boolean }> = []
    service.subscribe((event) => events.push(event))
    await service.setActive('s1', true)
    fake.fail('s1')
    expect(events[0]?.failed).toBe(true)
    await vi.runAllTimersAsync()
    expect(service.activeSessions()).toEqual([])
  })

  it('reports watch-failed when the child refuses the subscription', async () => {
    const fake = fakeClient()
    fake.setSubscribeResult({ ok: false, reason: 'fused' })
    const service = new GitStatusWatcherService({
      resolveTarget: async () => target,
      client: fake.client
    })
    await expect(service.setActive('s1', true)).resolves.toEqual({
      watching: false,
      reason: 'watch-failed'
    })
  })
})
