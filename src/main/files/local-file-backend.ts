import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  FILES_MAX_ENTRIES_PER_DIRECTORY,
  FILES_MAX_SEARCH_FILES,
  FILES_MAX_SEARCH_RESULTS,
  FILES_MAX_FILE_BYTES,
  isSkippedDirectory,
  looksBinaryBytes,
  type FileContent,
  type FileEntry,
  type FileSearchResult
} from '../../shared/domain/workspace-files'

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
  write(relativePath: string, text: string): Promise<{ size: number }>
  /** Plain-text search across the checkout. */
  search(query: string, options: { caseSensitive: boolean; limit: number }): Promise<FileSearchResult>
  /** Creates an empty file, or a directory. Never overwrites an existing path. */
  create(relativePath: string, kind: 'file' | 'directory'): Promise<void>
  /** Renames or moves one path. Fails when the target already exists. */
  rename(from: string, to: string): Promise<void>
  /** Deletes one file or one empty-or-not directory tree. */
  remove(relativePath: string): Promise<void>
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
      | 'already-exists',
    message: string
  ) {
    super(message)
    this.name = 'FileAccessError'
  }
}

function errnoOf(error: unknown): string {
  return error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : ''
}

function joinRelative(root: string, relative: string): string {
  return relative === '' ? root : join(root, relative)
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
        if (dirent.isDirectory()) {
          entries.push({ name: dirent.name, path: childRelative, kind: 'directory', size: null })
          continue
        }
        if (!dirent.isFile()) continue
        let size: number | null = null
        try {
          size = (await stat(joinRelative(root, childRelative))).size
        } catch {
          size = null
        }
        entries.push({ name: dirent.name, path: childRelative, kind: 'file', size })
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
        binary: looksBinaryBytes(buffer),
        tooLarge: false,
        missingTrailingNewline: buffer.length > 0 && buffer[buffer.length - 1] !== 0x0a
      }
    },

    async write(relative, text) {
      const absolute = joinRelative(root, relative)
      try {
        await writeFile(absolute, text, 'utf8')
        return { size: Buffer.byteLength(text, 'utf8') }
      } catch {
        throw new FileAccessError('write-failed', 'That file could not be written.')
      }
    },

    async search(query, options) {
      const needle = options.caseSensitive ? query : query.toLowerCase()
      const matches: FileSearchResult['matches'] = []
      let scannedFiles = 0
      let truncated = false

      const walk = async (relative: string): Promise<void> => {
        if (truncated) return
        let dirents
        try {
          dirents = await readdir(joinRelative(root, relative), { withFileTypes: true })
        } catch {
          return
        }
        dirents.sort((left, right) => left.name.localeCompare(right.name))
        for (const dirent of dirents) {
          if (truncated) return
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
            const line = lines[index] ?? ''
            const haystack = options.caseSensitive ? line : line.toLowerCase()
            const column = haystack.indexOf(needle)
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
      return { matches, truncated, scannedFiles }
    },

    async create(relative, kind) {
      const absolute = joinRelative(root, relative)
      try {
        // `wx`/mkdir without recursive both refuse to clobber an existing path.
        if (kind === 'directory') await mkdir(absolute)
        else await writeFile(absolute, '', { flag: 'wx' })
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

    async remove(relative) {
      try {
        await rm(joinRelative(root, relative), { recursive: true })
      } catch (error) {
        if (errnoOf(error) === 'ENOENT') throw new FileAccessError('not-found', 'That path does not exist.')
        throw new FileAccessError('write-failed', 'That path could not be deleted.')
      }
    }
  }
}

export { nameOf as fileNameOf }
export { FILES_MAX_SEARCH_RESULTS }
