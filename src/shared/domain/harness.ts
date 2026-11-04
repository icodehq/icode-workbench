/**
 * Harness registry and detection classification.
 *
 * Detection runs in main; this module only turns probe evidence into one of
 * three states. "Unavailable" requires evidence that the command cannot run
 * here. Anything ambiguous stays "detection_failed" and can be retried.
 */

export const HARNESS_IDS = ['claude', 'codex', 'opencode', 'shell'] as const
export type HarnessId = (typeof HARNESS_IDS)[number]

export type HarnessCommand =
  | { kind: 'executable'; name: string }
  | { kind: 'user-shell' }

export type HarnessDefinition = {
  id: HarnessId
  label: string
  command: HarnessCommand
}

export const HARNESS_DEFINITIONS: Record<HarnessId, HarnessDefinition> = {
  claude: { id: 'claude', label: 'Claude Code', command: { kind: 'executable', name: 'claude' } },
  codex: { id: 'codex', label: 'Codex', command: { kind: 'executable', name: 'codex' } },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    command: { kind: 'executable', name: 'opencode' }
  },
  shell: { id: 'shell', label: 'Shell', command: { kind: 'user-shell' } }
}

export function harnessLabel(id: HarnessId): string {
  return HARNESS_DEFINITIONS[id].label
}

/**
 * Shell is a terminal, not an agent. Review notes typed into it would be
 * executed as shell input, so only the coding-agent harnesses can receive them.
 */
export function isAgentHarness(id: HarnessId): boolean {
  return id !== 'shell'
}

export type HarnessProbeOutcome = 'exited' | 'timed_out' | 'signaled' | 'spawn_error'

/** Raw evidence from a real probe; produced by the detector in main. */
export type HarnessProbeEvidence = {
  harness: HarnessId
  resolvedPath: string | null
  outcome: HarnessProbeOutcome
  exitCode: number | null
  signal: string | null
  /** Node spawn errno (`ENOENT`, `EACCES`, …) when outcome is spawn_error. */
  spawnErrorCode: string | null
  stdout: string
  stderr: string
  durationMs: number
  observedAt: number
  attempts: number
}

export type HarnessProbeDiagnostics = {
  resolvedPath: string | null
  outcome: HarnessProbeOutcome
  exitCode: number | null
  signal: string | null
  stdoutTail: string
  stderrTail: string
  durationMs: number
  observedAt: number
  attempts: number
}

export type HarnessUnavailableReason = 'not_found' | 'permission_denied' | 'incompatible_installation'

export type HarnessDetectionFailureReason =
  | 'timeout'
  | 'terminated_by_signal'
  | 'nonzero_exit'
  | 'spawn_error'

export type HarnessIncompatibilityKind =
  | 'missing_platform_binary'
  | 'wrong_platform_package'
  | 'unsupported_platform'
  | 'incompatible_runtime'

export type HarnessAvailable = {
  state: 'available'
  harness: HarnessId
  version: string | null
  resolvedPath: string
  diagnostics: HarnessProbeDiagnostics
}

export type HarnessUnavailable = {
  state: 'unavailable'
  harness: HarnessId
  reason: HarnessUnavailableReason
  incompatibility: HarnessIncompatibilityKind | null
  message: string
  diagnostics: HarnessProbeDiagnostics
}

export type HarnessDetectionFailed = {
  state: 'detection_failed'
  harness: HarnessId
  reason: HarnessDetectionFailureReason
  message: string
  diagnostics: HarnessProbeDiagnostics
}

export type HarnessDetection = HarnessAvailable | HarnessUnavailable | HarnessDetectionFailed
export type HarnessDetectionState = HarnessDetection['state']

export function isHarnessSelectable(detection: HarnessDetection): boolean {
  return detection.state === 'available'
}

const MAX_STDOUT_TAIL = 1000
const MAX_STDERR_TAIL = 2000

function tail(value: string, limit: number): string {
  const trimmed = value.trim()
  return trimmed.length > limit ? trimmed.slice(trimmed.length - limit) : trimmed
}

function diagnosticsFrom(probe: HarnessProbeEvidence): HarnessProbeDiagnostics {
  return {
    resolvedPath: probe.resolvedPath,
    outcome: probe.outcome,
    exitCode: probe.exitCode,
    signal: probe.signal,
    stdoutTail: tail(probe.stdout, MAX_STDOUT_TAIL),
    stderrTail: tail(probe.stderr, MAX_STDERR_TAIL),
    durationMs: Math.max(0, Math.round(probe.durationMs)),
    observedAt: probe.observedAt,
    attempts: Math.max(1, Math.floor(probe.attempts))
  }
}

export function extractHarnessVersion(stdout: string, stderr: string): string | null {
  const match = /(?:^|[^\w.])v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(`${stdout}\n${stderr}`)
  return match?.[1] ?? null
}

type IncompatibilitySignature = {
  kind: HarnessIncompatibilityKind
  pattern: RegExp
}

// Generic installation diagnostics, not harness-specific facts.
const INCOMPATIBILITY_SIGNATURES: readonly IncompatibilitySignature[] = [
  {
    kind: 'missing_platform_binary',
    pattern:
      /missing optional dependency[\s\S]{0,160}(linux|darwin|win32)|cannot find module[\s\S]{0,160}(linux|darwin|win32)-(x64|arm64)/i
  },
  {
    kind: 'wrong_platform_package',
    pattern:
      /failed to install the right version[\s\S]{0,160}platform|package manager failed to install[\s\S]{0,160}(right|correct) version/i
  },
  {
    kind: 'unsupported_platform',
    pattern: /exec format error|cannot execute binary file|not supported on (this|your) platform|unsupported platform/i
  },
  {
    kind: 'incompatible_runtime',
    pattern: /node_module_version|glibc_[0-9.]+. not found|incompatible (node|runtime|abi)/i
  }
]

function detectIncompatibility(probe: HarnessProbeEvidence): IncompatibilitySignature | null {
  const haystack = `${probe.stderr}\n${probe.stdout}`
  return INCOMPATIBILITY_SIGNATURES.find((signature) => signature.pattern.test(haystack)) ?? null
}

/**
 * Classification order matters: a timeout has no verdict, and an unknown
 * nonzero exit is not evidence that execution is impossible.
 */
export function classifyHarnessProbe(probe: HarnessProbeEvidence): HarnessDetection {
  const diagnostics = diagnosticsFrom(probe)

  if (probe.outcome === 'timed_out') {
    return {
      state: 'detection_failed',
      harness: probe.harness,
      reason: 'timeout',
      message: `Version probe timed out after ${diagnostics.durationMs} ms`,
      diagnostics
    }
  }

  if (probe.outcome === 'signaled') {
    return {
      state: 'detection_failed',
      harness: probe.harness,
      reason: 'terminated_by_signal',
      message: `Version probe terminated by ${probe.signal ?? 'an unknown signal'}`,
      diagnostics
    }
  }

  if (probe.outcome === 'spawn_error') {
    if (probe.spawnErrorCode === 'ENOENT') {
      return {
        state: 'unavailable',
        harness: probe.harness,
        reason: 'not_found',
        incompatibility: null,
        message: 'Executable not found on PATH',
        diagnostics
      }
    }
    if (probe.spawnErrorCode === 'EACCES' || probe.spawnErrorCode === 'EPERM') {
      return {
        state: 'unavailable',
        harness: probe.harness,
        reason: 'permission_denied',
        incompatibility: null,
        message: 'Executable is not runnable with the current permissions',
        diagnostics
      }
    }
    return {
      state: 'detection_failed',
      harness: probe.harness,
      reason: 'spawn_error',
      message: `Could not start the version probe: ${probe.spawnErrorCode ?? 'unknown spawn error'}`,
      diagnostics
    }
  }

  if (probe.exitCode === 0) {
    if (!probe.resolvedPath) {
      return {
        state: 'detection_failed',
        harness: probe.harness,
        reason: 'spawn_error',
        message: 'Probe exited successfully but no executable path was resolved',
        diagnostics
      }
    }
    return {
      state: 'available',
      harness: probe.harness,
      version: extractHarnessVersion(probe.stdout, probe.stderr),
      resolvedPath: probe.resolvedPath,
      diagnostics
    }
  }

  const signature = detectIncompatibility(probe)
  if (signature) {
    return {
      state: 'unavailable',
      harness: probe.harness,
      reason: 'incompatible_installation',
      incompatibility: signature.kind,
      message: 'Installed command cannot run in this environment',
      diagnostics
    }
  }

  return {
    state: 'detection_failed',
    harness: probe.harness,
    reason: 'nonzero_exit',
    message: `Version probe exited with code ${String(probe.exitCode)}`,
    diagnostics
  }
}
