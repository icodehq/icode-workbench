import { describe, expect, it } from 'vitest'
import type { OneShotResult } from '../ai/harness-one-shot'
import {
  continuationDriver,
  isContinuationSessionId
} from './assistant-continuation'

function output(partial: Partial<OneShotResult> = {}): OneShotResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    outputOverflow: false,
    ...partial
  }
}

describe('continuation drivers', () => {
  it('keeps Claude one-shot and plan-mode on fresh and resume calls', () => {
    const driver = continuationDriver('claude')!
    const fresh = driver.freshArgs({ opencodeAgent: 'plan', resumeEnabled: true })
    expect(fresh).toContain('-p')
    expect(fresh).toContain('--permission-mode')
    expect(fresh).toContain('plan')
    expect(fresh).not.toContain('--resume')

    const resume = driver.resumeArgs('session-1', { opencodeAgent: 'plan' })!
    expect(resume.slice(0, 3)).toEqual(['-p', '--resume', 'session-1'])
    expect(resume).toContain('--permission-mode')
    expect(resume).toContain('stream-json')
  })

  it('uses Codex JSON persistence only when resume is enabled', () => {
    const driver = continuationDriver('codex')!
    const resumable = driver.freshArgs({ opencodeAgent: 'plan', resumeEnabled: true })
    expect(resumable).toContain('--json')
    expect(resumable).not.toContain('--ephemeral')

    const legacy = driver.freshArgs({ opencodeAgent: 'plan', resumeEnabled: false })
    expect(legacy).toContain('--ephemeral')
    expect(legacy).not.toContain('--json')

    const resume = driver.resumeArgs('thread-1', { opencodeAgent: 'plan' })!
    expect(resume).toEqual([
      '-c',
      'sandbox_mode="read-only"',
      'exec',
      'resume',
      'thread-1',
      '--json',
      '--skip-git-repo-check'
    ])
  })

  it('resumes OpenCode with the saved session and the same agent', () => {
    const driver = continuationDriver('opencode')!
    expect(driver.freshArgs({ opencodeAgent: 'build', resumeEnabled: true })).toEqual([
      'run',
      '--agent',
      'build',
      '--format',
      'json'
    ])
    expect(driver.resumeArgs('ses_abc', { opencodeAgent: 'build' })).toEqual([
      'run',
      '--session',
      'ses_abc',
      '--agent',
      'build',
      '--format',
      'json'
    ])
  })

  it('captures Claude init and result session ids across chunk boundaries', () => {
    const observer = continuationDriver('claude')!.createObserver()
    expect(observer.push('{"type":"system","subtype":"ini')).toBeNull()
    expect(observer.push('t","session_id":"session-1"}\n')).toBe('session-1')
    expect(observer.push('{"type":"result","session_id":"session-1"}\n')).toBeNull()
    expect(observer.push('{"type":"result","session_id":"bad id!"}\n')).toBeNull()
  })

  it('captures Codex thread.started and OpenCode session ids', () => {
    const codex = continuationDriver('codex')!.createObserver()
    expect(codex.push('{"type":"thread.started","thread_id":"thread-1"}\n')).toBe(
      'thread-1'
    )
    expect(codex.push('{"type":"turn.completed"}\n')).toBeNull()

    const opencode = continuationDriver('opencode')!.createObserver()
    expect(opencode.push('{"type":"step_start","sessionID":"ses_1"}\n')).toBe('ses_1')
    expect(opencode.push('{"type":"text","part":{"sessionID":"ses_1"}}\n')).toBeNull()
  })

  it('classifies missing and unsupported resume failures', () => {
    const claude = continuationDriver('claude')!
    expect(
      claude.classifyFailure(
        output({ stderr: 'No conversation found with session ID: abc' })
      )
    ).toBe('missing')
    expect(
      claude.classifyFailure(output({ stderr: 'unknown option --resume' }))
    ).toBe('unsupported')

    const codex = continuationDriver('codex')!
    expect(
      codex.classifyFailure(output({ stderr: 'no rollout found for thread id' }))
    ).toBe('missing')

    const opencode = continuationDriver('opencode')!
    expect(
      opencode.classifyFailure(output({ stderr: 'Session not found' }))
    ).toBe('missing')
  })

  it('accepts only conservative session-id shapes', () => {
    expect(isContinuationSessionId('ses_abc-123')).toBe(true)
    expect(isContinuationSessionId('0d12561a-e16f-4d64-a38a-c561985e6820')).toBe(true)
    expect(isContinuationSessionId('bad id')).toBe(false)
    expect(isContinuationSessionId("it's")).toBe(false)
    expect(isContinuationSessionId('')).toBe(false)
  })
})
