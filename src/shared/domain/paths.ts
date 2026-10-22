/**
 * Path vocabulary. These helpers decide whether a value *looks* absolute; only
 * the repository resolver may turn a path into a CanonicalRepositoryPath after
 * an OS-level realpath check.
 */

declare const canonicalPathBrand: unique symbol

export type CanonicalRepositoryPath = string & { readonly [canonicalPathBrand]: true }

export const MAX_PATH_LENGTH = 4096

export function isAbsolutePathLike(value: string): boolean {
  if (value.length === 0 || value.length > MAX_PATH_LENGTH) return false
  if (value.includes('\0')) return false
  if (value.startsWith('/')) return true
  if (/^[A-Za-z]:[\\/]/.test(value)) return true
  return value.startsWith('\\\\')
}

/** Caller must pass an already-realpath'd repository root. */
export function toCanonicalRepositoryPath(value: string): CanonicalRepositoryPath {
  if (!isAbsolutePathLike(value)) {
    throw new Error(`Repository path must be absolute: ${value}`)
  }
  return value as CanonicalRepositoryPath // SAFETY: isAbsolutePathLike validated shape and length.
}
