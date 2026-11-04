import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const isWindows = process.platform === 'win32'

/**
 * A host-valid endpoint for tests: a Unix socket on POSIX and a deterministic
 * profile-scoped pipe on Windows. Mirrors `hostSocketPath`.
 */
export function testSocketPath(root: string, name = 'terminal-host'): string {
  if (isWindows) {
    const scope = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 12)
    return `\\\\.\\pipe\\${name}-${scope}`
  }
  return join(root, 'socket', `${name}.sock`)
}

/** Pipes are kernel objects with no filesystem entry to inspect. */
export function endpointExists(path: string): boolean {
  return !isWindows && existsSync(path)
}

/** POSIX mode bits, or null where the platform does not expose them. */
export function socketModeOrNull(path: string): string | null {
  if (isWindows) return null
  return (statSync(path).mode & 0o777).toString(8).padStart(3, '0')
}

/**
 * Symlink creation is privilege-dependent on Windows (Developer Mode or an
 * elevated runner). Probe once instead of keying the tests on the OS name.
 */
export function canCreateSymlinks(): boolean {
  const root = mkdtempSync(join(tmpdir(), 'icode-symlink-probe-'))
  try {
    symlinkSync(join(root, 'target'), join(root, 'link'))
    return true
  } catch {
    return false
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
