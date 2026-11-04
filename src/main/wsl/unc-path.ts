/**
 * Spelling a distro's path so a Windows folder picker can browse it.
 *
 * A native folder dialog is a Windows shell window: it cannot enter a distro
 * directly, but it can browse `\\wsl.localhost\<distro>\…`, which is how Windows
 * itself exposes a distro's filesystem. So the picker starts there and the
 * selected Windows path is translated back into the Linux path the distro
 * records and executes with.
 *
 * This is deliberately the *only* transformation in the flow, and it is pure
 * string work: nothing runs inside the distro to answer a path question, and a
 * path that cannot be proved to belong to the requested distro is refused rather
 * than coerced. Coercing it is how a Windows drive folder would silently become
 * a WSL repository.
 */

/** `\\wsl.localhost\<distro>\…` and the older `\\wsl$\<distro>\…` spelling. */
const WSL_UNC = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)([\\/].*)?$/iu
const DRIVE_PATH = /^[A-Za-z]:[\\/]/u

export type WslPickTranslation =
  /** The pick belongs to this distro. */
  | { kind: 'linux'; path: string }
  /** The pick is inside a different distro. */
  | { kind: 'other-distro'; distro: string }
  /** The pick is on a Windows drive, which stays on this machine. */
  | { kind: 'windows-drive' }
  /** The pick is not a location this target can own (relative, bare UNC, …). */
  | { kind: 'outside' }

/**
 * Normalizes a POSIX path, or returns `null` when it is not one.
 *
 * `..` is refused instead of resolved: a picked path comes from a shell dialog
 * that already resolved it, so a traversal segment means the input did not come
 * from where we think it did.
 */
function normalizeLinuxPath(path: string): string | null {
  const trimmed = path.trim()
  if (!trimmed.startsWith('/')) return null
  const segments = trimmed.split('/').filter((segment) => segment.length > 0)
  if (segments.some((segment) => segment === '.' || segment === '..')) return null
  return `/${segments.join('/')}`
}

/**
 * The Windows path a folder picker can start at for `linuxPath`.
 *
 * Returns `null` for anything that is not an absolute POSIX path, so a caller
 * never passes a plausible-looking invention to the shell.
 */
export function toWslUncPath(linuxPath: string, distro: string): string | null {
  const normalizedDistro = distro.trim()
  if (normalizedDistro.length === 0) return null
  const normalized = normalizeLinuxPath(linuxPath)
  if (normalized === null) return null
  // WSL UNC paths use backslashes; the root is the distro itself.
  return `\\\\wsl.localhost\\${normalizedDistro}${normalized.replace(/\//gu, '\\')}`
}

/**
 * The distro and Linux path a Windows spelling names, or `null`.
 *
 * Used to recognise a distro folder that arrived through the *local* picker: the
 * Windows shell lets that dialog browse into a distro, but such a folder must not
 * be recorded as a repository on this machine's execution target.
 */
export function parseWslUnc(windowsPath: string): { distro: string; path: string } | null {
  const normalized = windowsPath.trim().replace(/\\/gu, '/')
  const match = WSL_UNC.exec(normalized)
  if (match === null) return null
  const distro = (match[1] ?? '').trim()
  if (distro.length === 0) return null
  const linuxPath = normalizeLinuxPath(match[2] ?? '/')
  if (linuxPath === null) return null
  return { distro, path: linuxPath }
}

/**
 * What a Windows pick means for the distro the dialog was opened for.
 *
 * Every outcome other than `linux` is a refusal the UI can explain; none of them
 * is silently reinterpreted as a path for this target.
 */
export function fromWslUncPath(windowsPath: string, distro: string): WslPickTranslation {
  const raw = windowsPath.trim()
  if (raw.length === 0) return { kind: 'outside' }
  // A drive folder is the common wrong answer: the dialog can be navigated out of
  // the distro, and that folder belongs to this machine.
  if (DRIVE_PATH.test(raw)) return { kind: 'windows-drive' }

  const normalized = raw.replace(/\\/gu, '/')
  const match = WSL_UNC.exec(normalized)
  if (match === null) return { kind: 'outside' }

  const pickedDistro = match[1] ?? ''
  // WSL distro names are matched case-insensitively; the name is otherwise an
  // identity, so a different one is a different filesystem.
  if (pickedDistro.toLowerCase() !== distro.trim().toLowerCase()) {
    return { kind: 'other-distro', distro: pickedDistro }
  }

  const normalizedLinux = normalizeLinuxPath(match[2] ?? '/')
  if (normalizedLinux === null) return { kind: 'outside' }
  return { kind: 'linux', path: normalizedLinux }
}
