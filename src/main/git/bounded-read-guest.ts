/**
 * Bounded reads against a repository inside a distro.
 *
 * The local reader (`runGitRead`) is the reference: a byte budget, a UTF-8-safe
 * truncation, a stderr tail, SIGTERM then SIGKILL, and a fixed allow-list of
 * read-only subcommands. None of that is re-implemented here. The only thing
 * that changes for WSL is *where Git runs*, so this module reuses the local
 * reader's helpers and replaces the process.
 *
 * Two guest-specific hazards it handles, neither of which exists locally:
 *
 *   - `wsl.exe` writes its own diagnostics as UTF-16LE. Those bytes must never be
 *     concatenated with Git's stdout, so stderr is kept as a separate tail and
 *     decoded only for the message.
 *   - `wsl.exe`'s exit code is the guest program's exit code, which is exactly
 *     what Git's callers expect; a killed `wsl.exe` reports `null`, and that is
 *     reported as a timeout rather than as a Git failure.
 */

import type { WslCommandRunner } from '../wsl/exec'
import { runGuestGit } from '../wsl/git/guest-git'
import {
  assertAllowedArgs,
  truncateUtf8,
  type GitReadOptions,
  type GitReadResult
} from './bounded-read'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_BYTE_BUDGET = 2 * 1024 * 1024
const DEFAULT_STDERR_BUDGET = 8 * 1024

/**
 * Builds a bounded read bound to one distro.
 *
 * The allow-list is applied here as well as in the local reader so a guest
 * mutation can never be routed through a read call.
 */
export function createGuestBoundedRead(
  runner: WslCommandRunner,
  distro: string,
  defaults: { timeoutMs?: number; byteBudget?: number; stderrBudget?: number } = {}
): (options: GitReadOptions) => Promise<GitReadResult> {
  return async (options) => {
    assertAllowedArgs(options.args)
    const timeoutMs = options.timeoutMs ?? defaults.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const byteBudget = options.byteBudget ?? defaults.byteBudget ?? DEFAULT_BYTE_BUDGET
    const stderrBudget = options.stderrBudget ?? defaults.stderrBudget ?? DEFAULT_STDERR_BUDGET

    const result = await runGuestGit(runner, {
      distro,
      cwd: options.cwd,
      args: options.args,
      timeoutMs
    })

    const truncated = result.stdout.length > byteBudget
    const kept = truncateUtf8(result.stdout, byteBudget)
    const stderrKept = result.stderr.subarray(0, stderrBudget)
    const timedOut = result.timedOut
    return {
      stdout: kept.toString('utf8'),
      // Diagnostics only. `decodeWslOutput` is deliberately not used: its UTF-16
      // heuristic would mangle a legitimate UTF-8 Git error.
      stderrTail: stderrKept.toString('utf8'),
      exitCode: timedOut ? null : result.exitCode,
      signal: null,
      truncated,
      truncatedReason: truncated ? 'bytes' : timedOut ? 'timeout' : null
    }
  }
}
