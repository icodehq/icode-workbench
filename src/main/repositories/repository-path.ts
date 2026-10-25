import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import type { ExecutionTarget } from '../../shared/domain/repository'
import type { WslCommandRunner } from '../wsl/exec'
import { GuestPathError, resolveGuestRepositoryRoot } from '../wsl/git/guest-path'
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

  const git = async (args: string[], cwd: string): Promise<string> => {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
    })
    return stdout.trim()
  }

  let commonDirRaw: string
  let primaryRootRaw: string
  try {
    // Why: --show-toplevel reports the *linked worktree* root, which would
    // register the same repository twice. The common Git dir identifies the
    // repository for both `.git` directories and `.git` files.
    commonDirRaw = await git(
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      canonicalInput
    ).catch(async () => git(['rev-parse', '--git-common-dir'], canonicalInput))
    if (commonDirRaw.length === 0) throw new Error('empty git common dir')
    // Older Git may answer with a relative `.git`; resolve it against the input
    // instead of the process working directory.
    if (!isAbsolute(commonDirRaw)) commonDirRaw = join(canonicalInput, commonDirRaw)
    primaryRootRaw = await readPrimaryWorktree(canonicalInput, git)
  } catch (error) {
    const detail =
      error && typeof error === 'object' && 'stderr' in error
        ? String((error as { stderr?: unknown }).stderr).trim().slice(0, 500)
        : 'git rev-parse --git-common-dir failed'
    throw failure(
      'NOT_A_GIT_REPO',
      'That folder is not inside a Git working tree.',
      detail.length > 0 ? detail : 'Initialize Git or choose a repository folder.',
      canonicalInput
    )
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

  return {
    root,
    currentBranch: await readBranch(root),
    commonDir,
    registeredVia: canonicalInput === canonicalRoot ? null : canonicalInput
  }
}

/**
 * First entry of `git worktree list --porcelain` is the primary checkout.
 * Falls back to `--show-toplevel` if the listing shape changes.
 */
async function readPrimaryWorktree(
  cwd: string,
  git: (args: string[], cwd: string) => Promise<string>
): Promise<string> {
  try {
    const listing = await git(['worktree', 'list', '--porcelain'], cwd)
    const first = listing
      .split('\n')
      .find((line) => line.startsWith('worktree '))
    if (first) {
      const value = first.slice('worktree '.length).trim()
      if (value.length > 0) return value
    }
  } catch {
    // Fall through to the toplevel probe.
  }
  return git(['rev-parse', '--show-toplevel'], cwd)
}

export type RepositoryPathRoutingDeps = {
  /** Needed only for a WSL target; a local target never touches it. */
  wsl?: {
    runner: WslCommandRunner
    signal?: AbortSignal
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
    const resolved = await resolveGuestRepositoryRoot(inputPath, {
      runner: deps.wsl.runner,
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
