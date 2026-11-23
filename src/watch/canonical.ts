import { realpathSync } from 'node:fs'
import type { SerializedWatchSpec } from '../shared/watch-protocol'

/**
 * Canonicalizes a watch root in the process that opens the physical watch.
 *
 * libuv compares the spelling it reports with the spelling it was given; a
 * Windows 8.3 short name makes that comparison fail (and once aborted the
 * process). The main process canonicalizes too, but the child must own this
 * because it may receive a root the main process built before a rename.
 */
export function canonicalWatchPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/**
 * Canonicalizes every path the ignore rules compare against an event path.
 *
 * Backends canonicalize their roots, and macOS reports `/private/var/...` for
 * a root created as `/var/...`. If the spec keeps the original spelling, an
 * event under that root looks like it is outside the worktree and every ignore
 * rule silently stops matching. The same applies to a Git directory reached
 * through a symlinked checkout.
 */
export function canonicalWatchSpec(spec: SerializedWatchSpec): SerializedWatchSpec {
  const canonical: SerializedWatchSpec = {
    ...spec,
    roots: spec.roots.map(canonicalWatchPath),
    worktreePath: canonicalWatchPath(spec.worktreePath)
  }
  if (spec.git !== undefined) {
    canonical.git = {
      worktreePath: canonicalWatchPath(spec.git.worktreePath),
      gitDir: canonicalWatchPath(spec.git.gitDir)
    }
  }
  return canonical
}
