import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join, isAbsolute } from 'node:path'

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    const stats = statSync(path)
    if (!stats.isFile()) return false
    // Why: a Microsoft Store App Execution Alias stub is a zero-byte reparse
    // point. `statSync` reports it as a regular file and `accessSync` succeeds,
    // but ConPTY rejects it at CreateProcess (ERROR_ACCESS_DENIED), so the
    // session would fail only after the worktree and PTY were already created.
    // Size is the portable half of that check. POSIX keeps accepting a
    // zero-byte script, where an empty file with the execute bit is legitimate.
    if (platform === 'win32' && stats.size === 0) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve a command on PATH without a shell, so a harness name can never be
 * interpreted as shell syntax. Only registry-owned names reach this function.
 */
export function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | null {
  if (name.length === 0) return null
  // An absolute path is allowed only from trusted inputs (process.env.SHELL),
  // never from a renderer-supplied command.
  if (isAbsolute(name)) return isExecutableFile(name, platform) ? name : null
  if (name.includes('/') || name.includes('\\')) return null
  const pathValue = env.PATH ?? env.Path ?? ''
  const dirs = pathValue.split(delimiter).filter((dir) => dir.length > 0)
  // A name that already carries an extension must not have every PATHEXT
  // extension appended to it: `powershell.exe` was searched as
  // `powershell.exe.EXE`, so the default shell could never be found and ADE
  // silently fell back to cmd.exe.
  const hasExtension = /\.[A-Za-z0-9]+$/u.test(name)
  const candidates =
    platform === 'win32' && !hasExtension
      ? (env.PATHEXT ?? '.EXE;.CMD;.BAT')
          .split(';')
          // Why: Windows runs a `.ps1` through the PowerShell script host, not
          // CreateProcess — Node reports EFTYPE, and under the default
          // `Restricted` policy the script is blocked before it starts. The
          // Agent harnesses are extensionless names resolved through PATHEXT,
          // so an inherited `.PS1` must never capture one. Everything else
          // keeps its place in the list, so candidate order is unchanged.
          .filter((extension) => extension.toLowerCase() !== '.ps1')
      : ['']

  for (const dir of dirs) {
    for (const extension of candidates) {
      const candidate = join(dir, `${name}${extension}`)
      if (isAbsolute(candidate) && isExecutableFile(candidate, platform)) return candidate
    }
  }
  return null
}
