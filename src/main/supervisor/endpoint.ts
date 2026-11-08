import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { namedPipe } from '../../shared/domain/endpoint'
import { profileSocketScope } from '../../host/paths'

/** macOS sun_path is 104 bytes; stay below it with room for a trailing suffix. */
const MAX_SOCKET_PATH_BYTES = 100

/**
 * Endpoint the supervisor CLI connects to and the control server listens on.
 *
 * One endpoint per iCode profile, like the activity ingress. A supervisor
 * binding is resolved from its token, not from the socket path, because several
 * project supervisors share this one control plane.
 */
export function supervisorSocketPath(options: {
  userDataDir: string
  platform?: NodeJS.Platform
}): string {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') {
    return namedPipe('icode-supervisor', profileSocketScope(options.userDataDir))
  }
  const fallback = join(options.userDataDir, 'run', 'supervisor.sock')
  if (Buffer.byteLength(fallback) <= MAX_SOCKET_PATH_BYTES) return fallback
  const scope = profileSocketScope(options.userDataDir)
  const scopedTemp = join(tmpdir(), 'icode', scope, 'supervisor.sock')
  if (Buffer.byteLength(scopedTemp) <= MAX_SOCKET_PATH_BYTES) return scopedTemp
  return join(tmpdir(), `icode-supervisor-${scope}.sock`)
}
