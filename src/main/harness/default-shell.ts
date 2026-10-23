/**
 * Which shell the "Shell" harness launches, and what to tell the user when none
 * can be found.
 *
 * POSIX behaviour is deliberately unchanged: `SHELL`, else `/bin/bash`, and a
 * missing binary is reported by the existing version probe.
 *
 * Windows has no `/bin/bash`, so it is discovered in preference order and the
 * resolution itself is the evidence. A shell is never probed with `--version`:
 * `cmd.exe` rejects the flag, and PowerShell would sit in an interactive
 * session until the probe timeout.
 */

import { findExecutable } from './find-executable'

export type ShellChoice =
  | { kind: 'command'; command: string }
  | { kind: 'unavailable'; message: string }

/** Preference order on Windows: modern PowerShell first, `cmd.exe` last. */
export const WINDOWS_SHELL_CANDIDATES = ['pwsh.exe', 'powershell.exe', 'cmd.exe'] as const

export type ChooseShellOptions = {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /** Resolves a bare name on PATH, or confirms an absolute path exists. */
  resolve: (name: string) => string | null
}

function configured(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : null
}

export function chooseShellCommand(options: ChooseShellOptions): ShellChoice {
  const { platform, env, resolve } = options

  const explicit = configured(env.SHELL)
  if (explicit) {
    const resolved = resolve(explicit)
    if (resolved) return { kind: 'command', command: resolved }
    // POSIX keeps its historic behaviour: hand the configured path to the probe
    // so the failure is reported as evidence rather than as a guess here.
    if (platform !== 'win32') return { kind: 'command', command: explicit }
    return {
      kind: 'unavailable',
      message:
        `SHELL is set to "${explicit}", but no executable exists at that path. ` +
        'Correct or unset SHELL, or set it to a shell such as pwsh.exe from `where pwsh`.'
    }
  }

  if (platform === 'win32') {
    for (const candidate of WINDOWS_SHELL_CANDIDATES) {
      const resolved = resolve(candidate)
      if (resolved) return { kind: 'command', command: resolved }
    }
    // COMSPEC is the OS's own command interpreter; accept it if it is the only
    // thing that resolves, but do not prefer it over a real shell.
    const comspec = configured(env.COMSPEC)
    if (comspec) {
      const resolved = resolve(comspec)
      if (resolved) return { kind: 'command', command: resolved }
    }
    return {
      kind: 'unavailable',
      message:
        `No Windows shell was found. Tried ${WINDOWS_SHELL_CANDIDATES.join(', ')}` +
        (comspec ? ` and COMSPEC (${comspec})` : '') +
        '. Install PowerShell 7 (pwsh.exe) or confirm that cmd.exe is on PATH.'
    }
  }

  return { kind: 'command', command: '/bin/bash' }
}

/**
 * The last-resort command the protocol requires where a value must be present
 * but is never executed (an attach-only request carries a placeholder).
 */
export function fallbackShellCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'cmd.exe' : '/bin/bash'
}

/** Convenience wrapper for callers that need a string, never an error object. */
export function resolvedShellCommand(
  options: {
    platform?: NodeJS.Platform
    env?: NodeJS.ProcessEnv
    resolve?: (name: string) => string | null
  } = {}
): string {
  const platform = options.platform ?? process.platform
  const choice = chooseShellCommand({
    platform,
    env: options.env ?? process.env,
    resolve: options.resolve ?? ((name) => findExecutable(name))
  })
  return choice.kind === 'command' ? choice.command : fallbackShellCommand(platform)
}
