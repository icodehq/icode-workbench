import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'

/**
 * Resolves the environment a GUI login session would have.
 *
 * A macOS app launched from Finder inherits launchd's minimal PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), so Homebrew, nvm, and `~/.local/bin`
 * installs are invisible to harness detection, Git, the Host, and every PTY.
 * Linux desktop launches have the same problem with `.desktop` entries.
 *
 * The fix is a single login-shell probe at startup: import only PATH and a
 * UTF-8 locale, and set SHELL, then let every consumer inherit `process.env`.
 * The probe is framed with sentinels so shell startup noise cannot be mistaken
 * for a value. Any failure leaves the inherited environment untouched.
 */

const START = '__ICODE_LOGIN_ENV_START__'
const END = '__ICODE_LOGIN_ENV_END__'
const PROBE = [
  `printf '${START}\\n'`,
  `printf 'PATH=%s\\n' "$PATH"`,
  `printf 'LANG=%s\\n' "\${LANG-}"`,
  `printf 'LC_ALL=%s\\n' "\${LC_ALL-}"`,
  `printf '${END}\\n'`
].join('; ')

export type LoginEnvironment = {
  shell: string
  path: string | null
  lang: string | null
}

export type LoginEnvironmentDeps = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Account shell fallback; tests inject a deterministic value. */
  accountShell?: string | null
  run?: (
    shell: string,
    args: string[],
    timeoutMs: number
  ) => Promise<{ stdout: string; exitCode: number | null }>
}

function defaultRun(
  shell: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    execFile(
      shell,
      args,
      { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error)
        else resolve({ stdout, exitCode: 0 })
      }
    )
  })
}

/** `userInfo()` can throw when the account has no passwd entry (e.g. sandboxed CI). */
function defaultAccountShell(): string | null {
  try {
    const shell = userInfo().shell
    return shell && shell.length > 0 ? shell : null
  } catch {
    return null
  }
}

function defaultShell(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, accountShell: string | null): string {
  const configured = env.SHELL
  if (configured && configured.length > 0) return configured
  if (accountShell && accountShell.length > 0) return accountShell
  return platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
}

export function parseLoginEnvironment(output: string): Omit<LoginEnvironment, 'shell'> {
  const start = output.indexOf(START)
  const end = output.lastIndexOf(END)
  if (start === -1 || end === -1 || end <= start) {
    return { path: null, lang: null }
  }
  const body = output.slice(start + START.length, end)
  let path: string | null = null
  let lang: string | null = null
  for (const line of body.split(/\r?\n/u)) {
    if (line.startsWith('PATH=') && line.length > 'PATH='.length) path = line.slice('PATH='.length)
    if (line.startsWith('LANG=') && line.length > 'LANG='.length) lang = line.slice('LANG='.length)
    // LC_ALL wins when it is set; otherwise LANG is the useful value.
    if (line.startsWith('LC_ALL=') && line.length > 'LC_ALL='.length) lang = line.slice('LC_ALL='.length)
  }
  return { path, lang }
}

function isUtf8Locale(value: string | null): boolean {
  return value !== null && /utf-?8/iu.test(value)
}

function localeDefault(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8'
}

export async function resolveLoginEnvironment(
  deps: LoginEnvironmentDeps = {}
): Promise<LoginEnvironment | null> {
  const platform = deps.platform ?? process.platform
  if (platform === 'win32') return null
  const env = deps.env ?? process.env
  // `null` is a deliberate test/CI answer ("no account shell"), so only a
  // missing value falls back to the real account lookup.
  const accountShell =
    deps.accountShell === undefined ? defaultAccountShell() : deps.accountShell
  const shell = defaultShell(platform, env, accountShell)
  const run = deps.run ?? defaultRun
  try {
    const { stdout } = await run(shell, ['-ilc', PROBE], 3000)
    const parsed = parseLoginEnvironment(stdout)
    return {
      shell,
      path: parsed.path,
      lang: isUtf8Locale(parsed.lang) ? parsed.lang : localeDefault(platform)
    }
  } catch {
    // A broken rc file must not prevent the app from starting.
    return null
  }
}

let applied: LoginEnvironment | null | undefined

/**
 * Applies the login environment once. Subsequent calls are no-ops; callers run
 * this before the Host is spawned so its PTYs inherit the resolved PATH.
 */
export async function applyLoginEnvironment(
  deps: LoginEnvironmentDeps = {}
): Promise<LoginEnvironment | null> {
  if (applied !== undefined) return applied
  const resolved = await resolveLoginEnvironment(deps)
  applied = resolved
  if (resolved === null) return null
  const env = deps.env ?? process.env
  env.SHELL = resolved.shell
  if (resolved.path !== null) env.PATH = resolved.path
  if (resolved.lang !== null) {
    env.LANG = resolved.lang
    // LC_ALL wins over LANG. An inherited non-UTF8 LC_ALL would silently undo
    // the login shell's UTF-8 value, so replace only that case.
    if (
      env.LC_ALL !== undefined &&
      env.LC_ALL.length > 0 &&
      !isUtf8Locale(env.LC_ALL)
    ) {
      env.LC_ALL = resolved.lang
    }
  }
  return resolved
}

/** Test seam: forget the one-shot application. */
export function resetLoginEnvironmentForTest(): void {
  applied = undefined
}
