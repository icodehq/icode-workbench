/**
 * Text-file helpers for managed hook configs that are not plain JSON.
 *
 * Writes are atomic, preserve an existing file's mode and symlink target, and
 * keep one `.icode.bak` copy. Provider-specific serializers own what the text
 * means; these helpers only move bytes safely.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'

export const MANAGED_CONFIG_BACKUP_SUFFIX = '.icode.bak'

export function readTextOrNull(path: string): string | null {
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf8')
}

export function eolFor(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

function writePathFor(path: string): string {
  if (!existsSync(path)) return path
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

export function writeTextAtomic(
  path: string,
  text: string,
  options: { mode?: number; defaultMode?: number; backup?: boolean } = {}
): void {
  const writePath = writePathFor(path)
  if (existsSync(writePath)) {
    try {
      if (readFileSync(writePath, 'utf8') === text) return
    } catch {
      // Fall through to the atomic write.
    }
  }
  const directory = dirname(writePath)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const existingMode = existsSync(writePath)
    ? statSync(writePath).mode & 0o777
    : (options.defaultMode ?? 0o600)
  const mode = options.mode ?? existingMode
  const temporary = `${writePath}.icode-tmp-${String(process.pid)}-${String(Math.random()).slice(2)}`
  try {
    writeFileSync(temporary, text, { encoding: 'utf8', mode, flag: 'wx' })
    if (process.platform !== 'win32') chmodSync(temporary, mode)
    if (options.backup !== false && existsSync(writePath)) {
      try {
        copyFileSync(writePath, `${writePath}${MANAGED_CONFIG_BACKUP_SUFFIX}`)
      } catch {
        // A backup is helpful, never required for a correct write.
      }
    }
    renameSync(temporary, writePath)
  } finally {
    if (existsSync(temporary)) {
      try {
        unlinkSync(temporary)
      } catch {
        // best effort
      }
    }
  }
}

export type MarkerStripResult = {
  text: string
  changed: boolean
  unbalanced: boolean
}

/**
 * Removes every marker-delimited block. An unmatched start marker means the
 * file was edited by hand; callers treat that as a refusal, never as permission
 * to delete the rest of the file.
 */
export function stripMarkerBlock(
  text: string,
  startMarker: string,
  endMarker: string
): MarkerStripResult {
  const eol = eolFor(text)
  const lines = text.split(/\r?\n/u)
  const out: string[] = []
  let changed = false
  let index = 0
  while (index < lines.length) {
    if (lines[index]?.trim() !== startMarker) {
      out.push(lines[index] ?? '')
      index += 1
      continue
    }
    let end = index + 1
    while (end < lines.length && lines[end]?.trim() !== endMarker) end += 1
    if (end >= lines.length) return { text, changed: false, unbalanced: true }
    changed = true
    index = end + 1
  }
  return { text: out.join(eol), changed, unbalanced: false }
}
