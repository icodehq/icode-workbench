import { describe, expect, it, vi } from 'vitest'
import type { HarnessDetectionResult } from '../harness/harness-detector'
import { CommitMessageService, type CommitMessageDeps } from './commit-message-service'
import type { LocalOneShotResult } from './harness-one-shot'

const WORKTREE = '/tmp/worktree'
const DIFF = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n'

function detection(command = '/fake/claude'): Extract<HarnessDetectionResult, { state: 'available' }> {
  return {
    state: 'available',
    harness: 'claude',
    version: '1.0.0',
    resolvedPath: command,
    command: { command, args: [] },
    diagnostics: {
      resolvedPath: command,
      outcome: 'exited',
      exitCode: 0,
      signal: null,
      stdoutTail: '',
      stderrTail: '',
      durationMs: 1,
      observedAt: 1,
      attempts: 1
    }
  }
}

function result(overrides: Partial<LocalOneShotResult> = {}): LocalOneShotResult {
  return {
    stdout: 'feat: generated message\n',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    outputOverflow: false,
    ...overrides
  }
}

function setup(overrides: Partial<CommitMessageDeps> = {}) {
  const runOneShot = vi.fn(async () => result())
  const detectHarness = vi.fn(async () => detection())
  const deps: CommitMessageDeps = {
    sessions: { get: vi.fn(async () => ({ harness: 'claude' as const })) },
    gitWorkspace: {
      resolve: vi.fn(async () => ({
        status: 'ok' as const,
        worktreePath: WORKTREE,
        target: { kind: 'local' as const }
      })),
      stagedDiff: vi.fn(async () => ({ status: 'ok' as const, patch: DIFF, truncated: false }))
    },
    detectHarness,
    runOneShot,
    ...overrides
  }
  return { service: new CommitMessageService(deps), deps, runOneShot, detectHarness }
}

describe('CommitMessageService', () => {
  it('generates a message from the staged diff with the session harness', async () => {
    const { service, runOneShot } = setup()
    const generated = await service.generate('ses_test', 'request-1')
    expect(generated).toEqual({
      status: 'ok',
      message: 'feat: generated message',
      agent: 'claude'
    })
    expect(runOneShot).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['-p', '--output-format', 'text', '--permission-mode', 'plan'],
        worktreePath: WORKTREE,
        target: { kind: 'local' },
        timeoutMs: 120_000
      })
    )
    const prompt = (runOneShot.mock.calls[0] as unknown as [{ prompt: string }])[0].prompt
    expect(prompt).toContain(DIFF)
    expect(prompt).toContain('Output ONLY the commit message')
  })

  it('refuses Shell sessions, empty indexes and an unavailable harness', async () => {
    const shell = setup({
      sessions: { get: vi.fn(async () => ({ harness: 'shell' as const })) }
    })
    expect(await shell.service.generate('ses_shell', 'request-shell')).toMatchObject({
      status: 'unavailable',
      reason: 'not-agent'
    })
    expect(shell.runOneShot).not.toHaveBeenCalled()

    const empty = setup({
      gitWorkspace: {
        resolve: vi.fn(async () => ({
          status: 'ok' as const,
          worktreePath: WORKTREE,
          target: { kind: 'local' as const }
        })),
        stagedDiff: vi.fn(async () => ({ status: 'ok' as const, patch: '  \n', truncated: false }))
      }
    })
    expect(await empty.service.generate('ses_empty', 'request-empty')).toMatchObject({
      status: 'unavailable',
      reason: 'no-staged-changes'
    })

    const missing = setup({
      detectHarness: vi.fn(async () => ({
        state: 'unavailable' as const,
        harness: 'claude' as const,
        reason: 'not_found' as const,
        incompatibility: null,
        message: 'claude was not found',
        diagnostics: detection().diagnostics,
        command: null
      }))
    })
    expect(await missing.service.generate('ses_missing', 'request-missing')).toMatchObject({
      status: 'unavailable',
      reason: 'harness-unavailable',
      detail: 'claude was not found'
    })
    expect(missing.runOneShot).not.toHaveBeenCalled()
  })

  it('reports timeout, failure stderr and empty output truthfully', async () => {
    const timedOut = setup({ runOneShot: vi.fn(async () => result({ timedOut: true })) })
    expect(await timedOut.service.generate('ses_t', 'request-t')).toMatchObject({
      status: 'unavailable',
      reason: 'generation-failed',
      detail: expect.stringContaining('timed out')
    })

    const failed = setup({
      runOneShot: vi.fn(async () =>
        result({ exitCode: 1, stdout: 'prompt echo', stderr: 'fatal: model unavailable' })
      )
    })
    expect(await failed.service.generate('ses_f', 'request-f')).toMatchObject({
      status: 'unavailable',
      reason: 'generation-failed',
      detail: expect.stringContaining('fatal: model unavailable')
    })

    const empty = setup({ runOneShot: vi.fn(async () => result({ stdout: '  \n' })) })
    expect(await empty.service.generate('ses_e', 'request-e')).toMatchObject({
      status: 'unavailable',
      reason: 'generation-failed',
      detail: expect.stringContaining('empty message')
    })
  })

  it('parses OpenCode JSON events', async () => {
    const stdout = [
      JSON.stringify({ type: 'step_start' }),
      JSON.stringify({ type: 'text', part: { id: 'a', text: 'fix: opencode message' } })
    ].join('\n')
    const { service } = setup({
      sessions: { get: vi.fn(async () => ({ harness: 'opencode' as const })) },
      detectHarness: vi.fn(async () => ({ ...detection('/fake/opencode'), harness: 'opencode' as const })),
      runOneShot: vi.fn(async () => result({ stdout }))
    })
    expect(await service.generate('ses_o', 'request-o')).toEqual({
      status: 'ok',
      message: 'fix: opencode message',
      agent: 'opencode'
    })
  })

  it('retries Codex without --ephemeral when its version rejects the flag', async () => {
    const runOneShot = vi
      .fn()
      .mockResolvedValueOnce(
        result({ exitCode: 1, stderr: "error: unexpected argument '--ephemeral' found" })
      )
      .mockResolvedValueOnce(result({ stdout: 'chore: codex message\n' }))
    const { service } = setup({
      sessions: { get: vi.fn(async () => ({ harness: 'codex' as const })) },
      detectHarness: vi.fn(async () => ({ ...detection('/fake/codex'), harness: 'codex' as const })),
      runOneShot
    })
    expect(await service.generate('ses_c', 'request-c')).toEqual({
      status: 'ok',
      message: 'chore: codex message',
      agent: 'codex'
    })
    expect(runOneShot).toHaveBeenCalledTimes(2)
    expect(runOneShot.mock.calls[1]![0].args).not.toContain('--ephemeral')
  })

  it('cancels an in-flight generation by request id', async () => {
    let release: (() => void) | null = null
    const runOneShot = vi.fn(
      (options: { signal: AbortSignal }) =>
        new Promise<LocalOneShotResult>((resolve) => {
          release = () => resolve(result({ cancelled: true }))
          options.signal.addEventListener('abort', () => release?.(), { once: true })
        })
    )
    const { service } = setup({ runOneShot })
    const pending = service.generate('ses_cancel', 'request-cancel')
    await vi.waitFor(() => expect(runOneShot).toHaveBeenCalled())
    expect(service.cancel('request-cancel')).toBe(true)
    expect(await pending).toEqual({ status: 'cancelled' })
    expect(service.cancel('request-cancel')).toBe(false)
  })
})
