import { describe, expect, it } from 'vitest'
import {
  WATCH_MAX_EVENTS_PER_FRAME,
  encodeWatchMessage,
  parseParentMessage,
  parseWatcherMessage
} from './watch-protocol'

describe('watch protocol', () => {
  it('round-trips a subscribe spec', () => {
    const raw = encodeWatchMessage({
      t: 'sub',
      rid: 7,
      sub: 'files:ses_x',
      spec: {
        kind: 'recursive',
        id: 'files:ses_x',
        roots: ['/wt'],
        worktreePath: '/wt',
        ignore: { skipDirectories: ['node_modules'], skipSuffixes: ['.swp'], stagingMarker: null }
      }
    })
    expect(parseParentMessage(raw)).toEqual({
      t: 'sub',
      rid: 7,
      sub: 'files:ses_x',
      spec: {
        kind: 'recursive',
        id: 'files:ses_x',
        roots: ['/wt'],
        worktreePath: '/wt',
        ignore: { skipDirectories: ['node_modules'], skipSuffixes: ['.swp'], stagingMarker: null }
      }
    })
  })

  it('round-trips events, acks, and errors', () => {
    expect(
      parseWatcherMessage(
        encodeWatchMessage({ t: 'ev', sub: 's', events: [['change', '/wt/a.ts']] })
      )
    ).toEqual({ t: 'ev', sub: 's', events: [['change', '/wt/a.ts']] })
    expect(parseWatcherMessage(encodeWatchMessage({ t: 'ok', rid: 2, bound: 3 }))).toEqual({
      t: 'ok',
      rid: 2,
      bound: 3
    })
    expect(
      parseWatcherMessage(encodeWatchMessage({ t: 'err', rid: 4, code: 'x', msg: 'nope' }))
    ).toEqual({ t: 'err', rid: 4, code: 'x', msg: 'nope' })
  })

  it('rejects malformed and over-cap frames', () => {
    expect(parseWatcherMessage('not json')).toBeNull()
    expect(parseWatcherMessage(JSON.stringify({ t: 'hello', v: 1 }))).toBeNull()
    expect(parseParentMessage(JSON.stringify({ t: 'sub', rid: 1, sub: 's' }))).toBeNull()
    expect(
      parseWatcherMessage(
        encodeWatchMessage({
          t: 'ev',
          sub: 's',
          events: Array.from(
            { length: WATCH_MAX_EVENTS_PER_FRAME + 1 },
            () => ['change', '/wt/a.ts'] as const
          )
        })
      )
    ).toBeNull()
  })
})
