import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FilesChangedEvent } from '../../shared/domain/workspace-files'
import type { SerializedWatchSpec } from '../../shared/watch-protocol'
import type {
  WatchClient,
  WatchEvent,
  WatchSubscribeResult,
  WatchSubscriptionHandlers
} from '../watch/watch-client'
import {
  WorkspaceFilesWatcherService,
  shouldIgnoreFilesWatchPath
} from './workspace-files-watcher'

function fakeClient(): {
  client: WatchClient
  specs: SerializedWatchSpec[]
  unsubscribed: string[]
  rootUpdates: Array<{ id: string; roots: string[] }>
  setRootsResult: (result: { ok: true; bound: number; missing: string[] } | { ok: false; reason: string }) => void
  setSubscribeResult: (result: WatchSubscribeResult) => void
  emit: (sessionId: string, events: WatchEvent[]) => void
  overflow: (sessionId: string) => void
  ready: (sessionId: string) => void
  fail: (sessionId: string) => void
} {
  const handlers = new Map<string, WatchSubscriptionHandlers>()
  const specs: SerializedWatchSpec[] = []
  const unsubscribed: string[] = []
  const rootUpdates: Array<{ id: string; roots: string[] }> = []
  let subscribeResult: WatchSubscribeResult = { ok: true, backend: 'fswatch' }
  let rootsResult: { ok: true; bound: number; missing: string[] } | { ok: false; reason: string } = {
    ok: true,
    bound: 1,
    missing: []
  }
  return {
    client: {
      async subscribe(spec, next) {
        specs.push(spec)
        if (subscribeResult.ok) handlers.set(spec.id, next)
        return subscribeResult
      },
      async updateRoots(id, roots) {
        rootUpdates.push({ id, roots: [...roots] })
        return rootsResult
      },
      async unsubscribe(id) {
        unsubscribed.push(id)
        handlers.delete(id)
      },
      stats: () => ({
        running: true,
        pid: 1,
        backend: 'fswatch',
        subscriptions: handlers.size,
        watches: 0,
        roots: 0,
        restarts: 0,
        fused: false
      })
    },
    specs,
    unsubscribed,
    rootUpdates,
    setRootsResult: (result) => {
      rootsResult = result
    },
    setSubscribeResult: (result) => {
      subscribeResult = result
    },
    emit: (sessionId, events) => handlers.get(`files:${sessionId}`)?.onEvents(events),
    overflow: (sessionId) => handlers.get(`files:${sessionId}`)?.onOverflow(),
    ready: (sessionId) => handlers.get(`files:${sessionId}`)?.onReady(),
    fail: (sessionId) => handlers.get(`files:${sessionId}`)?.onError(new Error('watch failed'))
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('workspace files watcher', () => {
  it('ignores Git metadata, dependency folders and staging files', () => {
    expect(shouldIgnoreFilesWatchPath('/wt/node_modules/x.js', '/wt')).toBe(true)
    expect(shouldIgnoreFilesWatchPath('/wt/.git/index', '/wt')).toBe(true)
    expect(shouldIgnoreFilesWatchPath('/wt/src/a.ts.icode-write-12-1', '/wt')).toBe(true)
    expect(shouldIgnoreFilesWatchPath('/wt/src/a.swp', '/wt')).toBe(true)
    expect(shouldIgnoreFilesWatchPath('/wt/src/a.ts', '/wt')).toBe(false)
    // The walk asks about ancestors; those must not be ignored.
    expect(shouldIgnoreFilesWatchPath('/wt', '/wt')).toBe(false)
    expect(shouldIgnoreFilesWatchPath('/', '/wt')).toBe(false)
  })

  it('ignores dependency folders below a package directory', () => {
    // A monorepo keeps `client/node_modules` one level down. Ignoring only the
    // first segment watched every dependency file in the checkout.
    expect(shouldIgnoreFilesWatchPath('/wt/client/node_modules', '/wt')).toBe(true)
    expect(shouldIgnoreFilesWatchPath('/wt/client/node_modules/pkg/index.js', '/wt')).toBe(
      true
    )
    expect(shouldIgnoreFilesWatchPath('/wt/packages/app/dist/bundle.js', '/wt')).toBe(true)
    expect(shouldIgnoreFilesWatchPath('/wt/client/src/index.ts', '/wt')).toBe(false)
    expect(shouldIgnoreFilesWatchPath('/wt/client/src/node_modules.ts', '/wt')).toBe(false)
  })

  it('sends a shallow spec for the visible folders', async () => {
    const fake = fakeClient()
    const service = new WorkspaceFilesWatcherService({
      resolveTarget: async () => ({ worktreePath: '/wt' }),
      client: fake.client
    })
    await service.setActive('ses_x', true, ['src', 'docs'])

    expect(fake.specs).toHaveLength(1)
    expect(fake.specs[0]).toMatchObject({
      kind: 'shallow',
      id: 'files:ses_x',
      roots: ['/wt', '/wt/docs', '/wt/src'],
      worktreePath: '/wt',
      ignore: {
        skipSuffixes: ['.swp', '.tmp'],
        stagingMarker: '.icode-write-'
      }
    })
    expect(fake.specs[0]?.ignore.skipDirectories).toContain('node_modules')
  })

  it('updates roots in place and forces one reconcile', async () => {
    vi.useFakeTimers()
    const fake = fakeClient()
    const service = new WorkspaceFilesWatcherService({
      resolveTarget: async () => ({ worktreePath: '/wt' }),
      client: fake.client,
      debounceMs: 50
    })
    const events: FilesChangedEvent[] = []
    service.subscribe((event) => events.push(event))

    await service.setActive('ses_x', true, ['src'])
    await service.setActive('ses_x', true, ['src', 'docs'])
    expect(fake.specs).toHaveLength(1)
    expect(fake.rootUpdates).toEqual([
      { id: 'files:ses_x', roots: ['/wt', '/wt/docs', '/wt/src'] }
    ])
    await vi.advanceTimersByTimeAsync(60)
    expect(events.at(-1)).toMatchObject({ overflow: true, changedPaths: [] })
    await service.setActive('ses_x', true, ['src'])
    expect(fake.rootUpdates.at(-1)?.roots).toEqual(['/wt', '/wt/src'])
  })

  it('drops roots outside the checkout and generated folders', async () => {
    const fake = fakeClient()
    const service = new WorkspaceFilesWatcherService({
      resolveTarget: async () => ({ worktreePath: '/wt' }),
      client: fake.client
    })
    await service.setActive('ses_x', true, [
      '/etc',
      '..',
      'node_modules/pkg',
      'src',
      ''
    ])
    expect(fake.specs[0]?.roots).toEqual(['/wt', '/wt/src'])
  })

  it('reports watch-failed when a root update fails', async () => {
    const fake = fakeClient()
    const service = new WorkspaceFilesWatcherService({
      resolveTarget: async () => ({ worktreePath: '/wt' }),
      client: fake.client
    })
    await service.setActive('ses_x', true)
    fake.setRootsResult({ ok: false, reason: 'fused' })
    await expect(service.setActive('ses_x', true, ['src'])).resolves.toEqual({
      watching: false,
      reason: 'watch-failed'
    })
    expect(service.activeSessions()).toEqual([])
  })

  it('coalesces a burst and normalises relative paths', async () => {
    vi.useFakeTimers()
    const fake = fakeClient()
    const service = new WorkspaceFilesWatcherService({
      resolveTarget: async () => ({ worktreePath: '/wt' }),
      client: fake.client,
      debounceMs: 50
    })
    const events: FilesChangedEvent[] = []
    service.subscribe((event) => events.push(event))

    expect(await service.setActive('ses_x', true)).toEqual({ watching: true })
    fake.emit('ses_x', [
      { type: 'add', path: '/wt/src/a.ts' },
      { type: 'change', path: '/wt/src/a.ts' },
      { type: 'change', path: '/wt/node_modules/dep.js' },
      { type: 'change', path: '/wt/client/node_modules/dep.js' },
      { type: 'change', path: '/wt/.git/index' }
    ])
    await vi.advanceTimersByTimeAsync(60)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      sessionId: 'ses_x',
      revision: 1,
      changedPaths: ['src/a.ts'],
      overflow: false
    })
  })

  it('reports overflow instead of an unbounded path list', async () => {
    vi.useFakeTimers()
    const fake = fakeClient()
    const service = new WorkspaceFilesWatcherService({
      resolveTarget: async () => ({ worktreePath: '/wt' }),
      client: fake.client,
      debounceMs: 50,
      maxPaths: 2
    })
    const events: FilesChangedEvent[] = []
    service.subscribe((event) => events.push(event))

    await service.setActive('ses_x', true)
    fake.emit('ses_x', [
      { type: 'add', path: '/wt/a.ts' },
      { type: 'add', path: '/wt/b.ts' },
      { type: 'add', path: '/wt/c.ts' }
    ])
    await vi.advanceTimersByTimeAsync(60)

    expect(events[0]).toMatchObject({ overflow: true })
    expect(events[0]?.changedPaths).toEqual(['a.ts', 'b.ts'])
  })

  it('treats a ready scan as one reconcile', async () => {
    vi.useFakeTimers()
    const fake = fakeClient()
    const service = new WorkspaceFilesWatcherService({
      resolveTarget: async () => ({ worktreePath: '/wt' }),
      client: fake.client,
      debounceMs: 50
    })
    const events: FilesChangedEvent[] = []
    service.subscribe((event) => events.push(event))

    await service.setActive('ses_x', true)
    fake.ready('ses_x')
    await vi.advanceTimersByTimeAsync(60)
    expect(events[0]).toMatchObject({ overflow: true, changedPaths: [] })
  })

  it('reports a failed watch and stops it', async () => {
    vi.useFakeTimers()
    const fake = fakeClient()
    const service = new WorkspaceFilesWatcherService({
      resolveTarget: async () => ({ worktreePath: '/wt' }),
      client: fake.client,
      debounceMs: 50
    })
    const events: FilesChangedEvent[] = []
    service.subscribe((event) => events.push(event))

    await service.setActive('ses_x', true)
    fake.fail('ses_x')
    await vi.advanceTimersByTimeAsync(10)

    expect(events.at(-1)).toMatchObject({ sessionId: 'ses_x', failed: true })
    expect(service.activeSessions()).toEqual([])
    expect(fake.unsubscribed).toContain('files:ses_x')
  })

  it('keeps sessions in one checkout independent', async () => {
    vi.useFakeTimers()
    const fake = fakeClient()
    const service = new WorkspaceFilesWatcherService({
      resolveTarget: async () => ({ worktreePath: '/wt' }),
      client: fake.client,
      debounceMs: 50
    })
    const events: FilesChangedEvent[] = []
    service.subscribe((event) => events.push(event))

    await service.setActive('ses_a', true)
    await service.setActive('ses_b', true)
    expect(fake.specs.map((spec) => spec.id)).toEqual(['files:ses_a', 'files:ses_b'])

    fake.emit('ses_a', [{ type: 'change', path: '/wt/src/a.ts' }])
    fake.emit('ses_b', [{ type: 'change', path: '/wt/src/b.ts' }])
    await vi.advanceTimersByTimeAsync(60)
    expect(events.map((event) => [event.sessionId, event.changedPaths])).toEqual([
      ['ses_a', ['src/a.ts']],
      ['ses_b', ['src/b.ts']]
    ])
  })

  it('is truthful when the target cannot be watched', async () => {
    const fake = fakeClient()
    const service = new WorkspaceFilesWatcherService({
      resolveTarget: async () => null,
      client: fake.client
    })
    expect(await service.setActive('ses_x', true)).toEqual({
      watching: false,
      reason: 'unsupported-target'
    })
    expect(fake.specs).toHaveLength(0)
  })

  it('reports watch-failed when the child refuses the subscription', async () => {
    const fake = fakeClient()
    fake.setSubscribeResult({ ok: false, reason: 'fused' })
    const service = new WorkspaceFilesWatcherService({
      resolveTarget: async () => ({ worktreePath: '/wt' }),
      client: fake.client
    })
    expect(await service.setActive('ses_x', true)).toEqual({
      watching: false,
      reason: 'watch-failed'
    })
    expect(service.activeSessions()).toEqual([])
  })

  it('unsubscribes when Files is hidden', async () => {
    const fake = fakeClient()
    const service = new WorkspaceFilesWatcherService({
      resolveTarget: async () => ({ worktreePath: '/wt' }),
      client: fake.client
    })
    await service.setActive('ses_x', true)
    await service.setActive('ses_x', false)
    expect(fake.unsubscribed).toEqual(['files:ses_x'])
    expect(service.activeSessions()).toEqual([])
  })
})
