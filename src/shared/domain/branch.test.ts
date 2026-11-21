import { describe, expect, it } from 'vitest'
import {
  isRemoteHeadRef,
  isValidBranchName,
  isValidStartRef,
  parseRemoteTrackingRef,
  startRefCandidates
} from './branch'

describe('isValidStartRef', () => {
  it('accepts bare, local and remote-tracking refs', () => {
    expect(isValidStartRef('feature/base')).toBe(true)
    expect(isValidStartRef('refs/heads/feature/base')).toBe(true)
    expect(isValidStartRef('refs/remotes/origin/feature/base')).toBe(true)
  })

  it('allows full refs longer than a branch name', () => {
    expect(isValidStartRef('a'.repeat(255))).toBe(true)
    expect(isValidStartRef('a'.repeat(1024))).toBe(true)
    expect(isValidStartRef('a'.repeat(1025))).toBe(false)
  })

  it('refuses other ref namespaces and invalid syntax', () => {
    expect(isValidStartRef('refs/tags/v1')).toBe(false)
    expect(isValidStartRef('refs/heads/')).toBe(false)
    expect(isValidStartRef('refs/remotes/')).toBe(false)
    expect(isValidStartRef('a..b')).toBe(false)
    expect(isValidStartRef('-x')).toBe(false)
    expect(isValidStartRef('has space')).toBe(false)
    expect(isValidStartRef('')).toBe(false)
  })
})

describe('isValidBranchName', () => {
  it('keeps the branch-name length cap and slash support', () => {
    expect(isValidBranchName('origin/foo')).toBe(true)
    expect(isValidBranchName('a'.repeat(255))).toBe(true)
    expect(isValidBranchName('a'.repeat(256))).toBe(false)
  })
})

describe('parseRemoteTrackingRef', () => {
  it('uses the longest configured remote name', () => {
    expect(
      parseRemoteTrackingRef('refs/remotes/team/origin/foo', ['origin', 'team/origin'])
    ).toEqual({
      remote: 'team/origin',
      branch: 'foo',
      fullRef: 'refs/remotes/team/origin/foo'
    })
    expect(parseRemoteTrackingRef('refs/remotes/origin/foo', ['origin'])).toEqual({
      remote: 'origin',
      branch: 'foo',
      fullRef: 'refs/remotes/origin/foo'
    })
  })

  it('returns null for unconfigured remotes, local refs and remote HEAD', () => {
    expect(parseRemoteTrackingRef('refs/remotes/fork/foo', ['origin'])).toBeNull()
    expect(parseRemoteTrackingRef('refs/heads/foo', ['origin'])).toBeNull()
    expect(parseRemoteTrackingRef('refs/remotes/origin/HEAD', ['origin'])).toBeNull()
    expect(parseRemoteTrackingRef('refs/remotes/origin/feature/HEAD', ['origin'])).toEqual({
      remote: 'origin',
      branch: 'feature/HEAD',
      fullRef: 'refs/remotes/origin/feature/HEAD'
    })
  })
})

describe('isRemoteHeadRef', () => {
  it('excludes only the direct remote HEAD slot', () => {
    expect(isRemoteHeadRef('refs/remotes/origin/HEAD', ['origin'])).toBe(true)
    expect(isRemoteHeadRef('refs/remotes/origin/feature/HEAD', ['origin'])).toBe(false)
    expect(isRemoteHeadRef('refs/remotes/team/origin/HEAD', ['team/origin'])).toBe(true)
  })

  it('recognizes a stale two-component HEAD ref from a removed remote', () => {
    expect(isRemoteHeadRef('refs/remotes/fork/HEAD', [])).toBe(true)
    expect(isRemoteHeadRef('refs/remotes/fork/feature/HEAD', [])).toBe(false)
  })
})

describe('startRefCandidates', () => {
  it('probes bare names locally first, then remotely', () => {
    expect(startRefCandidates('origin/feature', ['origin'])).toEqual([
      { ref: 'refs/heads/origin/feature', remoteTracking: null },
      {
        ref: 'refs/remotes/origin/feature',
        remoteTracking: {
          remote: 'origin',
          branch: 'feature',
          fullRef: 'refs/remotes/origin/feature'
        }
      }
    ])
  })

  it('uses exactly one candidate for explicit refs', () => {
    expect(startRefCandidates('refs/heads/feature', ['origin'])).toEqual([
      { ref: 'refs/heads/feature', remoteTracking: null }
    ])
    expect(startRefCandidates('refs/remotes/origin/feature', ['origin'])).toEqual([
      {
        ref: 'refs/remotes/origin/feature',
        remoteTracking: {
          remote: 'origin',
          branch: 'feature',
          fullRef: 'refs/remotes/origin/feature'
        }
      }
    ])
  })

  it('does not invent a remote candidate for a plain branch name', () => {
    expect(startRefCandidates('feature', ['origin'])).toEqual([
      { ref: 'refs/heads/feature', remoteTracking: null }
    ])
  })

  it('refuses tags and symbolic remote HEAD', () => {
    expect(startRefCandidates('refs/tags/v1', ['origin'])).toEqual([])
    expect(startRefCandidates('refs/remotes/origin/HEAD', ['origin'])).toEqual([])
  })
})
