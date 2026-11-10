/**
 * Runs a multi-step guest Git script in one `wsl.exe` spawn.
 *
 * The session-create path used to run five `rev-parse` calls and six marker
 * probes as eleven separate guest processes. This runner keeps the same
 * environment resolution as `runGuestGit` (the user's login PATH, `$HOME`, and
 * `GIT_TERMINAL_PROMPT=0`/`GIT_OPTIONAL_LOCKS=0`) but lets a caller hand over a
 * constant script that performs the whole read or the whole mutation.
 *
 * Two rules are inherited unchanged:
 *   - **argv only.** Paths and arguments are positional parameters (`$1`, …);
 *     nothing untrusted is interpolated into the script text.
 *   - **A mutation is never retried.** A timeout after `worktree add` has an
 *     unknown outcome, and re-running it could apply the mutation twice.
 */

import {
  GUEST_GIT_ENV,
  sharedGuestGitEnvironments
} from './guest-git'
import {
  isDirectGuestGitNotFound,
  type GuestGitEnvironment
} from './guest-git-environment'
import { isTransportFailure, runIdempotentGuest } from '../probe'
import type { WslByteResult, WslCommandRunner } from '../exec'

export type GuestGitScriptRequest = {
  distro: string
  label: string
  /** Constant script; `$1` is the git program, `$2...` are `args`. */
  script: string
  args: readonly string[]
  timeoutMs: number
  /** A mutation is executed exactly once; reads may retry transport failures. */
  mutation: boolean
  signal?: AbortSignal
}

export type GuestGitScriptOutcome =
  | { status: 'ok'; stdout: string; stderr: string; code: number | null }
  | { status: 'transport'; detail: string; timedOut: boolean }

export type GuestGitScriptRunner = (
  request: GuestGitScriptRequest
) => Promise<GuestGitScriptOutcome>

type ByteLaunch = WslByteResult | { status: 'wsl_missing' }

function ok(result: WslByteResult): GuestGitScriptOutcome {
  return {
    status: 'ok',
    stdout: result.stdout.toString('utf8'),
    stderr: result.stderr.toString('utf8'),
    code: result.timedOut ? null : result.code
  }
}

function transport(result: WslByteResult, detail: string): GuestGitScriptOutcome {
  return { status: 'transport', detail, timedOut: result.timedOut }
}

export function createGuestGitScriptRunner(
  runner: WslCommandRunner
): GuestGitScriptRunner {
  return async (request) => {
    const environments = sharedGuestGitEnvironments(runner)
    const probed = await environments.probe(request.distro, {
      ...(request.signal ? { signal: request.signal } : {})
    })

    const directArgv = (environment: GuestGitEnvironment): string[] => [
      '/usr/bin/env',
      `PATH=${environment.path}`,
      `HOME=${environment.home}`,
      ...GUEST_GIT_ENV,
      '/bin/sh',
      '-c',
      request.script,
      'icode-guest-script',
      environment.gitPath,
      ...request.args
    ]

    const fallbackArgv = (): string[] => [
      '/bin/sh',
      '-lc',
      request.script,
      'icode-guest-script',
      'git',
      ...request.args
    ]

    /**
     * Reads retry a transport failure once; mutations never do. `runIdempotentGuest`
     * already implements exactly that retry policy for reads.
     */
    const launch = async (argv: string[]): Promise<ByteLaunch> => {
      if (request.mutation) {
        return runner.runBytes({
          scope: 'guest',
          label: request.label,
          distro: request.distro,
          argv,
          timeoutMs: request.timeoutMs,
          ...(request.signal ? { signal: request.signal } : {})
        })
      }
      return runIdempotentGuest(
        runner,
        {
          scope: 'guest',
          label: request.label,
          distro: request.distro,
          argv,
          timeoutMs: request.timeoutMs,
          ...(request.signal ? { signal: request.signal } : {})
        },
        { retries: 1 }
      )
    }

    const decode = (result: ByteLaunch): GuestGitScriptOutcome => {
      if ('status' in result) {
        return { status: 'transport', detail: 'wsl.exe is not available.', timedOut: false }
      }
      if (isTransportFailure(result)) {
        return transport(result, 'The WSL distro did not answer the Git script.')
      }
      return ok(result)
    }

    if (probed.kind === 'resolved') {
      const direct = await launch(directArgv(probed.environment))
      if (
        !('status' in direct) &&
        isDirectGuestGitNotFound({
          exitCode: direct.timedOut ? null : direct.code,
          stderr: direct.stderr
        })
      ) {
        // The cached route is stale: Git was not found at the absolute path. Git
        // never ran, so even a mutation may fall back to the login shell once.
        environments.invalidate(request.distro)
      } else {
        return decode(direct)
      }
    }

    const fallback = await launch(fallbackArgv())
    return decode(fallback)
  }
}
