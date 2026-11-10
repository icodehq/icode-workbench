/**
 * Which environment Git runs in inside a distro — Orca's strategy, verified.
 *
 * Orca's rule (`git/wsl-git-read-environment.ts` + `wsl-command-resolution.ts`) is
 * not "always use a login shell". It is:
 *
 *   1. **Probe once per distro**, in the login shell, for `$PATH`, the absolute
 *      Git path and `$HOME`. The probe refuses (`exit 127`) when Git is not on
 *      the login PATH, and refuses (`exit 78`) when the login environment sets
 *      `XDG_CONFIG_HOME`, `LD_LIBRARY_PATH` or any `GIT_*` variable — because a
 *      direct spawn with only PATH/HOME would then behave differently from the
 *      shell the user actually uses.
 *   2. **Run `direct-git`** — `wsl.exe --exec /usr/bin/env PATH=… HOME=… <git> -C …`
 *      — shell-free, argv, byte-exact, for every call.
 *   3. **Fall back to the login shell** only when the probe could not resolve, or
 *      when a direct call fails with exit 127 and "not found"/"No such file".
 *
 * That last point is the important one for iCode. A distro where `git` lives on a
 * login-only PATH (nvm, asdf, a custom profile) works in Orca and would fail with
 * a naive `--exec git`, which is exactly what W60 shipped.
 *
 * The probe is cached per distro. A settled "no direct route" answer is cached too,
 * so a distro without Git does not pay a probe on every command.
 */

import type { WslCommandRunner } from '../exec'
import { LOGIN_FENCE_END, LOGIN_FENCE_START, LOGIN_FENCE_STATUS } from './guest-git'

// Re-exported so a caller that fences output does not need two import sites.
export { LOGIN_FENCE_END, LOGIN_FENCE_START, LOGIN_FENCE_STATUS }

export type GuestGitEnvironment = {
  /** Absolute Git path discovered in the login shell. */
  gitPath: string
  /** Login-shell `$PATH`, so the direct spawn finds the same helpers Git expects. */
  path: string
  home: string
}

const PROBE_TIMEOUT_MS = 10_000

/**
 * Constant probe. It prints `PATH\0gitPath\0HOME` only when a direct route is safe.
 *
 * The exit codes are part of the contract and are documented where they are used:
 * `127` means "no usable Git on the login PATH", `78` means "the login environment
 * would make a direct spawn diverge".
 */
export const GUEST_GIT_PROBE_SCRIPT = [
  '_ade_git=$(command -v git 2>/dev/null || true)',
  'case "$_ade_git" in /*) [ -x "$_ade_git" ] || exit 127 ;; *) exit 127 ;; esac',
  'if [ -n "${XDG_CONFIG_HOME:-}" ] || [ -n "${LD_LIBRARY_PATH:-}" ] || env | grep -q "^GIT_"; then exit 78; fi',
  // No trailing `exit`: the fence writer needs to run after this. A probe that
  // exits here would never emit its end marker.
  `printf '%s\\0%s\\0%s' "$PATH" "$_ade_git" "$HOME"`
].join('\n')

export function parseGuestGitProbe(stdout: Buffer): GuestGitEnvironment | null {
  // The probe writes NUL-separated fields inside a fenced region; anything the
  // login shell printed before the fence is not ours.
  const start = stdout.indexOf(LOGIN_FENCE_START)
  const end = stdout.indexOf(LOGIN_FENCE_END)
  if (start === -1 || end === -1 || end < start) return null
  const body = stdout.subarray(start + LOGIN_FENCE_START.length, end)
  const fields = body.toString('utf8').split('\u0000')
  const path = fields[0] ?? ''
  const gitPath = fields[1] ?? ''
  const home = fields[2] ?? ''
  if (
    !path.includes('/') ||
    path.length > 32_768 ||
    !gitPath.startsWith('/') ||
    gitPath.includes('\n') ||
    gitPath.includes('\r') ||
    !home.startsWith('/') ||
    home.includes('\n') ||
    home.includes('\r')
  ) {
    return null
  }
  return { gitPath, path, home }
}

/** Wraps a guest command so a login shell's banner cannot corrupt its output. */
export function fencedCommand(command: string): string {
  return [
    `printf '%s' '${LOGIN_FENCE_START}'`,
    command,
    `__icode_status=$?`,
    `printf '%s' '${LOGIN_FENCE_END}'`,
    `printf '%s%s' '${LOGIN_FENCE_STATUS}' "$__icode_status"`,
    'exit "$__icode_status"'
  ].join('\n')
}

export type GuestGitProbeOutcome =
  | { kind: 'resolved'; environment: GuestGitEnvironment }
  /** `no_git` = 127, `unsafe_env` = 78. Both mean "use the login shell". */
  | { kind: 'no_direct_route'; reason: 'no_git' | 'unsafe_env' | 'unparseable' }
  /** The probe itself could not run; retried on the next call. */
  | { kind: 'transient' }

export type GuestGitEnvironmentCache = {
  probe(distro: string, options?: { signal?: AbortSignal }): Promise<GuestGitProbeOutcome>
  /** Drops a cached route, so the next call re-probes. */
  invalidate(distro: string): void
  /** Whether a probe has already settled for this distro. */
  isSettled(distro: string): boolean
}

function keyOf(distro: string): string {
  return distro.trim().toLowerCase()
}

export function createGuestGitEnvironmentCache(
  runner: WslCommandRunner
): GuestGitEnvironmentCache {
  // A settled answer is what lets every later call skip the probe wait.
  const settled = new Map<string, GuestGitEnvironment | null>()
  const inFlight = new Map<string, Promise<GuestGitProbeOutcome>>()

  const probe = async (
    distro: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<GuestGitProbeOutcome> => {
    const key = keyOf(distro)
    if (settled.has(key)) {
      const cached = settled.get(key) ?? null
      return cached === null
        ? { kind: 'no_direct_route', reason: 'no_git' }
        : { kind: 'resolved', environment: cached }
    }
    const existing = inFlight.get(key)
    if (existing) return existing

    const pending = (async (): Promise<GuestGitProbeOutcome> => {
      const result = await runner.runBytes({
        scope: 'guest',
        label: 'git-env-probe',
        distro,
        // The login shell, because that is where the user's PATH lives.
        argv: ['sh', '-lc', fencedCommand(GUEST_GIT_PROBE_SCRIPT)],
        timeoutMs: PROBE_TIMEOUT_MS,
        ...(options.signal ? { signal: options.signal } : {})
      })
      if ('status' in result) return { kind: 'transient' }
      if (result.timedOut) return { kind: 'transient' }

      if (result.code === 127) {
        settled.set(key, null)
        return { kind: 'no_direct_route', reason: 'no_git' }
      }
      if (result.code === 78) {
        settled.set(key, null)
        return { kind: 'no_direct_route', reason: 'unsafe_env' }
      }
      const environment = parseGuestGitProbe(result.stdout)
      if (environment === null) {
        // Unparseable output is not a settled answer: the distro may be booting.
        return { kind: 'no_direct_route', reason: 'unparseable' }
      }
      settled.set(key, environment)
      return { kind: 'resolved', environment }
    })()

    inFlight.set(key, pending)
    try {
      return await pending
    } finally {
      inFlight.delete(key)
    }
  }

  return {
    probe,
    invalidate(distro) {
      const key = keyOf(distro)
      settled.delete(key)
      inFlight.delete(key)
    },
    isSettled(distro) {
      return settled.has(keyOf(distro))
    }
  }
}

/** Bound on the probe's contribution to one command's latency. */
export const GUEST_GIT_PROBE_WAIT_MS = 1_500

/** True when a direct spawn failed because Git was not found after all. */
export function isDirectGuestGitNotFound(result: {
  exitCode: number | null
  stderr: Buffer
}): boolean {
  if (result.exitCode !== 127) return false
  const message = result.stderr.toString('utf8')
  return message.includes('not found') || message.includes('No such file')
}

/**
 * Extracts a fenced payload and its status from a login-shell run.
 *
 * Everything the rc files printed is outside the fence and is dropped. The status
 * line follows the end marker so the real exit code survives even when the shell
 * itself returns something else.
 */
export function parseFencedOutput(stdout: Buffer): {
  payload: Buffer
  stderrStatus: number | null
} | null {
  const start = stdout.indexOf(LOGIN_FENCE_START)
  const end = stdout.indexOf(LOGIN_FENCE_END)
  if (start === -1 || end === -1 || end < start) return null
  const payload = stdout.subarray(start + LOGIN_FENCE_START.length, end)
  const tail = stdout.subarray(end + LOGIN_FENCE_END.length).toString('utf8')
  const match = new RegExp(`${LOGIN_FENCE_STATUS}(\\d+)`).exec(tail)
  return { payload, stderrStatus: match?.[1] !== undefined ? Number(match[1]) : null }
}
