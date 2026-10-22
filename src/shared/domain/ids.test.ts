import { describe, expect, it } from 'vitest'
import {
  assertDistinctSessionAndIncarnation,
  newRepoId,
  newSessionId,
  newWorkspaceId,
  parsePtyIncarnationId,
  parseRepoId,
  parseSessionId,
  parseWorkspaceId,
  toPtyIncarnationId,
  toSessionId
} from './ids'

describe('durable IDs', () => {
  it('generates the documented prefixes with UUID v4 bodies', () => {
    expect(newRepoId()).toMatch(/^repo_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(newWorkspaceId()).toMatch(/^ws_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(newSessionId()).toMatch(/^ses_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('generates unique values', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newSessionId()))
    expect(ids.size).toBe(50)
  })

  it('parses only the matching prefix', () => {
    const repo = newRepoId()
    const workspace = newWorkspaceId()
    const session = newSessionId()

    expect(parseRepoId(repo)).toBe(repo)
    expect(parseRepoId(workspace)).toBeNull()
    expect(parseWorkspaceId(workspace)).toBe(workspace)
    expect(parseSessionId(session)).toBe(session)
    expect(parseSessionId(repo)).toBeNull()
  })

  it('rejects malformed session identifiers', () => {
    expect(parseSessionId('ses_not-a-uuid')).toBeNull()
    expect(parseSessionId('repo_00000000-0000-4000-8000-000000000000')).toBeNull()
    expect(parseSessionId('')).toBeNull()
  })
})

describe('PTY incarnation IDs', () => {
  it('accepts the opaque format emitted by the Work 1 host', () => {
    expect(toPtyIncarnationId('56260a795d16b072')).toBe('56260a795d16b072')
    expect(parsePtyIncarnationId('inc_abc12345')).toBe('inc_abc12345')
  })

  it('rejects durable session IDs and malformed values', () => {
    expect(parsePtyIncarnationId(newSessionId())).toBeNull()
    expect(parsePtyIncarnationId(newRepoId())).toBeNull()
    expect(parsePtyIncarnationId(newWorkspaceId())).toBeNull()
    expect(parsePtyIncarnationId('short')).toBeNull()
    expect(parsePtyIncarnationId('has space here')).toBeNull()
    expect(parsePtyIncarnationId('x'.repeat(65))).toBeNull()
  })

  it('throws from the checked constructors on invalid input', () => {
    expect(() => toSessionId('nope')).toThrow('Invalid session ID')
    expect(() => toPtyIncarnationId('ses_00000000-0000-4000-8000-000000000000')).toThrow(
      'Invalid PTY incarnation ID'
    )
  })

  it('accepts a distinct durable/process pair', () => {
    expect(() =>
      assertDistinctSessionAndIncarnation(newSessionId(), toPtyIncarnationId('abcdef1234567890'))
    ).not.toThrow()
  })
})
