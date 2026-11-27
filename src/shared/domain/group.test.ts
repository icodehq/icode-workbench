import { describe, expect, it } from 'vitest'
import {
  BOT_GROUP_LIMITS,
  NEW_GROUP_THREAD_TITLE,
  groupLatestThread,
  groupThreadIsUntitled,
  groupThreadLabel,
  groupThreadTitleFromText
} from './group'

const thread = (overrides: {
  title: string
  isDefault: boolean
  latestAt: number | null
}) => overrides

describe('group thread titles', () => {
  it('uses the group name for the original room and the title for a thread', () => {
    expect(groupThreadLabel('Builders', { title: 'Builders', isDefault: true })).toBe('Builders')
    expect(groupThreadLabel('Builders', { title: 'Login revamp', isDefault: false })).toBe(
      'Login revamp'
    )
  })

  it('localizes an untitled thread without changing the stored title', () => {
    expect(
      groupThreadLabel('Builders', { title: NEW_GROUP_THREAD_TITLE, isDefault: false }, '新线程')
    ).toBe('新线程')
    expect(groupThreadIsUntitled({ title: NEW_GROUP_THREAD_TITLE, isDefault: false })).toBe(true)
    expect(groupThreadIsUntitled({ title: NEW_GROUP_THREAD_TITLE, isDefault: true })).toBe(false)
    expect(groupThreadIsUntitled({ title: 'Named', isDefault: false })).toBe(false)
  })

  it('names a thread from its first non-empty line, cut to the limit', () => {
    expect(groupThreadTitleFromText('\n  Login revamp  \nDetails')).toBe('Login revamp')
    expect(groupThreadTitleFromText('\n\n')).toBe(NEW_GROUP_THREAD_TITLE)
    const long = 'x'.repeat(BOT_GROUP_LIMITS.maxThreadTitleLength + 20)
    expect(groupThreadTitleFromText(long)).toHaveLength(BOT_GROUP_LIMITS.maxThreadTitleLength)
    expect(groupThreadTitleFromText(`  ${long}  `)).toHaveLength(
      BOT_GROUP_LIMITS.maxThreadTitleLength
    )
  })
})

describe('group latest thread', () => {
  it('picks the room with the newest line', () => {
    const threads = [
      thread({ title: 'Original', isDefault: true, latestAt: 10 }),
      thread({ title: 'Second', isDefault: false, latestAt: 30 }),
      thread({ title: 'Third', isDefault: false, latestAt: 20 })
    ]
    expect(groupLatestThread({ threads })?.title).toBe('Second')
  })

  it('prefers the original room on a tie and skips rooms with no line', () => {
    const threads = [
      thread({ title: 'Original', isDefault: true, latestAt: 30 }),
      thread({ title: 'Second', isDefault: false, latestAt: 30 }),
      thread({ title: 'Empty', isDefault: false, latestAt: null })
    ]
    expect(groupLatestThread({ threads })?.title).toBe('Original')
    expect(groupLatestThread({ threads: [threads[2]!] })).toBeNull()
    expect(groupLatestThread({ threads: [] })).toBeNull()
  })
})
