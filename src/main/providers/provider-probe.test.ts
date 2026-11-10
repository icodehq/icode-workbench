import { describe, expect, it } from 'vitest'
import { createProviderProbe, type FetchLike } from './provider-probe'
import type { ProviderLaunchInput } from '../../shared/provider-launch'

type Recorded = { url: string; init: RequestInit }

function fetcher(
  handler: (record: Recorded) => Response | Promise<Response>
): { fetch: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = []
  return {
    calls,
    fetch: async (url, init) => {
      const record = { url, init }
      calls.push(record)
      return handler(record)
    }
  }
}

const claude: ProviderLaunchInput = {
  harness: 'claude',
  baseUrl: 'https://relay.example.com',
  model: 'claude-sonnet-5',
  authStyle: 'auth_token',
  apiKey: 'sk-test'
}

function body(record: Recorded): Record<string, unknown> {
  return JSON.parse(String(record.init.body)) as Record<string, unknown>
}

describe('provider probe', () => {
  it('probes Claude with the Anthropic Messages shape', async () => {
    const fake = fetcher(() => new Response('{}', { status: 200 }))
    const probe = createProviderProbe({ fetch: fake.fetch, now: () => 10 })
    const result = await probe.test(claude)

    expect(result).toMatchObject({ ok: true, code: 'ok', status: 200 })
    expect(fake.calls[0]!.url).toBe('https://relay.example.com/v1/messages')
    const headers = fake.calls[0]!.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-test')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(body(fake.calls[0]!)).toMatchObject({ model: 'claude-sonnet-5', max_tokens: 1 })
  })

  it('uses x-api-key for an Anthropic API-key provider', async () => {
    const fake = fetcher(() => new Response('{}', { status: 200 }))
    const probe = createProviderProbe({ fetch: fake.fetch })
    await probe.test({ ...claude, authStyle: 'api_key' })
    const headers = fake.calls[0]!.init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-test')
    expect(headers.authorization).toBeUndefined()
  })

  it('does not double /v1 in Codex and OpenCode bases', async () => {
    const fake = fetcher(() => new Response('{}', { status: 200 }))
    const probe = createProviderProbe({ fetch: fake.fetch })

    await probe.test({ ...claude, harness: 'codex', authStyle: null, baseUrl: 'https://api.openai.com/v1' })
    await probe.test({ ...claude, harness: 'opencode', authStyle: null, baseUrl: 'https://api.deepseek.com/v1' })

    expect(fake.calls[0]!.url).toBe('https://api.openai.com/v1/responses')
    expect(fake.calls[1]!.url).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(body(fake.calls[0]!)).toMatchObject({ model: 'claude-sonnet-5', max_output_tokens: 1 })
    expect(body(fake.calls[1]!)).toMatchObject({ model: 'claude-sonnet-5', max_tokens: 1 })
  })

  it('maps auth failures and redacts the key from the response body', async () => {
    const fake = fetcher(
      () =>
        new Response('bad sk-secret123 Bearer abc123', {
          status: 401
        })
    )
    const probe = createProviderProbe({ fetch: fake.fetch })
    const result = await probe.test(claude)

    expect(result.code).toBe('auth_failed')
    expect(result.status).toBe(401)
    expect(result.message).not.toContain('sk-secret123')
    expect(result.message).not.toContain('abc123')
  })

  it('maps a missing endpoint to a model/endpoint failure', async () => {
    const fake = fetcher(() => new Response('not found', { status: 404 }))
    const probe = createProviderProbe({ fetch: fake.fetch })
    expect((await probe.test(claude)).code).toBe('model_or_endpoint')
  })

  it('maps a timeout', async () => {
    const fake = fetcher(() => {
      const error = new Error('timed out')
      error.name = 'TimeoutError'
      throw error
    })
    const probe = createProviderProbe({ fetch: fake.fetch, timeoutMs: 1 })
    expect((await probe.test(claude)).code).toBe('timeout')
  })

  it('maps a network failure to unreachable', async () => {
    const fake = fetcher(() => {
      throw new Error('ECONNREFUSED')
    })
    const probe = createProviderProbe({ fetch: fake.fetch })
    const result = await probe.test(claude)
    expect(result.code).toBe('unreachable')
    expect(result.message).toContain('ECONNREFUSED')
  })
})
