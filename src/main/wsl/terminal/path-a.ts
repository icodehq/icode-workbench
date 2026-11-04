/**
 * Path A: the local WSL terminal.
 *
 * Two WSL paths exist in iCode on purpose and must not collapse into one:
 *
 *   - **Path A (this module).** A terminal runs on the *desktop* PTY Host, whose
 *     child process is `wsl.exe`. The guest shell is inside that process, so
 *     input, output and resize ride the ordinary ConPTY of the local Host. No
 *     managed Guest Host, no relay, no bridge.
 *   - **Path B (`wsl/harness`, `wsl/relay`).** A coding Agent runs on the managed
 *     Guest Host, reached through the W5 relay.
 *
 * Orca's Path A is `resolveWindowsShellLaunchArgs` for `wsl.exe`
 * (`providers/windows-shell-args.ts:136-150`, call sites `:225-245`):
 *
 *     wsl.exe -d <distro> --exec sh -c \
 *       'cd <linuxCwd> && export PATH="$HOME/.local/bin:$PATH" && <interactive login shell>'
 *
 * Three details in that shape are load-bearing, and each was checked against the
 * Orca source rather than assumed:
 *
 *   1. **`--exec`, not `--`.** `wsl.exe -d d -- argv` expands `$name` in every
 *      argument against the guest environment before the guest runs
 *      (`shared/wsl-login-shell-command.ts:8-17`), which would silently rewrite a
 *      path or a script.
 *   2. **The PTY's cwd is a machine-local directory, never the Linux path.**
 *      Orca returns `effectiveCwd: defaultCwd` for exactly this reason. A ConPTY
 *      whose cwd is `/home/you/repo` cannot start at all.
 *   3. **The interactive login shell is resolved inside the guest**
 *      (`buildWslInteractiveLoginShellCommand`): `getent passwd` → `$SHELL` →
 *      `/bin/sh`. WSL users customise zsh, and a harness-detected shell would be
 *      the wrong one.
 */

import type { AppError } from '../../../shared/domain/errors'
import { makeAppError } from '../../../shared/domain/errors'
import type { ExecutionTarget } from '../../../shared/domain/repository'
import type { HarnessId } from '../../../shared/domain/harness'
import { resolveWslExecutablePath, type WslCommandRunner } from '../exec'
import { runIdempotentGuest } from '../probe'
import {
  RepositoryTargetError,
  revalidateRepositoryTarget,
  type TargetValidator
} from '../repository-target'

/** Marks the shell this script execs, so a test can see which branch ran. */
const SCRIPT_TAG = 'icode-wsl-terminal'

/**
 * Resolves the distro's login shell and replaces this process with it.
 *
 * A constant script whose only variable is `$1`: Orca quotes the path into the
 * script text, whereas here it travels as a positional argument, so no path can
 * ever be parsed as shell syntax. `exec` matters: the PTY's child becomes the
 * shell itself, so `exit` reaches the host with the shell's own status.
 */
export const WSL_INTERACTIVE_LOGIN_SHELL_SCRIPT = [
  `__icode_cwd="$1"`,
  `cd "$__icode_cwd" || { printf '%s\\n' "iCode: cannot enter $__icode_cwd" >&2; exit 1; }`,
  // Orca prepends this so a user-local install is reachable from the pane.
  'export PATH="$HOME/.local/bin:$PATH"',
  '__icode_shell=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)',
  'if [ -z "$__icode_shell" ] || [ ! -x "$__icode_shell" ]; then',
  '  __icode_shell="${SHELL:-/bin/bash}"',
  'fi',
  'if [ -z "$__icode_shell" ] || [ ! -x "$__icode_shell" ]; then',
  '  __icode_shell=/bin/sh',
  'fi',
  '__icode_name=$(basename "$__icode_shell" | tr "[:upper:]" "[:lower:]")',
  'case "$__icode_name" in',
  // bash/zsh/ksh read their PATH additions from interactive rc files.
  '  bash|zsh|ksh|mksh|ash) exec "$__icode_shell" -il ;;',
  // fish has no `-i` with `-l` combination in the same way; `-l` is its login mode.
  '  fish) exec "$__icode_shell" -l ;;',
  '  sh|dash) exec "$__icode_shell" -l ;;',
  '  *) exec /bin/sh -l ;;',
  'esac'
].join('\n')

/**
 * `wsl.exe` argv for one Path A terminal.
 *
 * `distro` is required: a terminal must never silently attach to whichever distro
 * happens to be the Windows default.
 */
export function buildWslTerminalArgs(distro: string, guestCwd: string): string[] {
  return [
    '-d',
    distro,
    '--exec',
    'sh',
    '-c',
    WSL_INTERACTIVE_LOGIN_SHELL_SCRIPT,
    SCRIPT_TAG,
    guestCwd
  ]
}

/**
 * Whether a (harness, target) pair is a Path A terminal.
 *
 * The single definition of "this is Path A": a terminal is the *shell* harness on
 * a WSL repository. Everything that touches a session's PTY asks this — creating,
 * attaching, writing, resizing, stopping, reconciling and removing — because a
 * Path A PTY is owned by the desktop Host, not by the distro's managed Host. A
 * second copy of this rule is how a live terminal gets reported dead.
 */
export function isPathATerminal(harness: HarnessId, target: ExecutionTarget): boolean {
  return harness === 'shell' && target.kind === 'wsl'
}

/** The host that owns a session's PTY: the desktop Host for Path A. */
export function hostTargetFor(harness: HarnessId, target: ExecutionTarget): ExecutionTarget {
  return isPathATerminal(harness, target) ? LOCAL_TARGET : target
}

/** The desktop host, spelled once. */
export const LOCAL_TARGET: ExecutionTarget = { kind: 'local' }

export type PathATerminalLaunch = {
  /** Always `wsl.exe`; the guest shell is its child. */
  command: string
  args: string[]
  /** The PTY's own cwd: machine-local, never the Linux path. */
  ptyCwd: string
  /** Where the guest shell starts. Recorded for diagnostics and tests. */
  guestCwd: string
  distro: string
}

export type PathATerminalFailure = {
  code: 'WSL_UNAVAILABLE' | 'WSL_DISTRO_NOT_FOUND' | 'PATH_NOT_FOUND' | 'NOT_A_DIRECTORY' | 'SPAWN_FAILED'
  error: AppError
}

export type PathATerminalOutcome =
  | { status: 'ready'; launch: PathATerminalLaunch }
  /** Not a WSL target: the caller keeps its local terminal path. */
  | { status: 'not_wsl' }
  | { status: 'failed'; failure: PathATerminalFailure }

export type PathATerminalDeps = {
  runner: WslCommandRunner
  validateTarget: TargetValidator
  /** Machine-local directory the PTY itself starts in (must exist locally). */
  ptyCwd: string
  /** Test seam: guest directory probe. */
  guestIsDirectory?: (distro: string, path: string) => Promise<boolean | null>
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

function failure(
  code: PathATerminalFailure['code'],
  message: string,
  detail?: string
): PathATerminalOutcome {
  return {
    status: 'failed',
    failure: { code, error: makeAppError(code, message, detail === undefined ? {} : { detail }) }
  }
}

/**
 * Validates the target, the distro and the guest directory, then builds the launch.
 *
 * Order matters: the target is re-proved first (a replaced registration must fail
 * before anything is spawned), then the guest directory is checked **in the
 * guest**, and only then is an argv produced. A failure here means no PTY at all —
 * never a local shell in its place.
 */
export async function resolvePathATerminal(
  target: ExecutionTarget,
  guestCwd: string,
  deps: PathATerminalDeps
): Promise<PathATerminalOutcome> {
  if (target.kind !== 'wsl') return { status: 'not_wsl' }

  let distro: string
  try {
    const proven = await revalidateRepositoryTarget(target, deps.validateTarget)
    if (proven === null) return { status: 'not_wsl' }
    distro = proven.distro
  } catch (error) {
    if (error instanceof RepositoryTargetError) {
      return { status: 'failed', failure: { code: 'WSL_DISTRO_NOT_FOUND', error: error.appError } }
    }
    throw error
  }

  if (!guestCwd.startsWith('/')) {
    return failure(
      'PATH_NOT_FOUND',
      'A WSL terminal needs an absolute path inside the distro.',
      guestCwd
    )
  }

  const probe = deps.guestIsDirectory ?? defaultGuestIsDirectory(deps.runner)
  const isDirectory = await probe(distro, guestCwd)
  if (isDirectory === false) {
    return failure(
      'NOT_A_DIRECTORY',
      'That folder is not available in the WSL distro.',
      `${distro}: ${guestCwd}`
    )
  }
  if (isDirectory === null) {
    // The guest could not answer. Refusing is the only honest outcome: launching
    // anyway could leave the shell in the wrong directory, and falling back to a
    // local shell would silently be the wrong machine.
    return failure(
      'WSL_UNAVAILABLE',
      'The WSL distro did not answer, so the terminal was not started.',
      distro
    )
  }

  return {
    status: 'ready',
    launch: {
      command: resolveWslExecutablePath(deps.env ?? process.env, deps.platform ?? process.platform),
      args: buildWslTerminalArgs(distro, guestCwd),
      ptyCwd: deps.ptyCwd,
      guestCwd,
      distro
    }
  }
}

/** `test -d` in the guest; `null` means "could not ask". */
function defaultGuestIsDirectory(
  runner: WslCommandRunner
): (distro: string, path: string) => Promise<boolean | null> {
  return async (distro, path) => {
    const result = await runIdempotentGuest(runner, {
      scope: 'guest',
      distro,
      argv: ['sh', '-c', 'test -d "$1"', 'icode-path-a', path],
      timeoutMs: 10_000
    })
    if ('status' in result) return null
    if (result.timedOut) return null
    return result.code === 0
  }
}
