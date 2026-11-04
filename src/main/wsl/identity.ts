/**
 * Which boot a distro is currently on.
 *
 * A distro's *registration* (W1's `distroId`) never changes across a restart, so
 * it cannot tell "the Host I recorded is still there" from "the Host died with
 * the previous boot and a new process reused its PID". Two Linux facts can:
 *
 *   - `/proc/sys/kernel/random/boot_id` — a fresh UUID per kernel boot;
 *   - field 22 of `/proc/1/stat` — PID 1's start time in clock ticks since boot.
 *
 * Together they name one distro boot instance. Nothing here reads a Windows PID
 * and nothing here calls `process.kill`: a guest PID means nothing on the host,
 * and a signal sent from Windows cannot prove a Linux process is alive.
 *
 * Parse failure is `unparseable`, not an identity. A guest that cannot answer is
 * reported as such; inventing an identity would let a stale Host look current.
 */

import type { WslCommandRunner, WslExecFailureStatus } from './exec'
import { WSL_DEFAULT_TIMEOUT_MS } from './exec'

/** Framing marker: everything outside a pair of these is guest noise. */
const SENTINEL = '__ICODE_IDENTITY__'

/**
 * A constant script: no caller value is interpolated, so no shell-quoting
 * question arises. `sh` is used rather than the user's login shell so a profile
 * cannot run here at all.
 */
export const GUEST_IDENTITY_SCRIPT = [
  `printf '%s\\n' ${SENTINEL}`,
  'cat /proc/sys/kernel/random/boot_id 2>/dev/null',
  `printf '%s\\n' ${SENTINEL}`,
  'cat /proc/1/stat 2>/dev/null',
  `printf '%s\\n' ${SENTINEL}`
].join('; ')

export type WslGuestIdentity = {
  /** Kernel boot UUID, lowercase. */
  bootId: string
  /** PID 1 start time in clock ticks since boot. */
  initStartTicks: string
  /** `<bootId>:<initStartTicks>` — one distro boot instance. */
  distroInstance: string
}

export type WslGuestIdentityRead =
  | { status: 'ok'; identity: WslGuestIdentity }
  | { status: 'unparseable'; detail: string }
  | { status: 'unavailable'; reason: WslExecFailureStatus }

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Field 22 of `/proc/<pid>/stat`, which is the process start time.
 *
 * The command name in field 2 is wrapped in parentheses and may itself contain
 * spaces and parentheses, so the fields are counted from the last `)`. Field 3
 * (state) is then index 0, which puts field 22 at index 19.
 */
export function procStatStartTicks(stat: string): string | null {
  const nameEnd = stat.lastIndexOf(')')
  if (nameEnd === -1) return null
  const fields = stat.slice(nameEnd + 1).trim().split(/\s+/)
  const ticks = fields[19]
  return ticks !== undefined && /^\d+$/u.test(ticks) ? ticks : null
}

/** Splits sentinel-framed output into its sections, ignoring anything outside. */
function frameSections(output: string): string[] {
  const parts = output.split(SENTINEL)
  // `before|sentinel|body|sentinel|body|sentinel|after` → the bodies are 2 and 3.
  return parts.length >= 4 ? [parts[1] ?? '', parts[2] ?? ''] : []
}

export function parseGuestIdentity(output: string): WslGuestIdentity | null {
  const sections = frameSections(output)
  if (sections.length !== 2) return null

  // A login banner may print before the first sentinel; the boot id is the last
  // token of its section, so leading noise does not matter.
  const bootId = sections[0]!.trim().split(/\s+/u).filter(Boolean).at(-1) ?? ''
  if (!UUID_PATTERN.test(bootId)) return null

  const initStartTicks = procStatStartTicks(sections[1]!)
  if (initStartTicks === null) return null

  const normalizedBootId = bootId.toLowerCase()
  return {
    bootId: normalizedBootId,
    initStartTicks,
    distroInstance: `${normalizedBootId}:${initStartTicks}`
  }
}

/** Reads one distro boot instance. Never throws. */
export async function readGuestIdentity(
  runner: WslCommandRunner,
  distro: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<WslGuestIdentityRead> {
  const outcome = await runner.run({
    scope: 'guest',
    distro,
    argv: ['sh', '-c', GUEST_IDENTITY_SCRIPT],
    timeoutMs: options.timeoutMs ?? WSL_DEFAULT_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {})
  })

  if (outcome.status !== 'ok') {
    return {
      status: 'unavailable',
      reason: outcome.status === 'wsl_missing' ? 'wsl_missing' : outcome.status
    }
  }

  const identity = parseGuestIdentity(outcome.stdout)
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
