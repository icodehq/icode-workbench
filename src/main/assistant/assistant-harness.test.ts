import { describe, expect, it } from 'vitest'
import {
  assistantHarnessArgs,
  parseAssistantHarnessOutput
} from './assistant-harness'

describe('assistant harness adapters', () => {
  it('uses one-shot read-only arguments for all three harnesses', () => {
    expect(assistantHarnessArgs('claude')).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode',
      'plan'
    ])
    expect(assistantHarnessArgs('codex')).toEqual([
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '-s',
      'read-only'
    ])
    expect(assistantHarnessArgs('opencode', 'build')).toEqual([
      'run',
      '--agent',
      'build',
      '--format',
      'json'
    ])
    expect(assistantHarnessArgs('shell')).toBeNull()
  })

  it('extracts Claude print-mode JSON and OpenCode events', () => {
    expect(
      parseAssistantHarnessOutput('claude', JSON.stringify({ result: 'hello', is_error: false }))
    ).toEqual({ ok: true, text: 'hello' })
    expect(
      parseAssistantHarnessOutput(
        'opencode',
        '{"type":"text","part":{"id":"p1","text":"hello"}}'
      )
    ).toEqual({ ok: true, text: 'hello' })
  })

  it('reads the final result event from Claude stream-json', () => {
    const output = [
      '{"type":"system","subtype":"init","model":"test"}',
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"{\\"reply\\":\\"ok\\""}}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"{\\"reply\\":\\"ok\\",\\"actions\\":[]}"}'
    ].join('\n')
    expect(parseAssistantHarnessOutput('claude', output)).toEqual({
      ok: true,
      text: '{"reply":"ok","actions":[]}'
    })
    expect(
      parseAssistantHarnessOutput('claude', '{"type":"system","subtype":"init"}\n')
    ).toMatchObject({ ok: false })
  })

  it('surfaces an error instead of treating it as a reply', () => {
    expect(
      parseAssistantHarnessOutput('claude', JSON.stringify({ is_error: true }))
    ).toMatchObject({ ok: false })
    expect(
      parseAssistantHarnessOutput(
        'claude',
        JSON.stringify({ is_error: true, result: 'API Error: 503 No available channel' })
      )
    ).toEqual({ ok: false, error: 'API Error: 503 No available channel' })
  })
})
