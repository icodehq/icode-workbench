import { describe, expect, it, vi } from 'vitest'
import type { HarnessDetectionResult } from '../harness/harness-detector'
import type { WslCommandRunner } from '../wsl/exec'
import { runHarnessOneShot, runLocalHarnessOneShot } from './harness-one-shot'

function detection(script: string): Extract<HarnessDetectionResult, { state: 'available' }> {
  return {
    state: 'available',
    harness: 'claude',
    version: 'test',
    resolvedPath: process.execPath,
    command: { command: process.execPath, args: ['-e', script] },
    diagnostics: {
      resolvedPath: process.execPath,
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

describe('runLocalHarnessOneShot', () => {
  it('writes the prompt to stdin and returns stdout', async () => {
    const script = `
      let data = ''
      process.stdin.on('data', (chunk) => { data += chunk })
      process.stdin.on('end', () => { process.stdout.write('got:' + data.split('\\n')[0]) })
    `
    const result = await runLocalHarnessOneShot({
      detection: detection(script),
      args: [],
      prompt: 'You are generating a single git commit message.\nrest',
      cwd: process.cwd(),
      timeoutMs: 5_000,
      signal: new AbortController().signal
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('got:You are generating a single git commit message.')
    expect(result.timedOut).toBe(false)
    expect(result.cancelled).toBe(false)
  })

  it('runs a guest harness through the login shell in the worktree', async () => {
    const guest = detection('unused')
    guest.command = {
      command: '/bin/bash',
      args: ['-ilc', "exec '/home/u/.local/bin/claude'"],
      shellWrapper: { scriptIndex: 1 }
    }
    const run = vi.fn(async () => ({
      status: 'ok' as const,
      stdout: 'feat: guest message\n',
      stderr: ''
    }))
    const runner = { run } as unknown as WslCommandRunner
    const result = await runHarnessOneShot(
      {
        detection: guest,
        args: ['-p', '--output-format', 'text'],
        prompt: 'prompt',
        worktreePath: '/home/u/worktree',
        target: { kind: 'wsl', distro: 'Ubuntu', distroId: null },
        timeoutMs: 5_000,
        signal: new AbortController().signal
      },
      runner
    )
    expect(result).toMatchObject({ exitCode: 0, stdout: 'feat: guest message\n' })
    const request = (run.mock.calls[0] as unknown as [
      { argv: string[]; stdin: string; distro: string }
    ])[0]
    expect(request.distro).toBe('Ubuntu')
    expect(request.stdin).toBe('prompt')
    expect(request.argv[0]).toBe('/bin/bash')
    expect(request.argv[2]).toContain("cd '/home/u/worktree' && exec '/home/u/.local/bin/claude'")
    expect(request.argv[2]).toContain("'-p'")
  })

  it('times out and cancels a hanging harness', async () => {
    const script = 'setTimeout(() => {}, 5000)'
    const timedOut = await runLocalHarnessOneShot({
      detection: detection(script),
      args: [],
      prompt: 'x',
      cwd: process.cwd(),
      timeoutMs: 50,
      signal: new AbortController().signal
    })
    expect(timedOut.timedOut).toBe(true)
    expect(timedOut.exitCode).not.toBe(0)

    const controller = new AbortController()
    const pending = runLocalHarnessOneShot({
      detection: detection(script),
      args: [],
      prompt: 'x',
      cwd: process.cwd(),
      timeoutMs: 5_000,
      signal: controller.signal
    })
    setTimeout(() => controller.abort(), 50)
    const cancelled = await pending
    expect(cancelled.cancelled).toBe(true)
  })
})
