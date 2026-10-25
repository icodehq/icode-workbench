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
  /** True when the file is not UTF-8 text; `text` is then empty. */
  binary: boolean
  /** True when the file exceeded the read budget. */
  tooLarge: boolean
  /** True when the on-disk bytes do not end with a newline. */
  missingTrailingNewline: boolean
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
