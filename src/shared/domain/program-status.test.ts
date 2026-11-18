import { describe, expect, it } from 'vitest'
import {
  PROGRAM_STATUS_QUERY_REPLY,
  classifyTerminalTitle,
  parseProgramStatusBody
} from './program-status'

describe('parseProgramStatusBody', () => {
  it('recognizes the capability probe', () => {
    expect(parseProgramStatusBody('?')).toEqual({ type: 'query' })
    expect(parseProgramStatusBody(' ? ')).toEqual({ type: 'query' })
  })

  it('parses a root report and ignores optional fields', () => {
    expect(
      parseProgramStatusBody('state=working:kind=permission:app=claude-code:progress=42')
    ).toEqual({
      type: 'report',
      report: { state: 'working', kind: 'permission', app: 'claude-code' }
    })
    expect(parseProgramStatusBody('state=done:msg=eA==:title=dGl0bGU=')).toEqual({
      type: 'report',
      report: { state: 'done' }
    })
  })

  it('ignores child records', () => {
    expect(parseProgramStatusBody('id=agent-1:state=working:app=claude-code')).toBeNull()
    expect(parseProgramStatusBody('id=:state=done')).toEqual({
      type: 'report',
      report: { state: 'done' }
    })
  })

  it('rejects malformed, oversized and unknown-state bodies', () => {
    expect(parseProgramStatusBody('')).toBeNull()
    expect(parseProgramStatusBody('state=thinking')).toBeNull()
    expect(parseProgramStatusBody('kind=permission')).toBeNull()
    expect(parseProgramStatusBody(`state=${'x'.repeat(5000)}`)).toBeNull()
  })

  it('only accepts known kinds', () => {
    expect(parseProgramStatusBody('state=blocked:kind=question')).toEqual({
      type: 'report',
      report: { state: 'blocked', kind: 'question' }
    })
    expect(parseProgramStatusBody('state=blocked:kind=unknown')).toEqual({
      type: 'report',
      report: { state: 'blocked' }
    })
  })
})

describe('classifyTerminalTitle', () => {
  it('classifies a braille spinner as working', () => {
    expect(classifyTerminalTitle('⠋ Fix the bug')).toBe('working')
  })

  it('lets a blocked prompt win over a spinner', () => {
    expect(classifyTerminalTitle('⠋ Action Required')).toBe('waiting')
    expect(classifyTerminalTitle('Permission required')).toBe('waiting')
    expect(classifyTerminalTitle('Do you want to continue? (y/N)')).toBe('waiting')
  })

  it('classifies Claude idle without confusing it with work', () => {
    expect(classifyTerminalTitle('✳ Claude Code')).toBe('idle')
  })

  it('returns null for an arbitrary title', () => {
    expect(classifyTerminalTitle('vim src/index.ts')).toBeNull()
    expect(classifyTerminalTitle('')).toBeNull()
  })
})

describe('PROGRAM_STATUS_QUERY_REPLY', () => {
  it('names every state and kind the parser accepts', () => {
    expect(PROGRAM_STATUS_QUERY_REPLY).toContain('states=idle,working,done,blocked,error')
    expect(PROGRAM_STATUS_QUERY_REPLY).toContain('kinds=permission,question,auth')
    expect(PROGRAM_STATUS_QUERY_REPLY.endsWith('\x1b\\')).toBe(true)
  })
})
