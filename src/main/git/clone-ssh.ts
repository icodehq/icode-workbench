/**
 * SSH entry point for an interactive clone.
 *
 * Everything is answered inside the target: the key, the agent and
 * `known_hosts` that matter are the distro's when the target is WSL. Commands
 * run in BatchMode, so a passphrase-protected key fails with a clear publickey
 * error instead of waiting for a prompt that can never appear.
 *
 * Only public keys and fingerprints cross IPC. Private key material is never
 * read by this module.
 */

import { execFile } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AppError } from '../../shared/domain/errors'
import { makeAppError } from '../../shared/domain/errors'
import type { ExecutionTarget } from '../../shared/domain/repository'
import { parseRemoteUrl, redactRemoteUrlCredentials } from '../../shared/domain/remote-url'
import { quotePosixShell } from '../../shared/domain/shell-quote'
import type { MessageKey } from '../../shared/i18n/messages'
import type { WslCommandRunner } from '../wsl/exec'
import type { GitWorktreeService } from '../worktrees/git-worktree-service'

const PROBE_TIMEOUT_MS = 15_000
const TEST_TIMEOUT_MS = 20_000
const SCAN_TIMEOUT_MS = 15_000
const KEYGEN_TIMEOUT_MS = 20_000

export type SshKeyInfo = {
  path: string
  type: string | null
  fingerprint: string | null
  publicKey: string
}

export type SshStatus = {
  sshAvailable: boolean
  keygenAvailable: boolean
  keyscanAvailable: boolean
  agentAvailable: boolean
  agentIdentities: number | null
  home: string | null
  defaultKeyPath: string | null
  defaultKeyExists: boolean
  keys: SshKeyInfo[]
  sshPath: string | null
  keygenPath: string | null
  keyscanPath: string | null
}

export type SshHostFingerprint = { type: string; fingerprint: string }

export type SshTestResult =
  | { status: 'ok' }
  | {
      status: 'host_key_unknown'
      host: string
      port: number
      fingerprints: SshHostFingerprint[]
    }
  | { status: 'auth_failed'; reason: 'publickey' | 'agent' | 'other'; detail?: string }
  | { status: 'ssh_unavailable'; detail?: string }
  | { status: 'network'; detail?: string }

export class CloneSshError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.message)
    this.name = 'CloneSshError'
  }
}

export type CloneSshDeps = {
  gitWorktrees: Pick<GitWorktreeService, 'gitResultFor'>
  runner: WslCommandRunner
}

const GUEST_STATUS_SCRIPT = [
  'home=$HOME',
  'sock=${SSH_AUTH_SOCK:-}',
  'ssh=$(command -v ssh 2>/dev/null || true)',
  'keygen=$(command -v ssh-keygen 2>/dev/null || true)',
  'keyscan=$(command -v ssh-keyscan 2>/dev/null || true)',
  'add=$(command -v ssh-add 2>/dev/null || true)',
  'agent=0',
  'count=',
  'if [ -n "$sock" ] && [ -n "$add" ]; then',
  '  ids=$("$add" -l 2>/dev/null); rc=$?',
  '  if [ "$rc" -eq 0 ]; then agent=1; count=$(printf "%s\\n" "$ids" | wc -l | tr -d " ")',
  '  elif [ "$rc" -eq 1 ]; then agent=1; count=0',
  '  fi',
  'fi',
  'exists=0',
  '[ -f "$home/.ssh/id_ed25519" ] && exists=1',
  `printf '%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0%s' "$home" "$sock" "$ssh" "$keygen" "$keyscan" "$add" "$agent" "$count" "$exists"`,
  'for pub in "$home"/.ssh/*.pub; do',
  '  [ -r "$pub" ] || continue',
  '  fp=$("$keygen" -lf "$pub" 2>/dev/null || true)',
  '  body=$(cat "$pub" 2>/dev/null || true)',
  `  printf '\\0KEY\\0%s\\0%s\\0%s' "$pub" "$fp" "$body"`,
  'done'
].join('\n')

const GUEST_SCAN_SCRIPT = [
  'host=$1',
  'port=$2',
  'keyscan=$3',
  'keygen=$4',
  '"$keyscan" -T 5 -p "$port" -t rsa,ecdsa,ed25519 "$host" 2>/dev/null | while IFS= read -r line; do',
  '  case "$line" in ""|\\#*) continue ;; esac',
  '  pub=${line#* }',
  '  out=$(printf "%s\\n" "$pub" | "$keygen" -lf - 2>/dev/null) || continue',
  "  printf '%s\\0%s\\0' \"$out\" \"$line\"",
  'done'
].join('\n')

const GUEST_WRITE_KNOWN_HOSTS = [
  'umask 077',
  'mkdir -p -- "$1" || exit 1',
  'chmod 700 -- "$1" 2>/dev/null || true',
  'cat >> "$1/known_hosts"',
  'chmod 600 -- "$1/known_hosts" 2>/dev/null || true'
].join('\n')

function sshError(message: string, messageKey?: MessageKey): CloneSshError {
  return new CloneSshError(
    makeAppError('INVALID_ARGUMENT', message, {
      ...(messageKey === undefined ? {} : { messageKey })
    })
  )
}

function parseSshUrl(url: string): { host: string; port: number } | null {
  const parsed = parseRemoteUrl(url)
  if (
    parsed === null ||
    parsed.kind !== 'url' ||
    parsed.isLocalPath ||
    parsed.host === null ||
    (parsed.scheme !== 'ssh' && parsed.scheme !== 'git+ssh')
  ) {
    return null
  }
  return { host: parsed.host, port: parsed.port ?? 22 }
}

function fingerprintOf(keygenLine: string): SshHostFingerprint | null {
  const fingerprint = /(SHA256:[A-Za-z0-9+/=]+)/u.exec(keygenLine)?.[1]
  if (fingerprint === undefined) return null
  const type = /\(([A-Z0-9-]+)\)\s*$/u.exec(keygenLine)?.[1] ?? 'unknown'
  return { type, fingerprint }
}

function detailOf(text: string): string | undefined {
  const redacted = redactRemoteUrlCredentials(text).trim()
  return redacted.length === 0 ? undefined : redacted.slice(0, 2_000)
}

function classifySshTest(stderr: string, timedOut: boolean): SshTestResult {
  const text = stderr
  if (timedOut) {
    return { status: 'network', ...(detailOf(text) ? { detail: detailOf(text) } : {}) }
  }
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/iu.test(text)) {
    return {
      status: 'auth_failed',
      reason: 'other',
      ...(detailOf(text) ? { detail: detailOf(text) } : {})
    }
  }
  if (/Host key verification failed/iu.test(text)) {
    return { status: 'host_key_unknown', host: '', port: 22, fingerprints: [] }
  }
  if (/Permission denied \(publickey/iu.test(text)) {
    return {
      status: 'auth_failed',
      reason: 'publickey',
      ...(detailOf(text) ? { detail: detailOf(text) } : {})
    }
  }
  if (/authentication agent|SSH_AUTH_SOCK/iu.test(text)) {
    return {
      status: 'auth_failed',
      reason: 'agent',
      ...(detailOf(text) ? { detail: detailOf(text) } : {})
    }
  }
  if (/Could not resolve hostname|Connection (refused|timed out)|Network is unreachable/iu.test(text)) {
    return { status: 'network', ...(detailOf(text) ? { detail: detailOf(text) } : {}) }
  }
  if (/ssh: not found|No such file or directory/iu.test(text)) {
    return { status: 'ssh_unavailable', ...(detailOf(text) ? { detail: detailOf(text) } : {}) }
  }
  return {
    status: 'auth_failed',
    reason: 'other',
    ...(detailOf(text) ? { detail: detailOf(text) } : {})
  }
}

function execCapture(
  command: string,
  args: readonly string[],
  options: { input?: string; timeoutMs: number }
): Promise<{ stdout: string; stderr: string; code: number | null; missing: boolean }> {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      [...args],
      { timeout: options.timeoutMs, windowsHide: true },
      (error, stdout, stderr) => {
        const failure = error as NodeJS.ErrnoException & { code?: string | number } | null
        if (failure !== null && failure.code === 'ENOENT') {
          resolve({ stdout: '', stderr: '', code: null, missing: true })
          return
        }
        resolve({
          stdout: String(stdout),
          stderr: String(stderr),
          code:
            failure === null
              ? 0
              : typeof failure.code === 'number'
                ? failure.code
                : 1,
          missing: false
        })
      }
    )
    if (options.input !== undefined) child.stdin?.end(options.input)
  })
}

async function commandAvailable(command: string): Promise<boolean> {
  const result = await execCapture(command, ['-V'], { timeoutMs: 2_000 })
  return !result.missing
}

async function localStatus(): Promise<SshStatus> {
  const home = homedir()
  const sshDir = join(home, '.ssh')
  const [sshAvailable, keygenAvailable, keyscanAvailable] = await Promise.all([
    commandAvailable('ssh'),
    commandAvailable('ssh-keygen'),
    commandAvailable('ssh-keyscan')
  ])
  const addResult = await execCapture('ssh-add', ['-l'], { timeoutMs: 3_000 })
  const agentAvailable =
    !addResult.missing && (addResult.code === 0 || addResult.code === 1)
  const agentIdentities =
    addResult.code === 0
      ? addResult.stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0).length
      : addResult.code === 1
        ? 0
        : null
  const defaultKeyPath = join(sshDir, 'id_ed25519')
  const keys: SshKeyInfo[] = []
  if (existsSync(sshDir)) {
    for (const name of readdirSync(sshDir).filter((entry) => entry.endsWith('.pub')).slice(0, 20)) {
      const path = join(sshDir, name)
      try {
        const publicKey = readFileSync(path, 'utf8').trim()
        const keygen = keygenAvailable
          ? await execCapture('ssh-keygen', ['-lf', path], { timeoutMs: 3_000 })
          : null
        const parsed = keygen === null ? null : fingerprintOf(keygen.stdout)
        keys.push({
          path,
          type: parsed?.type ?? null,
          fingerprint: parsed?.fingerprint ?? null,
          publicKey
        })
      } catch {
        // An unreadable public key is skipped, not a reason to fail the panel.
      }
    }
  }
  return {
    sshAvailable,
    keygenAvailable,
    keyscanAvailable,
    agentAvailable,
    agentIdentities,
    home,
    defaultKeyPath,
    defaultKeyExists: existsSync(defaultKeyPath),
    keys,
    sshPath: sshAvailable ? 'ssh' : null,
    keygenPath: keygenAvailable ? 'ssh-keygen' : null,
    keyscanPath: keyscanAvailable ? 'ssh-keyscan' : null
  }
}

function parseGuestStatus(stdout: Buffer): SshStatus {
  const fields = stdout.toString('utf8').split('\u0000')
  const [home = '', , ssh = '', keygen = '', keyscan = '', , agent = '0', count = '', exists = '0'] =
    fields
  const keys: SshKeyInfo[] = []
  let index = 9
  while (index < fields.length) {
    if (fields[index] !== 'KEY') {
      index += 1
      continue
    }
    const path = fields[index + 1] ?? ''
    const keygenLine = fields[index + 2] ?? ''
    const publicKey = fields[index + 3] ?? ''
    index += 4
    if (path.length === 0 || publicKey.length === 0) continue
    const parsed = fingerprintOf(keygenLine)
    keys.push({
      path,
      type: parsed?.type ?? null,
      fingerprint: parsed?.fingerprint ?? null,
      publicKey: publicKey.trim()
    })
  }
  const identities = count.trim().length === 0 ? null : Number(count)
  return {
    sshAvailable: ssh.startsWith('/'),
    keygenAvailable: keygen.startsWith('/'),
    keyscanAvailable: keyscan.startsWith('/'),
    agentAvailable: agent === '1',
    agentIdentities: identities !== null && Number.isFinite(identities) ? identities : null,
    home: home.startsWith('/') ? home : null,
    defaultKeyPath: home.startsWith('/') ? `${home.replace(/\/+$/u, '')}/.ssh/id_ed25519` : null,
    defaultKeyExists: exists === '1',
    keys,
    sshPath: ssh.startsWith('/') ? ssh : null,
    keygenPath: keygen.startsWith('/') ? keygen : null,
    keyscanPath: keyscan.startsWith('/') ? keyscan : null
  }
}

export class CloneSshService {
  constructor(private readonly deps: CloneSshDeps) {}

  async status(target: ExecutionTarget): Promise<SshStatus> {
    if (target.kind === 'local') return localStatus()
    const result = await this.deps.runner.runBytes({
      scope: 'guest',
      label: 'clone-ssh-status',
      distro: target.distro,
      argv: ['sh', '-lc', GUEST_STATUS_SCRIPT],
      timeoutMs: PROBE_TIMEOUT_MS
    })
    if ('status' in result || result.timedOut) {
      return {
        sshAvailable: false,
        keygenAvailable: false,
        keyscanAvailable: false,
        agentAvailable: false,
        agentIdentities: null,
        home: null,
        defaultKeyPath: null,
        defaultKeyExists: false,
        keys: [],
        sshPath: null,
        keygenPath: null,
        keyscanPath: null
      }
    }
    return parseGuestStatus(result.stdout)
  }

  async generate(
    target: ExecutionTarget,
    consent: true
  ): Promise<{ status: 'created' | 'exists'; keyPath: string; publicKey: string }> {
    if (consent !== true) {
      throw sshError('Key generation requires explicit consent.')
    }
    const status = await this.status(target)
    if (status.home === null || status.defaultKeyPath === null) {
      throw sshError('The target did not report a home directory.')
    }
    if (status.defaultKeyExists) {
      const existing = status.keys.find((key) => key.path === `${status.defaultKeyPath}.pub`)
      if (existing !== undefined) {
        return { status: 'exists', keyPath: status.defaultKeyPath, publicKey: existing.publicKey }
      }
      throw sshError('A key already exists at the default path.')
    }
    if (!status.keygenAvailable) {
      throw sshError('ssh-keygen is not available on this target.')
    }
    if (target.kind === 'local') {
      const sshDir = join(status.home, '.ssh')
      mkdirSync(sshDir, { recursive: true, mode: 0o700 })
      const result = await execCapture(
        'ssh-keygen',
        ['-q', '-t', 'ed25519', '-N', '', '-C', 'iCode clone', '-f', status.defaultKeyPath],
        { timeoutMs: KEYGEN_TIMEOUT_MS }
      )
      if (result.code !== 0 || result.missing) {
        throw sshError('The SSH key could not be generated.')
      }
      const publicKey = readFileSync(`${status.defaultKeyPath}.pub`, 'utf8').trim()
      return { status: 'created', keyPath: status.defaultKeyPath, publicKey }
    }
    const keygenPath = status.keygenPath
    if (keygenPath === null) throw sshError('ssh-keygen is not available on this target.')
    const result = await this.deps.runner.run({
      scope: 'guest',
      label: 'clone-ssh-keygen',
      distro: target.distro,
      argv: [
        'sh',
        '-c',
        'umask 077; mkdir -p -- "$1" || exit 1; chmod 700 -- "$1" 2>/dev/null || true; exec "$2" -q -t ed25519 -N "" -C "iCode clone" -f "$3"',
        'icode-ssh-keygen',
        `${status.home.replace(/\/+$/u, '')}/.ssh`,
        keygenPath,
        status.defaultKeyPath
      ],
      timeoutMs: KEYGEN_TIMEOUT_MS
    })
    if ('status' in result && result.status !== 'ok') {
      throw sshError('The SSH key could not be generated.')
    }
    const pub = await this.deps.runner.run({
      scope: 'guest',
      label: 'clone-ssh-public-key',
      distro: target.distro,
      argv: ['sh', '-c', 'cat -- "$1"', 'icode-ssh-pub', `${status.defaultKeyPath}.pub`],
      timeoutMs: PROBE_TIMEOUT_MS
    })
    if (pub.status !== 'ok') {
      throw sshError('The generated public key could not be read.')
    }
    return {
      status: 'created',
      keyPath: status.defaultKeyPath,
      publicKey: pub.stdout.trim()
    }
  }

  async test(target: ExecutionTarget, url: string): Promise<SshTestResult> {
    const parsed = parseSshUrl(url)
    if (parsed === null) {
      throw sshError('Choose an SSH URL to test SSH access.', 'addRepo.clone.auth.sshOnly')
    }
    const status = await this.status(target)
    if (!status.sshAvailable || status.sshPath === null || status.home === null) {
      return { status: 'ssh_unavailable' }
    }
    const git = await this.deps.gitWorktrees.gitResultFor(target)
    const sshCommand = `${quotePosixShell(status.sshPath)} -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes`
    const result = await git(
      status.home,
      ['-c', `core.sshCommand=${sshCommand}`, 'ls-remote', '--', url, 'HEAD'],
      TEST_TIMEOUT_MS,
      { env: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' } }
    )
    if (result.spawnFailure !== undefined) return { status: 'ssh_unavailable' }
    if (result.timedOut) {
      return { status: 'network', detail: 'The SSH connection timed out.' }
    }
    const stderr = result.stderr.toString('utf8')
    if (result.exitCode === 0) return { status: 'ok' }
    const classified = classifySshTest(stderr, false)
    if (classified.status !== 'host_key_unknown') return classified
    const scan = await this.scanHostKeys(target, parsed.host, parsed.port, status)
    if (scan.fingerprints.length === 0) {
      return {
        status: 'network',
        detail: detailOf(stderr) ?? 'The host key could not be read.'
      }
    }
    return {
      status: 'host_key_unknown',
      host: parsed.host,
      port: parsed.port,
      fingerprints: scan.fingerprints
    }
  }

  private async scanHostKeys(
    target: ExecutionTarget,
    host: string,
    port: number,
    status: SshStatus
  ): Promise<{ fingerprints: SshHostFingerprint[]; lines: string[] }> {
    if (target.kind === 'local') {
      const keyscan = await execCapture(
        'ssh-keyscan',
        ['-T', '5', '-p', String(port), '-t', 'rsa,ecdsa,ed25519', host],
        { timeoutMs: SCAN_TIMEOUT_MS }
      )
      const fingerprints: SshHostFingerprint[] = []
      const lines: string[] = []
      for (const raw of keyscan.stdout.split(/\r?\n/u)) {
        const line = raw.trim()
        if (line.length === 0 || line.startsWith('#')) continue
        const publicPart = line.slice(line.indexOf(' ') + 1)
        const keygen = await execCapture('ssh-keygen', ['-lf', '-'], {
          input: `${publicPart}\n`,
          timeoutMs: 3_000
        })
        const parsed = fingerprintOf(keygen.stdout)
        if (parsed === null) continue
        fingerprints.push(parsed)
        lines.push(line)
      }
      return { fingerprints, lines }
    }
    if (status.keyscanPath === null || status.keygenPath === null) {
      return { fingerprints: [], lines: [] }
    }
    const result = await this.deps.runner.runBytes({
      scope: 'guest',
      label: 'clone-ssh-keyscan',
      distro: target.distro,
      argv: [
        'sh',
        '-c',
        GUEST_SCAN_SCRIPT,
        'icode-ssh-keyscan',
        host,
        String(port),
        status.keyscanPath,
        status.keygenPath
      ],
      timeoutMs: SCAN_TIMEOUT_MS
    })
    if ('status' in result || result.timedOut) return { fingerprints: [], lines: [] }
    const fields = result.stdout.toString('utf8').split('\u0000')
    const fingerprints: SshHostFingerprint[] = []
    const lines: string[] = []
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const parsed = fingerprintOf(fields[index] ?? '')
      const line = fields[index + 1] ?? ''
      if (parsed === null || line.length === 0) continue
      fingerprints.push(parsed)
      lines.push(line.trim())
    }
    return { fingerprints, lines }
  }

  async trustHost(
    target: ExecutionTarget,
    host: string,
    port: number,
    fingerprints: string[]
  ): Promise<{ status: 'trusted' | 'already-trusted' }> {
    if (fingerprints.length === 0) {
      throw sshError('No host key fingerprint was confirmed.')
    }
    const status = await this.status(target)
    if (status.home === null) throw sshError('The target did not report a home directory.')
    const scan = await this.scanHostKeys(target, host, port, status)
    const wanted = new Set(fingerprints)
    const lines = scan.lines.filter((_line, index) => {
      const fingerprint = scan.fingerprints[index]?.fingerprint
      return fingerprint !== undefined && wanted.has(fingerprint)
    })
    if (lines.length === 0) {
      throw sshError('The host key changed while it was being confirmed.')
    }
    const knownHosts = `${status.home.replace(/\/+$/u, '')}/.ssh/known_hosts`
    if (target.kind === 'local') {
      const sshDir = join(status.home, '.ssh')
      mkdirSync(sshDir, { recursive: true, mode: 0o700 })
      try {
        chmodSync(sshDir, 0o700)
      } catch {
        // The directory may be owned by another security context.
      }
      appendFileSync(knownHosts, `${lines.join('\n')}\n`, { mode: 0o600 })
      try {
        chmodSync(knownHosts, 0o600)
      } catch {
        // Windows ignores POSIX modes; the user profile is the boundary.
      }
      return { status: 'trusted' }
    }
    const result = await this.deps.runner.run({
      scope: 'guest',
      label: 'clone-ssh-known-hosts',
      distro: target.distro,
      argv: [
        'sh',
        '-c',
        GUEST_WRITE_KNOWN_HOSTS,
        'icode-ssh-known-hosts',
        `${status.home.replace(/\/+$/u, '')}/.ssh`
      ],
      stdin: `${lines.join('\n')}\n`,
      timeoutMs: PROBE_TIMEOUT_MS
    })
    if ('status' in result && result.status !== 'ok') {
      throw sshError('known_hosts could not be updated.')
    }
    return { status: 'trusted' }
  }
}
