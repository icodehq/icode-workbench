import { describe, expect, it } from 'vitest'
import {
  providerCreateInputSchema,
  providerListResultSchema,
  providerViewSchema
} from './provider'

const base = {
  name: 'Relay',
  baseUrl: 'https://relay.example.com',
  model: 'claude-sonnet-5',
  apiKey: 'sk-test'
}

describe('provider schemas', () => {
  it('defaults Claude auth to the bearer token form', () => {
    const parsed = providerCreateInputSchema.parse({ ...base, harness: 'claude' })
    expect(parsed).toMatchObject({ harness: 'claude', authStyle: 'auth_token' })
  })

  it('rejects a Claude auth style on other harnesses', () => {
    expect(() =>
      providerCreateInputSchema.parse({ ...base, harness: 'codex', authStyle: 'auth_token' })
    ).toThrow()
  })

  it('rejects credentials embedded in the endpoint', () => {
    expect(() =>
      providerCreateInputSchema.parse({
        ...base,
        harness: 'claude',
        baseUrl: 'https://user:pass@relay.example.com'
      })
    ).toThrow()
  })

  it('the renderer view has no key field', () => {
    expect(
      providerViewSchema.safeParse({
        id: 'prv_00000000-0000-4000-8000-000000000001',
        harness: 'claude',
        name: 'Relay',
        baseUrl: 'https://relay.example.com',
        model: 'claude-sonnet-5',
        authStyle: 'auth_token',
        createdAt: 1,
        updatedAt: 1,
        apiKey: 'sk-test'
      }).success
    ).toBe(false)
  })

  it('the list payload carries the storage status but no key', () => {
    const parsed = providerListResultSchema.parse({
      providers: [
        {
          id: 'prv_00000000-0000-4000-8000-000000000001',
          harness: 'claude',
          name: 'Relay',
          baseUrl: 'https://relay.example.com',
          model: 'claude-sonnet-5',
          authStyle: 'auth_token',
          createdAt: 1,
          updatedAt: 1
        }
      ],
      selections: [{ harness: 'claude', providerId: null }],
      secretStorage: { backend: 'safe_storage', secure: true }
    })
    expect(parsed.providers[0]).not.toHaveProperty('apiKey')
  })
})
