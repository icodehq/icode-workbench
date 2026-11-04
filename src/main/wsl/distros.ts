/**
 * Which WSL distros exist, and which are running.
 *
 * The distro *list* comes from the Lxss registry rather than `wsl --list
 * --verbose`, for one decisive reason: `--verbose` prints localized headers and
 * a `*` default marker, so parsing it breaks on a non-English Windows. This
 * machine reports `Microsoft Windows [版本 …]`, and the registry says the same
 * thing in every locale.
 *
 * The registry is also the only place the registration GUID lives, which is the
 * identity W1 persists: it survives a rename and changes on unregister+reimport.
 *
 * Running state comes from `wsl --list --running --quiet`. The `--quiet` is not
 * cosmetic: without it `wsl.exe` prints a *localized* header
 * (`适用于 Linux 的 Windows 子系统发行版:`) that parses as a distro name — measured
 * on this machine, in the exact bytes the runner receives. A failed running probe
 * yields `null`, never `false`: "could not ask" must not be reported as "stopped".
 */

import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { WslExecOutcome } from './exec'
import { WSL_DEFAULT_TIMEOUT_MS, decodeWslOutput, type WslCommandRunner } from './exec'

const LXSS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'

/** `…\Lxss\{3089ca97-…}` — the GUID subkey a registration hangs off. */
const REGISTRATION_SUBKEY =
  /\\\{([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}\s*$/i

/** `    DistributionName    REG_SZ    Ubuntu-26.04` — value names have no spaces. */
const REGISTRY_VALUE_LINE = /^\s+([A-Za-z_][\w]*)\s+REG_\w+\s+(.*?)\s*$/

/** Distros Docker Desktop owns: real registrations, but never an iCode target. */
const INTERNAL_DISTRO_PREFIXES = ['docker-desktop'] as const

export type WslDistroRegistration = {
  /** Registration name, exactly as the registry spells it. */
  name: string
  /** Lowercase, unbraced GUID. Stable across a rename, changed by re-import. */
  registrationId: string
  version: 1 | 2 | null
}

export type WslDistro = WslDistroRegistration & {
  /** null when the running probe failed; never a guess. */
  running: boolean | null
}

export type WslDistroDiscovery =
  | { status: 'ok'; distros: readonly WslDistro[]; defaultRegistrationId: string | null }
  | {
      status: 'unavailable'
      reason: 'not_windows' | 'registry_unreadable' | 'undecodable_names'
      detail: string
    }

export function isInternalDistro(name: string): boolean {
  const lower = name.trim().toLowerCase()
  return INTERNAL_DISTRO_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

/**
 * Parses `reg.exe query <Lxss> /s`.
 *
 * Shape-matched rather than text-matched: the footer and error strings are
 * localized, but a `HKEY_…` line and a `NAME  REG_TYPE  value` line are not.
 * The root key is not a registration and is skipped — it carries values like
 * `NatIpAddress` and the default-distribution pointer.
 */
export function parseLxssRegistry(output: string): {
  registrations: WslDistroRegistration[]
  defaultRegistrationId: string | null
} {
  const registrations: WslDistroRegistration[] = []
  let defaultRegistrationId: string | null = null
  let current: { registrationId: string; name: string | null; version: 1 | 2 | null } | null = null

  const flush = (): void => {
    if (current?.name) {
      registrations.push({
        name: current.name,
        registrationId: current.registrationId,
        version: current.version
      })
    }
    current = null
  }

  for (const line of output.split(/\r?\n/)) {
    if (/^(HKEY_|HKLM|HKCU)/i.test(line.trim())) {
      flush()
      const match = REGISTRATION_SUBKEY.exec(line.trim())
      if (match?.[1]) {
        current = { registrationId: match[1].toLowerCase(), name: null, version: null }
      }
      continue
    }

    const value = REGISTRY_VALUE_LINE.exec(line)
    if (!value) continue
    const [, valueName, rawValue] = value as unknown as [string, string, string]

    // Only the root key carries this, and `current` is null there.
    if (valueName === 'DefaultDistribution') {
      const id = /\{([0-9a-f-]{36})\}/i.exec(rawValue)?.[1]
      if (id) defaultRegistrationId = id.toLowerCase()
      continue
    }
    if (!current) continue
    if (valueName === 'DistributionName') {
      current.name = rawValue
    } else if (valueName === 'Version') {
      // REG_DWORD arrives as hex text: 0x2 means WSL 2.
      const parsed = /^0x([0-9a-f]+)$/i.exec(rawValue)
      const version = parsed ? Number.parseInt(parsed[1]!, 16) : Number.parseInt(rawValue, 10)
      current.version = version === 1 || version === 2 ? version : null
    }
  }
  flush()

  return { registrations, defaultRegistrationId }
}

/**
 * Parses `wsl --list --quiet` / `--list --running`.
 *
 * The piped form is NUL-separated UTF-16-ish text that arrives with stray NULs;
 * a name may legitimately contain spaces, so lines are kept whole and only the
 * default marker and padding are removed.
 */
export function parseDistroNames(output: string): string[] {
  return output
    .replaceAll(String.fromCharCode(0), '')
    // A UTF-16LE BOM survives decoding as U+FEFF.
    .replace(/^\uFEFF/u, '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\*\s*/u, '').trim())
    .filter((line) => line.length > 0)
}

/**
 * `reg.exe` is addressed absolutely: a shadowing `reg.bat` on PATH would
 * otherwise receive a registry query from iCode.
 */
function resolveRegExecutable(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows'
  return join(root, 'System32', 'reg.exe')
}

export type WslDistroDiscoveryDeps = {
  runner: WslCommandRunner
  /** Test seam: reads the registry; production shells out to reg.exe once. */
  queryRegistry?: () => Promise<string | null | { undecodable: true }>
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

/**
 * `reg.exe` writes REG_SZ values in the console codepage, not UTF-16 and not
 * UTF-8. A name that does not decode is reported as undecodable instead of being
 * passed on with replacement characters: storing a plausible-looking wrong name
 * would later surface as "distro not found", which points at the wrong cause.
 */
function defaultRegistryQuery(
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<string | { undecodable: true } | null> {
  return new Promise((resolve) => {
    execFile(
      resolveRegExecutable(env),
      ['query', LXSS_KEY, '/s'],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }
        const text = decodeWslOutput(stdout as unknown as Buffer)
        resolve(text.includes('\uFFFD') ? { undecodable: true } : text)
      }
    )
  })
}

/**
 * Reads every registered distro plus running state.
 *
 * Never throws: a caller deciding whether to offer WSL needs an answer, and
 * "cannot tell" is one of the answers.
 */
export async function discoverWslDistros(
  deps: WslDistroDiscoveryDeps
): Promise<WslDistroDiscovery> {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') {
    return {
      status: 'unavailable',
      reason: 'not_windows',
      detail: 'WSL distros are only visible from Windows.'
    }
  }

  const env = deps.env ?? process.env
  const timeoutMs = deps.timeoutMs ?? WSL_DEFAULT_TIMEOUT_MS
  const query = deps.queryRegistry ?? (() => defaultRegistryQuery(env, timeoutMs))

  /**
   * A single failed read is retried once.
   *
   * Measured: `reg.exe` under load misses a 20 s budget outright (WSL's own
   * service stalls in the tens of seconds). Treating that one miss as "WSL is
   * unavailable" told the repository dialog — and target validation — that a
   * perfectly good distro did not exist. Two failures still report the honest
   * answer, so a genuinely unreadable registry is not hidden.
   */
  let registry = await query()
  if (registry === null) registry = await query()
  if (registry === null) {
    return {
      status: 'unavailable',
      reason: 'registry_unreadable',
      detail: 'The WSL registration registry key could not be read.'
    }
  }
  if (typeof registry !== 'string') {
    return {
      status: 'unavailable',
      reason: 'undecodable_names',
      detail:
        'A WSL distro name could not be decoded from the registration registry. Rename the distro to ASCII characters, or that distro cannot be targeted.'
    }
  }

  const { registrations, defaultRegistrationId } = parseLxssRegistry(registry)
  const running = await readRunningDistros(deps.runner, timeoutMs)
  const runningNames = running === null ? null : new Set(running.map((n) => n.toLowerCase()))

  const distros = registrations
    .filter((registration) => !isInternalDistro(registration.name))
    .map((registration) => ({
      ...registration,
      running:
        runningNames === null ? null : runningNames.has(registration.name.toLowerCase())
    }))
    .sort((left, right) => left.name.localeCompare(right.name))

  return { status: 'ok', distros, defaultRegistrationId }
}

/** Running distro names, or null when the probe could not answer. */
export async function readRunningDistros(
  runner: WslCommandRunner,
  timeoutMs: number = WSL_DEFAULT_TIMEOUT_MS
): Promise<string[] | null> {
  const outcome: WslExecOutcome = await runner.run({
    scope: 'host',
    argv: ['--list', '--running', '--quiet'],
    timeoutMs
  })
  if (outcome.status !== 'ok') return null
  return parseDistroNames(outcome.stdout).filter((name) => !isInternalDistro(name))
}

/** The default distro's name, resolved through the GUID the registry records. */
export function defaultDistroName(
  discovery: Extract<WslDistroDiscovery, { status: 'ok' }>
): string | null {
  if (discovery.defaultRegistrationId === null) return null
  const match = discovery.distros.find(
    (distro) => distro.registrationId === discovery.defaultRegistrationId
  )
  return match?.name ?? null
}
