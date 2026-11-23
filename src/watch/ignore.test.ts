import { describe, expect, it } from 'vitest'
import type { SerializedWatchSpec } from '../shared/watch-protocol'
import { ignoreSpecPath, parcelIgnoreRegexesForRoot } from './ignore'

const filesSpec: SerializedWatchSpec = {
  kind: 'shallow',
  id: 'files:s',
  roots: ['/wt'],
  worktreePath: '/wt',
  ignore: {
    skipDirectories: ['node_modules', 'dist'],
    skipSuffixes: ['.swp', '.tmp'],
    stagingMarker: '.icode-write-'
  }
}

const gitSpec: SerializedWatchSpec = {
  ...filesSpec,
  kind: 'recursive',
  id: 'git:s',
  roots: ['/repo', '/repo/.git'],
  worktreePath: '/repo',
  git: { worktreePath: '/repo', gitDir: '/repo/.git' }
}

describe('watcher ignore rules', () => {
  it('matches generated directories at any depth', () => {
    expect(ignoreSpecPath(filesSpec, '/wt/client/node_modules/pkg/index.js')).toBe(true)
    expect(ignoreSpecPath(filesSpec, '/wt/client/src/index.ts')).toBe(false)
    expect(ignoreSpecPath(filesSpec, '/wt/src/a.ts.icode-write-1')).toBe(true)
  })

  it('keeps Git metadata visible while dropping object churn', () => {
    expect(ignoreSpecPath(gitSpec, '/repo/.git/index')).toBe(false)
    expect(ignoreSpecPath(gitSpec, '/repo/.git/objects/ab/cdef')).toBe(true)
    expect(ignoreSpecPath(gitSpec, '/repo/client/node_modules/x.js')).toBe(true)
  })

  it('generates native regexes that prune generated dirs at any depth', () => {
    const patterns = parcelIgnoreRegexesForRoot(filesSpec, '/wt').map(
      (pattern) => new RegExp(pattern)
    )
    expect(patterns.some((pattern) => pattern.test('/wt/client/node_modules/x.js'))).toBe(true)
    expect(patterns.some((pattern) => pattern.test('/wt/node_modules'))).toBe(true)
    expect(patterns.some((pattern) => pattern.test('/wt/client/src/index.ts'))).toBe(false)
    expect(patterns.some((pattern) => pattern.test('/wt/src/a.swp'))).toBe(true)
    expect(patterns.some((pattern) => pattern.test('/wt/src/a.ts.icode-write-1'))).toBe(true)
  })

  it('uses Git-directory-specific rules for the git dir root', () => {
    const patterns = parcelIgnoreRegexesForRoot(gitSpec, '/repo/.git').map(
      (pattern) => new RegExp(pattern)
    )
    expect(patterns.some((pattern) => pattern.test('/repo/.git/objects/ab/cdef'))).toBe(true)
    expect(patterns.some((pattern) => pattern.test('/repo/.git/logs/HEAD'))).toBe(true)
    expect(patterns.some((pattern) => pattern.test('/repo/.git/index.lock'))).toBe(true)
    expect(patterns.some((pattern) => pattern.test('/repo/.git/index'))).toBe(false)
  })
})
