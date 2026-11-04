/**
 * Git inside a distro, run the way Orca runs it.
 *
 * Orca's `wslMode: 'direct-git'` (`wsl-command-runner/wsl-command-resolution.ts`)
 * is decisive: for a WSL repository it spawns
 * `wsl.exe -d <distro> --exec <git> -C <linuxPath> <args…>`. Git is *not* routed
 * through the host daemon, and the working directory is passed as `-C` rather
 * than inherited, because the Windows-side cwd is a Windows path that guest Git
 * cannot use.
 *
 * That is also the only option that fits ADE: the Host protocol carries terminal
 * session methods only (`createOrAttach`, `write`, `resize`, `kill`,
 * `listSessions`, `shutdownIfIdle`, `shutdown`, `ping`) and no exec, so "run Git
 * through the Host protocol" is not a thing that exists. This module reuses the
 * established guest-execution primitive (the same `wsl.exe` argv, program
 * resolution and interop cwd that W2 and W4 use) and adds nothing new in the
 * transport direction.
 *
 * Two properties matter more than the argv shape:
 *
 *   - **bytes, never text.** Git legitimately emits NUL bytes (`-z` listings,
 *     binary patches). The text runner's UTF-16 heuristic would corrupt them, so
 *     this path never decodes.
 *   - **argv only.** Paths travel as separate arguments after `-C`; nothing is
 *     ever concatenated into a shell string, so a path cannot become a command.
 */

import type { WslCommandRunner } from '../exec'
import { WSL_DEFAULT_TIMEOUT_MS } from '../exec'
import { isTransportFailure } from '../probe'
import {
  createGuestGitEnvironmentCache,
  fencedCommand,
  isDirectGuestGitNotFound,
  parseFencedOutput,
  type GuestGitEnvironmentCache
} from './guest-git-environment'

/** Git's own exit codes are part of the contract; only "could not run" is separate. */
export type GuestGitResult = {
  stdout: Buffer
  stderr: Buffer
  /** null when the process did not report one (killed, or `wsl.exe` absent). */
  exitCode: number | null
  timedOut: boolean
  /** Set when `wsl.exe` itself could not be started. */
  spawnFailure?: 'wsl_missing'
}

export type GuestGitRequest = {
  distro: string
  /** Guest absolute path. Passed as `-C`; never inherited from the Windows cwd. */
  cwd: string
  args: readonly string[]
  /** Payload for Git's stdin, e.g. a hunk patch for `git apply`. */
  stdin?: Buffer | string
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * Subcommands that cannot change the repository.
 *
 * Used only to decide whether a **timed-out** call may be retried. A mutation is
 * never retried: a timeout means the outcome is unknown, and re-running
 * `worktree add` or `branch -D` could apply it twice.
 */
const READ_ONLY_SUBCOMMANDS = new Set([
  'rev-parse',
  'rev-list',
  'status',
  'cat-file',
  'ls-files',
  'ls-tree',
  'diff',
  'log',
  'show',
  'for-each-ref',
  'merge-base'
])

export function isReadOnlyGit(args: readonly string[]): boolean {
  const subcommand = args[0]
  if (subcommand === undefined) return false
  if (subcommand === 'worktree') return args[1] === 'list'
  return READ_ONLY_SUBCOMMANDS.has(subcommand)
}

export type GuestGitDeps = {
  /** Probe cache, shared per process so one distro is probed once. */
  environments?: GuestGitEnvironmentCache
}

/**
 * Environment that must survive the `wsl.exe` boundary.
 *
 * `wsl.exe --exec` does not forward the caller's environment, so these are set
 * guest-side by `env`. They are the two Git settings the rest of ADE relies on:
 * never prompt, and never take an optional lock (a read must not create
 * `.git/index.lock`).
 */
export const GUEST_GIT_ENV = ['GIT_TERMINAL_PROMPT=0', 'GIT_OPTIONAL_LOCKS=0'] as const

/**
 * Marks where the login-shell fallback's payload begins and ends.
 *
 * A login shell runs the user's rc files, and those print banners on stdout. The
 * fence is the only reason a fallback can still be byte-exact: everything outside
 * it is discarded, and the payload inside it is never decoded.
 */
export const LOGIN_FENCE_START = '__ADE_GIT_OUT_START__'
export const LOGIN_FENCE_END = '__ADE_GIT_OUT_END__'
export const LOGIN_FENCE_STATUS = '__ADE_GIT_STATUS__'

/** Raised when a guest Git invocation could not run at all. */
export class GuestGitUnavailableError extends Error {
  constructor(readonly reason: 'wsl_missing', message: string) {
    super(message)
    this.name = 'GuestGitUnavailableError'
  }
}

/**
 * `wsl.exe -d <distro> --exec env GIT_…=… git -C <cwd> <args…>`
 *
 * `env` is used rather than a shell, so the value assignment cannot be affected
 * by quoting and no shell parses the path.
 */
/**
 * Per-process probe cache. One entry per distro, so a busy session does not pay
 * a login-shell probe per Git command.
 */
let sharedEnvironments: GuestGitEnvironmentCache | null = null

export function sharedGuestGitEnvironments(
  runner: WslCommandRunner
): GuestGitEnvironmentCache {
  sharedEnvironments ??= createGuestGitEnvironmentCache(runner)
  return sharedEnvironments
}

/** Test seam: forget cached routes (one suite must not leak into another). */
export function resetGuestGitEnvironments(): void {
  sharedEnvironments = null
}

/**
 * Runs Git inside a distro, choosing the environment the way Orca does.
 *
 * Three paths, in order:
 *
 *   1. **direct-git** when the probe resolved: absolute Git path, `PATH`/`HOME`
 *      from the login shell, no shell anywhere, bytes untouched.
 *   2. **login-shell fallback** when the probe found no direct route: `sh -lc`
 *      with a fence, so rc banners cannot corrupt the payload.
 *   3. **retry in the login shell** when a direct call fails with exit 127 and
 *      "not found" — the route was stale (a profile changed, or Git was removed),
 *      so the cache is invalidated and the shell is given one chance.
 */
export async function runGuestGit(
  runner: WslCommandRunner,
  request: GuestGitRequest,
  deps: GuestGitDeps = {}
): Promise<GuestGitResult> {
  const environments = deps.environments ?? sharedGuestGitEnvironments(runner)
  const timeoutMs = request.timeoutMs ?? WSL_DEFAULT_TIMEOUT_MS
  const probed = await environments.probe(request.distro, {
    ...(request.signal ? { signal: request.signal } : {})
  })

  /** One direct attempt: `env PATH HOME GIT_* <git> -C <cwd> <args>`. */
  const directAttempt = (environment: { path: string; home: string; gitPath: string }) =>
    runner.runBytes({
      scope: 'guest',
      distro: request.distro,
      argv: [
        '/usr/bin/env',
        `PATH=${environment.path}`,
        `HOME=${environment.home}`,
        ...GUEST_GIT_ENV,
        environment.gitPath,
        '-C',
        request.cwd,
        ...request.args
      ],
      timeoutMs,
      ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
      ...(request.signal ? { signal: request.signal } : {})
    })

  if (probed.kind === 'resolved') {
    let direct = await directAttempt(probed.environment)
    /**
     * Neither a timeout nor a `wsl.exe` transport failure is an answer.
     *
     * Only a read may be asked again: after a mutation the outcome is unknown, and
     * re-running `worktree add` or `branch -D` could apply it twice.
     */
    if (!('status' in direct) && isReadOnlyGit(request.args)) {
      if (isTransportFailure(direct)) {
        direct = await directAttempt(probed.environment)
      }
    }
    if ('status' in direct) {
      throw new GuestGitUnavailableError(
        'wsl_missing',
        'Git cannot run because wsl.exe is not available.'
      )
    }
    const resolved: GuestGitResult = {
      stdout: direct.stdout,
      stderr: direct.stderr,
      exitCode: direct.timedOut ? null : direct.code,
      timedOut: direct.timedOut
    }
    if (!isDirectGuestGitNotFound({ exitCode: resolved.exitCode, stderr: resolved.stderr })) {
      return resolved
    }
    // The probe's route is stale: re-probe next time.
    environments.invalidate(request.distro)
  }

  return runInLoginShell(runner, request, timeoutMs)
}

/**
 * The fallback: Git in the user's login shell, output fenced.
 *
 * The command is built with `quotePosixShell`-style single-quoting of every word,
 * so a path or argument can never become shell syntax.
 */
async function runInLoginShell(
  runner: WslCommandRunner,
  request: GuestGitRequest,
  timeoutMs: number
): Promise<GuestGitResult> {
  const invocation = ['git', '-C', request.cwd, ...request.args].map(quoteForShell).join(' ')
  const result = await runner.runBytes({
    scope: 'guest',
    distro: request.distro,
    argv: ['sh', '-lc', fencedCommand(invocation)],
    timeoutMs,
    ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
    ...(request.signal ? { signal: request.signal } : {})
  })
  if ('status' in result) {
    throw new GuestGitUnavailableError(
      'wsl_missing',
      'Git cannot run because wsl.exe is not available.'
    )
  }
  if (result.timedOut) {
    return {
      stdout: Buffer.alloc(0),
      stderr: Buffer.from('Git timed out.'),
      exitCode: null,
      timedOut: true
    }
  }

  const parsed = parseFencedOutput(result.stdout)
  if (parsed === null) {
    // No fence means the shell never reached the command. Report it as Git
    // failing to start rather than as an empty success.
    return {
      stdout: Buffer.alloc(0),
      stderr: result.stderr,
      exitCode: result.code ?? 127,
      timedOut: false
    }
  }
  return {
    stdout: parsed.payload,
    stderr: result.stderr,
    exitCode: parsed.stderrStatus ?? result.code,
    timedOut: false
  }
}

/** POSIX single-quoting: nothing in the word is interpreted by the shell. */
export function quoteForShell(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`
}

/** UTF-8 view for the callers that need text; trimming matches the local wrapper. */
export function guestGitText(result: GuestGitResult): string {
  return result.stdout.toString('utf8').trim()
}

/**
 * A local `execFile('git', ...)` shaped result, so one caller can consume both.
 * `GuestGitResult` is the richer type; the local path narrows into it.
 */
export type GitCommandResult = GuestGitResult
