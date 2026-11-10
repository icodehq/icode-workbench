import { realpathSync } from 'node:fs'

/**
 * Canonicalizes a directory before it is handed to a filesystem watcher.
 *
 * Why: libuv on Windows asserts that an event path starts with the watched
 * directory's spelling. Windows may hand us a directory through its 8.3 short
 * name (for example `RUNNER~1`) while libuv reports long names, so watching the
 * short spelling aborts the process with `0xC0000409`
 * (`STATUS_STACK_BUFFER_OVERRUN`). Resolving the root with the native realpath
 * expands the short name and keeps both sides in the same spelling.
 *
 * A path that does not exist yet (or cannot be resolved) is returned unchanged;
 * chokidar reports a normal watch error for it instead of crashing here.
 */
export function canonicalWatchPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}
