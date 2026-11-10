import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalWatchPath } from './watch-path'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

describe('canonicalWatchPath', () => {
  it('returns the native real path for an existing directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'icode-watch-path-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))

    // On Windows this expands an 8.3 short name; on macOS it resolves /var to
    // /private/var. Either way the watcher and its events share one spelling.
    expect(canonicalWatchPath(root)).toBe(realpathSync.native(root))
  })

  it('leaves a missing path untouched so the watcher can report it', () => {
    const missing = join(tmpdir(), `icode-missing-${process.pid}-${Date.now()}`)
    expect(canonicalWatchPath(missing)).toBe(missing)
  })
})
