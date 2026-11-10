/**
 * API-key encryption at rest.
 *
 * Electron's `safeStorage` is the only backend. It is described through a
 * narrow interface so tests (and the store) never import Electron:
 *
 *   Linux    libsecret / kwallet, or `basic_text` when no keyring is available
 *   macOS    Keychain
 *   Windows  DPAPI
 *
 * `basic_text` is obfuscation, not encryption. We still use it (the provider
 * must remain usable on a headless Linux box) but report it, so Settings can
 * warn instead of claiming protection it does not have.
 */

export type SecretBackend = 'safe_storage' | 'basic_text'

export type SecretStatus = {
  backend: SecretBackend | 'unavailable'
  /** False for `basic_text` and `unavailable`. */
  secure: boolean
}

export type EncryptedSecret = {
  ciphertext: Uint8Array
  scheme: 'safe_storage_v1'
  backend: SecretBackend
}

export type SecretCipher = {
  status(): SecretStatus
  encrypt(plaintext: string): EncryptedSecret
  decrypt(secret: Pick<EncryptedSecret, 'ciphertext' | 'backend'>): string
}

/** Minimal surface of Electron's `safeStorage`. */
export type SafeStorageLike = {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(plaintext: string): Buffer
  decryptString(ciphertext: Buffer): string
}

export class SecretStorageUnavailableError extends Error {
  constructor() {
    super(
      'The operating system key store is unavailable, so iCode cannot save an API key. Unlock the keyring (or run in a graphical session) and try again.'
    )
    this.name = 'SecretStorageUnavailableError'
  }
}

export class SecretUnreadableError extends Error {
  constructor(cause?: unknown) {
    super(
      'The stored API key cannot be decrypted on this machine. Re-enter the key in Settings; if the OS keyring changed, the previous value is unrecoverable.'
    )
    this.name = 'SecretUnreadableError'
    this.cause = cause
  }
}

function selectedBackend(storage: SafeStorageLike): SecretBackend {
  let raw: string | null = null
  try {
    raw = storage.getSelectedStorageBackend?.() ?? null
  } catch {
    raw = null
  }
  return raw === 'basic_text' ? 'basic_text' : 'safe_storage'
}

export function createSafeStorageCipher(storage: SafeStorageLike): SecretCipher {
  function status(): SecretStatus {
    try {
      if (!storage.isEncryptionAvailable()) {
        return { backend: 'unavailable', secure: false }
      }
    } catch {
      return { backend: 'unavailable', secure: false }
    }
    const backend = selectedBackend(storage)
    return { backend, secure: backend !== 'basic_text' }
  }

  return {
    status,
    encrypt(plaintext: string): EncryptedSecret {
      const current = status()
      if (current.backend === 'unavailable') throw new SecretStorageUnavailableError()
      let encrypted: Buffer
      try {
        encrypted = storage.encryptString(plaintext)
      } catch (error) {
        throw new SecretStorageUnavailableError()
      }
      const backend = current.backend
      return {
        ciphertext: new Uint8Array(encrypted),
        scheme: 'safe_storage_v1',
        backend
      }
    },
    decrypt(secret): string {
      try {
        return storage.decryptString(Buffer.from(secret.ciphertext))
      } catch (error) {
        throw new SecretUnreadableError(error)
      }
    }
  }
}
