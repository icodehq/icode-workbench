/**
 * A bounded retry for idempotent guest probes.
 *
 * Measured problem: `wsl.exe` startup under this controller (itself a process
 * *inside* the distro) intermittently exceeds a 20 s budget — about 30% of calls in
 * a 20-iteration run, each returning `timedOut` with empty output. A probe that
 * times out has not answered the question, so treating it as "no" produced
 * spurious `PATH_NOT_FOUND` / `NOT_A_GIT_REPO` results and made repository
 * resolution and Path A startup flaky.
 *
 * The rule here is deliberately narrow:
 *
 *   - **only timeouts are retried.** A non-zero exit is an answer ("no such
 *     directory", "not a repository") and must not be re-asked.
 *   - **one retry.** Enough to absorb a slow start, bounded so a dead distro still
 *     fails promptly.
 *   - **idempotent callers only.** Reads, and `mkdir -p`, may be repeated without
 *     changing the outcome. Anything else — `git worktree add`, a branch delete —
 *     must not use this: after a timeout its effect is unknown.
 */

import type { WslByteResult, WslCommandRunner, WslExecOutcome } from './exec'
import type { WslGuestCommand } from './exec'

export type GuestProbeResult = WslByteResult | { status: 'wsl_missing' }

export type GuestProbeOptions = {
  /** Extra attempts after the first. One by default. */
  retries?: number
}

/**
 * Whether `wsl.exe` itself failed, rather than the program inside the distro.
 *
 * Measured: the WSL service intermittently drops a connection and `wsl.exe` exits
 * 255 with `Wsl/Service/WSAETIMEDOUT` — in UTF-16LE, and immune to `WSL_UTF8=1`
 * because it comes from the service, not the guest program. That is a transport
 * failure: the guest never ran, so no answer was produced. Retrying is only safe
 * for idempotent callers, which is why this predicate lives here.
 */
export function isWslServiceFailure(result: WslByteResult): boolean {
  if (result.timedOut || result.code === 0 || result.code === null) return false
  const text = `${result.stdout.toString('utf8')}${result.stderr.toString('utf8')}`
  // UTF-16LE digits have NUL high bytes; dropping them makes the marker greppable.
  return text.replace(/\u0000/g, '').includes('Wsl/Service/')
}

/**
 * Whether the guest program never produced an answer.
 *
 * Exit 255 is `wsl.exe`'s own code for a service-level failure. The probes that
 * use this helper are one-line `test`/`mkdir`/`realpath` scripts, which exit 0 or
 * 1; 255 cannot come from them, so it means the transport failed. Reading it as
 * "no such folder" is what made a live worktree look missing.
 */
export function isTransportFailure(result: WslByteResult): boolean {
  return result.timedOut || isWslServiceFailure(result) || result.code === 255
}

/**
 * The same question, asked of the text-shaped outcome.
 *
 * `WslCommandRunner.run` reports a service failure as `exit_failure` with code
 * 255 and the service's own message, *not* as `timed_out`. Measured: the first
 * `wsl.exe` call after an idle period fails exactly that way and the next one
 * succeeds, so any caller that retries only `timed_out` fails every cold start.
 */
export function isTransportOutcome(outcome: WslExecOutcome): boolean {
  if (outcome.status === 'timed_out' || outcome.status === 'cancelled') return true
  if (outcome.status !== 'exit_failure') return false
  const text = `${outcome.stdout}${outcome.stderr}`.replace(/\u0000/g, '')
  return text.includes('Wsl/Service/') || outcome.code === 255
}

/**
 * Runs an idempotent guest call, retrying a timeout or a transport failure.
 *
 * `wsl_missing` is not retried: the binary is not there, and asking again cannot
 * change that. A guest program's own non-zero exit is an answer and is returned.
 */
export async function runIdempotentGuest(
  runner: WslCommandRunner,
  command: WslGuestCommand,
  options: GuestProbeOptions = {}
): Promise<GuestProbeResult> {
  const retries = options.retries ?? 1
  let last = await runner.runBytes(command)
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if ('status' in last) return last
    if (!isTransportFailure(last)) return last
    last = await runner.runBytes(command)
  }
  return last
}
