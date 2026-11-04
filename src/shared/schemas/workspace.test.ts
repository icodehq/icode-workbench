import { describe, expect, it } from 'vitest'
import { newSessionId } from '../domain/ids'
import {
  gitDiscardPathsInputSchema,
  gitSetPathsStagedInputSchema
} from './workspace'

const sessionId = newSessionId()
const target = { path: 'src/auth/session.ts', area: 'unstaged' as const }

describe('batch Git inputs', () => {
  it('accepts a selection with area, old path and status', () => {
    expect(
      gitSetPathsStagedInputSchema.safeParse({
        sessionId,
        staged: true,
        targets: [
          target,
          {
            path: 'src/auth/new.ts',
            area: 'unstaged',
            oldPath: 'src/auth/old.ts',
            status: 'renamed'
          },
          { path: 'docs/new.md', area: 'untracked', status: 'untracked' }
        ]
      }).success
    ).toBe(true)
  })

  it('rejects an empty selection, an unknown area and an unknown field', () => {
    expect(
      gitSetPathsStagedInputSchema.safeParse({ sessionId, staged: true, targets: [] }).success
    ).toBe(false)
    expect(
      gitSetPathsStagedInputSchema.safeParse({
        sessionId,
        staged: true,
        targets: [{ path: 'a.ts', area: 'index' }]
      }).success
    ).toBe(false)
    expect(
      gitSetPathsStagedInputSchema.safeParse({
        sessionId,
        staged: true,
        targets: [{ ...target, extra: true }]
      }).success
    ).toBe(false)
  })

  it('bounds the path length at the schema and leaves containment to main', () => {
    expect(
      gitSetPathsStagedInputSchema.safeParse({
        sessionId,
        staged: true,
        targets: [{ path: 'a'.repeat(4097), area: 'unstaged' }]
      }).success
    ).toBe(false)
  })

  it('accepts an optional expected revision on discard and bounds its length', () => {
    expect(
      gitDiscardPathsInputSchema.safeParse({
        sessionId,
        targets: [target],
        expectedRevision: '0123456789abcdef'
      }).success
    ).toBe(true)
    expect(
      gitDiscardPathsInputSchema.safeParse({ sessionId, targets: [target] }).success
    ).toBe(true)
    expect(
      gitDiscardPathsInputSchema.safeParse({
        sessionId,
        targets: [target],
        expectedRevision: 'x'.repeat(65)
      }).success
    ).toBe(false)
  })
})
