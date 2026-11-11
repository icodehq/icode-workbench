/**
 * Remote repository URLs: the one parser shared by the clone form, the remote
 * editor and the error classifier.
 *
 * Git accepts far more spellings than a URL parser does (`scp`-like
 * `git@host:owner/repo.git`, local paths, `file://`, and transport helpers like
 * `ext::`), so this deliberately recognizes "what the user typed" instead of
 * assuming `new URL`. The parser is descriptive: it never rewrites the value
 * that is passed to Git. Only display forms are derived here.
 *
 * Two safety rules live in this module because every caller needs them:
 *
 *   - Embedded credentials (`https://user:token@host/…`) are reduced to `***@`
 *     for display and for diagnostics.
 *   - A redacted display value can never be submitted back to Git as if it were
 *     the real URL; `containsRedactionPlaceholder` is the guard.
 */

export type RemoteProvider = 'github' | 'gitlab' | 'generic'

export type ParsedRemoteUrl = {
  /** The value exactly as supplied, trimmed. */
  input: string
  kind: 'url' | 'local-path'
  provider: RemoteProvider
  /** Lowercase hostname without userinfo; null for local paths. */
  host: string | null
  /** Repository path without a leading/trailing slash or one trailing `.git`. */
  path: string | null
  /** An HTTPS address for a recognized provider, or a credential-free http(s) URL. */
  webUrl: string | null
  /** Last path segment with one trailing `.git` removed. */
  suggestedName: string | null
  /** True when a URL carries a username or password. */
  hasCredentials: boolean
  /** Safe to display: credentials replaced by `***@`. */
  displayUrl: string
  isLocalPath: boolean
}

const SCHEME_ALLOWLIST = new Set(['http:', 'https:', 'ssh:', 'git:', 'git+ssh:', 'file:'])

const KNOWN_PROVIDER_HOSTS: Record<string, RemoteProvider> = {
  'github.com': 'github',
  'www.github.com': 'github',
  'gitlab.com': 'gitlab',
  'www.gitlab.com': 'gitlab'
}

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/u
const SCHEME_URL = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//u
const SCP_LIKE = /^(?:([^@\s/\\:]+)@)?([A-Za-z0-9._-]+):([^\s]+)$/u
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u
const REDACTION_PLACEHOLDER = /\*\*\*|%2A%2A%2A/iu

function isWindowsPath(value: string): boolean {
  return WINDOWS_DRIVE.test(value) || value.startsWith('\\\\')
}

function stripTrailingSlashes(value: string): string {
  const stripped = value.replace(/[\\/]+$/u, '')
  return stripped.length === 0 ? value : stripped
}

function lastSegment(value: string): string | null {
  const normalized = stripTrailingSlashes(value)
  const separator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  const segment = normalized.slice(separator + 1).trim()
  if (segment.length === 0 || segment === '.' || segment === '..') return null
  return segment
}

/** Removes exactly one trailing `.git`, leaving `.git.git` as `.git`. */
export function stripGitSuffix(segment: string): string {
  return segment.endsWith('.git') ? segment.slice(0, -4) : segment
}

function suggestedNameOf(path: string | null, suffixAlreadyStripped = false): string | null {
  if (path === null) return null
  const segment = lastSegment(path)
  if (segment === null) return null
  return suffixAlreadyStripped ? segment : stripGitSuffix(segment)
}

function normalizePath(value: string): string | null {
  const trimmed = value.replace(/^\/+/u, '').replace(/\/+$/u, '')
  if (trimmed.length === 0) return null
  const segments = trimmed.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null
  }
  // Only the repository name carries the `.git` suffix; a group called
  // `tools.git` is part of the path, not a suffix.
  segments[segments.length - 1] = stripGitSuffix(segments[segments.length - 1]!)
  const normalized = segments.join('/')
  return normalized.length === 0 ? null : normalized
}

function providerOf(host: string | null): RemoteProvider {
  if (host === null) return 'generic'
  return KNOWN_PROVIDER_HOSTS[host] ?? 'generic'
}

function webUrlOf(provider: RemoteProvider, host: string | null, path: string | null): string | null {
  if (host === null || path === null) return null
  if (provider === 'generic') return null
  if (path.split('/').length < 2) return null
  return `https://${host}/${encodePath(path)}`
}

function encodePath(path: string): string {
  return path.split('/').map((segment) => encodeURIComponent(segment)).join('/')
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function parseSchemeUrl(input: string): ParsedRemoteUrl | null {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }
  if (!SCHEME_ALLOWLIST.has(url.protocol)) return null

  const hasCredentials = isHttpProtocol(url.protocol)
    ? url.username.length > 0 || url.password.length > 0
    // An SSH username (`git@host`) is an identity, not a secret.
    : url.password.length > 0
  const host = url.hostname.length > 0 ? url.hostname.toLowerCase() : null
  const provider = providerOf(host)
  // A file URL's hostname is usually empty; its path is the repository location.
  const decodedPath =
    url.protocol === 'file:'
      ? safeDecode(url.pathname)
      : safeDecode(url.pathname.replace(/^\/+/u, ''))
  if (decodedPath === null || CONTROL_CHARACTERS.test(decodedPath)) return null
  const path = decodedPath.length === 0 ? null : normalizePath(decodedPath)
  const isLocalFile = url.protocol === 'file:'

  return {
    input,
    kind: 'url',
    provider,
    host,
    path,
    webUrl:
      provider === 'generic'
        ? isLocalFile
          ? null
          : credentialFreeHttpUrl(url, path)
        : webUrlOf(provider, host, path),
    suggestedName: suggestedNameOf(path, true),
    hasCredentials,
    displayUrl: redactRemoteUrlCredentials(input),
    isLocalPath: isLocalFile
  }
}

/**
 * A generic HTTPS repository can still open in a browser, but never with the
 * userinfo that may contain a token.
 */
function credentialFreeHttpUrl(url: URL, path: string | null): string | null {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.hostname.length === 0) return null
  return `${url.protocol}//${url.host}${path === null ? '' : `/${encodePath(path)}`}`
}

function parseScpLike(input: string): ParsedRemoteUrl | null {
  const match = SCP_LIKE.exec(input)
  if (match === null) return null
  const rawHost = match[2]
  const rawPath = match[3]
  // A Windows drive was already handled as a local path; a scheme URL never
  // reaches here. Require a repo-like path and refuse anything that still looks
  // like a URL or a transport helper (`ext::…`, `fd::…`).
  if (rawHost === undefined || rawPath === undefined) return null
  if (input.includes('::')) return null
  if (rawPath.startsWith('//') || rawPath.startsWith('::')) return null
  if (CONTROL_CHARACTERS.test(input)) return null
  const host = rawHost.toLowerCase()
  const provider = providerOf(host)
  const path = normalizePath(rawPath)
  if (path === null) return null
  return {
    input,
    kind: 'url',
    provider,
    host,
    path,
    webUrl: webUrlOf(provider, host, path),
    suggestedName: suggestedNameOf(path, true),
    hasCredentials: false,
    displayUrl: input,
    isLocalPath: false
  }
}

function parseLocalPath(input: string): ParsedRemoteUrl {
  return {
    input,
    kind: 'local-path',
    provider: 'generic',
    host: null,
    path: input,
    webUrl: null,
    suggestedName: suggestedNameOf(input),
    hasCredentials: false,
    displayUrl: input,
    isLocalPath: true
  }
}

/**
 * Describes a remote URL. Returns null for an empty value, control characters,
 * an unknown scheme, or a value Git would read as an option.
 */
export function parseRemoteUrl(value: string): ParsedRemoteUrl | null {
  const input = value.trim()
  if (input.length === 0 || input.startsWith('-')) return null
  if (CONTROL_CHARACTERS.test(input)) return null
  if (input.startsWith('/') || isWindowsPath(input)) return parseLocalPath(input)
  if (SCHEME_URL.test(input)) return parseSchemeUrl(input)
  return parseScpLike(input)
}

function isHttpProtocol(protocol: string): boolean {
  return protocol === 'http:' || protocol === 'https:'
}

/**
 * Replaces URL userinfo in arbitrary text. Git echoes the remote URL in several
 * errors, so this is also applied to stderr before it becomes an error detail.
 *
 * SSH usernames are left alone: `ssh://git@host/...` is not a credential. An
 * HTTPS username can be a token, and any password is redacted.
 */
export function redactRemoteUrlCredentials(value: string): string {
  return value.replace(
    /\b(https?|ssh|git|git\+ssh|file):\/\/([^/\s@]+)@/giu,
    (whole, scheme: string, userinfo: string) => {
      if (isHttpProtocol(`${scheme.toLowerCase()}:`) || userinfo.includes(':')) {
        return `${scheme.toLowerCase()}://***@`
      }
      return whole
    }
  )
}

/** True when a value still contains a display placeholder, so it must not be submitted. */
export function containsRedactionPlaceholder(value: string): boolean {
  return REDACTION_PLACEHOLDER.test(value)
}

/**
 * Whether a string is a plausible clone source.
 *
 * This is an allowlist, not a syntax check: Git's `ext::` and `fd::` transports
 * execute commands, and a remote URL typed by a user has no business doing that.
 * The value is still validated by Git; this only keeps obvious helpers and
 * option-looking values away from argv.
 */
export function isCloneableRemoteInput(value: string): boolean {
  const input = value.trim()
  if (input.length === 0 || input.startsWith('-') || CONTROL_CHARACTERS.test(input)) return false
  if (containsRedactionPlaceholder(input)) return false
  if (input.startsWith('/') || isWindowsPath(input)) return true
  if (SCHEME_URL.test(input)) {
    const scheme = SCHEME_URL.exec(input)?.[1]?.toLowerCase()
    if (scheme === undefined || !SCHEME_ALLOWLIST.has(`${scheme}:`)) return false
    const parsed = parseSchemeUrl(input)
    if (parsed === null) return false
    // A network scheme needs a host; `file:///path` legitimately has none.
    if (!parsed.isLocalPath && parsed.host === null) return false
    return true
  }
  return parseScpLike(input) !== null
}
