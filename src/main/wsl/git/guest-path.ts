/**
 * Turning a user-supplied path into a canonical repository root **inside the distro**.
 *
 * The local resolver (`repository-path.ts`) is the specification this follows, one
 * decision at a time, because the two must agree on what "the same repository"
 * means:
 *
 *   - `realpath` first, so a symlinked path and its target are one repository;
 *   - `stat` and require a directory;
 *   - `git rev-parse --path-format=absolute --git-common-dir`, because the common
 *     directory — not `--show-toplevel` — identifies the repository for both a
 *     `.git` directory and a `.git` file (linked worktree);
 *   - the first entry of `git worktree list --porcelain` as the primary checkout;
 *   - the branch name, `null` for a detached HEAD or an unborn branch.
 *
 * The difference is only *where* those calls run. Every one of them is a guest
 * process, so a Windows `realpath`/`stat`/`git` never sees a Guest path. That is
 * a structural guarantee here: there is no code path from this module to a local
 * filesystem call.
 */

import type { AppError } from '../../../shared/domain/errors'
import { makeAppError } from '../../../shared/domain/errors'
import type { CanonicalRepositoryPath } from '../../../shared/domain/paths'
import type { WslCommandRunner } from '../exec'
import { GuestGitUnavailableError, runGuestGit, type GuestGitResult } from './guest-git'
import { isTransportFailure, runIdempotentGuest } from '../probe'

const GIT_TIMEOUT_MS = 10_000

export type GuestResolvedRepository = {
  /** Guest absolute canonical root; becomes `repos.path` for a WSL row. */
  root: CanonicalRepositoryPath
  currentBranch: string | null
  /** Guest absolute canonical `--git-common-dir`; equal across linked worktrees. */
  commonDir: string
  /** Set when the user registered a linked worktree rather than the primary checkout. */
  registeredVia: string | null
}

export class GuestPathError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.message)
    this.name = 'GuestPathError'
  }
}

/**
 * Constant probes: no path is ever interpolated into a shell string.
 *
 * `-e` is required, not cosmetic. GNU `realpath` without it lets the *last*
 * component be missing, so a nonexistent folder would canonicalize successfully
 * and then be reported as "not a directory" — while the local resolver reports
 * `PATH_NOT_FOUND` for the same input. `-e` makes the two agree.
 */
const REALPATH_SCRIPT = 'realpath -e -- "$1"'
const STAT_DIR_SCRIPT = 'test -d "$1" && echo dir || { test -e "$1" && echo other || echo missing; }'

function failure(
  code: 'PATH_NOT_FOUND' | 'NOT_A_DIRECTORY' | 'NOT_A_GIT_REPO' | 'WSL_UNAVAILABLE',
  message: string,
  detail: string,
  path: string
): GuestPathError {
  return new GuestPathError(makeAppError(code, message, { detail, context: { path } }))
}

async function runShell(
  runner: WslCommandRunner,
  distro: string,
  script: string,
  argument: string,
  signal?: AbortSignal
): Promise<{ stdout: string; exitCode: number | null }> {
  // A timeout is not an answer: retry it once rather than reporting the path as
  // missing. Non-zero exits are answers and are returned as-is.
  const result = await runIdempotentGuest(runner, {
    scope: 'guest',
    distro,
    argv: ['sh', '-c', script, 'ade-path', argument],
    timeoutMs: GIT_TIMEOUT_MS,
    ...(signal ? { signal } : {})
  })
  if ('status' in result) {
    throw failure(
      'WSL_UNAVAILABLE',
      'WSL is not available.',
      'wsl.exe could not be started.',
      argument
    )
  }
  /**
   * A timeout or a `wsl.exe` service failure produced no answer.
   *
   * Without this the empty stdout was read as `missing`, and the caller told the
   * user "that path is not a folder" about a directory that was there — a
   * confident wrong answer caused by a transport hiccup.
   */
  if (isTransportFailure(result)) {
    throw failure(
      'WSL_UNAVAILABLE',
      'The WSL distro did not answer.',
      `Could not check ${argument} inside ${distro}; try again.`,
      argument
    )
  }
  return { stdout: result.stdout.toString('utf8').trim(), exitCode: result.code }
}

async function git(
  runner: WslCommandRunner,
  distro: string,
  cwd: string,
  args: string[],
  signal?: AbortSignal
): Promise<GuestGitResult> {
  return runGuestGit(runner, { distro, cwd, args, timeoutMs: GIT_TIMEOUT_MS, ...(signal ? { signal } : {}) })
}

/**
 * Guest `realpath`, or null when the path does not exist.
 *
 * A *transport* failure is not "does not exist" and must not read as one: it
 * throws, so the caller reports "WSL did not answer" instead of telling the user
 * that a folder they can see in their own terminal is missing.
 */
export async function guestRealpath(
  runner: WslCommandRunner,
  distro: string,
  path: string,
  signal?: AbortSignal
): Promise<string | null> {
  const { stdout, exitCode } = await runShell(runner, distro, REALPATH_SCRIPT, path, signal)
  return exitCode === 0 && stdout.startsWith('/') ? stdout : null
}

/**
 * Classifies a guest path without following it: `missing`, `dir`, or `other`.
 *
 * `test -e` and `-d` are used rather than `stat` so the answer is a shape, not a
 * parse of a format that differs between coreutils and busybox.
 */
export async function guestPathKind(
  runner: WslCommandRunner,
  distro: string,
  path: string,
  signal?: AbortSignal
): Promise<'missing' | 'dir' | 'other'> {
  const { stdout } = await runShell(runner, distro, STAT_DIR_SCRIPT, path, signal)
  return stdout === 'dir' || stdout === 'other' ? stdout : 'missing'
}

async function readBranch(
  runner: WslCommandRunner,
  distro: string,
  root: string,
  signal?: AbortSignal
): Promise<string | null> {
  try {
    const result = await git(runner, distro, root, ['rev-parse', '--abbrev-ref', 'HEAD'], signal)
    if (result.exitCode !== 0) return null
    const branch = result.stdout.toString('utf8').trim()
    // `HEAD` is what Git answers for a detached checkout.
    return branch.length > 0 && branch !== 'HEAD' ? branch : null
  } catch {
    return null
  }
}

/** First `worktree list --porcelain` entry, falling back to `--show-toplevel`. */
async function readPrimaryWorktree(
  runner: WslCommandRunner,
  distro: string,
  cwd: string,
  signal?: AbortSignal
): Promise<string> {
  try {
    const listing = await git(runner, distro, cwd, ['worktree', 'list', '--porcelain'], signal)
    if (listing.exitCode === 0) {
      const first = listing.stdout
        .toString('utf8')
        .split('\n')
        .find((line) => line.startsWith('worktree '))
      if (first) {
        const value = first.slice('worktree '.length).trim()
        if (value.length > 0) return value
      }
    }
  } catch {
    // Fall through to the toplevel probe.
  }
  const toplevel = await git(runner, distro, cwd, ['rev-parse', '--show-toplevel'], signal)
  if (toplevel.exitCode !== 0) throw new Error('git rev-parse --show-toplevel failed')
  return toplevel.stdout.toString('utf8').trim()
}

export type ResolveGuestRepositoryDeps = {
  runner: WslCommandRunner
  distro: string
  signal?: AbortSignal
}

/**
 * Resolves a repository path entirely inside the distro.
 *
 * A relative path is refused rather than resolved against the guest's cwd: the
 * caller's working directory is a Windows concept and has no guest meaning.
 */
export async function resolveGuestRepositoryRoot(
  inputPath: string,
  deps: ResolveGuestRepositoryDeps
): Promise<GuestResolvedRepository> {
  const { runner, distro, signal } = deps
  const trimmed = inputPath.trim()
  if (trimmed.length === 0) {
    throw failure('PATH_NOT_FOUND', 'Enter a repository folder path.', 'The path is empty.', trimmed)
  }
  if (!trimmed.startsWith('/')) {
    throw failure(
      'PATH_NOT_FOUND',
      'Enter an absolute path inside the WSL distro.',
      'WSL paths start with "/", for example /home/you/project.',
      trimmed
    )
  }

  const canonicalInput = await guestRealpath(runner, distro, trimmed, signal)
  if (canonicalInput === null) {
    throw failure(
      'PATH_NOT_FOUND',
      'That folder does not exist in the WSL distro.',
      `Checked ${trimmed} inside ${distro}.`,
      trimmed
    )
  }

  const kind = await guestPathKind(runner, distro, canonicalInput, signal)
  if (kind !== 'dir') {
    throw failure(
      'NOT_A_DIRECTORY',
      'That path is not a folder.',
      'Choose a directory that contains the repository.',
      canonicalInput
    )
  }

  let commonDir: string
  let primaryRoot: string
  try {
    const common = await git(
      runner,
      distro,
      canonicalInput,
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      signal
    )
    if (common.exitCode !== 0 || common.stdout.toString('utf8').trim().length === 0) {
      throw new Error(common.stderr.toString('utf8').trim() || 'git rev-parse failed')
    }
    // Older Git answers with a relative `.git`; resolve it against the input, never
    // against a process working directory that belongs to another filesystem.
    const raw = common.stdout.toString('utf8').trim()
    commonDir = raw.startsWith('/') ? raw : `${canonicalInput.replace(/\/+$/u, '')}/${raw}`
    primaryRoot = await readPrimaryWorktree(runner, distro, canonicalInput, signal)
  } catch (error) {
    if (error instanceof GuestGitUnavailableError) {
      throw failure('WSL_UNAVAILABLE', 'WSL is not available.', error.message, canonicalInput)
    }
    const detail = error instanceof Error ? error.message.slice(0, 500) : String(error)
    throw failure(
      'NOT_A_GIT_REPO',
      'That folder is not inside a Git working tree in the WSL distro.',
      detail,
      canonicalInput
    )
  }

  const canonicalCommon = (await guestRealpath(runner, distro, commonDir, signal)) ?? commonDir
  const canonicalRoot = (await guestRealpath(runner, distro, primaryRoot, signal)) ?? primaryRoot
  if (!canonicalRoot.startsWith('/')) {
    throw failure(
      'NOT_A_GIT_REPO',
      'Git reported an unusable repository root.',
      `git returned: ${canonicalRoot.slice(0, 500)}`,
      canonicalInput
    )
  }

  return {
    // The type is nominal; the value is a guest absolute path and every consumer
    // must treat it as one (routing is by target, never by inspecting the string).
    root: canonicalRoot as CanonicalRepositoryPath,
    currentBranch: await readBranch(runner, distro, canonicalRoot, signal),
    commonDir: canonicalCommon,
    registeredVia: canonicalInput === canonicalRoot ? null : canonicalInput
  }
}
