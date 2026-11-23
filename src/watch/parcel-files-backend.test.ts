import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SerializedWatchSpec } from '../shared/watch-protocol'
import type { BackendEvent } from './backends'
import { createParcelBackend } from './parcel-backend'
import { createParcelFilesBackend } from './parcel-files-backend'

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

describe('macOS files backend', () => {
  it('forwards only direct children of visible roots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'icode-parcel-files-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    mkdirSync(join(root, 'visible'), { recursive: true })
    mkdirSync(join(root, 'collapsed/deep'), { recursive: true })

    const spec: SerializedWatchSpec = {
      kind: 'shallow',
      id: 'files:test',
      roots: [root, join(root, 'visible')],
      worktreePath: root,
      ignore: {
        skipDirectories: ['node_modules', 'dist'],
        skipSuffixes: ['.swp', '.tmp'],
        stagingMarker: '.icode-write-'
      }
    }

    const backend = createParcelFilesBackend(createParcelBackend())
    const events: BackendEvent[] = []
    let ready = false
    const subscription = await backend.subscribe(spec, {
      events: (next) => events.push(...next),
      overflow: () => undefined,
      ready: () => {
        ready = true
      },
      error: (error) => {
        throw error
      }
    })
    cleanups.push(() => subscription.close())
    await until(() => ready, 5_000)

    writeFileSync(join(root, 'root.txt'), 'a\n')
    writeFileSync(join(root, 'visible', 'shown.txt'), 'b\n')
    writeFileSync(join(root, 'collapsed', 'hidden.txt'), 'c\n')
    writeFileSync(join(root, 'collapsed/deep', 'hidden2.txt'), 'd\n')

    await until(() => events.some((event) => event.path.endsWith('shown.txt')), 8_000)
    await wait(400)
    const paths = events.map((event) => event.path.replace(/\\/gu, '/'))
    expect(paths.some((path) => path.endsWith('/root.txt'))).toBe(true)
    expect(paths.some((path) => path.endsWith('visible/shown.txt'))).toBe(true)
    // FSEvents may also report the direct child directory itself. That is a
    // visible entry and may be forwarded; what must never leak is a path
    // *inside* the collapsed directory.
    expect(paths.some((path) => path.includes('collapsed/'))).toBe(false)

    // Collapsing the folder stops its events; the physical watch stays.
    expect(await subscription.setRoots?.([root])).toMatchObject({ bound: 1 })
    const before = events.length
    writeFileSync(join(root, 'visible', 'after-collapse.txt'), 'e\n')
    await wait(500)
    expect(events.slice(before).some((event) => event.path.includes('visible/'))).toBe(false)
  }, 20_000)
})
