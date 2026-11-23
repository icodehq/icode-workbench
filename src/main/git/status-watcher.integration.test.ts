import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { BackendSubscription } from '../../watch/backends'
import { createChokidarBackend } from '../../watch/chokidar-backend'
import type { WatchClient } from '../watch/watch-client'
import { GitStatusWatcherService, type GitStatusChangeEvent } from './status-watcher'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A `WatchClient` over the real child backend, without spawning the child.
 *
 * This keeps a genuine filesystem test in the unit suite while the child
 * protocol itself is covered by the supervisor tests. The main process never
 * loads chokidar in production; the import is test-only.
 */
function realBackendClient(): WatchClient {
  const backend = createChokidarBackend()
  const subscriptions = new Map<string, BackendSubscription>()
  return {
    async subscribe(spec, handlers) {
      const subscription = await backend.subscribe(spec, {
        events: (events) => handlers.onEvents(events),
        overflow: () => handlers.onOverflow(),
        ready: () => handlers.onReady(),
        error: (error) =>
          handlers.onError(error instanceof Error ? error : new Error(String(error)))
      })
      subscriptions.set(spec.id, subscription)
      return { ok: true, backend: backend.name }
    },
    async updateRoots(id, roots) {
      const subscription = subscriptions.get(id)
      if (subscription?.setRoots === undefined) return { ok: false, reason: 'unsupported' }
      const result = await subscription.setRoots(roots)
      return { ok: true, bound: result.bound, missing: result.missing }
    },
    async unsubscribe(id) {
      const subscription = subscriptions.get(id)
      subscriptions.delete(id)
      await subscription?.close()
    },
    stats: () => ({
      running: true,
      pid: 1,
      backend: backend.name,
      subscriptions: subscriptions.size,
      watches: 0,
      roots: 0,
      restarts: 0,
      fused: false
    })
  }
}

describe('GitStatusWatcherService with the chokidar backend', () => {
  it('sees a file written through the host path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'icode-watch-'))
    const worktreePath = join(root, 'worktree')
    const gitDir = join(root, 'git')
    mkdirSync(worktreePath)
    mkdirSync(gitDir)
    writeFileSync(join(worktreePath, 'existing.ts'), 'one\n')
    const service = new GitStatusWatcherService({
      resolveTarget: async () => ({ worktreePath, gitDir }),
      client: realBackendClient(),
      debounceMs: 100
    })
    const events: GitStatusChangeEvent[] = []
    service.subscribe((event) => events.push(event))
    cleanups.push(async () => {
      // Close the native watchers before removing their roots. Deleting a
      // watched directory first can leave libuv processing events for a path
      // that no longer exists, the suspected source of the Windows worker abort
      // (0xC0000409) that surfaced while the next test file was starting.
      await service.stopAll()
      rmSync(root, { recursive: true, force: true })
    })

    expect(await service.setActive('s1', true)).toEqual({ watching: true })
    await wait(500)
    writeFileSync(join(worktreePath, 'new-file.ts'), 'two\n')
    await wait(1500)
    expect(events.some((event) => event.changedPaths.includes('new-file.ts'))).toBe(true)
  })
})
