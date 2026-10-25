/**
 * Windows-side process evidence for the holder.
 *
 * This module is deliberately narrow: it answers questions about **Windows**
 * PIDs only. A Guest Host PID must never reach it, which is why the type it
 * takes is `WindowsProcessId` rather than a bare number — a guest pid is a
 * `number` too, and the compiler is the cheapest place to stop that mistake.
 *
 * The default query goes through CIM (`Get-CimInstance Win32_Process`), because
 * a PID alone cannot distinguish our holder from a later process that reused the
 * PID. Creation time plus command line can, and CIM is the supported way to read
 * both on current Windows. `wmic` is deprecated, and `tasklist` reports neither.
 */

import { execFile } from 'node:child_process'

export type WindowsProcessId = number & { readonly __windowsProcessId: unique symbol }

/** Only call this for a PID the OS reported as a Windows process. */
export function asWindowsProcessId(pid: number): WindowsProcessId | null {
  return Number.isSafeInteger(pid) && pid > 0 ? (pid as WindowsProcessId) : null
}

/**
 * What the process table said. `unavailable` is not `missing`: a failed read must
 * never be read as "the holder exited", because that would license a second one.
 */
export type WindowsProcessEvidence =
  | { status: 'present'; creationTimeMs: number | null; commandLine: string | null }
  | { status: 'missing' }
  | { status: 'unavailable' }

export type WindowsProcessQuery = (pid: WindowsProcessId) => Promise<WindowsProcessEvidence>

const QUERY_TIMEOUT_MS = 8_000
/** 1601-01-01 to 1970-01-01 in 100 ns ticks. */
const FILETIME_EPOCH_OFFSET_TICKS = 116_444_736_000_000_000n

/**
 * One CIM query, tab-separated, so no JSON date marshalling is involved.
 *
 * `ProcessId` is interpolated only after `asWindowsProcessId` has proven it is a
 * positive safe integer, so the filter cannot carry anything but digits.
 */
export function buildCimQueryScript(pid: WindowsProcessId): string {
  return [
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'`,
    `if ($p) { $c = $p.CommandLine; if ($null -eq $c) { $c = '' }`,
    `"$($p.ProcessId)\`t$($p.CreationDate.ToFileTimeUtc())\`t$($c -replace "\`t", ' ')" }`
  ].join('; ')
}

export function parseCimProcessOutput(stdout: string): WindowsProcessEvidence {
  const line = stdout.split(/\r?\n/u).find((entry) => entry.trim().length > 0)
  if (!line) return { status: 'missing' }

  const [rawPid, rawTicks, ...rest] = line.split('\t')
  if (rawPid === undefined || rawTicks === undefined) return { status: 'unavailable' }
  if (!/^\d+$/u.test(rawPid.trim()) || !/^\d+$/u.test(rawTicks.trim())) {
    return { status: 'unavailable' }
  }

  const ticks = BigInt(rawTicks.trim())
  if (ticks < FILETIME_EPOCH_OFFSET_TICKS) return { status: 'unavailable' }
  const creationTimeMs = Number((ticks - FILETIME_EPOCH_OFFSET_TICKS) / 10_000n)
  const commandLine = rest.join('\t').trim()
  return {
    status: 'present',
    creationTimeMs: Number.isSafeInteger(creationTimeMs) ? creationTimeMs : null,
    commandLine: commandLine.length > 0 ? commandLine : null
  }
}

/** The holder's identifying token, mirrored in Orca's holder command line. */
export const WSL_HOLDER_MARKER = 'ade-wsl-holder'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whether a Windows command line is our holder for one distro.
 *
 * All three parts must agree: the `wsl` program, the marker token, and this
 * exact distro as `-d`'s value. A `wsl.exe` running another distro is a different
 * holder; adopting it would tie this repository to the wrong distro.
 */
export function isHolderCommandLine(commandLine: string, distro: string): boolean {
  if (!commandLine.includes(WSL_HOLDER_MARKER)) return false
  if (!/wsl(\.exe)?"?\s/iu.test(commandLine)) return false
  const distroArg = new RegExp(`(^|\\s)-d\\s+("?)${escapeRegExp(distro)}\\2(\\s|$)`, 'iu')
  return distroArg.test(commandLine)
}

export type HolderClassification = {
  state: 'live' | 'exited' | 'unverifiable'
  /** Why, for the typed error detail. Never user-facing prose about secrets. */
  reason:
    | 'evidence_unavailable'
    | 'process_missing'
    | 'creation_time_mismatch'
    | 'command_line_missing'
    | 'command_line_mismatch'
    | 'verified'
    | 'verified_without_creation_time'
}

/**
 * Classifies a holder from one evidence read.
 *
 * Order matters. A creation-time disagreement is proof of PID reuse, so it is
 * `exited` even if the command line also disagrees. A missing command line is
 * `unverifiable` rather than `exited`: something is running under that PID, and
 * declaring it dead would license spawning a second holder.
 */
export function classifyHolderEvidence(
  record: { creationTimeMs: number | null },
  evidence: WindowsProcessEvidence,
  distro: string
): HolderClassification {
  if (evidence.status === 'unavailable') {
    return { state: 'unverifiable', reason: 'evidence_unavailable' }
  }
  if (evidence.status === 'missing') {
    return { state: 'exited', reason: 'process_missing' }
  }

  const timeKnown = record.creationTimeMs !== null && evidence.creationTimeMs !== null
  if (timeKnown && record.creationTimeMs !== evidence.creationTimeMs) {
    return { state: 'exited', reason: 'creation_time_mismatch' }
  }
  if (evidence.commandLine === null) {
    return { state: 'unverifiable', reason: 'command_line_missing' }
  }
  if (!isHolderCommandLine(evidence.commandLine, distro)) {
    return { state: 'exited', reason: 'command_line_mismatch' }
  }
  if (timeKnown) return { state: 'live', reason: 'verified' }
  if (record.creationTimeMs === null) {
    // The record never had a creation time to compare; the command line decided.
    return { state: 'live', reason: 'verified_without_creation_time' }
  }
  // The record has a time and the table could not supply one: not proof either way.
  return { state: 'unverifiable', reason: 'evidence_unavailable' }
}

export type WindowsProcessDeps = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Test seam. Production uses one CIM query per call. */
  runCommand?: (program: string, args: readonly string[]) => Promise<string>
}

/**
 * Production evidence query. Any failure — no PowerShell, a timeout, an
 * unparseable row — is `unavailable`, which the classifier keeps `unverifiable`.
 */
export function createWindowsProcessQuery(deps: WindowsProcessDeps = {}): WindowsProcessQuery {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows'
  const powershell = `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  const run =
    deps.runCommand ??
    ((program: string, args: readonly string[]) =>
      new Promise<string>((resolve, reject) => {
        execFile(
          program,
          [...args],
          {
            timeout: QUERY_TIMEOUT_MS,
            windowsHide: true,
            maxBuffer: 2 * 1024 * 1024,
            encoding: 'utf8'
          },
          (error, stdout) => (error ? reject(error) : resolve(stdout))
        )
      }))

  return async (pid) => {
    if (platform !== 'win32') return { status: 'unavailable' }
    try {
      const stdout = await run(powershell, [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        buildCimQueryScript(pid)
      ])
      return parseCimProcessOutput(stdout)
    } catch {
      return { status: 'unavailable' }
    }
  }
}
