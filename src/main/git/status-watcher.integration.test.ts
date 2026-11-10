import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitStatusWatcherService, type GitStatusChangeEvent } from './status-watcher'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('GitStatusWatcherService with chokidar', () => {
  it('sees a file written through the host path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'icode-watch-'))
    const worktreePath = join(root, 'worktree')
    const gitDir = join(root, 'git')
    mkdirSync(worktreePath)
    mkdirSync(gitDir)
    writeFileSync(join(worktreePath, 'existing.ts'), 'one\n')
    const service = new GitStatusWatcherService({
      resolveTarget: async () => ({ worktreePath, gitDir }),
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
