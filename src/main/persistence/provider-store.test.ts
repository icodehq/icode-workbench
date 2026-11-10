import { afterEach, describe, expect, it } from 'vitest'
import { ProviderStore } from './provider-store'
import { makeTempRoot, openTempDatabase } from './persistence-test-fixtures'
import { PROVIDER_ID_RE } from '../../shared/domain/ids'
import { DatabaseError, type Database } from './database'
import {
  SecretStorageUnavailableError,
  type SecretCipher
} from '../secrets/secret-cipher'
import type { ProviderCreateInput } from '../../shared/schemas/provider'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function fakeCipher(): SecretCipher {
  return {
    status: () => ({ backend: 'safe_storage', secure: true }),
    encrypt: (plaintext) => ({
      // Base64 is not encryption, but it proves the store writes the cipher's
      // output rather than the plaintext.
      ciphertext: new TextEncoder().encode(Buffer.from(plaintext).toString('base64')),
      scheme: 'safe_storage_v1',
      backend: 'safe_storage'
    }),
    decrypt: ({ ciphertext }) => {
      const value = Buffer.from(ciphertext).toString('utf8')
      return Buffer.from(value, 'base64').toString('utf8')
    }
  }
}

function setup(cipher: SecretCipher = fakeCipher()): { store: ProviderStore; db: Database } {
  const root = makeTempRoot('icode-providers-')
  cleanups.push(root.cleanup)
  const db = openTempDatabase(root)
  cleanups.push(() => db.close())
  return { store: new ProviderStore(db, cipher), db }
}

const CLAUDE: ProviderCreateInput = {
  harness: 'claude',
  name: 'Relay',
  baseUrl: 'https://relay.example.com',
  model: 'claude-sonnet-5',
  apiKey: 'sk-claude',
  authStyle: 'auth_token'
}

describe('provider store', () => {
  it('creates, lists, and selects a provider for its harness', () => {
    const { store } = setup()
    const created = store.createAndSelect(CLAUDE, 1000)

    expect(created.id).toMatch(PROVIDER_ID_RE)
    expect(created).not.toHaveProperty('apiKey')
    expect(store.list()).toEqual([created])
    expect(store.selected('claude')).toMatchObject({
      id: created.id,
      name: 'Relay',
      apiKey: 'sk-claude'
    })
    expect(store.selections()).toEqual([{ harness: 'claude', providerId: created.id }])

    store.select('claude', null, 1002)
    expect(store.selected('claude')).toBeNull()
  })

  it('encrypts the key and never stores plaintext', () => {
    const { store, db } = setup()
    store.create(CLAUDE, 1000)
    const row = db.raw
      .prepare('SELECT api_key_cipher, api_key_scheme, api_key_backend FROM providers')
      .get() as { api_key_cipher: Uint8Array; api_key_scheme: string; api_key_backend: string }

    expect(row.api_key_scheme).toBe('safe_storage_v1')
    expect(row.api_key_backend).toBe('safe_storage')
    expect(Buffer.from(row.api_key_cipher).toString()).not.toContain('sk-claude')
  })

  it('rolls back create-and-select when the name is already taken', () => {
    const { store } = setup()
    store.createAndSelect(CLAUDE, 1000)

    expect(() =>
      store.createAndSelect({ ...CLAUDE, name: 'Relay' }, 1001)
    ).toThrow(/already exists/)
    expect(store.list()).toHaveLength(1)
    expect(store.selections()).toHaveLength(1)
  })

  it('updates fields, keeps a blank key, and replaces a provided key', () => {
    const { store } = setup()
    const created = store.createAndSelect(CLAUDE, 1000)

    const kept = store.update(
      {
        id: created.id,
        harness: 'claude',
        name: 'Relay 2',
        baseUrl: 'https://relay2.example.com',
        model: 'claude-opus-5',
        authStyle: 'api_key'
      },
      1001
    )
    expect(kept).toMatchObject({ name: 'Relay 2', model: 'claude-opus-5', authStyle: 'api_key' })
    expect(store.findLaunchConfig(created.id)?.apiKey).toBe('sk-claude')

    store.update(
      {
        id: created.id,
        harness: 'claude',
        name: 'Relay 2',
        baseUrl: 'https://relay2.example.com',
        model: 'claude-opus-5',
        apiKey: 'sk-new'
      },
      1002
    )
    expect(store.findLaunchConfig(created.id)?.apiKey).toBe('sk-new')
  })

  it('refuses to select a provider that belongs to another harness', () => {
    const { store } = setup()
    const created = store.create(CLAUDE, 1000)
    expect(() => store.select('codex', created.id, 1001)).toThrow(/another harness/)
  })

  it('refuses to delete the selected provider', () => {
    const { store } = setup()
    const created = store.createAndSelect(CLAUDE, 1000)
    expect(() => store.remove(created.id)).toThrow(/selected provider cannot be removed/)

    store.select('claude', null, 1001)
    store.remove(created.id)
    expect(store.list()).toEqual([])
  })

  it('rejects a corrupt provider row without exposing it', () => {
    const { store, db } = setup()
    db.raw.exec('PRAGMA ignore_check_constraints = ON')
    db.raw
      .prepare(
        `INSERT INTO providers
           (id, harness, name, base_url, model, auth_style,
            api_key_cipher, api_key_scheme, api_key_backend, created_at, updated_at)
         VALUES (?, 'claude', 'Broken', 'https://x', 'm', 'auth_token', ?, 'other', 'safe_storage', 1, 1)`
      )
      .run('prv_00000000-0000-4000-8000-000000000001', new Uint8Array([1]))
    db.raw.exec('PRAGMA ignore_check_constraints = OFF')

    expect(() => store.list()).toThrow(DatabaseError)
  })

  it('surfaces an unavailable key store and refuses to write', () => {
    const unavailable: SecretCipher = {
      status: () => ({ backend: 'unavailable', secure: false }),
      encrypt: () => {
        throw new SecretStorageUnavailableError()
      },
      decrypt: () => {
        throw new Error('unavailable')
      }
    }
    const { store } = setup(unavailable)
    expect(() => store.create(CLAUDE, 1000)).toThrow(SecretStorageUnavailableError)
  })

  it('maps a duplicate provider name to an invalid-argument error', () => {
    const { store } = setup()
    store.create(CLAUDE, 1000)
    expect(() => store.create(CLAUDE, 1001)).toThrow(/already exists/)
  })
})
