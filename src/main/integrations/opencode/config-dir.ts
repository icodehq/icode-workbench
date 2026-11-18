import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export type OpenCodeConfigDirOptions = {
  env?: NodeJS.ProcessEnv
  home?: string
  platform?: NodeJS.Platform
  /**
   * OpenCode 2 honors OPENCODE_CONFIG_DIR; 1.x on Windows ignores it (verified
   * against 1.19.6) and always uses `%USERPROFILE%\.config\opencode`.
   */
  honorConfigDir?: boolean
}

/**
 * OpenCode 2 follows XDG_CONFIG_HOME; 1.x on Windows does not, so the canonical
 * path is derived from USERPROFILE there. The 1.x code path deliberately ignores
 * OPENCODE_CONFIG_DIR: installing into an overlay OpenCode never reads would
 * leave the integration silently inactive.
 */
export function resolveOpenCodeConfigDir(options: OpenCodeConfigDirOptions = {}): string {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const configured = options.honorConfigDir === false ? undefined : env.OPENCODE_CONFIG_DIR?.trim()
  if (configured) return configured
  if (platform === 'win32') {
    const executionHome = env.USERPROFILE?.trim() || home
    return join(executionHome, '.config', 'opencode')
  }
  const xdg = env.XDG_CONFIG_HOME?.trim()
  if (xdg && isAbsolute(xdg)) return join(xdg, 'opencode')
  return join(env.HOME || home, '.config', 'opencode')
}
