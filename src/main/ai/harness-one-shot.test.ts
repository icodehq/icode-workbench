import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { HarnessDetectionResult } from '../harness/harness-detector'
import { windowsShimCommandLine } from '../harness/launch-command'
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

  it('keeps a final result line beyond the old 1 MB stdout boundary', async () => {
    const script = `
      process.stdout.write('x'.repeat(1_200_000))
      process.stdout.write('\\nFINAL_RESULT\\n')
    `
    const result = await runLocalHarnessOneShot({
      detection: detection(script),
      args: [],
      prompt: 'x',
      cwd: process.cwd(),
      timeoutMs: 10_000,
      signal: new AbortController().signal
    })
    expect(result.outputOverflow).toBe(false)
    expect(result.stdout.endsWith('FINAL_RESULT\n')).toBe(true)
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

  it.skipIf(process.platform !== 'win32')(
    'kills the whole cmd shim tree so a timeout releases stdout promptly',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'icode-kill-tree-'))
      const shim = join(dir, 'hang.cmd')
      // The grandchild keeps stdout open; killing only cmd.exe would leave the
      // close event pending and the caller waiting far past the deadline.
      writeFileSync(shim, '@echo off\r\nnode -e "setInterval(()=>{},1000)"\r\n')
      try {
        const started = Date.now()
        const result = await runLocalHarnessOneShot({
          detection: {
            ...detection('unused'),
            command: {
              command: process.env.ComSpec ?? 'cmd.exe',
              args: windowsShimCommandLine(shim),
              cmdShim: { shim }
            }
          },
          args: [],
          prompt: 'x',
          cwd: dir,
          timeoutMs: 200,
          signal: new AbortController().signal
        })
        expect(result.timedOut).toBe(true)
        expect(Date.now() - started).toBeLessThan(3_000)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )
})
