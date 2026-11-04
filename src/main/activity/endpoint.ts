import { join } from 'node:path'
import { namedPipe } from '../../shared/domain/endpoint'
import { profileSocketScope } from '../../host/paths'

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
  return join(options.userDataDir, 'run', 'activity.sock')
}
