import { describe, expect, it } from 'vitest'
import { wakeDescription, wakePlan } from './session-sleep'

describe('session sleep wake plan', () => {
  it('resumes Claude by id when a hook token exists, otherwise by continue', () => {
    expect(wakePlan('claude', 'abc-123')).toEqual({
      args: ['--resume', 'abc-123'],
      resumesConversation: true
    })
    expect(wakePlan('claude', null)).toEqual({
      args: ['--continue'],
      resumesConversation: true
    })
  })

  it('uses each agent CLI resume form and keeps the worktree scope', () => {
    expect(wakePlan('codex', null)).toEqual({
      args: ['resume', '--last'],
      resumesConversation: true
    })
    expect(wakePlan('opencode', null)).toEqual({
      args: ['--continue'],
      resumesConversation: true
    })
  })

  it('does not claim a shell process can be resumed', () => {
    expect(wakePlan('shell', null)).toEqual({ args: [], resumesConversation: false })
    expect(wakeDescription('shell')).toContain('new shell')
    expect(wakeDescription('claude')).toContain('resumes')
  })
})
