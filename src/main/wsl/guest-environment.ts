/**
 * What the guest can actually run.
 *
 * The probe answers a narrow question W3/W4/W7 depend on: does this distro have
 * the interpreter and Git that a Host deployment needs, and where are they?
 *
 * Two deliberate properties:
 *
 *   - **Sentinels.** Only lines between a pair of markers are parsed, and only
 *     `key=value` lines inside them. A login profile that prints a greeting, an
 *     MOTD or a version-manager banner therefore cannot corrupt the result — and
 *     that is the ordinary case for the login-shell half of this probe, not an
 *     edge case.
 *   - **Both contexts are reported.** A non-login `sh -c` does not read the
 *     user's profile, so a distro where `node` is installed through nvm reports
 *     nothing there. The login-shell half reports what a terminal would see. The
 *     caller gets both instead of one number that is wrong in one of the two
 *     cases.
 */

import type { WslCommandRunner, WslExecFailureStatus } from './exec'
import { WSL_DEFAULT_TIMEOUT_MS } from './exec'

const PLATFORM_SENTINEL = '__ICODE_PLATFORM__'
const LOGIN_SENTINEL = '__ICODE_LOGIN__'

/**
 * Constant scripts. No caller value is interpolated; every substitution is
 * guest-side, so a distro name or a path can never become shell syntax.
 */
export const GUEST_PLATFORM_SCRIPT = [
  `printf '%s\\n' ${PLATFORM_SENTINEL}`,
  `printf 'os_id=%s\\n' "$( (. /etc/os-release 2>/dev/null && printf '%s' "\${ID:-}") 2>/dev/null)"`,
  `printf 'os_version=%s\\n' "$( (. /etc/os-release 2>/dev/null && printf '%s' "\${VERSION_ID:-}") 2>/dev/null)"`,
  `printf 'arch=%s\\n' "$(uname -m 2>/dev/null)"`,
  `printf 'glibc=%s\\n' "$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')"`,
  `printf 'node_path=%s\\n' "$(command -v node 2>/dev/null)"`,
  `printf 'node_version=%s\\n' "$(node --version 2>/dev/null)"`,
  `printf 'git_path=%s\\n' "$(command -v git 2>/dev/null)"`,
  `printf 'git_version=%s\\n' "$(git --version 2>/dev/null)"`,
  `printf '%s\\n' ${PLATFORM_SENTINEL}`
].join('; ')

export const GUEST_LOGIN_SCRIPT = [
  `__icode_shell=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)`,
  `if [ -z "$__icode_shell" ] || [ ! -x "$__icode_shell" ]; then __icode_shell="\${SHELL:-/bin/sh}"; fi`,
  `printf '%s\\n' ${LOGIN_SENTINEL}`,
  `printf 'login_shell=%s\\n' "$__icode_shell"`,
  `"$__icode_shell" -lc 'printf "login_path=%s\\n" "$PATH"; printf "login_node_path=%s\\n" "$(command -v node 2>/dev/null)"; printf "login_node_version=%s\\n" "$(node --version 2>/dev/null)"; printf "login_git_path=%s\\n" "$(command -v git 2>/dev/null)"; printf "login_git_version=%s\\n" "$(git --version 2>/dev/null)"' 2>/dev/null`,
  `printf '%s\\n' ${LOGIN_SENTINEL}`
].join('; ')

/** One executable as the guest reports it. An absent one is `null`, never "". */
export type GuestExecutable = {
  path: string | null
  version: string | null
}

export type GuestPlatform = {
  /** `/etc/os-release` ID, e.g. `ubuntu`. */
  osId: string | null
  osVersion: string | null
  /** `uname -m`, e.g. `x86_64`. */
  arch: string | null
  /** glibc version without the `glibc ` prefix. */
  glibc: string | null
  node: GuestExecutable
  git: GuestExecutable
}

/** What the user's login shell sees. Absent when it could not be run. */
export type GuestLoginEnvironment = {
  shell: string | null
  pathVariable: string | null
  node: GuestExecutable
  git: GuestExecutable
}

export type WslGuestEnvironment = {
  platform: GuestPlatform
  /** null when the login-shell probe failed; a Host can still deploy without it. */
  login: GuestLoginEnvironment | null
}

export type WslGuestEnvironmentRead =
  | { status: 'ok'; environment: WslGuestEnvironment }
  | { status: 'unavailable'; reason: WslExecFailureStatus }

/**
 * Parses `key=value` lines from the section between two sentinels.
 *
 * Anything that is not a `key=value` line is discarded, which is what makes a
 * noisy profile harmless. A repeated key keeps its first value so a profile that
 * re-exports `PATH` cannot overwrite the measurement.
 */
export function parseFramedValues(output: string, sentinel: string): Map<string, string> {
  const parts = output.split(sentinel)
  const values = new Map<string, string>()
  if (parts.length < 3) return values
  // Bodies are sandwiched between markers; join the middle ones in case the guest
  // echoes a marker itself.
  const body = parts.slice(1, -1).join('\n')
  for (const line of body.split(/\r?\n/u)) {
    const match = /^([a-z_][\w]*)=(.*)$/u.exec(line.trim())
    if (!match) continue
    const [, key, value] = match as unknown as [string, string, string]
    if (!values.has(key)) values.set(key, value.trim())
  }
  return values
}

function text(values: Map<string, string>, key: string): string | null {
  const value = values.get(key)
  return value !== undefined && value.length > 0 ? value : null
}

function executable(
  values: Map<string, string>,
  pathKey: string,
  versionKey: string
): GuestExecutable {
  return { path: text(values, pathKey), version: text(values, versionKey) }
}

export function parseGuestPlatform(output: string): GuestPlatform | null {
  const values = parseFramedValues(output, PLATFORM_SENTINEL)
  // `arch` is the one field a healthy guest always answers; without it the
  // section was not ours to parse.
  const arch = text(values, 'arch')
  if (arch === null && values.size === 0) return null
  return {
    osId: text(values, 'os_id'),
    osVersion: text(values, 'os_version'),
    arch,
    glibc: text(values, 'glibc'),
    node: executable(values, 'node_path', 'node_version'),
    git: executable(values, 'git_path', 'git_version')
  }
}

export function parseGuestLoginEnvironment(output: string): GuestLoginEnvironment | null {
  const values = parseFramedValues(output, LOGIN_SENTINEL)
  if (values.size === 0) return null
  return {
    shell: text(values, 'login_shell'),
    pathVariable: text(values, 'login_path'),
    node: executable(values, 'login_node_path', 'login_node_version'),
    git: executable(values, 'login_git_path', 'login_git_version')
  }
}

/**
 * Probes platform facts, then the login-shell view.
 *
 * The second probe is best-effort: a distro whose login shell hangs or prints
 * nothing still yields a usable platform result, so a Host deploy only needs the
 * first to succeed.
 */
export async function probeGuestEnvironment(
  runner: WslCommandRunner,
  distro: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<WslGuestEnvironmentRead> {
  const timeoutMs = options.timeoutMs ?? WSL_DEFAULT_TIMEOUT_MS

  const platformOutcome = await runner.run({
    scope: 'guest',
    distro,
    argv: ['sh', '-c', GUEST_PLATFORM_SCRIPT],
    timeoutMs,
    ...(options.signal ? { signal: options.signal } : {})
  })
  if (platformOutcome.status !== 'ok') {
    return {
      status: 'unavailable',
      reason: platformOutcome.status === 'wsl_missing' ? 'wsl_missing' : platformOutcome.status
    }
  }
  const platform = parseGuestPlatform(platformOutcome.stdout)
  if (platform === null) {
    // A guest that ran but produced nothing parseable is reported as a failure to
    // answer, not as a distro that lacks Node.
    return { status: 'unavailable', reason: 'exit_failure' }
  }

  const loginOutcome = await runner.run({
    scope: 'guest',
    distro,
    argv: ['sh', '-c', GUEST_LOGIN_SCRIPT],
    timeoutMs,
    ...(options.signal ? { signal: options.signal } : {})
  })
  const login =
    loginOutcome.status === 'ok' ? parseGuestLoginEnvironment(loginOutcome.stdout) : null

  return { status: 'ok', environment: { platform, login } }
}
