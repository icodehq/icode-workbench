import { cp, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  FILES_MAX_ENTRIES_PER_DIRECTORY,
  FILES_MAX_SEARCH_FILES,
  FILES_MAX_SEARCH_RESULTS,
  FILES_MAX_FILE_BYTES,
  isSkippedDirectory,
  looksBinaryBytes,
  type FileContent,
  type FileEntry,
  type FileSearchOptions,
  type FileSearchResult,
  type FileStat
} from '../../shared/domain/workspace-files'
import { isSearchPathIncluded } from '../../shared/domain/glob'
import { compileTextMatcher } from '../../shared/domain/text-search'

/**
 * File access for one checkout, wherever it lives.
 *
 * Two implementations exist — the controller's own filesystem and a distro's —
 * because a guest path is not a path this process can open. The service above
 * selects one from the session's execution target and never falls back: reading
 * a guest checkout with the local implementation would answer about a different
 * machine and report every file as missing.
 */
export type FileBackend = {
  /** Entries of one directory inside the checkout. */
  list(relativePath: string): Promise<{ entries: FileEntry[]; truncated: boolean }>
  read(relativePath: string): Promise<FileContent>
  stat(relativePath: string): Promise<FileStat>
  /**
   * Writes one file.
   *
   * `expectedEtag` is the optimistic-concurrency check: a string requires that
   * version, `null` requires that the path is still absent, and `undefined`
   * keeps the unconditional write used by non-editor callers.
   */
  write(
    relativePath: string,
    text: string,
    expectedEtag?: string | null
  ): Promise<{ size: number; etag: string }>
  /** Plain-text search across the checkout. */
  search(
    query: string,
    options: FileSearchOptions & { signal?: AbortSignal }
  ): Promise<FileSearchResult>
  /** Creates an empty file, or a directory. Never overwrites an existing path. */
  create(relativePath: string, kind: 'file' | 'directory'): Promise<{ etag: string | null }>
  /** Renames or moves one path. Fails when the target already exists. */
  rename(from: string, to: string): Promise<void>
  /** Recursively copies one path. Fails when the target already exists. */
  copy(from: string, to: string): Promise<void>
  /** Deletes one file or one empty-or-not directory tree. */
  remove(relativePath: string): Promise<void>
  /** Moves one path out of the checkout into an app-owned operation directory. */
  trash(relativePath: string, opDir: string, name: string): Promise<void>
  /** Moves one trashed item back to its original worktree-relative path. */
  restoreTrash(opDir: string, name: string, relativePath: string): Promise<void>
  /** Deletes one trash operation directory. */
  discardTrash(opDir: string): Promise<void>
  /** True when the trash operation directory still exists on this host. */
  trashExists(opDir: string): Promise<boolean>
}

/** Raised when the backend could not read at all, distinct from "no such file". */
export class FileAccessError extends Error {
  constructor(
    readonly reason:
      | 'not-found'
      | 'not-a-file'
      | 'not-a-directory'
      | 'unreadable'
      | 'write-failed'
      | 'already-exists'
      | 'changed-on-disk'
      | 'invalid-query'
      | 'cancelled',
    message: string,
    /** The version that made the write conflict, when the host can report it. */
    readonly currentEtag?: string
  ) {
    super(message)
    this.name = 'FileAccessError'
  }
}

/** Opaque version used by the editor's optimistic save. */
function hashOf(buffer: Buffer): string {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`
}

/** Directories and oversized files are versioned by stat, not by content. */
function statEtag(info: Stats): string {
  return `stat:${info.mtimeMs}:${info.size}`
}

function etagOf(info: Stats, buffer: Buffer): string {
  return info.size > FILES_MAX_FILE_BYTES ? statEtag(info) : hashOf(buffer)
}

async function etagForPath(absolute: string, info: Stats): Promise<string> {
  if (info.size > FILES_MAX_FILE_BYTES) return statEtag(info)
  return hashOf(await readFile(absolute))
}

function fileStatOf(relative: string, info: Stats, etag: string): FileStat {
  return {
    path: relative,
    kind: info.isDirectory() ? 'directory' : 'file',
    size: info.size,
    etag,
    modifiedAt: Number.isFinite(info.mtimeMs) ? Math.round(info.mtimeMs) : null
  }
}

let writeSequence = 0

function errnoOf(error: unknown): string {
  return error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : ''
}

function joinRelative(root: string, relative: string): string {
  return relative === '' ? root : join(root, relative)
}

/** Same-filesystem rename, with a copy+remove fallback for a different volume. */
async function moveAbsolute(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (error) {
    if (errnoOf(error) !== 'EXDEV') throw error
    await cp(from, to, { recursive: true, errorOnExist: true, force: false })
    await rm(from, { recursive: true, force: true })
  }
}

function nameOf(relative: string): string {
  const index = relative.lastIndexOf('/')
  return index === -1 ? relative : relative.slice(index + 1)
}

/** The controller's filesystem. Identical in behaviour to pre-W81 browsing. */
export function createLocalFileBackend(root: string): FileBackend {
  return {
    async list(relative) {
      const absolute = joinRelative(root, relative)
      let dirents
      try {
        dirents = await readdir(absolute, { withFileTypes: true })
      } catch (error) {
        if (errnoOf(error) === 'ENOENT') throw new FileAccessError('not-found', 'That directory does not exist.')
        if (errnoOf(error) === 'ENOTDIR') {
          throw new FileAccessError('not-a-directory', 'That path is not a directory.')
        }
        throw new FileAccessError('unreadable', 'That directory could not be read.')
      }

      const entries: FileEntry[] = []
      let truncated = false
      for (const dirent of dirents) {
        if (entries.length >= FILES_MAX_ENTRIES_PER_DIRECTORY) {
          truncated = true
          break
        }
        if (dirent.name === '.' || dirent.name === '..') continue
        const childRelative = relative === '' ? dirent.name : `${relative}/${dirent.name}`
        let info: Stats | null = null
        try {
          info = await stat(joinRelative(root, childRelative))
        } catch {
          info = null
        }
        const modifiedAt =
          info !== null && Number.isFinite(info.mtimeMs) ? Math.round(info.mtimeMs) : null
        if (dirent.isDirectory()) {
          entries.push({
            name: dirent.name,
            path: childRelative,
            kind: 'directory',
            size: null,
            modifiedAt
          })
          continue
        }
        if (!dirent.isFile()) continue
        entries.push({
          name: dirent.name,
          path: childRelative,
          kind: 'file',
          size: info?.size ?? null,
          modifiedAt
        })
      }
      entries.sort(
        (left, right) =>
          Number(right.kind === 'directory') - Number(left.kind === 'directory') ||
          left.name.localeCompare(right.name)
      )
      return { entries, truncated }
    },

    async read(relative) {
      const absolute = joinRelative(root, relative)
      let info
      try {
        info = await stat(absolute)
      } catch (error) {
        if (errnoOf(error) === 'ENOENT') throw new FileAccessError('not-found', 'That file does not exist.')
        throw new FileAccessError('unreadable', 'That file could not be read.')
      }
      if (!info.isFile()) throw new FileAccessError('not-a-file', 'That path is not a file.')
      if (info.size > FILES_MAX_FILE_BYTES) {
        return {
          path: relative,
          text: '',
          size: info.size,
          etag: statEtag(info),
          binary: false,
          tooLarge: true,
          missingTrailingNewline: false
        }
      }
      const buffer = await readFile(absolute)
      return {
        path: relative,
        text: looksBinaryBytes(buffer) ? '' : buffer.toString('utf8'),
        size: info.size,
        etag: etagOf(info, buffer),
        binary: looksBinaryBytes(buffer),
        tooLarge: false,
        missingTrailingNewline: buffer.length > 0 && buffer[buffer.length - 1] !== 0x0a
      }
    },

    async stat(relative) {
      const absolute = joinRelative(root, relative)
      let info
      try {
        info = await stat(absolute)
      } catch (error) {
        if (errnoOf(error) === 'ENOENT') throw new FileAccessError('not-found', 'That path does not exist.')
        throw new FileAccessError('unreadable', 'That path could not be read.')
      }
      if (info.isDirectory()) {
        return fileStatOf(relative, info, statEtag(info))
      }
      if (!info.isFile()) {
        throw new FileAccessError('not-a-file', 'That path is not a file or folder.')
      }
      if (info.size > FILES_MAX_FILE_BYTES) {
        return fileStatOf(relative, info, statEtag(info))
      }
      const buffer = await readFile(absolute)
      return fileStatOf(relative, info, etagOf(info, buffer))
    },

    async write(relative, text, expectedEtag) {
      const absolute = joinRelative(root, relative)
      let current: Stats | null = null
      try {
        current = await stat(absolute)
      } catch (error) {
        if (errnoOf(error) !== 'ENOENT') {
          throw new FileAccessError('write-failed', 'That file could not be checked before writing.')
        }
      }
      if (current !== null && current.isDirectory()) {
        throw new FileAccessError('not-a-file', 'That path is a directory.')
      }

      if (expectedEtag !== undefined) {
        if (expectedEtag === null) {
          if (current !== null) {
            throw new FileAccessError(
              'changed-on-disk',
              'Something already exists at that path.',
              await etagForPath(absolute, current)
            )
          }
        } else {
          if (current === null) {
            throw new FileAccessError('changed-on-disk', 'That file was deleted on disk.')
          }
          const currentEtag = await etagForPath(absolute, current)
          if (currentEtag !== expectedEtag) {
            throw new FileAccessError(
              'changed-on-disk',
              'That file changed on disk.',
              currentEtag
            )
          }
        }
      }

      // Stage then rename, so a failed write cannot truncate the real file. The
      // etag check above narrows the check-to-rename window; the watcher and the
      // conflict dialog cover the remainder.
      const temp = `${absolute}.icode-write-${process.pid}-${++writeSequence}`
      try {
        await writeFile(temp, text, current === null ? 'utf8' : { encoding: 'utf8', mode: current.mode })
        await rename(temp, absolute)
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined)
        const code = errnoOf(error)
        // Windows can refuse replacing an existing file with rename. The etag
        // has already been checked, so the direct write is the best available
        // fallback there.
        if (code === 'EEXIST' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY') {
          try {
            await writeFile(absolute, text, 'utf8')
          } catch {
            throw new FileAccessError('write-failed', 'That file could not be written.')
          }
        } else {
          throw new FileAccessError('write-failed', 'That file could not be written.')
        }
      }

      try {
        const after = await stat(absolute)
        return { size: after.size, etag: hashOf(Buffer.from(text, 'utf8')) }
      } catch {
        return { size: Buffer.byteLength(text, 'utf8'), etag: hashOf(Buffer.from(text, 'utf8')) }
      }
    },

    async search(query, options) {
      const matcher = compileTextMatcher(query, {
        caseSensitive: options.caseSensitive,
        wholeWord: options.wholeWord,
        regex: options.regex
      })
      if (matcher.error !== null) {
        throw new FileAccessError('invalid-query', matcher.error)
      }
      const matches: FileSearchResult['matches'] = []
      let scannedFiles = 0
      let truncated = false
      const cancelled = (): boolean => options.signal?.aborted === true

      const walk = async (relative: string): Promise<void> => {
        if (truncated || cancelled()) return
        let dirents
        try {
          dirents = await readdir(joinRelative(root, relative), { withFileTypes: true })
        } catch {
          return
        }
        dirents.sort((left, right) => left.name.localeCompare(right.name))
        for (const dirent of dirents) {
          if (truncated || cancelled()) return
          if (dirent.isDirectory()) {
            if (isSkippedDirectory(dirent.name)) continue
            await walk(relative === '' ? dirent.name : `${relative}/${dirent.name}`)
            continue
          }
          if (!dirent.isFile()) continue
          if (scannedFiles >= FILES_MAX_SEARCH_FILES) {
            truncated = true
            return
          }
          const childRelative = relative === '' ? dirent.name : `${relative}/${dirent.name}`
          if (!isSearchPathIncluded(childRelative, options.include, options.exclude)) continue
          scannedFiles += 1
          let buffer: Buffer
          try {
            const info = await stat(joinRelative(root, childRelative))
            if (info.size > FILES_MAX_FILE_BYTES) continue
            buffer = await readFile(joinRelative(root, childRelative))
          } catch {
            continue
          }
          if (looksBinaryBytes(buffer)) continue
          const lines = buffer.toString('utf8').split('\n')
          for (let index = 0; index < lines.length; index += 1) {
            if (cancelled()) return
            const line = lines[index] ?? ''
            const column = matcher.match(line)
            if (column === -1) continue
            matches.push({
              path: childRelative,
              line: index + 1,
              column: column + 1,
              text: line.trimEnd().slice(0, 400)
            })
            if (matches.length >= options.limit) {
              truncated = true
              return
            }
          }
        }
      }

      await walk('')
      return {
        matches,
        truncated,
        scannedFiles,
        ...(cancelled() ? { cancelled: true } : {})
      }
    },

    async create(relative, kind) {
      const absolute = joinRelative(root, relative)
      try {
        // `wx`/mkdir without recursive both refuse to clobber an existing path.
        if (kind === 'directory') {
          await mkdir(absolute)
          return { etag: null }
        }
        await writeFile(absolute, '', { flag: 'wx' })
        const info = await stat(absolute)
        return { etag: etagOf(info, Buffer.alloc(0)) }
      } catch (error) {
        if (errnoOf(error) === 'EEXIST') {
          throw new FileAccessError('already-exists', 'Something already exists at that path.')
        }
        if (errnoOf(error) === 'ENOENT') {
          throw new FileAccessError('not-found', 'The parent directory does not exist.')
        }
        throw new FileAccessError('write-failed', 'That path could not be created.')
      }
    },

    async rename(from, to) {
      // POSIX `rename` silently replaces the target; that would destroy a file
      // the user still has. Refuse a collision explicitly instead.
      try {
        await lstat(joinRelative(root, to))
        throw new FileAccessError('already-exists', 'Something already exists at the new path.')
      } catch (error) {
        if (error instanceof FileAccessError) throw error
        if (errnoOf(error) !== 'ENOENT') {
          throw new FileAccessError('write-failed', 'The new path could not be checked.')
        }
      }
      try {
        await rename(joinRelative(root, from), joinRelative(root, to))
      } catch (error) {
        const code = errnoOf(error)
        if (code === 'EEXIST' || code === 'ENOTEMPTY') {
          throw new FileAccessError('already-exists', 'Something already exists at the new path.')
        }
        if (code === 'ENOENT') throw new FileAccessError('not-found', 'That path does not exist.')
        throw new FileAccessError('write-failed', 'That path could not be renamed.')
      }
    },

    async copy(from, to) {
      // A directory cannot be copied into itself. An equal target is handled by
      // the existing-target check below, which produces `already-exists`.
      if (to.startsWith(`${from}/`)) {
        throw new FileAccessError('write-failed', 'A folder cannot be copied into itself.')
      }
      const source = joinRelative(root, from)
      const target = joinRelative(root, to)
      try {
        await lstat(source)
      } catch (error) {
        if (errnoOf(error) === 'ENOENT') throw new FileAccessError('not-found', 'That path does not exist.')
        throw new FileAccessError('unreadable', 'That path could not be read.')
      }
      try {
        await lstat(target)
        throw new FileAccessError('already-exists', 'Something already exists at the new path.')
      } catch (error) {
        if (error instanceof FileAccessError) throw error
        if (errnoOf(error) !== 'ENOENT') {
          throw new FileAccessError('write-failed', 'The new path could not be checked.')
        }
      }
      try {
        await cp(source, target, {
          recursive: true,
          errorOnExist: true,
          force: false,
          preserveTimestamps: true
        })
      } catch (error) {
        const code = errnoOf(error)
        if (code === 'ENOENT') throw new FileAccessError('not-found', 'That path does not exist.')
        if (code === 'EEXIST') {
          throw new FileAccessError('already-exists', 'Something already exists at the new path.')
        }
        throw new FileAccessError('write-failed', 'That path could not be copied.')
      }
    },

    async remove(relative) {
      try {
        await rm(joinRelative(root, relative), { recursive: true })
      } catch (error) {
        if (errnoOf(error) === 'ENOENT') throw new FileAccessError('not-found', 'That path does not exist.')
        throw new FileAccessError('write-failed', 'That path could not be deleted.')
      }
    },
    async trash(relative, opDir, name) {
      const source = joinRelative(root, relative)
      try {
        await mkdir(opDir, { recursive: true })
        await moveAbsolute(source, join(opDir, name))
      } catch (error) {
        if (errnoOf(error) === 'ENOENT') {
          throw new FileAccessError('not-found', 'That path does not exist.')
        }
        throw new FileAccessError('write-failed', 'That path could not be moved to Trash.')
      }
    },
    async restoreTrash(opDir, name, relative) {
      const target = joinRelative(root, relative)
      try {
        await mkdir(dirname(target), { recursive: true })
        await lstat(target)
        throw new FileAccessError('already-exists', 'Something already exists at the original path.')
      } catch (error) {
        if (error instanceof FileAccessError) throw error
        if (errnoOf(error) !== 'ENOENT') {
          throw new FileAccessError('write-failed', 'The original path could not be prepared.')
        }
      }
      try {
        await moveAbsolute(join(opDir, name), target)
      } catch (error) {
        if (errnoOf(error) === 'ENOENT') {
          throw new FileAccessError('not-found', 'The Trash item is no longer there.')
        }
        throw new FileAccessError('write-failed', 'That item could not be restored.')
      }
    },
    async discardTrash(opDir) {
      try {
        await rm(opDir, { recursive: true, force: true })
      } catch {
        throw new FileAccessError('write-failed', 'That Trash directory could not be removed.')
      }
    },
    async trashExists(opDir) {
      try {
        return (await stat(opDir)).isDirectory()
      } catch {
        return false
      }
    }
  }
}

export { nameOf as fileNameOf }
export { FILES_MAX_SEARCH_RESULTS }
