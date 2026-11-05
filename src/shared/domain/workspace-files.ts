/**
 * Workspace file browsing, editing and search.
 *
 * Every request is scoped to one session, so the answer is always about that
 * session's worktree on that session's host. Paths on the wire are
 * worktree-relative: the renderer never supplies an absolute path, and main
 * re-validates each one, because a "path" from a renderer is user input.
 */

/** Directories that are never worth walking in a project tree. */
export const FILES_SKIP_DIRECTORIES = [
  '.git',
  'node_modules',
  '.venv',
  '__pycache__',
  'dist',
  'out',
  'build',
  '.next',
  '.turbo',
  'target'
] as const

/** One file tree response is capped so a huge repository cannot stall the UI. */
export const FILES_MAX_ENTRIES_PER_DIRECTORY = 2000
/** A file larger than this is reported as too large instead of loaded. */
export const FILES_MAX_FILE_BYTES = 2 * 1024 * 1024
export const FILES_MAX_SEARCH_RESULTS = 200
export const FILES_MAX_SEARCH_FILES = 4000
/** How many leading bytes are sniffed for binary content. */
export const FILES_BINARY_SNIFF_BYTES = 8000

export type FileEntryKind = 'file' | 'directory'

export type FileEntry = {
  /** Basename, for display. */
  name: string
  /** Worktree-relative path with forward slashes. */
  path: string
  kind: FileEntryKind
  /** Bytes for a file; null for a directory. */
  size: number | null
  /** Milliseconds since the Unix epoch; null when the host cannot report it. */
  modifiedAt: number | null
}

export type FileListing = {
  /** The directory that was listed, worktree-relative ('' is the root). */
  path: string
  entries: FileEntry[]
  truncated: boolean
}

export type FileContent = {
  path: string
  text: string
  size: number
  /**
   * Opaque disk version. A save may name this as its expected version, so an
   * Agent's intervening write becomes an explicit conflict instead of a silent
   * overwrite. Backends choose the shape; callers never parse it.
   */
  etag: string
  /** True when the file is not UTF-8 text; `text` is then empty. */
  binary: boolean
  /** True when the file exceeded the read budget. */
  tooLarge: boolean
  /** True when the on-disk bytes do not end with a newline. */
  missingTrailingNewline: boolean
}

/** Version and type of one path, without reading its contents. */
export type FileStat = {
  path: string
  kind: FileEntryKind
  size: number
  etag: string | null
  /** Milliseconds since the Unix epoch; null when the host cannot report it. */
  modifiedAt: number | null
}

/**
 * What changed inside one watched worktree.
 *
 * `changedPaths` are worktree-relative and may contain paths that no longer
 * exist. `overflow` means the burst exceeded the per-window cap, so the
 * consumer must reconcile broadly instead of trusting the list.
 */
export type FilesChangedEvent = {
  sessionId: string
  revision: number
  changedPaths: string[]
  overflow: boolean
  /** True when the watcher stopped and the consumer must fall back to polling. */
  failed?: boolean
}

export type FilesWatchOutcome =
  | { watching: true }
  | {
      watching: false
      reason: 'unsupported-target' | 'watch-failed' | 'cancelled'
    }

/** One path's outcome inside a batch operation. */
export type FileBatchEntry = {
  path: string
  /** Present for move/copy. */
  from?: string
  to?: string
  ok: boolean
  /** True when the work was deliberately not needed (same parent). */
  skipped?: boolean
  reason?: string
  detail?: string
}

export type FileBatchResult = {
  results: FileBatchEntry[]
}

/** One deleted path held in the app-managed session trash. */
export type FileTrashEntry = {
  /** Original worktree-relative path. */
  path: string
  /** Opaque item name inside the operation directory. */
  name: string
  kind: 'file' | 'directory'
}

/** A restorable delete batch. */
export type FileTrashOperation = {
  opId: string
  createdAt: number
  entries: FileTrashEntry[]
}

export type FileTrashResult = {
  /** Null when nothing could be moved to trash. */
  opId: string | null
  results: FileBatchEntry[]
  /** The successful paths, for the notice/banner. */
  entries: FileTrashEntry[]
}

export type FileSearchMatch = {
  path: string
  /** 1-based line number. */
  line: number
  /** 1-based column of the first match on the line. */
  column: number
  /** The matched line, trimmed of trailing whitespace and capped. */
  text: string
}

export type FileSearchResult = {
  matches: FileSearchMatch[]
  /** True when the result cap was hit. */
  truncated: boolean
  /** Files examined before the cap, for an honest "searched N files" note. */
  scannedFiles: number
  /** True when a newer search or Stop superseded this one. */
  cancelled?: boolean
}

/** Options shared by search and the bounded replace scan. */
export type FileSearchOptions = {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
  include: string[]
  exclude: string[]
  limit: number
}

export type FileReplaceEntry = {
  path: string
  ok: boolean
  replaced: number
  reason?: string
  detail?: string
}

export type FileReplaceResult = {
  files: number
  replacements: number
  results: FileReplaceEntry[]
  /** True when the search surface was capped before all matches were examined. */
  truncated: boolean
}

/** Why a file operation could not be answered. */
export type FilesUnavailableReason =
  | 'primary-checkout'
  | 'worktree-missing'
  | 'worktree-unavailable'
  | 'path-outside'
  | 'not-found'
  | 'not-a-file'
  | 'not-a-directory'
  | 'unreadable'
  | 'file-too-large'
  | 'binary'
  | 'write-failed'
  | 'already-exists'
  /** The disk changed since the caller read it; `currentEtag` names the new version. */
  | 'changed-on-disk'
  /** The search pattern is not a valid regular expression. */
  | 'invalid-query'
  /** A newer search or Stop superseded this one. */
  | 'cancelled'

export function isSkippedDirectory(name: string): boolean {
  return (FILES_SKIP_DIRECTORIES as readonly string[]).includes(name)
}

/**
 * Normalises a worktree-relative path supplied by the renderer.
 *
 * Returns null for anything that could escape the worktree or that would be
 * ambiguous to a shell or to Git. Deliberately strict: the only accepted shape
 * is `a`, `a/b`, `a/b/c` with no empty, `.` or `..` segments.
 */
export function normalizeRelativePath(raw: string): string | null {
  if (raw === '') return ''
  if (raw.length > 4096) return null
  if (raw.includes('\u0000')) return null
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return null
  const segments = raw.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null
  }
  return segments.join('/')
}

/** The parent directory of a relative path ('' at the root). */
export function parentPath(relativePath: string): string {
  const index = relativePath.lastIndexOf('/')
  return index === -1 ? '' : relativePath.slice(0, index)
}

/**
 * A NUL byte in the first chunk is the standard binary heuristic.
 *
 * Takes a byte array rather than a `Buffer` so this module stays usable from the
 * renderer, which has no Node types.
 */
export function looksBinaryBytes(bytes: ArrayLike<number>): boolean {
  const limit = Math.min(bytes.length, FILES_BINARY_SNIFF_BYTES)
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) return true
  }
  return false
}
