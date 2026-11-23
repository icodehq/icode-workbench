import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SerializedWatchSpec } from '../shared/watch-protocol'
import { canonicalWatchSpec } from './canonical'
import { ignoreSpecPath } from './ignore'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function filesSpec(worktreePath: string): SerializedWatchSpec {
  return {
    kind: 'recursive',
    id: 'files:test',
    roots: [worktreePath],
    worktreePath,
    ignore: {
      skipDirectories: ['node_modules'],
      skipSuffixes: [],
      stagingMarker: null
    }
  }
}

describe('canonicalWatchSpec', () => {
  it('evaluates ignores against the spelling the OS reports', () => {
    const base = mkdtempSync(join(tmpdir(), 'icode-watch-canonical-'))
    cleanups.push(() => rmSync(base, { recursive: true, force: true }))
    const root = join(base, 'repo')
    mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true })
    mkdirSync(join(root, '.git'))

    const alias = join(base, 'alias')
    try {
      symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      // A locked-down Windows runner may refuse the link. The spelling check
      // below still exercises whatever the platform's realpath produced.
      return
    }

    const canonicalRoot = realpathSync.native(root)
    const eventPath = join(canonicalRoot, 'node_modules', 'dep', 'x.js')
    // The non-canonical spelling cannot see that the event is inside the checkout.
    expect(ignoreSpecPath(filesSpec(alias), eventPath)).toBe(false)

    const canonical = canonicalWatchSpec(filesSpec(alias))
    expect(canonical.worktreePath).toBe(canonicalRoot)
    expect(canonical.roots).toEqual([canonicalRoot])
    expect(ignoreSpecPath(canonical, eventPath)).toBe(true)

    const gitSpec: SerializedWatchSpec = {
      ...filesSpec(alias),
      git: { worktreePath: alias, gitDir: join(alias, '.git') }
    }
    expect(canonicalWatchSpec(gitSpec).git).toEqual({
      worktreePath: canonicalRoot,
      gitDir: join(canonicalRoot, '.git')
    })
  })
})
