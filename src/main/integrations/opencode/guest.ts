import type { WslCommandRunner, WslExecOutcome } from '../../wsl/exec'
import { isTransportOutcome } from '../../wsl/probe'

const CONFIG_TIMEOUT_MS = 10_000
const MAX_CONFIG_BYTES = 1024 * 1024

const GUEST_CONFIG_DIR = [
  'if [ -n "$OPENCODE_CONFIG_DIR" ]; then printf %s "$OPENCODE_CONFIG_DIR"',
  'elif [ -n "$XDG_CONFIG_HOME" ]; then',
  '  case "$XDG_CONFIG_HOME" in',
  '    /*) printf %s "$XDG_CONFIG_HOME/opencode" ;;',
  '    *) printf %s "$HOME/.config/opencode" ;;',
  '  esac',
  'else printf %s "$HOME/.config/opencode"',
  'fi'
].join('\n')

const GUEST_READ = 'if [ -f "$1" ]; then cat -- "$1"; fi'
const GUEST_WRITE = [
  'tmp="$1.icode-tmp-$$"',
  'trap \'rm -f -- "$tmp"\' 0 1 2 15',
  'mkdir -p -- "$(dirname -- "$1")" || exit 1',
  'cat > "$tmp" || exit 1',
  'chmod 600 -- "$tmp" 2>/dev/null || true',
  'mv -f -- "$tmp" "$1" || exit 1',
  'trap - 0 1 2 15'
].join('\n')
const GUEST_REMOVE = 'rm -f -- "$1"'
const GUEST_RMDIR = 'rmdir -- "$1" 2>/dev/null || true'

function guestSuccess(result: WslExecOutcome, action: string): string {
  if (result.status === 'wsl_missing') {
    throw new Error(`WSL is not available while trying to ${action}.`)
  }
  if (result.status === 'timed_out' || result.status === 'cancelled') {
    throw new Error(`Timed out while trying to ${action}.`)
  }
  if (isTransportOutcome(result)) {
    throw new Error(`The WSL distro did not answer while trying to ${action}.`)
  }
  if (result.status !== 'ok') {
    const detail = result.stderr.trim()
    throw new Error(detail.length > 0 ? detail : `Could not ${action}.`)
  }
  return result.stdout
}

export async function resolveGuestOpenCodeConfigDir(
  runner: WslCommandRunner,
  distro: string,
  signal?: AbortSignal
): Promise<string> {
  const result = await runner.run({
    scope: 'guest',
    label: 'opencode-config-dir',
    distro,
    argv: ['sh', '-c', GUEST_CONFIG_DIR],
    timeoutMs: CONFIG_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal })
  })
  const path = guestSuccess(result, 'read the OpenCode config directory').trim()
  if (!path.startsWith('/') || path.length > 4096) {
    throw new Error('The OpenCode config directory is not an absolute guest path.')
  }
  return path.replace(/\/+$/u, '')
}

export async function readGuestFile(
  runner: WslCommandRunner,
  distro: string,
  path: string
): Promise<string | null> {
  const result = await runner.run({
    scope: 'guest',
    label: 'opencode-read',
    distro,
    argv: ['sh', '-c', GUEST_READ, 'icode-opencode-read', path],
    timeoutMs: CONFIG_TIMEOUT_MS
  })
  const text = guestSuccess(result, 'read an OpenCode file')
  if (text.length > MAX_CONFIG_BYTES) throw new Error('The OpenCode file is too large.')
  return text.length === 0 ? null : text
}

export async function writeGuestFile(
  runner: WslCommandRunner,
  distro: string,
  path: string,
  text: string
): Promise<void> {
  const result = await runner.run({
    scope: 'guest',
    label: 'opencode-write',
    distro,
    argv: ['sh', '-c', GUEST_WRITE, 'icode-opencode-write', path],
    stdin: text,
    timeoutMs: CONFIG_TIMEOUT_MS
  })
  guestSuccess(result, 'write an OpenCode file')
}

export async function removeGuestFile(
  runner: WslCommandRunner,
  distro: string,
  path: string
): Promise<void> {
  const result = await runner.run({
    scope: 'guest',
    label: 'opencode-remove',
    distro,
    argv: ['sh', '-c', GUEST_REMOVE, 'icode-opencode-remove', path],
    timeoutMs: CONFIG_TIMEOUT_MS
  })
  guestSuccess(result, 'remove an OpenCode file')
}

export async function removeGuestDirectory(
  runner: WslCommandRunner,
  distro: string,
  path: string
): Promise<void> {
  const result = await runner.run({
    scope: 'guest',
    label: 'opencode-rmdir',
    distro,
    argv: ['sh', '-c', GUEST_RMDIR, 'icode-opencode-rmdir', path],
    timeoutMs: CONFIG_TIMEOUT_MS
  })
  guestSuccess(result, 'remove an OpenCode directory')
}
