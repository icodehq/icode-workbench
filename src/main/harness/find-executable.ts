import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join, isAbsolute } from 'node:path'

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
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
  if (isAbsolute(name)) return isExecutableFile(name) ? name : null
  if (name.includes('/') || name.includes('\\')) return null
  const pathValue = env.PATH ?? env.Path ?? ''
  const dirs = pathValue.split(delimiter).filter((dir) => dir.length > 0)
  // A name that already carries an extension must not have every PATHEXT
  // extension appended to it: `powershell.exe` was searched as
  // `powershell.exe.EXE`, so the default shell could never be found and ADE
  // silently fell back to cmd.exe.
  const hasExtension = /\.[A-Za-z0-9]+$/u.test(name)
  const candidates =
    platform === 'win32' && !hasExtension ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : ['']

  for (const dir of dirs) {
    for (const extension of candidates) {
      const candidate = join(dir, `${name}${extension}`)
      if (isAbsolute(candidate) && isExecutableFile(candidate)) return candidate
    }
  }
  return null
}
