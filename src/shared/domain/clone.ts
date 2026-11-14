/**
 * Clone destination rules shared by the dialog and the main process.
 *
 * The directory name is the only part the user controls, and it becomes a path
 * segment on the target host. The rules are deliberately strict and the same on
 * every platform, so a name accepted by the dialog cannot be refused later for
 * a spelling reason.
 */

import type { ExecutionTarget } from './repository'

export const MAX_CLONE_NAME_LENGTH = 200

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/iu

export function isValidCloneName(value: string): boolean {
  if (value.length === 0 || value.length > MAX_CLONE_NAME_LENGTH) return false
  if (value !== value.trim()) return false
  if (value === '.' || value === '..') return false
  if (/[\\/\u0000-\u001f\u007f]/u.test(value)) return false
  if (value.endsWith('.') || value.endsWith(' ')) return false
  return !WINDOWS_RESERVED.test(value)
}

function isWindowsSpelling(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\')
}

/**
 * The destination preview and the value the main process clones into.
 *
 * A Windows drive/UNC parent uses backslashes; everything else — including a
 * WSL guest path — uses POSIX separators. No path module is involved, so the
 * renderer can compute the same value it shows.
 */
export function joinCloneDestination(
  parent: string,
  name: string,
  target: ExecutionTarget
): string {
  if (target.kind === 'local' && isWindowsSpelling(parent)) {
    return `${parent.replace(/[\\/]+$/u, '')}\\${name}`
  }
  return `${parent.replace(/\/+$/u, '')}/${name}`
}
