import { describe, expect, it } from 'vitest'
import { parseHarnessOutput } from './harness-output'

describe('harness output parsing', () => {
  it('passes Claude and Codex text through', () => {
    expect(parseHarnessOutput('claude', 'feat: add a thing\n')).toEqual({
      ok: true,
      text: 'feat: add a thing\n'
    })
    expect(parseHarnessOutput('codex', 'fix: repair it\n')).toEqual({
      ok: true,
      text: 'fix: repair it\n'
    })
  })

  it('joins text parts from OpenCode JSON events', () => {
    const stdout = [
      JSON.stringify({ type: 'step_start' }),
      JSON.stringify({ type: 'text', part: { id: 'a', text: 'feat: first' } }),
      JSON.stringify({ type: 'text', part: { id: 'b', text: 'body' } })
    ].join('\n')
    expect(parseHarnessOutput('opencode', stdout)).toEqual({
      ok: true,
      text: 'feat: first\nbody'
    })
  })

  it('resets parts at a new step and surfaces an OpenCode error event', () => {
    const reset = [
      JSON.stringify({ type: 'text', part: { id: 'old', text: 'old answer' } }),
      JSON.stringify({ type: 'step_start' }),
      JSON.stringify({ type: 'text', part: { id: 'new', text: 'new answer' } })
    ].join('\n')
    expect(parseHarnessOutput('opencode', reset)).toEqual({ ok: true, text: 'new answer' })

    const failed = JSON.stringify({
      type: 'error',
      error: { data: { message: 'model unavailable' } }
    })
    expect(parseHarnessOutput('opencode', failed)).toEqual({
      ok: false,
      error: 'model unavailable'
    })
  })

  it('rejects malformed OpenCode output', () => {
    expect(parseHarnessOutput('opencode', 'not json')).toMatchObject({ ok: false })
    expect(parseHarnessOutput('opencode', JSON.stringify({ type: 1 }))).toMatchObject({
      ok: false
    })
  })
})
