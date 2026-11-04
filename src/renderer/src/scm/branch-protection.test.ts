import { describe, expect, it } from 'vitest'
import { isBranchProtected } from './branch-protection'

describe('isBranchProtected', () => {
  it('matches exact and glob patterns', () => {
    expect(isBranchProtected('main', ['main'])).toBe(true)
    expect(isBranchProtected('release/1.2', ['release/*'])).toBe(true)
    expect(isBranchProtected('hotfix-42', ['hotfix-*'])).toBe(true)
    expect(isBranchProtected('feature/main', ['main'])).toBe(false)
    expect(isBranchProtected('feature/main', ['feature/*'])).toBe(true)
  })

  it('ignores empty patterns and detached or missing branches', () => {
    expect(isBranchProtected('main', ['', '   '])).toBe(false)
    expect(isBranchProtected(null, ['main'])).toBe(false)
    expect(isBranchProtected(undefined, ['main'])).toBe(false)
  })

  it('treats dots and regex characters literally', () => {
    expect(isBranchProtected('release.1', ['release.1'])).toBe(true)
    expect(isBranchProtected('releaseX1', ['release.1'])).toBe(false)
  })
})
