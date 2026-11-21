/**
 * The app-wide HTTP/HTTPS proxy model.
 *
 * The user-facing contract is deliberately the standard environment-variable
 * vocabulary: separate HTTP and HTTPS proxy URLs plus a NO_PROXY list. The
 * runtime makes those values reach Chromium, local Git, local sessions, and WSL
 * guest processes; no secrets are accepted here.
 */

export const PROXY_MODES = ['system', 'manual', 'off'] as const

export type ProxyMode = (typeof PROXY_MODES)[number]

export type NetworkProxySettings = {
  mode: ProxyMode
  /** Empty means "not configured"; manual mode requires at least one URL. */
  httpProxyUrl: string
  httpsProxyUrl: string
  noProxy: string
}

export const DEFAULT_NETWORK_PROXY_SETTINGS: NetworkProxySettings = {
  mode: 'system',
  httpProxyUrl: '',
  httpsProxyUrl: '',
  noProxy: ''
}

export const PROXY_URL_MAX_LENGTH = 2_048
export const NO_PROXY_MAX_LENGTH = 8_192
export const NO_PROXY_MAX_TOKENS = 128
export const NO_PROXY_TOKEN_MAX_LENGTH = 255

/**
 * Every environment name the runtime owns. Both spellings are emitted where
 * the OS allows it; Windows cannot carry both (its environment is
 * case-insensitive), so it receives lowercase only.
 */
export const MANAGED_PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  'ALL_PROXY',
  'all_proxy'
] as const

export type ManagedProxyEnvKey = (typeof MANAGED_PROXY_ENV_KEYS)[number]

/** The three destinations that should never be sent to a proxy by default. */
export const DEFAULT_NO_PROXY = ['localhost', '127.0.0.1', '::1'] as const

const PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks5:', 'socks5h:'])
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u
const WHITESPACE = /\s/u
const NO_PROXY_TOKEN = /^[*.]?[A-Za-z0-9_.:[\]-]+(?:\/\d{1,3})?$/u

export type ProxyUrlIssue =
  | 'invalid'
  | 'scheme'
  | 'userinfo'
  | 'host'
  | 'port'
  | 'path'
  | 'control'
  | 'length'

export type NoProxyIssue = 'length' | 'count' | 'token'

export type ProxySettingsIssue =
  | { field: 'httpProxyUrl' | 'httpsProxyUrl'; reason: ProxyUrlIssue }
  | { field: 'noProxy'; reason: NoProxyIssue }
  | { field: 'mode'; reason: 'manualNeedsProxy' }

export function isProxyMode(value: unknown): value is ProxyMode {
  return typeof value === 'string' && (PROXY_MODES as readonly string[]).includes(value)
}

/** The raw `host[:port]` (without userinfo) between `//` and the path. */
function authorityOf(value: string): string | null {
  const match = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/u.exec(value)
  if (match === null) return null
  const authority = match[1] ?? ''
  return authority.slice(authority.lastIndexOf('@') + 1)
}

/** The explicitly written port, even when it is the scheme's default. */
function explicitPort(authority: string): string | null {
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']')
    if (close === -1) return null
    const rest = authority.slice(close + 1)
    return rest.startsWith(':') ? rest.slice(1) : null
  }
  const colon = authority.lastIndexOf(':')
  return colon === -1 ? null : authority.slice(colon + 1)
}

function portIsValid(port: string | null): boolean {
  if (port === null || !/^\d+$/u.test(port)) return false
  const numeric = Number(port)
  return Number.isInteger(numeric) && numeric >= 1 && numeric <= 65_535
}

/**
 * Reports why a proxy URL is unusable, or `null` when it is valid.
 *
 * A proxy URL must name a host and an explicit port; a missing port is a
 * configuration error rather than a silent protocol default. Credentials are
 * rejected in v1 — they would have to be stored and forwarded, and the common
 * local proxy (Clash) needs none.
 */
export function inspectProxyUrl(value: string): ProxyUrlIssue | null {
  if (value.length > PROXY_URL_MAX_LENGTH) return 'length'
  if (CONTROL_CHARACTERS.test(value)) return 'control'
  if (WHITESPACE.test(value)) return 'control'
  const trimmed = value.trim()
  if (trimmed.length === 0) return 'host'
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return 'invalid'
  }
  if (!PROXY_PROTOCOLS.has(url.protocol)) return 'scheme'
  if (url.username.length > 0 || url.password.length > 0) return 'userinfo'
  if (url.hostname.length === 0) return 'host'
  // `URL` drops the default port (`:443` for HTTPS), so the raw authority is
  // the only place that proves the user wrote one explicitly.
  const authority = authorityOf(trimmed)
  if (authority === null || !portIsValid(explicitPort(authority))) return 'port'
  if (url.pathname.length > 0 && url.pathname !== '/') return 'path'
  if (url.search.length > 0 || url.hash.length > 0) return 'path'
  return null
}

/** Canonical `scheme://host:port`; assumes the value already passed inspection. */
export function normalizeProxyUrl(value: string): string {
  const trimmed = value.trim()
  const url = new URL(trimmed)
  const authority = authorityOf(trimmed)
  const port = authority === null ? url.port : explicitPort(authority) ?? url.port
  const lowerHost = url.hostname.toLowerCase()
  const host =
    lowerHost.startsWith('[') || !lowerHost.includes(':')
      ? lowerHost
      : `[${lowerHost}]`
  return `${url.protocol}//${host}${port.length > 0 ? `:${port}` : ''}`
}

function splitNoProxy(value: string): string[] {
  return value.split(/[\s,]+/u).filter((token) => token.length > 0)
}

export function inspectNoProxy(value: string): NoProxyIssue | null {
  if (value.length > NO_PROXY_MAX_LENGTH) return 'length'
  if (CONTROL_CHARACTERS.test(value)) return 'token'
  const tokens = splitNoProxy(value)
  if (tokens.length > NO_PROXY_MAX_TOKENS) return 'count'
  for (const token of tokens) {
    if (token.length > NO_PROXY_TOKEN_MAX_LENGTH) return 'length'
    if (token === '*' || token === '<local>') continue
    if (!NO_PROXY_TOKEN.test(token)) return 'token'
  }
  return null
}

/** Deduplicated, comma-separated, case-preserved NO_PROXY tokens. */
export function normalizeNoProxy(value: string): string {
  const seen = new Set<string>()
  const tokens: string[] = []
  for (const token of splitNoProxy(value)) {
    const key = token.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tokens.push(token)
  }
  return tokens.join(',')
}

/**
 * The stored bypass list plus loopback. Loopback is never proxied by default:
 * local Git remotes and local services should not be sent through a proxy.
 */
export function noProxyWithLoopback(value: string): string {
  const tokens = splitNoProxy(normalizeNoProxy(value))
  const seen = new Set(tokens.map((token) => token.toLowerCase()))
  for (const loopback of DEFAULT_NO_PROXY) {
    if (!seen.has(loopback)) {
      seen.add(loopback)
      tokens.push(loopback)
    }
  }
  return tokens.join(',')
}

/**
 * Validates a settings object for saving. Persisted invalid values are
 * normalized separately; this is the strict path used by the IPC schema and the
 * settings card.
 */
export function validateNetworkProxySettings(
  value: NetworkProxySettings
): ProxySettingsIssue[] {
  if (value.mode !== 'manual') return []
  const issues: ProxySettingsIssue[] = []
  let configured = 0
  for (const field of ['httpProxyUrl', 'httpsProxyUrl'] as const) {
    const raw = value[field].trim()
    if (raw.length === 0) continue
    configured += 1
    const reason = inspectProxyUrl(raw)
    if (reason !== null) issues.push({ field, reason })
  }
  if (configured === 0) issues.push({ field: 'mode', reason: 'manualNeedsProxy' })
  if (value.noProxy.trim().length > 0) {
    const reason = inspectNoProxy(value.noProxy)
    if (reason !== null) issues.push({ field: 'noProxy', reason })
  }
  return issues
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, maxLength)
}

/**
 * Tolerant parsing for the preferences file.
 *
 * Missing fields and an unknown mode fall back to the defaults. A manual mode
 * whose URLs are invalid falls back to `system` rather than applying a broken
 * proxy; the UI never writes that shape, so this only handles hand-edited files.
 */
export function parseNetworkProxySettings(value: unknown): NetworkProxySettings {
  const record = asRecord(value)
  if (record === null) return { ...DEFAULT_NETWORK_PROXY_SETTINGS }
  const mode = isProxyMode(record.mode) ? record.mode : 'system'
  const httpProxyUrl = asString(record.httpProxyUrl, PROXY_URL_MAX_LENGTH)
  const httpsProxyUrl = asString(record.httpsProxyUrl, PROXY_URL_MAX_LENGTH)
  const noProxy = asString(record.noProxy, NO_PROXY_MAX_LENGTH)

  if (mode !== 'manual') {
    return { mode, httpProxyUrl, httpsProxyUrl, noProxy }
  }

  const candidate: NetworkProxySettings = {
    mode,
    httpProxyUrl,
    httpsProxyUrl,
    noProxy
  }
  if (validateNetworkProxySettings(candidate).length > 0) {
    return { ...DEFAULT_NETWORK_PROXY_SETTINGS }
  }
  return {
    mode,
    httpProxyUrl: httpProxyUrl.length > 0 ? normalizeProxyUrl(httpProxyUrl) : '',
    httpsProxyUrl: httpsProxyUrl.length > 0 ? normalizeProxyUrl(httpsProxyUrl) : '',
    noProxy: normalizeNoProxy(noProxy)
  }
}

/**
 * Text produced by Git/curl/Chromium when the proxy, rather than the remote,
 * is the failure. Kept narrow so a generic DNS or TLS failure is not
 * misattributed to the proxy.
 */
const PROXY_FAILURE_TEXT =
  /CONNECT tunnel failed|could not resolve proxy|proxy CONNECT aborted|ERR_PROXY_|ERR_TUNNEL_|ERR_SOCKS_|Received HTTP code 407|HTTP\/\d(?:\.\d)? 407|status(?: code)? 407/iu

export function isProxyFailureText(value: string): boolean {
  return PROXY_FAILURE_TEXT.test(value)
}
