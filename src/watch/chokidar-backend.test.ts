import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SerializedWatchSpec } from '../shared/watch-protocol'
import type { BackendEvent } from './backends'
import { createChokidarBackend } from './chokidar-backend'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function until(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await wait(25)
  }
  throw new Error('condition was not met before the deadline')
}

describe('chokidar backend', () => {
  it('prunes nested generated directories at any depth', async () => {
    const root = mkdtempSync(join(tmpdir(), 'icode-watch-backend-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    mkdirSync(join(root, 'packages/app/src'), { recursive: true })
    mkdirSync(join(root, 'packages/app/node_modules/dep'), { recursive: true })
    mkdirSync(join(root, 'packages/app/dist'), { recursive: true })
    writeFileSync(join(root, 'packages/app/src/existing.ts'), 'one\n')

    const spec: SerializedWatchSpec = {
      kind: 'recursive',
      id: 'files:test',
      roots: [root],
      worktreePath: root,
      ignore: {
        skipDirectories: ['node_modules', 'dist'],
        skipSuffixes: ['.swp', '.tmp'],
        stagingMarker: '.icode-write-'
      }
    }

    const backend = createChokidarBackend()
    const events: BackendEvent[] = []
    let ready = false
    const subscription = await backend.subscribe(spec, {
      events: (next) => events.push(...next),
      overflow: () => undefined,
      ready: () => {
        ready = true
      },
      error: () => undefined
    })
    cleanups.push(() => subscription.close())
    await until(() => ready, 5_000)

    writeFileSync(join(root, 'packages/app/src/a.ts'), 'a\n')
    writeFileSync(join(root, 'packages/app/node_modules/dep/x.js'), 'x\n')
    writeFileSync(join(root, 'packages/app/dist/out.js'), 'o\n')
    await until(
      () =>
        events.some((event) => event.path.replace(/\\/gu, '/').endsWith('src/a.ts')),
      8_000
    )
    await wait(300)

    const paths = events.map((event) => event.path.replace(/\\/gu, '/'))
    expect(paths.some((path) => path.endsWith('packages/app/src/a.ts'))).toBe(true)
    expect(paths.some((path) => path.includes('/node_modules/'))).toBe(false)
    expect(paths.some((path) => path.includes('/dist/'))).toBe(false)
  }, 20_000)
})
