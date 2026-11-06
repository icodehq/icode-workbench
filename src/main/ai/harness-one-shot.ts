/**
 * One non-interactive harness run for text generation.
 *
 * The prompt goes over stdin so a staged diff never appears in the process
 * list or hits argv limits. The harness runs in the session's worktree and is
 * killed on timeout or cancellation; no shell interprets the prompt.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ExecutionTarget } from '../../shared/domain/repository'
import type { HarnessDetectionResult } from '../harness/harness-detector'
import { quoteForPosixShell, withLaunchArgs } from '../harness/launch-command'
import type { WslCommandRunner } from '../wsl/exec'

const MAX_OUTPUT_BYTES = 1_000_000

export type LocalOneShotOptions = {
  detection: Extract<HarnessDetectionResult, { state: 'available' }>
  args: readonly string[]
  prompt: string
  cwd: string
  timeoutMs: number
  signal: AbortSignal
}

export type OneShotRunOptions = {
  detection: Extract<HarnessDetectionResult, { state: 'available' }>
  args: readonly string[]
  prompt: string
  worktreePath: string
  target: ExecutionTarget
  timeoutMs: number
  signal: AbortSignal
}

export type OneShotResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  cancelled: boolean
  outputOverflow: boolean
}

export type LocalOneShotResult = OneShotResult

/** Runs in the session worktree on this machine, or inside its WSL distro. */
export async function runHarnessOneShot(
  options: OneShotRunOptions,
  runner?: WslCommandRunner
): Promise<OneShotResult> {
  if (options.target.kind === 'local') {
    return runLocalHarnessOneShot({
      detection: options.detection,
      args: options.args,
      prompt: options.prompt,
      cwd: options.worktreePath,
      timeoutMs: options.timeoutMs,
      signal: options.signal
    })
  }
  return runGuestHarnessOneShot(options, options.target.distro, runner)
}

async function runGuestHarnessOneShot(
  options: OneShotRunOptions,
  distro: string,
  runner?: WslCommandRunner
): Promise<OneShotResult> {
  const base = options.detection.command
  if (base === null || runner === undefined) {
    return {
      stdout: '',
      stderr: 'The WSL agent command is unavailable.',
      exitCode: null,
      timedOut: false,
      cancelled: false,
      outputOverflow: false
    }
  }

  const command = withLaunchArgs(base, options.args)
  if (typeof command.args === 'string' || command.shellWrapper === undefined) {
    return {
      stdout: '',
      stderr: 'The WSL agent launch command is not a shell wrapper.',
      exitCode: null,
      timedOut: false,
      cancelled: false,
      outputOverflow: false
    }
  }
  const args = [...command.args]
  const scriptIndex = command.shellWrapper.scriptIndex
  const script = args[scriptIndex]
  if (script === undefined) {
    return {
      stdout: '',
      stderr: 'The WSL agent launch script is missing.',
      exitCode: null,
      timedOut: false,
      cancelled: false,
      outputOverflow: false
    }
  }
  // The login shell starts in the interop cwd; enter the session worktree first
  // so an agent that reads project instructions sees the right checkout.
  args[scriptIndex] = `cd ${quoteForPosixShell(options.worktreePath)} && ${script}`

  const result = await runner.run({
    scope: 'guest',
    distro,
    argv: [command.command, ...args],
    stdin: options.prompt,
    timeoutMs: options.timeoutMs,
    signal: options.signal
  })
  switch (result.status) {
    case 'ok':
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        outputOverflow: false
      }
    case 'exit_failure':
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.code,
        timedOut: false,
        cancelled: false,
        outputOverflow: false
      }
    case 'timed_out':
      return {
        stdout: '',
        stderr: '',
        exitCode: null,
        timedOut: true,
        cancelled: false,
        outputOverflow: false
      }
    case 'cancelled':
      return {
        stdout: '',
        stderr: '',
        exitCode: null,
        timedOut: false,
        cancelled: true,
        outputOverflow: false
      }
    case 'wsl_missing':
      return {
        stdout: '',
        stderr: result.detail,
        exitCode: null,
        timedOut: false,
        cancelled: false,
        outputOverflow: false
      }
  }
}

export async function runLocalHarnessOneShot(
  options: LocalOneShotOptions
): Promise<LocalOneShotResult> {
  const base = options.detection.command
  if (base === null) {
    return {
      stdout: '',
      stderr: 'The harness command is unavailable.',
      exitCode: null,
      timedOut: false,
      cancelled: false,
      outputOverflow: false
    }
  }

  const command = withLaunchArgs(base, options.args)
  // A Windows .cmd shim is a raw cmd.exe command line; passing it as one
  // verbatim argument keeps its quoting intact.
  const rawCommandLine = typeof command.args === 'string'
  let spawnArgs: string[]
  if (typeof command.args === 'string') {
    spawnArgs = [command.args]
  } else {
    spawnArgs = command.args
  }
  const child: ChildProcessWithoutNullStreams = spawn(command.command, spawnArgs, {
    cwd: options.cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    ...(rawCommandLine ? { windowsVerbatimArguments: true } : {})
  })

  let stdout = ''
  let stderr = ''
  let outputOverflow = false
  let timedOut = false
  let cancelled = false
  let settled = false
  let killTimer: NodeJS.Timeout | null = null

  const append = (current: string, chunk: Buffer): string => {
    const remaining = MAX_OUTPUT_BYTES - current.length
    if (remaining <= 0) {
      outputOverflow = true
      return current
    }
    if (chunk.length > remaining) {
      outputOverflow = true
      return current + chunk.subarray(0, remaining).toString('utf8')
    }
    return current + chunk.toString('utf8')
  }

  const onStdout = (chunk: Buffer): void => {
    stdout = append(stdout, chunk)
  }
  const onStderr = (chunk: Buffer): void => {
    stderr = append(stderr, chunk)
  }
  child.stdout.on('data', onStdout)
  child.stderr.on('data', onStderr)
  child.stdin.on('error', () => {
    // A harness may exit before reading stdin; the close result is authoritative.
  })
  child.stdin.end(options.prompt)

  const kill = (): void => {
    if (settled) return
    try {
      child.kill()
    } catch {
      // Already gone.
    }
    if (killTimer === null) {
      killTimer = setTimeout(() => {
        if (settled) return
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
      }, 2000)
      killTimer.unref?.()
    }
  }

  const onAbort = (): void => {
    cancelled = true
    kill()
  }
  if (options.signal.aborted) onAbort()
  else options.signal.addEventListener('abort', onAbort, { once: true })

  const timer = setTimeout(() => {
    timedOut = true
    kill()
  }, options.timeoutMs)
  timer.unref?.()

  const result = await new Promise<LocalOneShotResult>((resolve) => {
    const finish = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer !== null) clearTimeout(killTimer)
      options.signal.removeEventListener('abort', onAbort)
      resolve({ stdout, stderr, exitCode, timedOut, cancelled, outputOverflow })
    }
    child.once('error', (error) => {
      stderr = stderr.length > 0 ? stderr : error.message
      finish(null)
    })
    child.once('close', (code) => finish(code))
  })

  return result
}
