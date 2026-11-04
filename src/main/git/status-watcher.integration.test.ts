import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitStatusWatcherService, type GitStatusChangeEvent } from './status-watcher'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
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
    cleanups.push(() => {
      void service.stopAll()
      rmSync(root, { recursive: true, force: true })
    })

    expect(await service.setActive('s1', true)).toEqual({ watching: true })
    await wait(500)
    writeFileSync(join(worktreePath, 'new-file.ts'), 'two\n')
    await wait(1500)
    expect(events.some((event) => event.changedPaths.includes('new-file.ts'))).toBe(true)
  })
})
