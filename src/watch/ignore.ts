/**
 * Child-side ignore rules.
 *
 * The serialized spec carries the directory/suffix rules; this module turns
 * them into (a) a delivery predicate used by every backend and (b) native glob
 * patterns the parcel backend can prune with. Both are derived from the same
 * spec so a backend difference cannot silently widen what is watched.
 */

import {
  shouldIgnoreFilesWatchPath,
  shouldIgnoreWatchPath
} from '../shared/domain/watch-ignore'
import type { SerializedWatchSpec } from '../shared/watch-protocol'

/** True when a delivered path must not wake the subscription. */
export function ignoreSpecPath(spec: SerializedWatchSpec, path: string): boolean {
  return spec.git
    ? shouldIgnoreWatchPath(path, spec.git)
    : shouldIgnoreFilesWatchPath(path, spec.worktreePath)
}

function regexEscape(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&')
}

/** Separator-aware prefix: parcel hands the native matcher absolute paths. */
function nestedDirectoryRegex(names: readonly string[]): string {
  if (names.length === 0) return ''
  const alternatives = names.map(regexEscape).join('|')
  if (process.platform === 'win32') {
    return `^(?:[\\\\/])?(?:[^\\\\/]+[\\\\/])*(?:${alternatives})(?:[\\\\/][\\s\\S]*)?$`
  }
  return `^(?:/)?(?:[^/]+/)*(?:${alternatives})(?:/[\\s\\S]*)?$`
}

function suffixRegex(suffixes: readonly string[]): string {
  const alternatives = suffixes.map(regexEscape).join('|')
  if (process.platform === 'win32') {
    return `(?:^|[\\\\/])[^\\\\/]*(?:${alternatives})$`
  }
  return `(?:^|/)[^/]*(?:${alternatives})$`
}

/**
 * Native regex sources for one parcel subscription root.
 *
 * `ignoreGlobs` is a misnomer in @parcel/watcher 2.5.6: the native binding
 * compiles each entry as a **regular expression** (the JS wrapper only builds
 * regexes for the `ignore` option). We therefore emit component regexes rather
 * than globs, matching Orca's approach and avoiding the pathological leading
 * double-star lookaheads Parcel 2.5.6 produces for glob patterns.
 *
 * A recursive Source Control watch opens two roots: the worktree (where `.git`
 * is metadata churn) and the Git directory (where `objects`/`logs` churn but
 * `index`/`HEAD` matter). The rules differ per root.
 */
export function parcelIgnoreRegexesForRoot(
  spec: SerializedWatchSpec,
  root: string
): string[] {
  const gitDir = spec.git?.gitDir
  if (gitDir !== undefined && root === gitDir) {
    return [
      nestedDirectoryRegex(['objects', 'logs', 'lfs']),
      suffixRegex(['.lock', '.tmp']),
      process.platform === 'win32'
        ? `(?:^|[\\\\/])(?:next-index-|watchman-)`
        : `(?:^|/)(?:next-index-|watchman-)`
    ].filter((pattern) => pattern.length > 0)
  }

  const directories = [...spec.ignore.skipDirectories]
  if (spec.git !== undefined && !directories.includes('.git')) directories.push('.git')
  const patterns = [
    nestedDirectoryRegex(directories),
    suffixRegex(spec.ignore.skipSuffixes),
    spec.ignore.stagingMarker !== null
      ? `^.*${regexEscape(spec.ignore.stagingMarker)}.*$`
      : ''
  ].filter((pattern) => pattern.length > 0)
  return patterns
}
