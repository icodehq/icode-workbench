/**
 * Harness discovery and launch inside a WSL distro.
 *
 * Orca's guest detection (`src/wsl-guest/preflight-handler.ts`) is the reference,
 * and two of its rules exist because WSL-specific facts break the obvious
 * implementation:
 *
 *   1. **Skip `/mnt/*` PATH entries.** WSL appends the Windows PATH, so
 *      `command -v claude` can resolve to a Windows-installed shim
 *      (`/mnt/c/nvm4w/nodejs/claude`, measured on this machine). That is not a
 *      guest install, and reporting it as one is wrong. Orca passes
 *      `skipWindowsMountDirs: true` for exactly this reason.
 *   2. **Ask the user's login shell.** A harness installed by nvm/asdf is only on
 *      the *login* PATH. Measured: non-login `wsl.exe --exec` has no `node` at
 *      all, so an nvm-installed harness would either not be found or would fail
 *      on its `#!/usr/bin/env node` shebang.
 *
 * The launch command therefore runs the harness through that same login shell,
 * with `exec` so the PTY's process *is* the harness (no wrapper shell in the
 * middle), and with the absolute guest path resolved by discovery.
 */

import type { HarnessId } from '../../../shared/domain/harness'
import type { WslCommandRunner } from '../exec'
import { quoteForShell } from '../git/guest-git'
import { PROBE_TIMEOUT_MS, type ProbeResult } from '../../harness/harness-detector'

/** Marks the resolved path so a shell banner cannot be mistaken for it. */
export const AGENT_PATH_PREFIX = '__ADE_AGENT_PATH__'

const LOOKUP_TIMEOUT_MS = 10_000
/** Shells whose startup files a package-manager install commonly relies on. */
const INTERACTIVE_SHELLS = new Set(['bash', 'zsh', 'fish'])
/** Orca's conservative allow-list: a rare shell gets the `/bin/sh` fallback. */
const SUPPORTED_SHELLS = new Set(['bash', 'zsh', 'fish', 'sh', 'dash'])

/**
 * Resolves several names in **one** login-shell call.
 *
 * Batching is not only cheaper: three concurrent interactive shells made
 * discovery intermittently report a harness that was plainly on PATH (measured
 * while wiring W7). One shell, one deterministic answer.
 *
 * `$@` carries the names, so no name is ever interpolated into this text. The
 * Windows-mount skip is the same rule Orca applies
 * (`preflight-handler.ts`, `skipWindowsMountDirs`): WSL appends the Windows PATH,
 * so a `/mnt/c/...` npm shim would otherwise read as a guest install — measured
 * on this machine, where `command -v claude` answers with a Windows shim.
 */
export const GUEST_PATH_LOOKUP_BATCH_SCRIPT = [
  '__ade_old_ifs=$IFS',
  'for __ade_name in "$@"; do',
  '  __ade_found=""',
  '  IFS=:',
  '  for __ade_dir in $PATH; do',
  '    case "$__ade_dir" in /mnt/*|/mnt) continue ;; esac',
  '    if [ -f "$__ade_dir/$__ade_name" ] && [ -x "$__ade_dir/$__ade_name" ]; then',
  '      __ade_found="$__ade_dir/$__ade_name"',
  '      break',
  '    fi',
  '  done',
  '  IFS=$__ade_old_ifs',
  `  if [ -n "$__ade_found" ]; then printf '${AGENT_PATH_PREFIX}%s=%s\\n' "$__ade_name" "$__ade_found"; fi`,
  'done'
].join('\n')

/** Prints the login `$SHELL` so the caller can ask the same shell the user has. */
export const GUEST_SHELL_SCRIPT = 'printf %s "${SHELL:-}"'

export type GuestShell = {
  /** Absolute guest path of the user's shell, or `/bin/sh`. */
  shell: string
  /** Orca's mode: interactive login for bash/zsh/fish, login for sh/dash. */
  mode: '-ilc' | '-lc'
}

function isAbsolutePosix(value: string): boolean {
  return value.startsWith('/') && !value.includes('\n') && !value.includes('\r')
}

export function shellModeFor(shell: string): '-ilc' | '-lc' {
  const name = shell.slice(shell.lastIndexOf('/') + 1).toLowerCase()
  // Why interactive: bash/zsh users commonly add package-manager bins from
  // interactive startup files. POSIX sh may not accept `-i` with `-c`.
  return INTERACTIVE_SHELLS.has(name) ? '-ilc' : '-lc'
}

/**
 * Parses `name=/absolute/path` pairs from a batch lookup.
 *
 * A relative or malformed path is dropped rather than trusted.
 */
export function parseGuestExecutableMap(stdout: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith(AGENT_PATH_PREFIX)) continue
    const body = line.slice(AGENT_PATH_PREFIX.length)
    const split = body.indexOf('=')
    if (split <= 0) continue
    const name = body.slice(0, split)
    const candidate = body.slice(split + 1)
    if (!isAbsolutePosix(candidate)) continue
    if (!found.has(name)) found.set(name, candidate)
  }
  return found
}

export type GuestHarnessProbeDeps = {
  runner: WslCommandRunner
  distro: string
  signal?: AbortSignal
}

async function runShell(
  deps: GuestHarnessProbeDeps,
  shell: string,
  mode: '-ilc' | '-lc' | '-c',
  script: string,
  argument: string | null
): Promise<{ stdout: string; code: number | null } | null> {
  const result = await deps.runner.runBytes({
    scope: 'guest',
    distro: deps.distro,
    argv: [
      shell,
      mode,
      script,
      'ade-lookup',
      ...(argument === null ? [] : [argument])
    ],
    timeoutMs: LOOKUP_TIMEOUT_MS,
    ...(deps.signal ? { signal: deps.signal } : {})
  })
  if ('status' in result) return null
  return { stdout: result.stdout.toString('utf8'), code: result.code }
}

/**
 * The user's login shell, or `/bin/sh`.
 *
 * Only a supported shell is honoured: a rare shell may not implement the lookup
 * script's POSIX constructs, and Orca restricts itself the same way.
 */
export async function resolveGuestShell(deps: GuestHarnessProbeDeps): Promise<GuestShell> {
  const result = await runShell(deps, '/bin/sh', '-c', GUEST_SHELL_SCRIPT, null)
  const shell = result?.stdout.trim() ?? ''
  const name = shell.slice(shell.lastIndexOf('/') + 1).toLowerCase()
  if (!isAbsolutePosix(shell) || !SUPPORTED_SHELLS.has(name)) {
    return { shell: '/bin/sh', mode: '-lc' }
  }
  return { shell, mode: shellModeFor(shell) }
}

/**
 * Finds several executables on the guest PATH, in one call per shell.
 *
 * Same two attempts as the single-name form, in Orca's order: the user's login
 * shell, then `/bin/sh` with the inherited PATH. Anything the first pass missed is
 * looked for again by `sh`, which is what makes a broken profile recoverable.
 */
export async function resolveGuestExecutables(
  deps: GuestHarnessProbeDeps & { names: readonly string[]; shell?: GuestShell }
): Promise<Map<string, string>> {
  const chosen = deps.shell ?? (await resolveGuestShell(deps))
  const names = [...new Set(deps.names)]
  if (names.length === 0) return new Map()

  const viaLogin = await runShellBatch(deps, chosen.shell, chosen.mode, names)
  const resolved = viaLogin === null ? new Map<string, string>() : parseGuestExecutableMap(viaLogin)
  const missing = names.filter((name) => !resolved.has(name))
  if (missing.length === 0 || chosen.shell === '/bin/sh') return resolved

  const viaSh = await runShellBatch(deps, '/bin/sh', '-c', missing)
  if (viaSh !== null) {
    for (const [name, path] of parseGuestExecutableMap(viaSh)) {
      if (!resolved.has(name)) resolved.set(name, path)
    }
  }
  return resolved
}

async function runShellBatch(
  deps: GuestHarnessProbeDeps,
  shell: string,
  mode: '-ilc' | '-lc' | '-c',
  names: readonly string[]
): Promise<string | null> {
  const result = await deps.runner.runBytes({
    scope: 'guest',
    distro: deps.distro,
    argv: [shell, mode, GUEST_PATH_LOOKUP_BATCH_SCRIPT, 'ade-lookup', ...names],
    timeoutMs: LOOKUP_TIMEOUT_MS,
    ...(deps.signal ? { signal: deps.signal } : {})
  })
  if ('status' in result) return null
  return result.stdout.toString('utf8')
}

/**
 * Finds one executable on the guest PATH.
 *
 * Two attempts, in Orca's order: the user's login shell, then `/bin/sh` with the
 * inherited PATH. The second matters when a profile is broken or absent.
 */
export async function resolveGuestExecutable(
  deps: GuestHarnessProbeDeps & { name: string; shell?: GuestShell }
): Promise<string | null> {
  const found = await resolveGuestExecutables({ ...deps, names: [deps.name] })
  return found.get(deps.name) ?? null
}

/**
 * Runs `--version` against a resolved guest executable.
 *
 * The executable's own directory is prepended to the **login** PATH: a harness is
 * usually a script whose shebang is `#!/usr/bin/env node`, and node itself may
 * only be on the login PATH.
 */
export async function probeGuestHarnessVersion(
  deps: GuestHarnessProbeDeps,
  file: string,
  args: string[],
  loginPath?: string
): Promise<ProbeResult> {
  const startedAt = Date.now()
  const directory = file.slice(0, file.lastIndexOf('/')) || '/'
  const path = loginPath && loginPath.length > 0 ? `${directory}:${loginPath}` : directory
  const result = await deps.runner.runBytes({
    scope: 'guest',
    distro: deps.distro,
    argv: ['env', `PATH=${path}`, 'NO_COLOR=1', 'CI=1', file, ...args],
    timeoutMs: PROBE_TIMEOUT_MS,
    ...(deps.signal ? { signal: deps.signal } : {})
  })
  const durationMs = Date.now() - startedAt
  if ('status' in result) {
    return {
      outcome: 'spawn_error',
      exitCode: null,
      signal: null,
      spawnErrorCode: 'ENOENT',
      stdout: '',
      stderr: '',
      durationMs
    }
  }
  if (result.timedOut) {
    return {
      outcome: 'timed_out',
      exitCode: null,
      signal: null,
      spawnErrorCode: null,
      stdout: result.stdout.toString('utf8').slice(0, 8192),
      stderr: result.stderr.toString('utf8').slice(0, 8192),
      durationMs
    }
  }
  return {
    outcome: result.code === 0 ? 'exited' : 'exited',
    exitCode: result.code,
    signal: result.signal,
    spawnErrorCode: null,
    stdout: result.stdout.toString('utf8').slice(0, 8192),
    stderr: result.stderr.toString('utf8').slice(0, 8192),
    durationMs
  }
}

/** Reads the login PATH once per distro: it is what makes a harness runnable. */
export const GUEST_LOGIN_PATH_SCRIPT = 'printf %s "$PATH"'

export async function resolveGuestLoginPath(
  deps: GuestHarnessProbeDeps,
  shell: GuestShell
): Promise<string | null> {
  const result = await runShell(deps, shell.shell, shell.mode, GUEST_LOGIN_PATH_SCRIPT, null)
  const value = result?.stdout.trim() ?? ''
  return value.includes('/') ? value : null
}

/**
 * The launch spec for a harness in a guest.
 *
 * `exec` is deliberate: the PTY's process becomes the harness itself, so exit
 * status and process identity are the harness's, with no shell in between. The
 * login shell is what puts the user's PATH (nvm, asdf, …) in scope — without it a
 * guest harness installed by a version manager cannot even resolve its own
 * interpreter.
 */
export function guestLaunchSpec(
  shell: GuestShell,
  absolutePath: string
): {
  command: string
  args: string[]
  shellWrapper: { scriptIndex: number }
} {
  return {
    command: shell.shell,
    args: [shell.mode, `exec ${quoteForShell(absolutePath)}`],
    // The harness is exec'd from the script, not from argv: anything appended to
    // argv would be the login shell's `$0`/`$1` (fixed in Work 71).
    shellWrapper: { scriptIndex: 1 }
  }
}

export type GuestHarnessContext = {
  shell: GuestShell
  loginPath: string | null
}

/** Everything discovery needs, resolved once per detection pass. */
export async function resolveGuestHarnessContext(
  deps: GuestHarnessProbeDeps
): Promise<GuestHarnessContext> {
  const shell = await resolveGuestShell(deps)
  const loginPath = await resolveGuestLoginPath(deps, shell)
  return { shell, loginPath }
}

/** Kept for callers that only need the id type in this module's signature. */
export type GuestHarnessId = HarnessId
