import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SerializedWatchSpec } from '../shared/watch-protocol'
import type { BackendEmitter, BackendEvent } from './backends'
import { createShallowBackend } from './shallow-watch'

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

function spec(roots: string[], worktreePath: string): SerializedWatchSpec {
  return {
    kind: 'shallow',
    id: 'files:test',
    roots,
    worktreePath,
    ignore: {
      skipDirectories: ['node_modules', 'dist'],
      skipSuffixes: ['.swp', '.tmp'],
      stagingMarker: '.icode-write-'
    }
  }
}

function emitter(): BackendEmitter & {
  emitted: BackendEvent[]
  readies: number
  errors: unknown[]
  rootErrors: string[]
} {
  const record = {
    emitted: [] as BackendEvent[],
    readies: 0,
    errors: [] as unknown[],
    rootErrors: [] as string[],
    events: (next: readonly BackendEvent[]) => {
      record.emitted.push(...next)
    },
    overflow: () => undefined,
    ready: () => {
      record.readies += 1
    },
    error: (error: unknown) => {
      record.errors.push(error)
    },
    rootError: (root: string) => {
      record.rootErrors.push(root)
    }
  }
  return record
}

describe('shallow files backend', () => {
  it('watches only the roots it was given, and updates them in place', async () => {
    const root = mkdtempSync(join(tmpdir(), 'icode-shallow-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    mkdirSync(join(root, 'sub'), { recursive: true })

    const backend = createShallowBackend({ retryDelaysMs: [20], rebindIntervalMs: 5_000 })
    const watch = emitter()
    const subscription = await backend.subscribe(spec([root], root), watch)
    cleanups.push(() => subscription.close())
    await until(() => watch.readies === 1, 2_000)

    writeFileSync(join(root, 'root.txt'), 'a\n')
    await until(() => watch.emitted.some((event) => event.path.endsWith('root.txt')), 3_000)

    const before = watch.emitted.length
    writeFileSync(join(root, 'sub/deep.txt'), 'b\n')
    await wait(400)
    expect(watch.emitted.length).toBe(before)

    expect(await subscription.setRoots?.([root, join(root, 'sub')])).toMatchObject({
      bound: 2,
      missing: []
    })
    writeFileSync(join(root, 'sub/visible.txt'), 'c\n')
    await until(
      () => watch.emitted.some((event) => event.path.endsWith('sub/visible.txt')),
      3_000
    )
  })

  it('ignores generated names and shares a root between subscriptions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'icode-shallow-share-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    mkdirSync(join(root, 'node_modules'), { recursive: true })

    const backend = createShallowBackend({ retryDelaysMs: [20], rebindIntervalMs: 5_000 })
    const first = emitter()
    const second = emitter()
    const a = await backend.subscribe({ ...spec([root], root), id: 'files:a' }, first)
    const b = await backend.subscribe({ ...spec([root], root), id: 'files:b' }, second)
    cleanups.push(() => a.close(), () => b.close())
    await until(() => first.readies === 1 && second.readies === 1, 2_000)

    writeFileSync(join(root, 'node_modules/ignored.js'), 'x\n')
    writeFileSync(join(root, 'shared.txt'), 'y\n')
    await until(() => first.emitted.some((event) => event.path.endsWith('shared.txt')), 3_000)
    expect(second.emitted.some((event) => event.path.endsWith('shared.txt'))).toBe(true)
    expect(first.emitted.some((event) => event.path.includes('node_modules'))).toBe(false)
  })

  it('rebinds a directory that was deleted and recreated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'icode-shallow-rebind-'))
    const watched = join(root, 'watched')
    mkdirSync(watched)
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))

    const backend = createShallowBackend({ retryDelaysMs: [20], rebindIntervalMs: 100 })
    const watch = emitter()
    const subscription = await backend.subscribe(spec([watched], watched), watch)
    cleanups.push(() => subscription.close())
    await until(() => watch.readies === 1, 2_000)

    rmSync(watched, { recursive: true, force: true })
    await wait(150)
    mkdirSync(watched)
    await wait(300)
    writeFileSync(join(watched, 'after.txt'), 'z\n')
    await until(
      () => watch.emitted.some((event) => event.path.endsWith('after.txt')),
      4_000
    )
  })

  it('reports a root that never binds without killing the subscription', async () => {
    const root = mkdtempSync(join(tmpdir(), 'icode-shallow-missing-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const missing = join(root, 'missing')
    const backend = createShallowBackend({ retryDelaysMs: [20], rebindIntervalMs: 5_000 })
    const watch = emitter()
    const subscription = await backend.subscribe(spec([root, missing], root), watch)
    cleanups.push(() => subscription.close())

    await until(() => watch.rootErrors.includes(missing), 2_000)
    writeFileSync(join(root, 'still-works.txt'), 'ok\n')
    await until(
      () => watch.emitted.some((event) => event.path.endsWith('still-works.txt')),
      3_000
    )
  })
})
