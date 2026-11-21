/**
 * Pure proxy-environment helpers.
 *
 * Everything here is deterministic and Electron-free so the platform rules can
 * be unit-tested without spawning a Git process or a WSL distro.
 */

import {
  inspectProxyUrl,
  noProxyWithLoopback,
  normalizeProxyUrl,
  type NetworkProxySettings
} from '../../shared/domain/network'

export type ProxyEnv = Record<string, string>

/** The proxy values inherited from the process environment at startup. */
export type InheritedProxy = {
  http: string
  https: string
  noProxy: string
  all: string
}

/** What Chromium's `resolveProxy()` reported for each scheme. Empty = direct. */
export type ResolvedProxy = {
  http: string
  https: string
}

export type EffectiveProxyUrls = {
  http: string
  https: string
  noProxy: string
  source: 'manual' | 'environment' | 'system' | 'none'
}

export type ChromiumProxyConfig =
  | { mode: 'system' | 'direct' }
  | { mode: 'fixed_servers'; proxyRules: string; proxyBypassRules?: string }

const ENV_NAMES = {
  http: ['http_proxy', 'HTTP_PROXY'],
  https: ['https_proxy', 'HTTPS_PROXY'],
  noProxy: ['no_proxy', 'NO_PROXY'],
  all: ['all_proxy', 'ALL_PROXY']
} as const

function firstValue(env: NodeJS.ProcessEnv, names: readonly string[]): string {
  for (const name of names) {
    const value = env[name]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return ''
}

export function captureInheritedProxy(env: NodeJS.ProcessEnv): InheritedProxy {
  return {
    http: firstValue(env, ENV_NAMES.http),
    https: firstValue(env, ENV_NAMES.https),
    noProxy: firstValue(env, ENV_NAMES.noProxy),
    all: firstValue(env, ENV_NAMES.all)
  }
}

/**
 * System mode fills a missing scheme; it never overrides an inherited value.
 * An inherited ALL_PROXY is used as the fallback for either scheme, but is not
 * re-emitted itself, so the separate HTTP/HTTPS contract stays unambiguous.
 */
export function effectiveProxyUrls(
  settings: NetworkProxySettings,
  inherited: InheritedProxy,
  resolved: ResolvedProxy
): EffectiveProxyUrls {
  if (settings.mode === 'off') {
    return { http: '', https: '', noProxy: '', source: 'none' }
  }
  if (settings.mode === 'manual') {
    return {
      http: settings.httpProxyUrl,
      https: settings.httpsProxyUrl,
      noProxy: noProxyWithLoopback(settings.noProxy),
      source: 'manual'
    }
  }
  const fromEnvironment = inherited.http.length > 0 || inherited.https.length > 0 ||
    inherited.all.length > 0
  return {
    http: inherited.http || resolved.http || inherited.all,
    https: inherited.https || resolved.https || inherited.all,
    noProxy: noProxyWithLoopback(inherited.noProxy),
    source: fromEnvironment ? 'environment' : resolved.http || resolved.https ? 'system' : 'none'
  }
}

/**
 * Emits the environment contract.
 *
 * Windows receives lowercase only: its environment block is case-insensitive
 * and cannot carry `HTTP_PROXY` and `http_proxy` as separate entries, and
 * Git/curl ignore uppercase `HTTP_PROXY`. POSIX and the WSL guest receive both
 * spellings because their tools disagree about which one they read.
 */
export function emittedProxyEnv(
  urls: EffectiveProxyUrls,
  target: NodeJS.Platform | 'guest'
): ProxyEnv {
  const env: ProxyEnv = {}
  const hasProxy = urls.http.length > 0 || urls.https.length > 0
  if (!hasProxy) return env

  if (urls.http.length > 0) {
    env.http_proxy = urls.http
    if (target !== 'win32') env.HTTP_PROXY = urls.http
  }
  if (urls.https.length > 0) {
    env.https_proxy = urls.https
    if (target !== 'win32') env.HTTPS_PROXY = urls.https
  }
  if (urls.noProxy.length > 0) {
    env.no_proxy = urls.noProxy
    if (target !== 'win32') env.NO_PROXY = urls.noProxy
  }
  return env
}

/**
 * Parses the text returned by `session.resolveProxy()`.
 *
 * The first usable entry wins. `DIRECT` is ignored; SOCKS4 is not supported and
 * is skipped. SOCKS5 uses `socks5h` so Git/curl resolve names at the proxy.
 */
export function parseResolveProxyResult(value: string): string {
  for (const rawEntry of value.split(';')) {
    const entry = rawEntry.trim()
    if (entry.length === 0 || /^DIRECT$/iu.test(entry)) continue
    const match = /^(PROXY|HTTPS|SOCKS5|SOCKS|SOCKS4)\s+(.+)$/iu.exec(entry)
    if (match === null) continue
    const kind = match[1]?.toUpperCase()
    if (kind === 'SOCKS4') continue
    const authority = match[2]?.trim() ?? ''
    if (authority.length === 0) continue
    const protocol = kind === 'PROXY' ? 'http:' : kind === 'HTTPS' ? 'https:' : 'socks5h:'
    const candidate = `${protocol}//${authority}`
    if (inspectProxyUrl(candidate) !== null) continue
    return normalizeProxyUrl(candidate)
  }
  return ''
}

function chromiumRule(url: string): string {
  const parsed = new URL(url)
  if (parsed.protocol === 'socks5:' || parsed.protocol === 'socks5h:') {
    return `socks5://${parsed.host}`
  }
  if (parsed.protocol === 'https:') return `https://${parsed.host}`
  return parsed.host
}

export function chromiumProxyConfig(
  settings: NetworkProxySettings
): ChromiumProxyConfig {
  if (settings.mode === 'system') return { mode: 'system' }
  if (settings.mode === 'off') return { mode: 'direct' }
  const rules: string[] = []
  if (settings.httpProxyUrl.length > 0) {
    rules.push(`http=${chromiumRule(settings.httpProxyUrl)}`)
  }
  if (settings.httpsProxyUrl.length > 0) {
    rules.push(`https=${chromiumRule(settings.httpsProxyUrl)}`)
  }
  if (rules.length === 0) return { mode: 'system' }
  const bypass = noProxyWithLoopback(settings.noProxy)
  return {
    mode: 'fixed_servers',
    proxyRules: rules.join(';'),
    ...(bypass.length > 0 ? { proxyBypassRules: bypass } : {})
  }
}

function bareHost(hostname: string): string {
  return hostname.replace(/^\[/u, '').replace(/\]$/u, '').toLowerCase()
}

export function isLoopbackProxyHost(hostname: string): boolean {
  const host = bareHost(hostname)
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0'
}

/**
 * Rewrites only the proxy URL host, never NO_PROXY: bypass tokens describe
 * destinations inside the guest, not where the proxy listens.
 */
export function rewriteLoopbackProxyUrl(url: string, gateway: string): string {
  const parsed = new URL(url)
  if (!isLoopbackProxyHost(parsed.hostname)) return url
  const normalizedGateway = bareHost(gateway)
  if (normalizedGateway.length === 0) return url
  const host = normalizedGateway.includes(':') ? `[${normalizedGateway}]` : normalizedGateway
  return `${parsed.protocol}//${host}:${parsed.port}`
}

export function guestProxyEnv(
  settings: NetworkProxySettings,
  inherited: InheritedProxy,
  resolved: ResolvedProxy,
  options: { gateway: string | null; mirrored: boolean }
): ProxyEnv {
  const urls = effectiveProxyUrls(settings, inherited, resolved)
  if (urls.http.length === 0 && urls.https.length === 0) return {}
  const gateway = options.mirrored ? null : options.gateway
  return emittedProxyEnv(
    {
      ...urls,
      http:
        gateway === null || urls.http.length === 0
          ? urls.http
          : rewriteLoopbackProxyUrl(urls.http, gateway),
      https:
        gateway === null || urls.https.length === 0
          ? urls.https
          : rewriteLoopbackProxyUrl(urls.https, gateway)
    },
    'guest'
  )
}

/** `['HTTPS_PROXY=…', 'http_proxy=…']`, sorted for deterministic argv/tests. */
export function guestEnvAssignments(env: ProxyEnv): string[] {
  return Object.keys(env)
    .sort()
    .map((key) => `${key}=${env[key]}`)
}
