import { describe, expect, it } from 'vitest'
import {
  SecretStorageUnavailableError,
  SecretUnreadableError,
  createSafeStorageCipher,
  type SafeStorageLike
} from './secret-cipher'

function storage(overrides: Partial<SafeStorageLike> = {}): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'keychain',
    encryptString: (plaintext) => Buffer.from(`enc:${Buffer.from(plaintext).toString('base64')}`),
    decryptString: (ciphertext) => {
      const value = ciphertext.toString('utf8')
      if (!value.startsWith('enc:')) throw new Error('unreadable')
      return Buffer.from(value.slice(4), 'base64').toString('utf8')
    },
    ...overrides
  }
}

describe('secret cipher', () => {
  it('round-trips through a secure backend without storing plaintext', () => {
    const cipher = createSafeStorageCipher(storage())
    expect(cipher.status()).toEqual({ backend: 'safe_storage', secure: true })
    const encrypted = cipher.encrypt('sk-secret')
    expect(Buffer.from(encrypted.ciphertext).toString()).not.toContain('sk-secret')
    expect(cipher.decrypt(encrypted)).toBe('sk-secret')
  })

  it('reports basic_text as insecure but still round-trips', () => {
    const cipher = createSafeStorageCipher(
      storage({ getSelectedStorageBackend: () => 'basic_text' })
    )
    expect(cipher.status()).toEqual({ backend: 'basic_text', secure: false })
    const encrypted = cipher.encrypt('sk-secret')
    expect(encrypted.backend).toBe('basic_text')
    expect(cipher.decrypt(encrypted)).toBe('sk-secret')
  })

  it('refuses to encrypt when no key store is available', () => {
    const cipher = createSafeStorageCipher(storage({ isEncryptionAvailable: () => false }))
    expect(cipher.status()).toEqual({ backend: 'unavailable', secure: false })
    expect(() => cipher.encrypt('sk-secret')).toThrow(SecretStorageUnavailableError)
  })

  it('fails decryption without leaking the ciphertext', () => {
    const cipher = createSafeStorageCipher(
      storage({ decryptString: () => { throw new Error('keyring changed') } })
    )
    let error: unknown
    try {
      cipher.decrypt({
        ciphertext: new TextEncoder().encode('opaque'),
        backend: 'safe_storage'
      })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(SecretUnreadableError)
    expect(String(error)).not.toContain('opaque')
  })
})
