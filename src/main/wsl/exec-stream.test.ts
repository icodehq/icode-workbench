import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { WslCommandRunner, type WslStreamLauncher } from './exec'

function streamLauncher(script: string): WslStreamLauncher {
  return () =>
    spawn('sh', ['-c', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // The production launcher creates a process group on POSIX so a shell's
      // child is reachable by cancellation. Mirror that here.
      detached: process.platform !== 'win32'
    })
}

const request = {
  scope: 'guest' as const,
  distro: 'Ubuntu',
  argv: ['/bin/true']
}

describe('WslCommandRunner.runStream', () => {
  it('forwards stdout and stderr chunks as they arrive', async () => {
    const runner = new WslCommandRunner({
      streamLauncher: streamLauncher('printf "one\\n"; printf "two\\n" >&2')
    })
    const stdout: string[] = []
    const stderr: string[] = []
    const result = await runner.runStream(request, {
      onStdout: (chunk) => stdout.push(chunk.toString('utf8')),
      onStderr: (chunk) => stderr.push(chunk.toString('utf8'))
    })
    expect(result).toMatchObject({ code: 0, timedOut: false, cancelled: false })
    expect(stdout.join('')).toBe('one\n')
    expect(stderr.join('')).toBe('two\n')
  })

  it('reports a non-zero exit without treating it as a transport failure', async () => {
    const runner = new WslCommandRunner({ streamLauncher: streamLauncher('exit 3') })
    const result = await runner.runStream(request)
    expect(result.code).toBe(3)
    expect(result.timedOut).toBe(false)
    expect(result.spawnFailure).toBeUndefined()
  })

  it('kills a command that exceeds its timeout', async () => {
    const runner = new WslCommandRunner({
      streamLauncher: streamLauncher('sleep 10')
    })
    const started = Date.now()
    const result = await runner.runStream({ ...request, timeoutMs: 60 })
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('cancels through the AbortSignal', async () => {
    const runner = new WslCommandRunner({
      streamLauncher: streamLauncher('printf "start\\n"; sleep 10')
    })
    const controller = new AbortController()
    const pending = runner.runStream(
      { ...request, signal: controller.signal },
      {
        onStdout: () => controller.abort()
      }
    )
    const result = await pending
    expect(result.cancelled).toBe(true)
  })

  it('returns cancelled for an already-aborted request without spawning', async () => {
    let spawned = false
    const runner = new WslCommandRunner({
      streamLauncher: () => {
        spawned = true
        return spawn('sh', ['-c', 'true'], { stdio: ['ignore', 'pipe', 'pipe'] })
      }
    })
    const controller = new AbortController()
    controller.abort()
    const result = await runner.runStream({ ...request, signal: controller.signal })
    expect(result.cancelled).toBe(true)
    expect(spawned).toBe(false)
  })

  it('maps a missing wsl.exe to wsl_missing', async () => {
    const runner = new WslCommandRunner({
      streamLauncher: () => {
        throw Object.assign(new Error('spawn wsl.exe ENOENT'), { code: 'ENOENT' })
      }
    })
    const result = await runner.runStream(request)
    expect(result.spawnFailure).toBe('wsl_missing')
  })

  it('maps an asynchronous ENOENT error event', async () => {
    const runner = new WslCommandRunner({
      streamLauncher: () =>
        spawn('icode-definitely-not-a-real-program', [], {
          stdio: ['ignore', 'pipe', 'pipe']
        })
    })
    const result = await runner.runStream(request)
    expect(result.spawnFailure).toBe('wsl_missing')
  })

  it('refuses an empty argv', async () => {
    const runner = new WslCommandRunner({ streamLauncher: streamLauncher('true') })
    await expect(
      runner.runStream({ scope: 'guest', distro: 'Ubuntu', argv: [] })
    ).rejects.toThrow('argv must name a program')
  })
})
