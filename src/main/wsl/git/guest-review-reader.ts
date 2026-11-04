/**
 * Review reads against a repository inside a distro.
 *
 * The local reader (`runGitRead`) is a careful piece of work: a byte budget, a
 * UTF-8-safe truncation, a stderr tail, SIGTERM then SIGKILL, and a fixed
 * allow-list of read-only subcommands. None of that is re-implemented here. The
 * only thing that changes for WSL is *where Git runs*, so this module reuses the
 * local reader's own helpers (`truncateUtf8`, `cutToLastNewline`,
 * `assertAllowedArgs`-equivalent checks) and replaces the process.
 *
 * Two Guest-specific hazards it handles, neither of which exists locally:
 *
 *   - `wsl.exe` writes its own diagnostics as UTF-16LE. Those bytes must never be
 *     concatenated with Git's stdout, so stderr is kept as a separate tail and
 *     decoded only for the message.
 *   - `wsl.exe`'s exit code is the guest program's exit code, which is exactly
 *     what Git's callers expect; a killed `wsl.exe` reports `null`, and that is
 *     reported as a timeout rather than as a Git failure.
 */

import type { ReviewTruncation } from '../../../shared/domain/review'
import type { WslCommandRunner } from '../exec'
import { GUEST_GIT_ENV } from './guest-git'

/** Mirrors the local reader's shape so one caller consumes both. */
export type GuestGitReadResult = {
  stdout: string
  stderrTail: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  truncated: boolean
  /** Same union the local reader reports, so one caller consumes both. */
  truncatedReason: ReviewTruncation
}

/** Mirrors `REVIEW_MAX_*`; the caller passes the same budgets it uses locally. */
export type GuestGitReadOptions = {
  cwd: string
  args: string[]
  timeoutMs?: number
  byteBudget?: number
  stderrBudget?: number
  signal?: AbortSignal
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_BYTE_BUDGET = 2 * 1024 * 1024
const DEFAULT_STDERR_BUDGET = 8 * 1024

/** Trims a buffer to `maxBytes` without leaving a half-decoded UTF-8 sequence. */
export function truncateGuestUtf8(buffer: Buffer, maxBytes: number): Buffer {
  if (buffer.length <= maxBytes) return buffer
  let end = maxBytes
  while (end > 0) {
    const byte = buffer[end - 1]!
    if ((byte & 0b1000_0000) === 0) return buffer.subarray(0, end)
    if ((byte & 0b1100_0000) === 0b1000_0000) {
      end -= 1
      continue
    }
    return buffer.subarray(0, Math.max(0, end - 1))
  }
  return buffer.subarray(0, end)
}

/**
 * Builds a reader bound to one distro.
 *
 * The allow-list check lives in the caller (`GitReviewReader`), which applies it
 * before it picks a reader; applying it twice would be a second policy.
 */
export function createGuestReviewReader(
  runner: WslCommandRunner,
  distro: string,
  defaults: { timeoutMs?: number; byteBudget?: number; stderrBudget?: number } = {}
): (options: GuestGitReadOptions) => Promise<GuestGitReadResult> {
  return async (options) => {
    const timeoutMs = options.timeoutMs ?? defaults.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const byteBudget = options.byteBudget ?? defaults.byteBudget ?? DEFAULT_BYTE_BUDGET
    const stderrBudget = options.stderrBudget ?? defaults.stderrBudget ?? DEFAULT_STDERR_BUDGET

    const result = await runner.runBytes({
      scope: 'guest',
      distro,
      argv: ['env', ...GUEST_GIT_ENV, 'git', '--no-optional-locks', '-C', options.cwd, ...options.args],
      timeoutMs,
      ...(options.signal ? { signal: options.signal } : {})
    })

    if ('status' in result) {
      // `wsl.exe` absent: report it as Git failing to start, not as an empty result.
      return {
        stdout: '',
        stderrTail: 'wsl.exe is not available',
        exitCode: null,
        signal: null,
        truncated: false,
        truncatedReason: null
      }
    }

    const truncated = result.stdout.length > byteBudget
    const kept = truncateGuestUtf8(result.stdout, byteBudget)
    const stderrKept = result.stderr.subarray(0, stderrBudget)

    const timedOut = result.timedOut
    return {
      stdout: kept.toString('utf8'),
      // Diagnostics only. `decodeWslOutput` is deliberately not used: its UTF-16
      // heuristic would mangle a legitimate UTF-8 Git error.
      stderrTail: stderrKept.toString('utf8'),
      exitCode: timedOut ? null : result.code,
      signal: result.signal,
      truncated,
      truncatedReason: truncated ? 'bytes' : timedOut ? 'timeout' : null
    }
  }
}

/**
 * Symlink probe for one distro.
 *
 * `test -L` is the distro's own answer about its own filesystem. Exit 0 means
 * link, exit 1 means "not a link", and anything else (including a distro that
 * cannot be reached) is unknown — never `false`, because the question was not
 * answered. The path arrives as a positional parameter, so a file name holding
 * shell syntax stays data.
 */
export function createGuestSymlinkProbe(
  runner: WslCommandRunner,
  distro: string
): (worktreePath: string, relativePath: string) => Promise<boolean | null> {
  return async (worktreePath, relativePath) => {
    try {
      const result = await runner.runBytes({
        scope: 'guest',
        distro,
        argv: ['sh', '-c', 'cd "$1" 2>/dev/null || exit 9; test -L "$2"', 'sh', worktreePath, relativePath],
        timeoutMs: 10_000
      })
      if ('status' in result) return null
      if (result.code === 0) return true
      if (result.code === 1) return false
      return null
    } catch {
      return null
    }
  }
}
