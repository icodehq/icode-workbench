import { lstatSync, realpathSync } from 'node:fs'
import { dirname, join, posix as posixPath, resolve as resolvePath, sep } from 'node:path'
import type { WslCommandRunner } from '../wsl/exec'
import { readError, GitReadError } from './bounded-read'

/**
 * Path handling for a checkout that may live on this machine or inside a distro.
 *
 * A guest path is not just unresolvable here — it is not even a path *shape*
 * this platform understands. `path.resolve('/tmp/x', 'a.txt')` on Windows
 * returns `D:\tmp\x\a.txt`, so a Windows-dialect containment test rejects every
 * guest path. The dialect therefore travels with the checkout, like the reader.
 */
export type ContainmentResolution = {
  /** Resolves symlinks where the checkout lives. */
  realpath: (path: string) => string
  resolve: (root: string, child: string) => string
  dirname: (path: string) => string
  separator: string
}

/** The controller's own filesystem. */
export const localContainment: ContainmentResolution = {
  realpath: realpathSync,
  resolve: (root, child) => resolvePath(root, child),
  dirname: (value) => dirname(value),
  separator: sep
}

/**
 * A distro checkout: POSIX path shape, and no local symlink resolution.
 *
 * Containment stays lexical here (`assertSafeRelativePath` plus the prefix
 * test). The read runs inside the distro, which is the only place a guest
 * symlink could be followed, and no controller path can be reached through a
 * guest path, so the boundary this protects is unchanged.
 */
export const guestContainment: ContainmentResolution = {
  realpath: (value) => value,
  resolve: (root, child) => posixPath.resolve(root, child),
  dirname: (value) => posixPath.dirname(value),
  separator: '/'
}

/**
 * Whether a path is a symlink, answered by the host that owns the checkout.
 *
 * `null` = the question could not be answered (unreachable distro, vanished
 * file). Reporting `false` there would turn "unknown" into a fact about the
 * user's tree.
 */
export type SymlinkProbe = (worktreePath: string, relativePath: string) => Promise<boolean | null>

/** The controller's own filesystem. A missing path is unknown, not "not a link". */
export const localSymlinkProbe: SymlinkProbe = async (worktreePath, relativePath) => {
  try {
    // lstat never follows the link, so this cannot expose a target's content.
    return lstatSync(join(worktreePath, relativePath)).isSymbolicLink()
  } catch {
    return null
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
): SymlinkProbe {
  return async (worktreePath, relativePath) => {
    try {
      const result = await runner.runBytes({
        scope: 'guest',
        distro,
        argv: [
          'sh',
          '-c',
          'cd "$1" 2>/dev/null || exit 9; test -L "$2"',
          'sh',
          worktreePath,
          relativePath
        ],
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

export function assertSafeRelativePath(rawPath: string): void {
  const invalid = (detail: string): never => {
    throw readError('INVALID_ARGUMENT', 'That change path is not valid.', detail)
  }
  if (rawPath.length === 0 || rawPath.length > 4096) invalid('length')
  if (rawPath.includes('\u0000')) invalid('nul')
  if (rawPath.startsWith('-')) invalid('option-like')
  if (rawPath.startsWith('/')) invalid('absolute')
  if (/^[A-Za-z]:[\\/]/.test(rawPath)) invalid('drive')
  if (rawPath.startsWith('\\\\')) invalid('unc')
  if (rawPath.split(/[\\/]/u).some((segment) => segment === '..')) invalid('parent')
}

/**
 * Confirms the requested path resolves inside the worktree, following
 * intermediate symlinks. A file that is itself a symlink is allowed: Git prints
 * the link target as content and never reads through it.
 *
 * `resolution` is a seam, not a preference: reading a distro checkout must not
 * call the controller's `realpathSync`, which throws ENOENT for a path that only
 * exists inside the distro.
 */
export function assertContained(
  worktreePath: string,
  rawPath: string,
  resolution: ContainmentResolution = localContainment
): void {
  assertSafeRelativePath(rawPath)
  const root = resolution.realpath(worktreePath)
  const candidate = resolution.resolve(root, rawPath)
  if (!(candidate === root || candidate.startsWith(`${root}${resolution.separator}`))) {
    throw readError('CHANGE_PATH_OUTSIDE', 'That path is outside the session worktree.')
  }

  // Resolve the nearest existing ancestor. This catches an intermediate
  // directory that is a symlink pointing outside the worktree, and works for
  // files that do not exist yet.
  let ancestor = resolution.dirname(candidate)
  for (;;) {
    try {
      const real = resolution.realpath(ancestor)
      if (!(real === root || real.startsWith(`${root}${resolution.separator}`))) {
        throw readError('CHANGE_PATH_OUTSIDE', 'That path resolves outside the session worktree.')
      }
      return
    } catch (error) {
      if (error instanceof GitReadError) throw error
      const parent = resolution.dirname(ancestor)
      if (parent === ancestor) {
        throw readError('CHANGE_PATH_OUTSIDE', 'That path cannot be resolved inside the worktree.')
      }
      ancestor = parent
    }
  }
}
