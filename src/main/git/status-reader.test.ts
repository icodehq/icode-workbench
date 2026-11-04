import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STATUS_LIMIT,
  PorcelainV2Parser,
  STATUS_V2_ARGS,
  parsePorcelainV2
} from './status-reader'

const record = (...parts: string[]): string => `${parts.join(' ')}\u0000`

function header(branch = 'main', oid = 'a'.repeat(40), upstream?: string, ab?: string): string {
  let value = record('# branch.oid', oid) + record('# branch.head', branch)
  if (upstream) value += record('# branch.upstream', upstream)
  if (ab) value += record('# branch.ab', ab)
  return value
}

describe('parsePorcelainV2', () => {
  it('reads branch, upstream and ahead/behind from one status call', () => {
    const status = parsePorcelainV2(
      header('main', '1'.repeat(40), 'origin/main', '+3 -2')
    )
    expect(status.branch).toBe('main')
    expect(status.headOid).toBe('1'.repeat(40))
    expect(status.upstream).toBe('origin/main')
    expect(status.ahead).toBe(3)
    expect(status.behind).toBe(2)
    expect(status.clean).toBe(true)
    expect(status.statusLength).toBe(0)
  })

  it('handles an unborn branch and a detached HEAD', () => {
    const unborn = parsePorcelainV2(record('# branch.oid', '(initial)') + record('# branch.head', 'main'))
    expect(unborn.headOid).toBeNull()
    expect(unborn.branch).toBe('main')

    const detached = parsePorcelainV2(record('# branch.oid', '2'.repeat(40)) + record('# branch.head', '(detached)'))
    expect(detached.branch).toBeNull()
    expect(detached.headOid).toBe('2'.repeat(40))
  })

  it('emits one entry per area for a partially staged path', () => {
    const status = parsePorcelainV2(
      header() +
        record(
          '1',
          'MM',
          'N...',
          '100644',
          '100644',
          '100644',
          'hH',
          'hI',
          'src/auth/session.ts'
        )
    )
    expect(status.staged).toHaveLength(1)
    expect(status.unstaged).toHaveLength(1)
    expect(status.staged[0]?.code).toBe('M ')
    expect(status.unstaged[0]?.code).toBe(' M')
    expect(status.staged[0]?.status).toBe('modified')
    expect(status.statusLength).toBe(1)
    expect(status.clean).toBe(false)
  })

  it('preserves spaces in a path and reads a rename origin', () => {
    const status = parsePorcelainV2(
      header() +
        record(
          '2',
          'RM',
          'N...',
          '100644',
          '100644',
          '100644',
          'hH',
          'hI',
          'R100',
          'new name .txt'
        ) +
        record('old name .txt')
    )
    expect(status.staged).toHaveLength(1)
    expect(status.unstaged).toHaveLength(1)
    expect(status.staged[0]).toMatchObject({
      path: 'new name .txt',
      oldPath: 'old name .txt',
      area: 'staged',
      status: 'renamed'
    })
    expect(status.unstaged[0]?.path).toBe('new name .txt')
  })

  it('reads untracked and unmerged records', () => {
    const status = parsePorcelainV2(
      header() +
        record('?', 'new file.ts') +
        record('u', 'UU', 'N...', '100644', '100644', '100644', '100644', 'h1', 'h2', 'h3', 'conflict.ts')
    )
    expect(status.untracked.map((entry) => entry.path)).toEqual(['new file.ts'])
    expect(status.conflicted).toHaveLength(1)
    expect(status.conflicted[0]).toMatchObject({ path: 'conflict.ts', area: 'conflicted', status: 'unmerged' })
  })

  it('parses records split across arbitrary chunks, including a rename boundary', () => {
    const first = header()
    const rename =
      record('2', 'R.', 'N...', '100644', '100644', '100644', 'hH', 'hI', 'R100', 'new.txt')
    const second = record('old.txt') + record('?', 'third.txt')
    const whole = first + rename + second
    for (const split of [1, 7, 80, Math.floor(whole.length / 2), whole.length - 1]) {
      const parser = new PorcelainV2Parser()
      parser.push(whole.slice(0, split))
      parser.push(whole.slice(split))
      const status = parser.finish()
      expect(status.staged[0]?.path).toBe('new.txt')
      expect(status.staged[0]?.oldPath).toBe('old.txt')
      expect(status.untracked[0]?.path).toBe('third.txt')
      expect(status.statusLength).toBe(2)
    }
  })

  it('does not split a multi-byte path across Buffer chunks', () => {
    const whole = Buffer.from(header() + record('?', '设计/文件.ts'))
    for (const split of [1, 2, 3, 5, 11, 17, whole.length - 1]) {
      const parser = new PorcelainV2Parser()
      parser.push(whole.subarray(0, split))
      parser.push(whole.subarray(split))
      expect(parser.finish().untracked[0]?.path).toBe('设计/文件.ts')
    }
  })

  it('stops at the configured limit and reports it truthfully', () => {
    const body =
      header() +
      record('?', 'a.ts') +
      record('?', 'b.ts') +
      record('?', 'c.ts') +
      record('?', 'd.ts') +
      record('?', 'e.ts')
    const stopped = parsePorcelainV2(body, { limit: 2 })
    expect(stopped.statusLength).toBe(2)
    expect(stopped.didHitLimit).toBe(true)
    expect(stopped.untracked.map((entry) => entry.path)).toEqual(['a.ts', 'b.ts'])

    const exact = parsePorcelainV2(body, { limit: 5 })
    expect(exact.statusLength).toBe(5)
    expect(exact.didHitLimit).toBe(false)
    expect(exact.untracked).toHaveLength(5)
  })

  it('reports false from push once the parser has stopped', () => {
    const parser = new PorcelainV2Parser({ limit: 1 })
    expect(parser.push(record('?', 'a.ts'))).toBe(true)
    expect(parser.push(record('?', 'b.ts'))).toBe(false)
    expect(parser.limitReached).toBe(true)
    expect(parser.finish().didHitLimit).toBe(true)
  })

  it('changes the revision when a path or code changes, not for a repeated read', () => {
    const first = parsePorcelainV2(header() + record('?', 'a.ts'))
    const repeated = parsePorcelainV2(header() + record('?', 'a.ts'))
    const changed = parsePorcelainV2(header() + record('?', 'b.ts'))
    expect(repeated.revision).toBe(first.revision)
    expect(changed.revision).not.toBe(first.revision)
  })

  it('exposes the v2 read arguments used by the reader', () => {
    expect(STATUS_V2_ARGS).toContain('--porcelain=v2')
    expect(STATUS_V2_ARGS).toContain('--untracked-files=all')
    expect(DEFAULT_STATUS_LIMIT).toBe(10_000)
  })
})
