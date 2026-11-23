/**
 * One-off Git credential handoff for an interactive clone.
 *
 * Git's credential-helper protocol receives `protocol`, `host` and `path` on
 * stdin, so a helper can refuse a secret for any other host. Askpass only gets a
 * human-readable prompt and is deliberately not used.
 *
 * The helper script is constant and contains no secret. A sibling `binding`
 * file names the exact protocol/host/path it may answer for, and a sibling
 * `secret` file holds the username and password. All three live in a directory
 * that exists only for this clone attempt. Nothing is passed through argv or the
 * environment, and the directory is removed after the attempt.
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppError } from '../../shared/domain/errors'
import { makeAppError } from '../../shared/domain/errors'
import { parseRemoteUrl } from '../../shared/domain/remote-url'
import { quotePosixShell } from '../../shared/domain/shell-quote'
import type { MessageKey } from '../../shared/i18n/messages'
import type { WslCommandRunner, WslGuestCommand } from '../wsl/exec'

const STALE_AFTER_MS = 12 * 60 * 60 * 1_000
const GUEST_TIMEOUT_MS = 10_000

/** Constant helper. Reads only its sibling files; never echoes a secret to a log. */
export const CLONE_CREDENTIAL_HELPER = [
  '#!/bin/sh',
  'case "$1" in',
  '  get) ;;',
  '  *) exit 0 ;;',
  'esac',
  'dir=${0%/*}',
  '[ "$dir" = "$0" ] && dir=.',
  '[ -r "$dir/binding" ] || exit 0',
  '[ -r "$dir/secret" ] || exit 0',
  'protocol=',
  'host=',
  'path=',
  'lines=0',
  'while IFS= read -r line; do',
  '  lines=$((lines + 1))',
  '  [ "$lines" -le 64 ] || exit 0',
  '  case "$line" in',
  '    protocol=*) protocol=${line#protocol=} ;;',
  '    host=*) host=${line#host=} ;;',
  '    path=*) path=${line#path=} ;;',
  '  esac',
  'done',
  'expected_protocol=',
  'expected_host=',
  'expected_path=',
  'expected_path_raw=',
  '{',
  '  IFS= read -r expected_protocol',
  '  IFS= read -r expected_host',
  '  IFS= read -r expected_path',
  '  IFS= read -r expected_path_raw',
  '} < "$dir/binding"',
  '[ "$protocol" = "$expected_protocol" ] || exit 0',
  '[ "$host" = "$expected_host" ] || exit 0',
  'if [ -n "$path" ]; then',
  '  actual=${path#/}',
  '  actual=${actual%/}',
  '  [ "$actual" = "$expected_path" ] || [ "$actual" = "$expected_path_raw" ] || exit 0',
  'fi',
  'username=',
  'password=',
  '{',
  '  IFS= read -r username',
  '  IFS= read -r password',
  '} < "$dir/secret"',
  '[ -n "$username" ] || exit 0',
  '[ -n "$password" ] || exit 0',
  `printf 'username=%s\\npassword=%s\\n' "$username" "$password"`,
  'exit 0',
  ''
].join('\n')

const GUEST_MKDIR =
  'umask 077; mkdir -p -- "$1" || exit 1; chmod 700 -- "$1" 2>/dev/null || true'
const GUEST_WRITE =
  'umask 077; cat > "$1" || exit 1; chmod 600 -- "$1" 2>/dev/null || true'
const GUEST_REMOVE_TREE = 'rm -rf -- "$1"'
const GUEST_SWEEP = [
  'root="$1"',
  '[ -d "$root" ] || exit 0',
  'find "$root" -mindepth 1 -maxdepth 1 -type d -mmin +720 -exec rm -rf -- {} + 2>/dev/null || true',
  'exit 0'
].join('\n')

export type CloneCredentialBundle = {
  /** Git global options, before the `clone`/`ls-remote` subcommand. */
  gitOptions: readonly string[]
  /** Keep askpass from offering a second, uncontrolled answer. */
  env: Readonly<Record<string, string>>
  /** Removes the on-disk handoff. Safe to call more than once. */
  dispose(): Promise<void>
}

export class CloneCredentialError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.message)
    this.name = 'CloneCredentialError'
  }
}

function credentialError(messageKey: MessageKey): CloneCredentialError {
  return new CloneCredentialError(
    makeAppError('INVALID_ARGUMENT', 'The credential handoff could not be prepared.', {
      messageKey
    })
  )
}

function assertHttpsRemote(url: string): { host: string; pathDecoded: string; pathRaw: string } {
  const parsed = parseRemoteUrl(url)
  if (
    parsed === null ||
    parsed.kind !== 'url' ||
    parsed.scheme !== 'https' ||
    parsed.hasCredentials ||
    parsed.host === null ||
    parsed.path === null
  ) {
    throw credentialError('addRepo.clone.auth.httpsOnly')
  }
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    throw credentialError('addRepo.clone.auth.httpsOnly')
  }
  const pathRaw = pathname.replace(/^\/+/u, '').replace(/\/+$/u, '')
  let pathDecoded = pathRaw
  try {
    pathDecoded = decodeURIComponent(pathRaw)
  } catch {
    // Keep the raw form; the helper accepts either binding line.
  }
  if (pathRaw.length === 0 || pathDecoded.length === 0) {
    throw credentialError('addRepo.clone.auth.httpsOnly')
  }
  assertBindingValue(pathRaw)
  assertBindingValue(pathDecoded)
  assertBindingValue(parsed.host)
  return { host: parsed.host, pathDecoded, pathRaw }
}

function assertBindingValue(value: string): void {
  if (value.length === 0 || /[\u0000\r\n]/u.test(value)) {
    throw credentialError('addRepo.clone.auth.httpsOnly')
  }
}

function assertUsername(value: string): void {
  if (value.length === 0 || value.length > 255 || /[\u0000\r\n]/u.test(value)) {
    throw credentialError('addRepo.clone.auth.invalidCredential')
  }
}

function assertPassword(value: Buffer): void {
  if (
    value.length === 0 ||
    value.length > 4_096 ||
    value.includes(0) ||
    value.includes(0x0a) ||
    value.includes(0x0d)
  ) {
    throw credentialError('addRepo.clone.auth.invalidCredential')
  }
}

function bindingText(host: string, pathDecoded: string, pathRaw: string): string {
  return ['https', host, pathDecoded, pathRaw, ''].join('\n')
}

function secretBuffer(username: string, password: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${username}\n`, 'utf8'), password, Buffer.from('\n')])
}

async function writePrivate(path: string, data: Buffer | string, mode: number): Promise<void> {
  await writeFile(path, data, { mode })
  try {
    await chmod(path, mode)
  } catch {
    // Windows reports EPERM for POSIX modes; the user-profile directory is the
    // boundary there.
  }
}

function toShellPath(path: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? path.replace(/\\/gu, '/') : path
}

let helperShell: Promise<string> | null = null

/** The POSIX shell Git for Windows already ships; `sh` is the last resort. */
function resolveHelperShell(): Promise<string> {
  helperShell ??= (async (): Promise<string> => {
    if (process.platform !== 'win32') {
      return existsSync('/bin/sh') ? '/bin/sh' : 'sh'
    }
    try {
      const execPath = await new Promise<string>((resolve, reject) => {
        execFile(
          'git',
          ['--exec-path'],
          { timeout: 5_000, windowsHide: true },
          (error, stdout) => {
            if (error) reject(error)
            else resolve(String(stdout).trim())
          }
        )
      })
      const candidate = join(execPath, '..', '..', '..', 'bin', 'sh.exe')
      if (existsSync(candidate)) return candidate
    } catch {
      // Fall through to PATH. Git's own `!` helper is already interpreted by a
      // shell, so `sh` normally resolves.
    }
    return 'sh'
  })()
  return helperShell
}

/** Git options that replace every inherited helper for this one command. */
export function helperGitOptions(
  shell: string,
  helperScript: string,
  platform: NodeJS.Platform = process.platform
): string[] {
  const shellWord = quotePosixShell(toShellPath(shell, platform))
  const scriptWord = quotePosixShell(toShellPath(helperScript, platform))
  return [
    '-c',
    'credential.helper=',
    '-c',
    `credential.helper=!${shellWord} ${scriptWord}`,
    '-c',
    'credential.useHttpPath=true'
  ]
}

const sweptLocalRoots = new Set<string>()

async function sweepLocalRoot(root: string): Promise<void> {
  if (sweptLocalRoots.has(root)) return
  sweptLocalRoots.add(root)
  try {
    const entries = await readdir(root, { withFileTypes: true })
    const cutoff = Date.now() - STALE_AFTER_MS
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('attempt-'))
        .map(async (entry) => {
          const path = join(root, entry.name)
          try {
            const info = await stat(path)
            if (info.mtimeMs < cutoff) await rm(path, { recursive: true, force: true })
          } catch {
            // A concurrent attempt may have removed it.
          }
        })
    )
  } catch {
    // A missing root or an unreadable directory does not block the clone.
  }
}

/** Prepare a local credential handoff. The caller owns and must zero `password`. */
export async function createLocalCredentialBundle(input: {
  root: string
  url: string
  username: string
  password: Buffer
}): Promise<CloneCredentialBundle> {
  const binding = assertHttpsRemote(input.url)
  assertUsername(input.username)
  assertPassword(input.password)

  await mkdir(input.root, { recursive: true, mode: 0o700 })
  await sweepLocalRoot(input.root)
  const directory = join(input.root, `attempt-${randomUUID()}`)
  await mkdir(directory, { recursive: false, mode: 0o700 })
  try {
    const helperScript = join(directory, 'helper.sh')
    await writePrivate(helperScript, CLONE_CREDENTIAL_HELPER, 0o700)
    await writePrivate(
      join(directory, 'binding'),
      bindingText(binding.host, binding.pathDecoded, binding.pathRaw),
      0o600
    )
    await writePrivate(
      join(directory, 'secret'),
      secretBuffer(input.username, input.password),
      0o600
    )
    const shell = await resolveHelperShell()
    return {
      gitOptions: helperGitOptions(shell, helperScript),
      env: { GIT_ASKPASS: '', SSH_ASKPASS: '' },
      dispose: async () => {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    if (error instanceof CloneCredentialError) throw error
    throw new CloneCredentialError(
      makeAppError('INTERNAL', 'The credential handoff could not be prepared.', {
        ...(error instanceof Error ? { detail: error.message } : {})
      })
    )
  }
}

function guestCommand(
  distro: string,
  script: string,
  path: string,
  stdin: Buffer | string | undefined,
  label: string,
  signal: AbortSignal | undefined
): WslGuestCommand {
  return {
    scope: 'guest',
    label,
    distro,
    argv: ['sh', '-c', script, 'icode-clone-auth', path],
    ...(stdin === undefined ? {} : { stdin }),
    timeoutMs: GUEST_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal })
  }
}

async function runGuest(
  runner: WslCommandRunner,
  command: WslGuestCommand
): Promise<void> {
  const result = await runner.run(command)
  if ('status' in result && result.status !== 'ok') {
    throw new CloneCredentialError(
      makeAppError('INTERNAL', 'The credential handoff could not be prepared inside the distro.')
    )
  }
}

const sweptGuestRoots = new Set<string>()

function guestRootKey(distro: string, root: string): string {
  return `${distro.trim().toLowerCase()}\u0000${root}`
}

async function sweepGuestRoot(
  runner: WslCommandRunner,
  distro: string,
  root: string
): Promise<void> {
  const key = guestRootKey(distro, root)
  if (sweptGuestRoots.has(key)) return
  sweptGuestRoots.add(key)
  try {
    await runner.run(guestCommand(distro, GUEST_SWEEP, root, undefined, 'clone-auth-sweep', undefined))
  } catch {
    // Best-effort: stale files are not a reason to block a clone.
  }
}

/** Prepare a distro-side handoff. The caller owns and must zero `password`. */
export async function createGuestCredentialBundle(input: {
  runner: WslCommandRunner
  distro: string
  home: string
  requestId: string
  url: string
  username: string
  password: Buffer
  signal?: AbortSignal
}): Promise<CloneCredentialBundle> {
  const binding = assertHttpsRemote(input.url)
  assertUsername(input.username)
  assertPassword(input.password)
  if (!input.home.startsWith('/') || /[\u0000\r\n]/u.test(input.home)) {
    throw new CloneCredentialError(
      makeAppError('WSL_UNAVAILABLE', 'The WSL distro did not report a usable home directory.')
    )
  }
  const home = input.home.replace(/\/+$/u, '') || '/'
  const root = `${home}/.icode/clone-auth`
  const directory = `${root}/${input.requestId}-${randomUUID()}`
  const helperScript = `${directory}/helper.sh`

  try {
    await runGuest(
      input.runner,
      guestCommand(input.distro, GUEST_MKDIR, directory, undefined, 'clone-auth-mkdir', input.signal)
    )
    await runGuest(
      input.runner,
      guestCommand(
        input.distro,
        GUEST_WRITE,
        helperScript,
        CLONE_CREDENTIAL_HELPER,
        'clone-auth-helper',
        input.signal
      )
    )
    await runGuest(
      input.runner,
      guestCommand(
        input.distro,
        GUEST_WRITE,
        `${directory}/binding`,
        bindingText(binding.host, binding.pathDecoded, binding.pathRaw),
        'clone-auth-binding',
        input.signal
      )
    )
    await runGuest(
      input.runner,
      guestCommand(
        input.distro,
        GUEST_WRITE,
        `${directory}/secret`,
        secretBuffer(input.username, input.password),
        'clone-auth-secret',
        input.signal
      )
    )
  } catch (error) {
    await input.runner
      .run(guestCommand(input.distro, GUEST_REMOVE_TREE, directory, undefined, 'clone-auth-remove', undefined))
      .catch(() => undefined)
    throw error
  }

  await sweepGuestRoot(input.runner, input.distro, root).catch(() => undefined)

  return {
    gitOptions: helperGitOptions('/bin/sh', helperScript),
    env: { GIT_ASKPASS: '', SSH_ASKPASS: '' },
    dispose: async () => {
      await input.runner
        .run(
          guestCommand(
            input.distro,
            GUEST_REMOVE_TREE,
            directory,
            undefined,
            'clone-auth-remove',
            undefined
          )
        )
        .catch(() => undefined)
    }
  }
}

/**
 * A URL that Git would rewrite before transport must not carry an in-app
 * credential: the helper's binding would name the wrong host. The anonymous
 * clone remains available for users who intentionally configure `insteadOf`.
 */
export function matchingInsteadOfPrefix(url: string, config: string): string | null {
  const target = url.toLowerCase()
  for (const line of config.split(/\r?\n/u)) {
    const separator = line.search(/\s/u)
    if (separator <= 0) continue
    const key = line.slice(0, separator)
    if (!/^url\..+\.insteadof$/iu.test(key)) continue
    const prefix = line.slice(separator).trim()
    if (prefix.length > 0 && target.startsWith(prefix.toLowerCase())) return prefix
  }
  return null
}
