import { realpathSync } from 'node:fs'

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
