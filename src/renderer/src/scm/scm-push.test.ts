import { describe, expect, it } from 'vitest'
import { parseUpstream, pushDefaults } from './scm-push'

describe('parseUpstream', () => {
  it('splits the remote and branch', () => {
    expect(parseUpstream('origin/main', ['origin'])).toEqual({
      remote: 'origin',
      branch: 'main'
    })
    expect(parseUpstream('upstream/release/1.0', ['origin', 'upstream'])).toEqual({
      remote: 'upstream',
      branch: 'release/1.0'
    })
  })

  it('matches remote names that contain slashes', () => {
    expect(parseUpstream('team/origin/main', ['origin', 'team/origin'])).toEqual({
      remote: 'team/origin',
      branch: 'main'
    })
  })

  it('rejects malformed values', () => {
    expect(parseUpstream(null, ['origin'])).toBeNull()
    expect(parseUpstream('', ['origin'])).toBeNull()
    expect(parseUpstream('main', ['origin'])).toBeNull()
    expect(parseUpstream('/main', ['origin'])).toBeNull()
    expect(parseUpstream('origin/', ['origin'])).toBeNull()
  })
})

describe('pushDefaults', () => {
  it('uses the configured upstream when it still exists', () => {
    expect(
      pushDefaults({
        upstream: 'origin/feature/x',
        localBranch: 'session/one',
        headOid: 'head',
        remotes: ['origin']
      })
    ).toEqual({ remote: 'origin', branch: 'feature/x', reason: '' })
  })

  it('falls back to origin and the local branch', () => {
    expect(
      pushDefaults({
        upstream: null,
        localBranch: 'session/one',
        headOid: 'head',
        remotes: ['upstream', 'origin']
      })
    ).toEqual({ remote: 'origin', branch: 'session/one', reason: '' })
  })

  it('uses the first remote when origin is absent', () => {
    expect(
      pushDefaults({
        upstream: 'gone/main',
        localBranch: 'session/one',
        headOid: 'head',
        remotes: ['upstream']
      })
    ).toEqual({ remote: 'upstream', branch: 'session/one', reason: '' })
  })

  it('reports loading, no remotes, detached and unborn states', () => {
    expect(
      pushDefaults({
        upstream: null,
        localBranch: 'session/one',
        headOid: 'head',
        remotes: null
      })
    ).toMatchObject({ reason: 'scm.push.loadingRemotes' })
    expect(
      pushDefaults({
        upstream: null,
        localBranch: 'session/one',
        headOid: 'head',
        remotes: []
      })
    ).toMatchObject({ reason: 'push.noRemotes' })
    expect(
      pushDefaults({
        upstream: null,
        localBranch: null,
        headOid: 'head',
        remotes: ['origin']
      })
    ).toMatchObject({ reason: 'scm.push.detached' })
    expect(
      pushDefaults({
        upstream: null,
        localBranch: 'session/one',
        headOid: null,
        remotes: ['origin']
      })
    ).toMatchObject({ reason: 'scm.push.unborn' })
  })
})
