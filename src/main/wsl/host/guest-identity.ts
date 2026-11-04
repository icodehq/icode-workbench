/**
 * One guest execution that answers "which distro boot, and which Host process".
 *
 * Why one execution and not three. Between a `cat` of the boot id and a `cat` of
 * `/proc/<pid>/stat` a distro can restart, and the two answers would then describe
 * different boots — the exact confusion `distroInstance` exists to prevent. So the
 * pid file, the boot id, PID 1 and the Host's own stat/cmdline/meta are read by a
 * single shell script in a single `wsl.exe` call.
 *
 * The script is a constant. Its two parameters (pid file, meta path) arrive as
 * argv and are always quoted, so a path can never become shell syntax.
 */

import type { WslCommandRunner, WslExecFailureStatus } from '../exec'
import { WSL_DEFAULT_TIMEOUT_MS } from '../exec'
import { procStatStartTicks } from '../identity'
import type { GuestHostMeta } from './records'
import { parseGuestHostMeta } from './records'

const SENTINEL = '__ICODE_HOST_ID__'

/**
 * Sections, in order: boot id, PID 1 stat, Host stat, Host command line, `meta.json`.
 *
 * `tr -dc '0-9'` on the pid file is a guard as well as a convenience: a pid file
 * carrying anything but digits cannot become a path segment under `/proc`.
 */
export const GUEST_HOST_IDENTITY_SCRIPT = [
  'S=' + SENTINEL,
  `printf '%s\\n' "$S"`,
  'cat /proc/sys/kernel/random/boot_id 2>/dev/null',
  `printf '%s\\n' "$S"`,
  'cat /proc/1/stat 2>/dev/null',
  `printf '%s\\n' "$S"`,
  `__icode_pid=$(cat "$1" 2>/dev/null | tr -dc '0-9')`,
  `printf 'host_pid=%s\\n' "$__icode_pid"`,
  `if [ -n "$__icode_pid" ]; then cat "/proc/$__icode_pid/stat" 2>/dev/null; fi`,
  `printf '%s\\n' "$S"`,
  `if [ -n "$__icode_pid" ]; then tr '\\0' ' ' < "/proc/$__icode_pid/cmdline" 2>/dev/null; fi`,
  `printf '\\n%s\\n' "$S"`,
  'cat "$2" 2>/dev/null',
  `printf '%s\\n' "$S"`
].join('; ')

export function buildHostIdentityArgs(pidFile: string, metaPath: string): string[] {
  return ['sh', '-c', GUEST_HOST_IDENTITY_SCRIPT, 'icode-host-identity', pidFile, metaPath]
}

export type GuestHostIdentity = {
  bootId: string
  initTicks: string
  /** `<bootId>:<initTicks>`; changes on every distro restart. */
  distroInstance: string
  /** null means "no Host pid recorded", a valid answer, not an error. */
  hostPid: number | null
  hostStartTicks: string | null
  hostCommandLine: string | null
  meta: GuestHostMeta | null
}

export type GuestHostIdentityRead =
  | { status: 'ok'; identity: GuestHostIdentity }
  | { status: 'unparseable'; detail: string }
  | { status: 'unavailable'; reason: WslExecFailureStatus }

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

export function parseGuestHostIdentity(output: string): GuestHostIdentity | null {
  const parts = output.split(SENTINEL)
  // `before|s|boot|s|pid1|s|hoststat|s|cmdline|s|meta|s|after`
  if (parts.length < 7) return null
  const [bootSection, pidOneSection, hostStatSection, cmdLineSection, metaSection] = parts.slice(
    1,
    6
  ) as [string, string, string, string, string]

  const bootId = (bootSection.trim().split(/\s+/u).filter(Boolean).at(-1) ?? '').toLowerCase()
  if (!UUID_PATTERN.test(bootId)) return null

  const initTicks = procStatStartTicks(pidOneSection)
  if (initTicks === null) return null

  const pidMatch = /host_pid=(\d+)/u.exec(hostStatSection)
  const hostPid = pidMatch?.[1] !== undefined ? Number(pidMatch[1]) : null
  const hostStartTicks = procStatStartTicks(hostStatSection)
  const commandLine = cmdLineSection.trim()
  const meta = parseGuestHostMeta(metaSection.trim())

  return {
    bootId,
    initTicks,
    distroInstance: `${bootId}:${initTicks}`,
    hostPid: hostPid !== null && Number.isSafeInteger(hostPid) && hostPid > 0 ? hostPid : null,
    hostStartTicks,
    hostCommandLine: commandLine.length > 0 ? commandLine : null,
    meta
  }
}

export async function readGuestHostIdentity(
  runner: WslCommandRunner,
  distro: string,
  paths: { pidFile: string; metaPath: string },
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<GuestHostIdentityRead> {
  const outcome = await runner.run({
    scope: 'guest',
    distro,
    argv: buildHostIdentityArgs(paths.pidFile, paths.metaPath),
    timeoutMs: options.timeoutMs ?? WSL_DEFAULT_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {})
  })
  if (outcome.status !== 'ok') {
    return {
      status: 'unavailable',
      reason: outcome.status === 'wsl_missing' ? 'wsl_missing' : outcome.status
    }
  }
  const identity = parseGuestHostIdentity(outcome.stdout)
  if (identity === null) {
    return {
      status: 'unparseable',
      detail: `the guest did not report a boot id and PID 1 start time (${outcome.stdout
        .trim()
        .slice(0, 120)})`
    }
  }
  return { status: 'ok', identity }
}

/**
 * Whether the running process is the Host we deployed, in this boot.
 *
 * The Host's command line must name our exact entry file. That is the guest-side
 * equivalent of the holder's command-line proof, and it is the only reason a
 * Guest PID may later be signalled — by the guest, never by Windows.
 */
export function guestHostIsOurs(
  identity: GuestHostIdentity,
  expected: { entryPath: string; recordedPid?: number; recordedStartTicks?: string }
): identity is GuestHostIdentity & {
  hostPid: number
  hostStartTicks: string
  hostCommandLine: string
} {
  if (identity.hostPid === null || identity.hostStartTicks === null) return false
  if (identity.hostCommandLine === null) return false
  if (!identity.hostCommandLine.includes(expected.entryPath)) return false
  if (identity.meta !== null && identity.meta.pid !== identity.hostPid) return false
  if (expected.recordedPid !== undefined && expected.recordedPid !== identity.hostPid) return false
  if (
    expected.recordedStartTicks !== undefined &&
    expected.recordedStartTicks !== identity.hostStartTicks
  ) {
    return false
  }
  return true
}
