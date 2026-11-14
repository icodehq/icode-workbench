import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FilesChangedEvent } from '../../shared/domain/workspace-files'
import {
  WorkspaceFilesWatcherService,
  shouldIgnoreFilesWatchPath,
  type FilesWatchEvent,
  type FilesWatchFactory
} from './workspace-files-watcher'

function controller() {
  let options:
    | {
        ignored: (path: string) => boolean
        onEvent: (event: FilesWatchEvent) => void
        onError: (error: unknown) => void
        onReady?: () => void
      }
    | null = null
  let closed = false
  const factory: FilesWatchFactory = (_roots, next) => {
    options = next
    return {
      close: async () => {
        closed = true
      }
    }
  }
  return {
    factory,
    emit: (event: FilesWatchEvent) => options?.onEvent(event),
    error: () => options?.onError(new Error('watch failed')),
    wasClosed: () => closed
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
    // Chokidar asks about ancestors while walking; those must not be ignored.
    expect(shouldIgnoreFilesWatchPath('/wt', '/wt')).toBe(false)
    expect(shouldIgnoreFilesWatchPath('/', '/wt')).toBe(false)
  })

  it('coalesces a burst and normalises relative paths', async () => {
    vi.useFakeTimers()
    const watch = controller()
    const service = new WorkspaceFilesWatcherService({
      resolveTarget: async () => ({ worktreePath: '/wt' }),
      factory: watch.factory,
      debounceMs: 50
    })
    const events: FilesChangedEvent[] = []
    service.subscribe((event) => events.push(event))

    expect(await service.setActive('ses_x', true)).toEqual({ watching: true })
    watch.emit({ type: 'add', path: '/wt/src/a.ts' })
    watch.emit({ type: 'change', path: '/wt/src/a.ts' })
    watch.emit({ type: 'change', path: '/wt/node_modules/dep.js' })
    watch.emit({ type: 'change', path: '/wt/.git/index' })
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
    const watch = controller()
    const service = new WorkspaceFilesWatcherService({
      resolveTarget: async () => ({ worktreePath: '/wt' }),
      factory: watch.factory,
      debounceMs: 50,
      maxPaths: 2
    })
    const events: FilesChangedEvent[] = []
    service.subscribe((event) => events.push(event))

    await service.setActive('ses_x', true)
    watch.emit({ type: 'add', path: '/wt/a.ts' })
    watch.emit({ type: 'add', path: '/wt/b.ts' })
    watch.emit({ type: 'add', path: '/wt/c.ts' })
    await vi.advanceTimersByTimeAsync(60)

    expect(events[0]).toMatchObject({ overflow: true })
    expect(events[0]?.changedPaths).toEqual(['a.ts', 'b.ts'])
  })

  it('reports a failed watch and stops it', async () => {
    vi.useFakeTimers()
    const watch = controller()
    const service = new WorkspaceFilesWatcherService({
      resolveTarget: async () => ({ worktreePath: '/wt' }),
      factory: watch.factory,
      debounceMs: 50
    })
    const events: FilesChangedEvent[] = []
    service.subscribe((event) => events.push(event))

    await service.setActive('ses_x', true)
    watch.error()
    await vi.advanceTimersByTimeAsync(10)

    expect(events.at(-1)).toMatchObject({ sessionId: 'ses_x', failed: true })
    expect(service.activeSessions()).toEqual([])
    expect(watch.wasClosed()).toBe(true)
  })

  it('shares one OS watch between sessions in the same checkout', async () => {
    vi.useFakeTimers()
    let watches = 0
    const callbacks: Array<(event: FilesWatchEvent) => void> = []
    const service = new WorkspaceFilesWatcherService({
      resolveTarget: async () => ({ worktreePath: '/wt' }),
      factory: (_roots, options) => {
        watches += 1
        callbacks.push(options.onEvent)
        return { close: async () => undefined }
      },
      debounceMs: 50
    })
    const events: FilesChangedEvent[] = []
    service.subscribe((event) => events.push(event))

    await service.setActive('ses_a', true)
    await service.setActive('ses_b', true)
    expect(watches).toBe(1)

    callbacks[0]?.({ type: 'change', path: '/wt/src/a.ts' })
    await vi.advanceTimersByTimeAsync(60)
    expect(events.map((event) => event.sessionId).sort()).toEqual(['ses_a', 'ses_b'])
    expect(events.map((event) => event.changedPaths)).toEqual([['src/a.ts'], ['src/a.ts']])
  })

  it('is truthful when the host cannot be watched', async () => {
    const service = new WorkspaceFilesWatcherService({
      resolveTarget: async () => null,
      factory: controller().factory
    })
    expect(await service.setActive('ses_x', true)).toEqual({
      watching: false,
      reason: 'unsupported-target'
    })
  })

  it('closes the OS watch when Files is hidden', async () => {
    const watch = controller()
    const service = new WorkspaceFilesWatcherService({
      resolveTarget: async () => ({ worktreePath: '/wt' }),
      factory: watch.factory
    })
    await service.setActive('ses_x', true)
    await service.setActive('ses_x', false)
    expect(watch.wasClosed()).toBe(true)
    expect(service.activeSessions()).toEqual([])
  })
})
