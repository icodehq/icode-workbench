import { spawn } from 'node:child_process'
import {
  HARNESS_DEFINITIONS,
  HARNESS_IDS,
  classifyHarnessProbe,
  type HarnessDetection,
  type HarnessDetectionState,
  type HarnessId,
  type HarnessProbeEvidence
} from '../../shared/domain/harness'
import { chooseShellCommand } from './default-shell'
import { findExecutable } from './find-executable'

export const PROBE_TIMEOUT_MS = 5000
const MAX_CAPTURE_BYTES = 8192

/** npm installs Windows CLIs as `.cmd` shims, alongside a `.ps1` twin. */
const WINDOWS_CMD_SHIM = /\.(cmd|bat)$/iu

function quoteWindowsArg(value: string): string {
  return /[\s"]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value
}

/**
 * How to start `file` with `args`.
 *
 * Node refuses to spawn a `.cmd`/`.bat` directly (EINVAL, since the fix for
 * CVE-2024-27980) and cannot execute a `.ps1` at all (EFTYPE). Both are how npm
 * installs Windows CLIs, so such a shim is started through the command
 * interpreter instead of being reported as unusable.
 */
export function spawnSpec(
  file: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  comspec = process.env.ComSpec
): { file: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (platform !== 'win32' || !WINDOWS_CMD_SHIM.test(file)) return { file, args }
  const command = [file, ...args].map(quoteWindowsArg).join(' ')
  return {
    file: comspec && comspec.length > 0 ? comspec : 'cmd.exe',
    args: ['/d', '/s', '/c', `"${command}"`],
    windowsVerbatimArguments: true
  }
}

export type ProbeResult = {
  outcome: 'exited' | 'timed_out' | 'signaled' | 'spawn_error'
  exitCode: number | null
  signal: string | null
  spawnErrorCode: string | null
  stdout: string
  stderr: string
  durationMs: number
}

export type HarnessDetectorDeps = {
  resolve: (name: string) => string | null
  probe: (file: string, args: string[]) => Promise<ProbeResult>
  /** For `user-shell`: the executable to launch, or null when none exists. */
  shellPath: () => string | null
  /** Explains why `shellPath()` returned null. */
  shellUnavailableMessage?: () => string
  /** Test seam: selects the Windows branch without a Windows host. */
  platform?: NodeJS.Platform
  now?: () => number
}

export type HarnessDetectionResult = HarnessDetection & {
  /** Command configuration to hand to the host. Only present when available. */
  command: { command: string; args: string[] } | null
}

export class HarnessDetector {
  constructor(private readonly deps: HarnessDetectorDeps) {}

  async detect(harness: HarnessId, attempts = 1): Promise<HarnessDetectionResult> {
    const now = this.deps.now ?? Date.now
    const platform = this.deps.platform ?? process.platform
    const definition = HARNESS_DEFINITIONS[harness]
    const isUserShell = definition.command.kind === 'user-shell'
    const configuredShell = isUserShell ? this.deps.shellPath() : null

    // No shell on this platform: report why, rather than probing a path that
    // cannot exist. The message is the actionable part.
    if (isUserShell && configuredShell === null) {
      return {
        state: 'detection_failed',
        harness,
        reason: 'spawn_error',
        message:
          this.deps.shellUnavailableMessage?.() ??
          'No shell executable is available on this platform.',
        diagnostics: {
          resolvedPath: null,
          outcome: 'spawn_error',
          exitCode: null,
          signal: null,
          stdoutTail: '',
          stderrTail: '',
          durationMs: 0,
          observedAt: now(),
          attempts
        },
        command: null
      }
    }

    const executableName = isUserShell
      ? (configuredShell as string)
      : definition.command.kind === 'executable'
        ? definition.command.name
        : (configuredShell as string)

    // Windows shells have no non-interactive version flag worth calling:
    // `cmd.exe --version` fails, and PowerShell would open an interactive
    // session until the probe timeout. Resolution is the evidence.
    if (isUserShell && platform === 'win32') {
      const winShell = this.deps.resolve(executableName)
      const observedAt = now()
      const diagnostics = {
        resolvedPath: winShell,
        outcome: (winShell ? 'exited' : 'spawn_error') as ProbeResult['outcome'],
        exitCode: null,
        signal: null,
        stdoutTail: '',
        stderrTail: '',
        durationMs: 0,
        observedAt,
        attempts
      }
      if (!winShell) {
        return {
          state: 'detection_failed',
          harness,
          reason: 'spawn_error',
          message: `The configured shell "${executableName}" could not be resolved to an executable.`,
          diagnostics,
          command: null
        }
      }
      return {
        state: 'available',
        harness,
        version: null,
        resolvedPath: winShell,
        diagnostics,
        command: { command: winShell, args: [] }
      }
    }

    const resolvedPath = this.deps.resolve(executableName)
    const startedAt = Date.now()
    let probe: ProbeResult
    if (!resolvedPath) {
      probe = {
        outcome: 'spawn_error',
        exitCode: null,
        signal: null,
        spawnErrorCode: 'ENOENT',
        stdout: '',
        stderr: '',
        durationMs: 0
      }
    } else {
      probe = await this.deps.probe(resolvedPath, ['--version'])
    }
    const observedAt = now()
    const evidence: HarnessProbeEvidence = {
      harness,
      resolvedPath,
      outcome: probe.outcome,
      exitCode: probe.exitCode,
      signal: probe.signal,
      spawnErrorCode: probe.spawnErrorCode,
      stdout: probe.stdout,
      stderr: probe.stderr,
      durationMs: probe.durationMs || Date.now() - startedAt,
      observedAt,
      attempts
    }
    const classification = classifyHarnessProbe(evidence)
    if (classification.state === 'available') {
      return {
        ...classification,
        command: { command: resolvedPath ?? executableName, args: [] }
      }
    }
    return { ...classification, command: null }
  }

  async detectAll(): Promise<HarnessDetectionResult[]> {
    return Promise.all(HARNESS_IDS.map((harness) => this.detect(harness)))
  }

  async detectOne(harness: HarnessId): Promise<HarnessDetectionResult> {
    return this.detect(harness)
  }
}

export type HarnessStateSummary = {
  harness: HarnessId
  state: HarnessDetectionState
}

export function createHarnessDetector(overrides: Partial<HarnessDetectorDeps> = {}): HarnessDetector {
  const resolve = (name: string): string | null => findExecutable(name)
  const shellChoice = (): ReturnType<typeof chooseShellCommand> =>
    chooseShellCommand({ platform: process.platform, env: process.env, resolve })
  return new HarnessDetector({
    resolve,
    probe: probeVersion,
    shellPath: () => {
      const choice = shellChoice()
      return choice.kind === 'command' ? choice.command : null
    },
    shellUnavailableMessage: () => {
      const choice = shellChoice()
      return choice.kind === 'unavailable'
        ? choice.message
        : 'No shell executable is available on this platform.'
    },
    platform: process.platform,
    ...overrides
  })
}

/**
 * Real version probe. A timeout is not evidence the harness cannot run, so it
 * becomes `timed_out` and classification reports `detection_failed`.
 */
export function probeVersion(file: string, args: string[]): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: NodeJS.Timeout | null = null

    const finish = (result: ProbeResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }

    let child
    try {
      const spec = spawnSpec(file, args)
      child = spawn(spec.file, spec.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        env: { ...process.env, NO_COLOR: '1', CI: '1' }
      })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? null
      finish({
        outcome: 'spawn_error',
        exitCode: null,
        signal: null,
        spawnErrorCode: code,
        stdout: '',
        stderr: '',
        durationMs: Date.now() - startedAt
      })
      return
    }

    const capture = (current: string, chunk: Buffer): string => {
      if (current.length >= MAX_CAPTURE_BYTES) return current
      return (current + chunk.toString('utf8')).slice(0, MAX_CAPTURE_BYTES)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = capture(stdout, chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = capture(stderr, chunk)
    })
    child.once('error', (error: NodeJS.ErrnoException) => {
      finish({
        outcome: 'spawn_error',
        exitCode: null,
        signal: null,
        spawnErrorCode: error.code ?? null,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt
      })
    })
    child.once('exit', (code, signal) => {
      finish({
        outcome: signal ? 'signaled' : 'exited',
        exitCode: code,
        signal: signal ?? null,
        spawnErrorCode: null,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt
      })
    })

    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // the child may have exited between the timeout and the kill
      }
      finish({
        outcome: 'timed_out',
        exitCode: null,
        signal: null,
        spawnErrorCode: null,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt
      })
    }, PROBE_TIMEOUT_MS)
  })
}
