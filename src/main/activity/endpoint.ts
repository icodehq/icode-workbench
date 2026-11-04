import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { namedPipe } from '../../shared/domain/endpoint'
import { profileSocketScope } from '../../host/paths'

/** macOS sun_path is 104 bytes; stay below it with room for a trailing suffix. */
const MAX_SOCKET_PATH_BYTES = 100

/**
 * Endpoint the Claude hooks connect to, and the server listens on.
 *
 * Both sides read this one function, so they cannot drift: the hook script
 * receives the value through `ICODE_ACTIVITY_SOCKET` and connects with
 * `net.createConnection`, which accepts either a path or a pipe name.
 *
 * Windows requires a named pipe; POSIX keeps the socket beside the profile's
 * other run state. The scope is the same profile digest the Terminal Host uses,
 * so two iCode profiles never share an ingress.
 */
export function activitySocketPath(options: {
  userDataDir: string
  /** Test seam: selects the Windows branch without a Windows host. */
  platform?: NodeJS.Platform
}): string {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') {
    return namedPipe('icode-activity', profileSocketScope(options.userDataDir))
  }
  const fallback = join(options.userDataDir, 'run', 'activity.sock')
  if (Buffer.byteLength(fallback) <= MAX_SOCKET_PATH_BYTES) return fallback
  // Keep the socket in a per-profile directory so its parent can stay owner-
  // only; the flat name is the last resort for an unusually long temp root.
  const scope = profileSocketScope(options.userDataDir)
  const scopedTemp = join(tmpdir(), 'icode', scope, 'activity.sock')
  if (Buffer.byteLength(scopedTemp) <= MAX_SOCKET_PATH_BYTES) return scopedTemp
  return join(tmpdir(), `icode-activity-${scope}.sock`)
}
