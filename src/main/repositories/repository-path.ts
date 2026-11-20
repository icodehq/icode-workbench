import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import type { ExecutionTarget } from '../../shared/domain/repository'
import type { WslCommandRunner } from '../wsl/exec'
import type { GuestGitScriptRunner } from '../wsl/git/guest-git-script'
import {
  GuestPathError,
  resolveGuestRepositoryRoot,
  resolveGuestRepositoryRootBatched
} from '../wsl/git/guest-path'
import { makeAppError } from '../../shared/domain/errors'
import type { AppError } from '../../shared/domain/errors'
import type { CanonicalRepositoryPath } from '../../shared/domain/paths'
import { toCanonicalRepositoryPath } from '../../shared/domain/paths'

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 5000

export type ResolvedRepository = {
  /** Primary checkout root, used as `repos.path` and the only durable identity. */
  root: CanonicalRepositoryPath
  currentBranch: string | null
  /** Canonical `git rev-parse --git-common-dir`; equal for every linked worktree. */
  commonDir: string
  /** Set when the user registered a linked worktree rather than the primary checkout. */
  registeredVia: string | null
}

export type RepositoryPathFailure = {
  error: AppError
}

export class RepositoryPathError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.message)
    this.name = 'RepositoryPathError'
  }
}

function failure(
  code: 'PATH_NOT_FOUND' | 'NOT_A_DIRECTORY' | 'NOT_A_GIT_REPO',
  message: string,
  detail: string,
  path: string
): RepositoryPathError {
  return new RepositoryPathError(
    makeAppError(code, message, { detail, context: { path } })
  )
}

async function readBranch(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }
    )
    const branch = stdout.trim()
    return branch.length > 0 ? branch : null
  } catch {
    // Detached HEAD or a repository without commits: branch is unavailable, not fatal.
    return null
  }
}

type GitCapture = {
  stdout: string
  stderr: string
  exitCode: number | null
}

/**
 * A Git read that keeps stdout and stderr even when Git exits non-zero.
 *
 * An unborn branch is the case that matters: `rev-parse --git-common-dir
 * --abbrev-ref HEAD` prints the common dir and then fails on `HEAD`. Throwing
 * that away would turn a perfectly good repository into "not a Git repository".
 */
async function captureGit(args: string[], cwd: string): Promise<GitCapture> {
  try {
    const { stdout, stderr } = await execFileAsync('git', ['-C', cwd, ...args], {
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
    })
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 }
  } catch (error) {
    const captured = error as {
      stdout?: string | Buffer
      stderr?: string | Buffer
      code?: number | string
    }
    return {
      stdout: String(captured.stdout ?? '').trim(),
      stderr: String(captured.stderr ?? '').trim(),
      exitCode: typeof captured.code === 'number' ? captured.code : null
    }
  }
}

/** First entry of `git worktree list --porcelain` is the primary checkout. */
function firstWorktreeRoot(listing: string): string | null {
  const first = listing
    .split('\n')
    .find((line) => line.startsWith('worktree '))
  if (first === undefined) return null
  const value = first.slice('worktree '.length).trim()
  return value.length > 0 ? value : null
}

/**
 * The only place that turns a user-supplied path into a canonical root.
 * Validates existence, directory shape, and Git work-tree membership.
 */
export async function resolveRepositoryRoot(inputPath: string): Promise<ResolvedRepository> {
  const trimmed = inputPath.trim()
  if (trimmed.length === 0) {
    throw failure('PATH_NOT_FOUND', 'Enter a repository folder path.', 'The path is empty.', trimmed)
  }

  let canonicalInput: string
  try {
    canonicalInput = await realpath(trimmed)
  } catch {
    throw failure(
      'PATH_NOT_FOUND',
      'That folder does not exist.',
      'Check the path or use the folder picker.',
      trimmed
    )
  }

  const info = await stat(canonicalInput).catch(() => null)
  if (!info || !info.isDirectory()) {
    throw failure(
      'NOT_A_DIRECTORY',
      'That path is not a folder.',
      'Choose a directory that contains the repository.',
      canonicalInput
    )
  }

  /**
   * The common dir, the input's own worktree root, and the branch are answered
   * at the input; the primary checkout comes from the porcelain listing. They
   * are independent, so the two Git processes start together: Add project pays
   * one wave, not two.
   */
  const [absolute, listing] = await Promise.all([
    captureGit(
      [
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
        '--show-toplevel',
        '--abbrev-ref',
        'HEAD'
      ],
      canonicalInput
    ),
    captureGit(['worktree', 'list', '--porcelain'], canonicalInput)
  ])
  // Older Git may not know `--path-format`; the relative form is the fallback.
  const commonAttempt =
    absolute.stdout.length > 0
      ? absolute
      : await captureGit(
          [
            'rev-parse',
            '--git-common-dir',
            '--show-toplevel',
            '--abbrev-ref',
            'HEAD'
          ],
          canonicalInput
        )
  let commonDirRaw: string
  let worktreeAtInputRaw: string
  let branchAtInput: string | null
  if (commonAttempt.stdout.length === 0) {
    throw failure(
      'NOT_A_GIT_REPO',
      'That folder is not inside a Git working tree.',
      (commonAttempt.stderr || absolute.stderr || 'git rev-parse --git-common-dir failed').slice(
        0,
        500
      ),
      canonicalInput
    )
  }
  const [commonLine, worktreeLine, branchLine] = commonAttempt.stdout
    .split('\n')
    .map((line) => line.trim())
  commonDirRaw = commonLine ?? ''
  worktreeAtInputRaw = worktreeLine ?? ''
  if (commonDirRaw.length === 0) {
    throw failure(
      'NOT_A_GIT_REPO',
      'That folder is not inside a Git working tree.',
      'Initialize Git or choose a repository folder.',
      canonicalInput
    )
  }
  /*
   * A non-zero exit means the branch question failed (an unborn branch), not
   * that the common dir is unknown. `HEAD` is a detached checkout and is kept,
   * exactly as the single-query read did.
   */
  branchAtInput =
    commonAttempt.exitCode === 0 && branchLine !== undefined && branchLine.length > 0
      ? branchLine
      : null
  // Older Git may answer with a relative `.git`; resolve it against the input
  // instead of the process working directory.
  if (!isAbsolute(commonDirRaw)) commonDirRaw = join(canonicalInput, commonDirRaw)

  let primaryRootRaw: string
  const listedRoot = firstWorktreeRoot(listing.stdout)
  if (listedRoot !== null) {
    primaryRootRaw = listedRoot
  } else {
    // The listing shape was unusable; the toplevel probe is the older fallback.
    const toplevel = await captureGit(['rev-parse', '--show-toplevel'], canonicalInput)
    primaryRootRaw = toplevel.stdout
    if (primaryRootRaw.length === 0) {
      throw failure(
        'NOT_A_GIT_REPO',
        'That folder is not inside a Git working tree.',
        (toplevel.stderr || listing.stderr || 'git worktree list failed').slice(0, 500),
        canonicalInput
      )
    }
  }

  let commonDir: string
  try {
    commonDir = await realpath(commonDirRaw)
  } catch {
    commonDir = commonDirRaw
  }

  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(primaryRootRaw)
  } catch {
    canonicalRoot = primaryRootRaw
  }

  let root: CanonicalRepositoryPath
  try {
    root = toCanonicalRepositoryPath(canonicalRoot)
  } catch {
    throw failure(
      'NOT_A_GIT_REPO',
      'Git reported an unusable repository root.',
      `git returned: ${canonicalRoot.slice(0, 500)}`,
      canonicalInput
    )
  }

  /*
   * The combined query read the branch at the input. That is the same checkout
   * only when the input's worktree root is the primary root — a linked worktree
   * (even one created inside the primary folder) has its own branch, so the
   * recorded branch stays the primary checkout's, exactly as before.
   */
  let worktreeAtInput: string | null = null
  if (worktreeAtInputRaw.length > 0) {
    try {
      worktreeAtInput = await realpath(worktreeAtInputRaw)
    } catch {
      worktreeAtInput = worktreeAtInputRaw
    }
  }
  const sameCheckout = worktreeAtInput !== null && worktreeAtInput === canonicalRoot
  return {
    root,
    currentBranch: sameCheckout ? branchAtInput : await readBranch(root),
    commonDir,
    registeredVia: canonicalInput === canonicalRoot ? null : canonicalInput
  }
}

export type RepositoryPathRoutingDeps = {
  /** Needed only for a WSL target; a local target never touches it. */
  wsl?: {
    runner: WslCommandRunner
    signal?: AbortSignal
    /**
     * Batched guest script. When present the whole resolution runs in one
     * `wsl.exe` spawn instead of six; the answers and errors are identical.
     */
    script?: GuestGitScriptRunner
  }
}

/**
 * The single target-aware entry point for path resolution.
 *
 * Routing is by `executionTarget.kind` and nothing else. The local branch runs
 * the pre-W6 code verbatim, so existing behaviour is unchanged; the WSL branch
 * never calls `realpath`, `stat` or Windows Git, because a guest path is not a
 * Windows path and no amount of fallback makes it one.
 */
export async function resolveRepositoryRootFor(
  inputPath: string,
  target: ExecutionTarget,
  deps: RepositoryPathRoutingDeps = {}
): Promise<ResolvedRepository> {
  if (target.kind === 'local') return resolveRepositoryRoot(inputPath)

  if (!deps.wsl) {
    throw new RepositoryPathError(
      makeAppError(
        'WSL_UNAVAILABLE',
        'A WSL repository needs a distro connection to resolve its path.',
        { detail: 'No WSL runner was provided.', context: { path: inputPath } }
      )
    )
  }

  try {
    const resolved =
      deps.wsl.script === undefined
        ? await resolveGuestRepositoryRoot(inputPath, {
            runner: deps.wsl.runner,
            distro: target.distro,
            ...(deps.wsl.signal ? { signal: deps.wsl.signal } : {})
          })
        : await resolveGuestRepositoryRootBatched(inputPath, {
            script: deps.wsl.script,
            distro: target.distro,
            ...(deps.wsl.signal ? { signal: deps.wsl.signal } : {})
          })
    return {
      root: resolved.root,
      currentBranch: resolved.currentBranch,
      commonDir: resolved.commonDir,
      registeredVia: resolved.registeredVia
    }
  } catch (error) {
    if (error instanceof GuestPathError) throw new RepositoryPathError(error.appError)
    throw error
  }
}
