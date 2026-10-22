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
import { findExecutable } from './find-executable'

export const PROBE_TIMEOUT_MS = 5000
const MAX_CAPTURE_BYTES = 8192

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
  shellPath: () => string
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
    const definition = HARNESS_DEFINITIONS[harness]
    const executableName =
      definition.command.kind === 'user-shell' ? this.deps.shellPath() : definition.command.name

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
  return new HarnessDetector({
    resolve: (name) => findExecutable(name),
    probe: probeVersion,
    shellPath: () => (process.env.SHELL && process.env.SHELL.length > 0 ? process.env.SHELL : '/bin/bash'),
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
      child = spawn(file, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
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
