import type { ProviderTestResult } from '../../shared/schemas/provider'
import type { ProviderLaunchInput } from '../../shared/provider-launch'

/**
 * A real, minimal provider probe.
 *
 * The Settings "Test" button is the only deliberate network egress from this
 * feature. It sends one tiny request through the same endpoint construction the
 * launch path uses, so a wrong key, model, or base URL fails here instead of at
 * the first prompt. Results are sanitized: no key, headers, or raw body ever
 * leave this module.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export type ProviderProbe = {
  test(provider: ProviderLaunchInput): Promise<ProviderTestResult>
}

const DEFAULT_TIMEOUT_MS = 10_000
const BODY_CAP_BYTES = 2048

type ProbeRequest = {
  url: string
  headers: Record<string, string>
  body: unknown
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, '')
}

/** Claude's base URL is the origin; the path lives under /v1. */
function claudeUrl(baseUrl: string): string {
  const base = trimBase(baseUrl)
  return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`
}

/** Codex and OpenCode accept either an origin or an explicit /v1 base. */
function agentUrl(baseUrl: string, path: string): string {
  const base = trimBase(baseUrl)
  return base.endsWith('/v1') ? `${base}${path}` : `${base}/v1${path}`
}

function requestFor(provider: ProviderLaunchInput): ProbeRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  switch (provider.harness) {
    case 'claude': {
      headers['anthropic-version'] = '2023-06-01'
      if (provider.authStyle === 'api_key') headers['x-api-key'] = provider.apiKey
      else headers.authorization = `Bearer ${provider.apiKey}`
      return {
        url: claudeUrl(provider.baseUrl),
        headers,
        body: {
          model: provider.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }]
        }
      }
    }
    case 'codex':
      headers.authorization = `Bearer ${provider.apiKey}`
      return {
        url: agentUrl(provider.baseUrl, '/responses'),
        headers,
        body: { model: provider.model, input: 'ping', max_output_tokens: 1 }
      }
    case 'opencode':
      headers.authorization = `Bearer ${provider.apiKey}`
      return {
        url: agentUrl(provider.baseUrl, '/chat/completions'),
        headers,
        body: {
          model: provider.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }]
        }
      }
  }
}

/** Keep provider output useful without letting it grow or echo credentials. */
export function sanitizeProbeMessage(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{6,}/gu, 'sk-…')
    .replace(/Bearer\s+[^\s"']+/giu, 'Bearer …')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 300)
}

async function readCapped(response: Response, cap: number): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const decoder = new TextDecoder()
  let text = ''
  try {
    while (text.length < cap) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return text.slice(0, cap)
}

function result(
  code: ProviderTestResult['code'],
  status: number | null,
  latencyMs: number,
  message: string
): ProviderTestResult {
  return { ok: code === 'ok', code, status, latencyMs, message: message.slice(0, 500) }
}

export function createProviderProbe(options: {
  fetch: FetchLike
  timeoutMs?: number
  now?: () => number
}): ProviderProbe {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = options.now ?? Date.now

  return {
    async test(provider): Promise<ProviderTestResult> {
      const request = requestFor(provider)
      const startedAt = now()
      try {
        const response = await options.fetch(request.url, {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify(request.body),
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'manual'
        })
        const latencyMs = now() - startedAt
        if (response.status >= 200 && response.status < 300) {
          return result('ok', response.status, latencyMs, `Reached the provider (HTTP ${response.status}).`)
        }
        const body = sanitizeProbeMessage(await readCapped(response, BODY_CAP_BYTES))
        if (response.status === 401 || response.status === 403) {
          return result(
            'auth_failed',
            response.status,
            latencyMs,
            `The provider rejected the API key (HTTP ${response.status}).${body ? ` ${body}` : ''}`
          )
        }
        if (response.status === 404) {
          return result(
            'model_or_endpoint',
            response.status,
            latencyMs,
            `The endpoint was not found (HTTP 404). Check the base URL.${body ? ` ${body}` : ''}`
          )
        }
        if (response.status === 400 || response.status === 422) {
          return result(
            'model_or_endpoint',
            response.status,
            latencyMs,
            `The provider rejected the request (HTTP ${response.status}). Check the model and endpoint.${body ? ` ${body}` : ''}`
          )
        }
        return result(
          'internal',
          response.status,
          latencyMs,
          `The provider answered HTTP ${response.status}.${body ? ` ${body}` : ''}`
        )
      } catch (error) {
        const latencyMs = now() - startedAt
        const name = error instanceof Error ? error.name : ''
        if (name === 'AbortError' || name === 'TimeoutError') {
          return result('timeout', null, latencyMs, `The provider did not answer within ${timeoutMs} ms.`)
        }
        const message = error instanceof Error ? error.message : String(error)
        return result(
          'unreachable',
          null,
          latencyMs,
          `Could not reach the provider: ${sanitizeProbeMessage(message)}`
        )
      }
    }
  }
}
