/**
 * One non-interactive harness run for text generation.
 *
 * The prompt goes over stdin so a staged diff never appears in the process
 * list or hits argv limits. The harness runs in the session's worktree and is
 * killed on timeout or cancellation; no shell interprets the prompt.
 */

import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { ExecutionTarget } from '../../shared/domain/repository'
import type { HarnessDetectionResult } from '../harness/harness-detector'
import { quoteForPosixShell, withLaunchArgs } from '../harness/launch-command'
import {
  resolveWslExecutablePath,
  resolveWslInteropCwd,
  type WslCommandRunner
} from '../wsl/exec'

/**
 * A stream-json run emits one JSON line per token event; a single turn can
 * legitimately exceed a megabyte before its final `result` line. The old 1MB
 * cap cut that line off and turned a successful answer into "no result event".
 * The cap still bounds a runaway harness; the assistant parser also captures
 * the result event incrementally so a truncated tail cannot lose it.
 */
const MAX_OUTPUT_BYTES = 16_000_000

/**
 * Ends the whole harness tree, not only the shim.
 *
 * On Windows the resolved command is an npm `.cmd` shim, so the spawned child
 * is `cmd.exe`; Claude/Codex is its child. Killing only `cmd.exe` leaves the
 * agent holding the stdout/stderr pipes, and the `close` event does not fire
 * until that orphan exits. A timed-out or stopped Mira turn would then stay
 * "working" for minutes after its deadline. `taskkill /T` closes the tree and
 * releases the pipes immediately.
 */
function killHarnessTree(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    const taskkill = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'taskkill.exe'
    )
    execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, (error) => {
      if (error) {
        try {
          child.kill()
        } catch {
          // Already gone.
        }
      }
    })
    return
  }
  try {
    child.kill()
  } catch {
    // Already gone.
  }
}

/** Receives decoded stdout text as it arrives; never used for final parsing. */
export type OneShotChunkListener = (chunk: string) => void

export type LocalOneShotOptions = {
  detection: Extract<HarnessDetectionResult, { state: 'available' }>
  args: readonly string[]
  prompt: string
  cwd: string
  timeoutMs: number
  signal: AbortSignal
  onStdoutChunk?: OneShotChunkListener
}

export type OneShotRunOptions = {
  detection: Extract<HarnessDetectionResult, { state: 'available' }>
  args: readonly string[]
  prompt: string
  worktreePath: string
  target: ExecutionTarget
  timeoutMs: number
  signal: AbortSignal
  onStdoutChunk?: OneShotChunkListener
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
      signal: options.signal,
      ...(options.onStdoutChunk === undefined
        ? {}
        : { onStdoutChunk: options.onStdoutChunk })
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
  const argv = [command.command, ...args]

  if (options.onStdoutChunk !== undefined) {
    return runGuestHarnessOneShotStreaming(options, distro, runner, argv)
  }

  const result = await runner.run({
    scope: 'guest',
    distro,
    argv,
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

/**
 * The WSL equivalent of the local streaming spawn.
 *
 * `WslCommandRunner` uses `execFile`, which only resolves with the complete
 * output. Mira needs the same incremental stdout for a guest harness, so this
 * path builds the identical `wsl.exe` argv and owns the process directly.
 */
async function runGuestHarnessOneShotStreaming(
  options: OneShotRunOptions,
  distro: string,
  runner: WslCommandRunner,
  argv: readonly string[]
): Promise<OneShotResult> {
  const program = resolveWslExecutablePath(process.env, process.platform)
  const spawnArgs = runner.buildArgs({ scope: 'guest', distro, argv })
  let child: ChildProcessWithoutNullStreams
  try {
    child = spawn(program, spawnArgs, {
      cwd: resolveWslInteropCwd(process.env),
      env: { ...process.env, WSL_UTF8: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
  } catch (error) {
    return {
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: null,
      timedOut: false,
      cancelled: false,
      outputOverflow: false
    }
  }

  let stdout = ''
  let stderr = ''
  let outputOverflow = false
  let timedOut = false
  let cancelled = false
  let settled = false
  let killTimer: NodeJS.Timeout | null = null
  const outDecoder = new StringDecoder('utf8')
  const errDecoder = new StringDecoder('utf8')

  const append = (current: string, chunk: string): string => {
    const remaining = MAX_OUTPUT_BYTES - current.length
    if (remaining <= 0) {
      outputOverflow = true
      return current
    }
    if (chunk.length > remaining) {
      outputOverflow = true
      return current + chunk.slice(0, remaining)
    }
    return current + chunk
  }

  child.stdout.on('data', (chunk: Buffer) => {
    const text = outDecoder.write(chunk)
    if (text.length === 0) return
    stdout = append(stdout, text)
    options.onStdoutChunk?.(text)
  })
  child.stderr.on('data', (chunk: Buffer) => {
    const text = errDecoder.write(chunk)
    if (text.length > 0) stderr = append(stderr, text)
  })
  child.stdin.on('error', () => {
    // A harness may exit before reading stdin; the close result is authoritative.
  })
  child.stdin.end(options.prompt)

  const kill = (): void => {
    if (settled) return
    killHarnessTree(child)
    if (killTimer === null) {
      killTimer = setTimeout(() => {
        if (settled) return
        if (process.platform === 'win32') {
          killHarnessTree(child)
          return
        }
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

  const exitCode = await new Promise<number | null>((resolve) => {
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer !== null) clearTimeout(killTimer)
      options.signal.removeEventListener('abort', onAbort)
      resolve(code)
    }
    child.once('error', (error) => {
      stderr = stderr.length > 0 ? stderr : error.message
      finish(null)
    })
    child.once('close', (code) => finish(code))
  })

  return { stdout, stderr, exitCode, timedOut, cancelled, outputOverflow }
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
  const outDecoder = new StringDecoder('utf8')
  const errDecoder = new StringDecoder('utf8')

  const append = (current: string, chunk: string): string => {
    const remaining = MAX_OUTPUT_BYTES - current.length
    if (remaining <= 0) {
      outputOverflow = true
      return current
    }
    if (chunk.length > remaining) {
      outputOverflow = true
      return current + chunk.slice(0, remaining)
    }
    return current + chunk
  }

  const onStdout = (chunk: Buffer): void => {
    const text = outDecoder.write(chunk)
    if (text.length === 0) return
    stdout = append(stdout, text)
    options.onStdoutChunk?.(text)
  }
  const onStderr = (chunk: Buffer): void => {
    const text = errDecoder.write(chunk)
    if (text.length > 0) stderr = append(stderr, text)
  }
  child.stdout.on('data', onStdout)
  child.stderr.on('data', onStderr)
  child.stdin.on('error', () => {
    // A harness may exit before reading stdin; the close result is authoritative.
  })
  child.stdin.end(options.prompt)

  const kill = (): void => {
    if (settled) return
    killHarnessTree(child)
    if (killTimer === null) {
      killTimer = setTimeout(() => {
        if (settled) return
        if (process.platform === 'win32') {
          // A second taskkill covers a tree that was still being created when
          // the first one ran.
          killHarnessTree(child)
          return
        }
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
