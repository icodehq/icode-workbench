/**
 * Owns the effective proxy configuration for the whole app.
 *
 * The user-facing model is the standard environment-variable contract. This
 * service turns it into three concrete things:
 *
 *   1. a Chromium session configuration (`setProxy`),
 *   2. the process environment inherited by local Git and terminal sessions,
 *   3. a guest environment for WSL processes (both cases, NAT-aware).
 *
 * It deliberately keeps no secrets: v1 rejects proxy URLs containing userinfo.
 */

import { execFile } from 'node:child_process'
import {
  MANAGED_PROXY_ENV_KEYS,
  parseNetworkProxySettings,
  validateNetworkProxySettings,
  type NetworkProxySettings
} from '../../shared/domain/network'
import { makeAppError } from '../../shared/domain/errors'
import {
  loadAppPreferences,
  updateAppPreferences,
  type AppPreferences
} from '../app/preferences'
import {
  captureInheritedProxy,
  chromiumProxyConfig,
  effectiveProxyUrls,
  emittedProxyEnv,
  guestProxyEnv,
  isLoopbackProxyHost,
  parseResolveProxyResult,
  type ChromiumProxyConfig,
  type InheritedProxy,
  type ProxyEnv,
  type ResolvedProxy
} from './proxy-environment'
import { resolveWslExecutablePath, resolveWslInteropCwd } from '../wsl/exec'

export type ProxySession = {
  setProxy(config: ChromiumProxyConfig): Promise<void>
  resolveProxy(url: string): Promise<string>
  forceReloadProxyConfig(): Promise<void>
  closeAllConnections(): Promise<void>
  fetch(input: string, init?: RequestInit): Promise<Response>
}

export type WslNetworkMode = 'nat' | 'mirrored' | 'unknown'

export type WslNetwork = {
  mode: WslNetworkMode
  gateway: string | null
}

export type NetworkProxyRuntimeDeps = {
  directory: string
  session: ProxySession
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  resolveTimeoutMs?: number
  loadPreferences?: (directory: string) => AppPreferences
  savePreferences?: (directory: string, patch: Partial<AppPreferences>) => boolean
  /** Test seam for the per-distro networking probe. */
  probeWsl?: (distro: string) => Promise<WslNetwork>
  now?: () => number
}

export type NetworkProxyRuntime = {
  initialize(): Promise<void>
  settings(): NetworkProxySettings
  saveSettings(input: NetworkProxySettings): Promise<NetworkProxySettings>
  /** Extra env for a local (or desktop-Host) PTY. */
  localSessionEnv(): ProxyEnv
  /** Extra env for a PTY running inside a WSL distro. */
  guestSessionEnv(distro: string): Promise<ProxyEnv>
  /** Extra env for every guest-scope `wsl.exe` spawn (Git, clone, Host). */
  wslGuestEnvironment(distro: string): Promise<ProxyEnv>
  /** The live local Git environment; read fresh for every command. */
  gitEnv(): NodeJS.ProcessEnv
  fetch(input: string, init?: RequestInit): Promise<Response>
}

const DEFAULT_RESOLVE_TIMEOUT_MS = 3_000
const HTTP_PROBE_URL = 'http://example.com/'
const HTTPS_PROBE_URL = 'https://example.com/'
const WSL_CACHE_TTL_MS = 5 * 60_000
const WSL_PROBE_TIMEOUT_MS = 5_000

export function parseWslNetwork(output: string): WslNetwork {
  const text = output.replace(/\u0000/gu, '')
  const mode = /^\s*(nat|mirrored)\s*$/imu.exec(text)
  const gateway = /default\s+via\s+([0-9A-Fa-f:.]+)/iu.exec(text)
  if (mode !== null) {
    return {
      mode: mode[1]!.toLowerCase() as 'nat' | 'mirrored',
      gateway: gateway?.[1] ?? null
    }
  }
  if (gateway !== null) return { mode: 'nat', gateway: gateway[1]! }
  return { mode: 'unknown', gateway: null }
}

function defaultWslProbe(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): (distro: string) => Promise<WslNetwork> {
  return async (distro) => {
    if (platform !== 'win32') return { mode: 'unknown', gateway: null }
    const program = resolveWslExecutablePath(env, platform)
    return new Promise<WslNetwork>((resolve) => {
      execFile(
        program,
        [
          '-d',
          distro,
          '--exec',
          'sh',
          '-c',
          'wslinfo --networking-mode 2>/dev/null; ip route show default 2>/dev/null'
        ],
        {
          timeout: WSL_PROBE_TIMEOUT_MS,
          windowsHide: true,
          encoding: 'utf8',
          cwd: resolveWslInteropCwd(env),
          env: { ...env, WSL_UTF8: '1' }
        },
        (error, stdout) => {
          if (error) {
            resolve({ mode: 'unknown', gateway: null })
            return
          }
          resolve(parseWslNetwork(stdout))
        }
      )
    })
  }
}

export async function createNetworkProxyRuntime(
  deps: NetworkProxyRuntimeDeps
): Promise<NetworkProxyRuntime> {
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  const resolveTimeoutMs = deps.resolveTimeoutMs ?? DEFAULT_RESOLVE_TIMEOUT_MS
  const loadPreferences = deps.loadPreferences ?? loadAppPreferences
  const savePreferences = deps.savePreferences ?? updateAppPreferences
  const now = deps.now ?? Date.now
  const probeWsl = deps.probeWsl ?? defaultWslProbe(env, platform)

  let settingsValue: NetworkProxySettings = { ...parseNetworkProxySettings(null) }
  let inherited: InheritedProxy = captureInheritedProxy(env)
  let resolvedValue: ResolvedProxy = { http: '', https: '' }
  let hostEnv: ProxyEnv = {}
  let initialized = false
  let applying: Promise<void> = Promise.resolve()
  const wslCache = new Map<string, { at: number; value: WslNetwork }>()
  const warnedWslHosts = new Set<string>()

  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = applying.then(work, work)
    applying = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  async function resolveOne(url: string): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      return await Promise.race([
        deps.session.resolveProxy(url).catch(() => ''),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve(''), resolveTimeoutMs)
        })
      ])
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  async function resolveSystemProxies(current: InheritedProxy): Promise<ResolvedProxy> {
    const needsHttp = current.http.length === 0 && current.all.length === 0
    const needsHttps = current.https.length === 0 && current.all.length === 0
    if (!needsHttp && !needsHttps) return { http: '', https: '' }
    const [httpRaw, httpsRaw] = await Promise.all([
      needsHttp ? resolveOne(HTTP_PROBE_URL) : Promise.resolve(''),
      needsHttps ? resolveOne(HTTPS_PROBE_URL) : Promise.resolve('')
    ])
    return {
      http: parseResolveProxyResult(httpRaw),
      https: parseResolveProxyResult(httpsRaw)
    }
  }

  async function wslNetworkFor(distro: string): Promise<WslNetwork> {
    if (platform !== 'win32') return { mode: 'unknown', gateway: null }
    const key = distro.trim().toLowerCase()
    const cached = wslCache.get(key)
    if (cached !== undefined && now() - cached.at < WSL_CACHE_TTL_MS) {
      return cached.value
    }
    const value = await probeWsl(distro).catch(
      (): WslNetwork => ({ mode: 'unknown', gateway: null })
    )
    // Cache failures too: a slow or broken distro must not pay a probe on
    // every guest command. A settings change clears the cache.
    wslCache.set(key, { at: now(), value })
    return value
  }

  function isLoopbackUrl(value: string): boolean {
    if (value.length === 0) return false
    try {
      return isLoopbackProxyHost(new URL(value).hostname)
    } catch {
      return false
    }
  }

  async function wslGuestEnvironment(distro: string): Promise<ProxyEnv> {
    if (settingsValue.mode === 'off') {
      // The distro may carry its own global proxy variables. Empty assignments
      // make "Off" mean direct inside the guest too.
      const cleared: ProxyEnv = {}
      for (const key of MANAGED_PROXY_ENV_KEYS) cleared[key] = ''
      return cleared
    }
    const urls = effectiveProxyUrls(settingsValue, inherited, resolvedValue)
    if (urls.http.length === 0 && urls.https.length === 0) return {}
    if (platform !== 'win32') return emittedProxyEnv(urls, 'guest')

    const network = await wslNetworkFor(distro)
    if (network.mode === 'mirrored') return emittedProxyEnv(urls, 'guest')
    if (network.mode === 'nat' && network.gateway !== null) {
      return guestProxyEnv(settingsValue, inherited, resolvedValue, {
        gateway: network.gateway,
        mirrored: false
      })
    }

    const key = distro.trim().toLowerCase()
    if (
      !warnedWslHosts.has(key) &&
      (isLoopbackUrl(urls.http) || isLoopbackUrl(urls.https))
    ) {
      warnedWslHosts.add(key)
      process.stderr.write(
        `[icode] WSL networking mode for ${distro} could not be determined; ` +
          'a loopback-only proxy may be unreachable from the distro.\n'
      )
    }
    return emittedProxyEnv(urls, 'guest')
  }

  function applyToProcessEnv(next: ProxyEnv): void {
    for (const key of MANAGED_PROXY_ENV_KEYS) {
      delete env[key]
    }
    for (const [key, value] of Object.entries(next)) {
      env[key] = value
    }
  }

  async function applySettings(next: NetworkProxySettings): Promise<void> {
    settingsValue = next
    // Chromium is configured first: in system mode `resolveProxy` must reflect
    // the system configuration, not a previously applied manual proxy.
    try {
      await deps.session.setProxy(chromiumProxyConfig(next))
    } catch (error) {
      process.stderr.write(
        `[icode] could not apply the Chromium proxy: ${
          error instanceof Error ? error.message : String(error)
        }\n`
      )
    }
    if (next.mode === 'system') {
      try {
        await deps.session.forceReloadProxyConfig()
      } catch {
        // A PAC reload is advisory; the current configuration remains usable.
      }
    }
    const resolved =
      next.mode === 'system' ? await resolveSystemProxies(inherited) : { http: '', https: '' }
    resolvedValue = resolved
    const urls = effectiveProxyUrls(next, inherited, resolved)
    hostEnv = emittedProxyEnv(urls, platform)
    applyToProcessEnv(hostEnv)
    wslCache.clear()
    warnedWslHosts.clear()
    try {
      await deps.session.closeAllConnections()
    } catch {
      // Pooled sockets are best-effort; the new configuration is still active.
    }
  }

  const runtime: NetworkProxyRuntime = {
    async initialize(): Promise<void> {
      if (initialized) return
      initialized = true
      // Capture before this service writes anything; the login-environment
      // probe has already run by the time the runtime starts.
      inherited = captureInheritedProxy(env)
      settingsValue = parseNetworkProxySettings(
        loadPreferences(deps.directory).proxy
      )
      await applySettings(settingsValue)
    },

    settings(): NetworkProxySettings {
      return { ...settingsValue }
    },

    saveSettings(input: NetworkProxySettings): Promise<NetworkProxySettings> {
      return serial(async () => {
        const issues = validateNetworkProxySettings(input)
        if (issues.length > 0) {
          throw makeAppError('INVALID_ARGUMENT', 'The proxy settings are invalid.', {
            detail: issues
              .map((issue) =>
                issue.field === 'mode' ? issue.reason : `${issue.field}: ${issue.reason}`
              )
              .join('; ')
          })
        }
        const normalized = parseNetworkProxySettings(input)
        if (!savePreferences(deps.directory, { proxy: normalized })) {
          throw makeAppError('INTERNAL', 'The proxy settings could not be saved.')
        }
        await applySettings(normalized)
        return { ...settingsValue }
      })
    },

    localSessionEnv(): ProxyEnv {
      return { ...hostEnv }
    },

    guestSessionEnv(distro: string): Promise<ProxyEnv> {
      return wslGuestEnvironment(distro)
    },

    wslGuestEnvironment,

    gitEnv(): NodeJS.ProcessEnv {
      return env
    },

    fetch(input: string, init?: RequestInit): Promise<Response> {
      return deps.session.fetch(input, init)
    }
  }

  await runtime.initialize()
  return runtime
}
