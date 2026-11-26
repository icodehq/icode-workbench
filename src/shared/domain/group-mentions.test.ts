import { describe, expect, it } from 'vitest'
import type { GroupNamedBot, GroupRoom } from './group'
import {
  GroupMentionError,
  groupAudience,
  groupDraftAudience,
  groupMentionSegments,
  groupMentions,
  groupReplyDraft,
  groupReplyMentions
} from './group-mentions'

const bots: GroupNamedBot[] = [
  { id: 'backend', name: 'Backend' },
  { id: 'reviewer', name: 'Reviewer' },
  { id: 'back', name: 'Back' }
]

const room = (replyMode: GroupRoom['replyMode'] = { kind: 'bot', botId: 'backend' }): GroupRoom => ({
  members: [{ botId: 'backend' }, { botId: 'reviewer' }, { botId: 'back' }],
  replyMode
})

describe('group mentions', () => {
  it('reads a member mention and prefers the longest name', () => {
    const mentions = groupMentions('@Backend please look', bots, [])
    expect(mentions).toEqual([
      expect.objectContaining({ match: 'member', ids: ['backend'], leading: true })
    ])
    expect(groupMentions('@Back look', bots, [])[0]).toMatchObject({
      match: 'member',
      ids: ['back']
    })
  })

  it('reads @everyone and ignores unknown non-leading mentions', () => {
    expect(groupMentions('@everyone take a look', bots, ['backend', 'reviewer'])[0]).toMatchObject({
      match: 'everyone',
      ids: ['backend', 'reviewer']
    })
    expect(groupMentions('ask @nobody later', bots, [])[0]).toMatchObject({ match: 'none' })
  })

  it('treats code, quotes and file references as data', () => {
    const text = [
      '```',
      '@Backend',
      '```',
      '`@Reviewer`',
      '> @Back',
      '"@Backend"',
      '@src/index.ts',
      'real @Reviewer'
    ].join('\n')
    expect(groupAudience(text, room({ kind: 'mentions' }), bots)).toEqual(['reviewer'])
  })
})

describe('group audience', () => {
  it('uses explicit mentions before the reply mode', () => {
    expect(groupAudience('@Reviewer check this', room({ kind: 'all' }), bots)).toEqual(['reviewer'])
    expect(groupAudience('hello', room({ kind: 'all' }), bots)).toEqual([
      'backend',
      'reviewer',
      'back'
    ])
    expect(groupAudience('hello', room({ kind: 'bot', botId: 'reviewer' }), bots)).toEqual([
      'reviewer'
    ])
    expect(groupAudience('hello', room({ kind: 'mentions' }), bots)).toEqual([])
  })

  it('rejects a leading unknown mention and a missing default replier', () => {
    expect(() => groupAudience('@Ghost hello', room(), bots)).toThrow(GroupMentionError)
    expect(() => groupAudience('hello', room({ kind: 'bot', botId: 'gone' }), bots)).toThrow(
      'GROUP_REPLIER_NOT_MEMBER'
    )
  })

  it('reads a draft and ignores a mention still being typed', () => {
    expect(groupDraftAudience('hello @Backen', room({ kind: 'mentions' }), bots)).toEqual({
      ids: [],
      addressed: false
    })
    expect(groupDraftAudience('hello @Back ', room({ kind: 'mentions' }), bots)).toEqual({
      ids: ['back'],
      addressed: true
    })
    expect(groupDraftAudience('@Ghost hi', room(), bots)).toBe('invalid')
  })
})

describe('reply hand-offs', () => {
  it('hands off only to named members, never the speaker or @everyone', () => {
    expect(
      groupReplyMentions(
        'Backend says: @Reviewer can you check? @everyone @Backend',
        room(),
        bots,
        'backend'
      )
    ).toEqual([{ id: 'reviewer', start: expect.any(Number) }])
  })

  it('ignores mentions inside code and quoted history', () => {
    const reply = '`@Reviewer`\n```\n@Back\n```\n<quoted_room_history>@Backend</quoted_room_history>'
    expect(groupReplyMentions(reply, room(), bots, 'backend')).toEqual([])
  })

  it('prefixes a reply to a member and leaves an unknown bot alone', () => {
    expect(groupReplyDraft('reviewer', 'thanks', room(), bots)).toBe('@Reviewer thanks')
    expect(groupReplyDraft('gone', 'thanks', room(), bots)).toBe('thanks')
  })
})

describe('mention segments', () => {
  it('marks only real mentions', () => {
    expect(groupMentionSegments('ask @Backend and @nobody', ['Backend'])).toEqual([
      { text: 'ask ', mention: false },
      { text: '@Backend', mention: true },
      { text: ' and @nobody', mention: false }
    ])
  })
})
