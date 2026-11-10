import type { Database } from './database'
import { DatabaseError } from './database'
import { makeAppError } from '../../shared/domain/errors'
import { newProviderRowId, PROVIDER_AUTH_STYLES } from '../../shared/schemas/provider'
import type {
  ProviderAuthStyle,
  ProviderCreateInput,
  ProviderHarness,
  ProviderSecretStorage,
  ProviderSelectionPayload,
  ProviderUpdateInput,
  ProviderViewPayload
} from '../../shared/schemas/provider'
import type { SecretCipher } from '../secrets/secret-cipher'
import { SecretUnreadableError } from '../secrets/secret-cipher'
import { parseProviderId } from '../../shared/domain/ids'

/** Main-process only: this carries the decrypted key and must never cross IPC. */
export type ProviderLaunchConfig = ProviderViewPayload & { apiKey: string }

type ProviderRow = {
  id: unknown
  harness: unknown
  name: unknown
  base_url: unknown
  model: unknown
  auth_style: unknown
  api_key_cipher: unknown
  api_key_scheme: unknown
  api_key_backend: unknown
  created_at: unknown
  updated_at: unknown
}

type SelectionRow = {
  harness: unknown
  provider_id: unknown
}

type StoredProvider = ProviderViewPayload & {
  ciphertext: Uint8Array
  scheme: 'safe_storage_v1'
  backend: 'safe_storage' | 'basic_text'
}

const HARNESSES: readonly ProviderHarness[] = ['claude', 'codex', 'opencode']
const BACKENDS: readonly ('safe_storage' | 'basic_text')[] = ['safe_storage', 'basic_text']

function corrupt(column: string): never {
  throw new DatabaseError(
    makeAppError('DB_CORRUPT', 'A provider row in the database is invalid.', {
      detail: `providers.${column} has an unexpected value. The database was not modified.`
    })
  )
}

function requireString(value: unknown, column: string): string {
  if (typeof value !== 'string' || value.length === 0) corrupt(column)
  return value
}

function requireInteger(value: unknown, column: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) corrupt(column)
  return value
}

function requireBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array && value.length > 0) return value
  // node:sqlite has returned Buffer in some versions; Buffer is a Uint8Array.
  if (Buffer.isBuffer(value) && value.length > 0) return new Uint8Array(value)
  corrupt('api_key_cipher')
}

function providerFromRow(row: ProviderRow): StoredProvider {
  const rawId = requireString(row.id, 'id')
  const id = parseProviderId(rawId)
  if (id === null) corrupt('id')
  const harness = requireString(row.harness, 'harness')
  if (!HARNESSES.includes(harness as ProviderHarness)) corrupt('harness')
  const authStyle =
    row.auth_style === null
      ? null
      : requireString(row.auth_style, 'auth_style')
  if (
    authStyle !== null &&
    !PROVIDER_AUTH_STYLES.includes(authStyle as ProviderAuthStyle)
  ) {
    corrupt('auth_style')
  }
  if (harness !== 'claude' && authStyle !== null) corrupt('auth_style')
  if (harness === 'claude' && authStyle === null) corrupt('auth_style')
  const scheme = requireString(row.api_key_scheme, 'api_key_scheme')
  if (scheme !== 'safe_storage_v1') corrupt('api_key_scheme')
  const backend = requireString(row.api_key_backend, 'api_key_backend')
  if (!BACKENDS.includes(backend as 'safe_storage' | 'basic_text')) {
    corrupt('api_key_backend')
  }
  return {
    id,
    harness: harness as ProviderHarness,
    name: requireString(row.name, 'name'),
    baseUrl: requireString(row.base_url, 'base_url'),
    model: requireString(row.model, 'model'),
    authStyle: authStyle as ProviderAuthStyle | null,
    createdAt: requireInteger(row.created_at, 'created_at'),
    updatedAt: requireInteger(row.updated_at, 'updated_at'),
    ciphertext: requireBytes(row.api_key_cipher),
    scheme: 'safe_storage_v1',
    backend: backend as 'safe_storage' | 'basic_text'
  }
}

function selectionFromRow(row: SelectionRow): ProviderSelectionPayload {
  const harness = requireString(row.harness, 'harness')
  if (!HARNESSES.includes(harness as ProviderHarness)) corrupt('harness')
  const providerId = row.provider_id
  if (providerId === null) return { harness: harness as ProviderHarness, providerId: null }
  if (typeof providerId !== 'string' || parseProviderId(providerId) === null) {
    corrupt('provider_id')
  }
  return { harness: harness as ProviderHarness, providerId }
}

function toView(provider: StoredProvider): ProviderViewPayload {
  return {
    id: provider.id,
    harness: provider.harness,
    name: provider.name,
    baseUrl: provider.baseUrl,
    model: provider.model,
    authStyle: provider.authStyle,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt
  }
}

function uniqueNameError(): DatabaseError {
  return new DatabaseError(
    makeAppError('INVALID_ARGUMENT', 'A provider with this name already exists for this harness.', {
      detail: 'Choose another name, or edit the existing provider.'
    })
  )
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed: providers\.harness, providers\.name/iu.test(error.message)
  )
}

/**
 * Provider rows and per-harness selection.
 *
 * The store owns the cipher: keys are encrypted on write and decrypted only for
 * a launch or a connection probe. Every renderer-facing method returns a view
 * without the ciphertext.
 *
 * Selection is resolved on launch, not cached. A running PTY keeps the
 * environment it started with; editing or switching a provider applies to the
 * next create/restart.
 */
export class ProviderStore {
  constructor(
    private readonly db: Database,
    private readonly cipher: SecretCipher
  ) {
    this.assertProviderSchema()
  }

  /**
   * Prototype dev databases used a plaintext `api_key` column and version 13.
   * They never shipped. Fail with a remedy instead of a SQLite "no such column".
   */
  private assertProviderSchema(): void {
    let columns: Array<{ name?: unknown }>
    try {
      columns = this.db.raw.prepare("PRAGMA table_info('providers')").all() as Array<{
        name?: unknown
      }>
    } catch (error) {
      throw new DatabaseError(
        makeAppError('DB_CORRUPT', 'The provider table cannot be read.', {
          detail: error instanceof Error ? error.message : String(error)
        }),
        { cause: error }
      )
    }
    const names = columns
      .map((column) => column.name)
      .filter((name): name is string => typeof name === 'string')
    if (names.length === 0) {
      throw new DatabaseError(
        makeAppError('DB_CORRUPT', 'The provider table is missing; migrations did not run.')
      )
    }
    if (names.includes('api_key') && !names.includes('api_key_cipher')) {
      throw new DatabaseError(
        makeAppError('DB_CORRUPT', 'This development database predates encrypted provider storage.', {
          detail:
            'It contains only prototype provider data. Delete the iCode database and restart to create the final schema.',
          context: { path: this.db.path }
        })
      )
    }
    if (!names.includes('api_key_cipher')) {
      throw new DatabaseError(
        makeAppError('DB_CORRUPT', 'The provider table has an unexpected shape.', {
          context: { path: this.db.path }
        })
      )
    }
  }

  list(): ProviderViewPayload[] {
    const rows = this.db.raw
      .prepare(
        `SELECT id, harness, name, base_url, model, auth_style,
                api_key_cipher, api_key_scheme, api_key_backend,
                created_at, updated_at
         FROM providers
         ORDER BY harness, created_at, id`
      )
      .all() as ProviderRow[]
    return rows.map((row) => toView(providerFromRow(row)))
  }

  findById(id: string): ProviderViewPayload | null {
    const row = this.db.raw
      .prepare(
        `SELECT id, harness, name, base_url, model, auth_style,
                api_key_cipher, api_key_scheme, api_key_backend,
                created_at, updated_at
         FROM providers WHERE id = ?`
      )
      .get(id) as ProviderRow | undefined
    return row === undefined ? null : toView(providerFromRow(row))
  }

  /** Main-process only. Used by the launch resolver and the connection probe. */
  findLaunchConfig(id: string): ProviderLaunchConfig | null {
    const row = this.db.raw
      .prepare(
        `SELECT id, harness, name, base_url, model, auth_style,
                api_key_cipher, api_key_scheme, api_key_backend,
                created_at, updated_at
         FROM providers WHERE id = ?`
      )
      .get(id) as ProviderRow | undefined
    if (row === undefined) return null
    return this.toLaunchConfig(providerFromRow(row))
  }

  selections(): ProviderSelectionPayload[] {
    const rows = this.db.raw
      .prepare('SELECT harness, provider_id FROM harness_provider_selection ORDER BY harness')
      .all() as SelectionRow[]
    return rows.map(selectionFromRow)
  }

  storageStatus(): ProviderSecretStorage {
    return this.cipher.status()
  }

  create(input: ProviderCreateInput, now: number): ProviderViewPayload {
    return this.insert(input, now)
  }

  /** Insert and select in one transaction: a failure cannot leave an orphan. */
  createAndSelect(input: ProviderCreateInput, now: number): ProviderViewPayload {
    return this.db.transaction(() => {
      const created = this.insert(input, now)
      this.select(input.harness, created.id, now)
      return created
    })
  }

  update(input: ProviderUpdateInput, now: number): ProviderViewPayload {
    const existing = this.findById(input.id)
    if (existing === null) {
      throw new DatabaseError(
        makeAppError('INVALID_ARGUMENT', 'The provider does not exist.', {
          context: { providerId: input.id }
        })
      )
    }
    if (existing.harness !== input.harness) {
      throw new DatabaseError(
        makeAppError('INVALID_ARGUMENT', 'A provider cannot change harnesses.')
      )
    }
    const authStyle =
      input.harness === 'claude'
        ? (input.authStyle ?? existing.authStyle ?? 'auth_token')
        : null
    const ciphertext =
      input.apiKey === undefined
        ? this.cipherTextOf(input.id)
        : this.encrypt(input.apiKey)
    try {
      this.db.raw
        .prepare(
          `UPDATE providers
           SET name = ?, base_url = ?, model = ?, auth_style = ?,
               api_key_cipher = ?, api_key_scheme = ?, api_key_backend = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run(
          input.name,
          input.baseUrl,
          input.model,
          authStyle,
          ciphertext.cipher,
          ciphertext.scheme,
          ciphertext.backend,
          now,
          input.id
        )
    } catch (error) {
      if (isUniqueViolation(error)) throw uniqueNameError()
      throw new DatabaseError(
        makeAppError('INTERNAL', 'The provider could not be updated.', {
          detail: error instanceof Error ? error.message : String(error)
        }),
        { cause: error }
      )
    }
    return this.requireView(input.id)
  }

  remove(id: string): void {
    const selected = this.db.raw
      .prepare('SELECT 1 AS present FROM harness_provider_selection WHERE provider_id = ?')
      .get(id) as { present?: unknown } | undefined
    if (selected !== undefined) {
      throw new DatabaseError(
        makeAppError('INVALID_ARGUMENT', 'The selected provider cannot be removed.', {
          detail: 'Choose Native configuration or another provider for this harness first.'
        })
      )
    }
    try {
      this.db.raw.prepare('DELETE FROM providers WHERE id = ?').run(id)
    } catch (error) {
      throw new DatabaseError(
        makeAppError('INTERNAL', 'The provider could not be removed.', {
          detail: error instanceof Error ? error.message : String(error)
        }),
        { cause: error }
      )
    }
  }

  select(harness: ProviderHarness, providerId: string | null, now: number): void {
    if (providerId !== null) {
      const provider = this.findById(providerId)
      if (provider === null) {
        throw new DatabaseError(
          makeAppError('INVALID_ARGUMENT', 'The selected provider does not exist.', {
            context: { providerId }
          })
        )
      }
      if (provider.harness !== harness) {
        throw new DatabaseError(
          makeAppError('INVALID_ARGUMENT', 'The provider belongs to another harness.', {
            context: { harness, providerId }
          })
        )
      }
    }
    try {
      this.db.raw
        .prepare(
          `INSERT INTO harness_provider_selection (harness, provider_id, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(harness) DO UPDATE SET
             provider_id = excluded.provider_id,
             updated_at = excluded.updated_at`
        )
        .run(harness, providerId, now)
    } catch (error) {
      throw new DatabaseError(
        makeAppError('INTERNAL', 'The provider selection could not be stored.', {
          detail: error instanceof Error ? error.message : String(error)
        }),
        { cause: error }
      )
    }
  }

  /** The provider a harness should launch with, decrypted for main only. */
  selected(harness: ProviderHarness): ProviderLaunchConfig | null {
    const row = this.db.raw
      .prepare(
        `SELECT p.id, p.harness, p.name, p.base_url, p.model, p.auth_style,
                p.api_key_cipher, p.api_key_scheme, p.api_key_backend,
                p.created_at, p.updated_at
         FROM harness_provider_selection s
         JOIN providers p ON p.id = s.provider_id
         WHERE s.harness = ?`
      )
      .get(harness) as ProviderRow | undefined
    if (row === undefined) return null
    const config = this.toLaunchConfig(providerFromRow(row))
    return config.harness === harness ? config : null
  }

  private insert(input: ProviderCreateInput, now: number): ProviderViewPayload {
    const id = newProviderRowId()
    const authStyle = input.harness === 'claude' ? (input.authStyle ?? 'auth_token') : null
    const ciphertext = this.encrypt(input.apiKey)
    try {
      this.db.raw
        .prepare(
          `INSERT INTO providers
             (id, harness, name, base_url, model, auth_style,
              api_key_cipher, api_key_scheme, api_key_backend, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.harness,
          input.name,
          input.baseUrl,
          input.model,
          authStyle,
          ciphertext.cipher,
          ciphertext.scheme,
          ciphertext.backend,
          now,
          now
        )
    } catch (error) {
      if (isUniqueViolation(error)) throw uniqueNameError()
      throw new DatabaseError(
        makeAppError('INTERNAL', 'The provider could not be stored.', {
          detail: error instanceof Error ? error.message : String(error)
        }),
        { cause: error }
      )
    }
    return this.requireView(id)
  }

  private requireView(id: string): ProviderViewPayload {
    const view = this.findById(id)
    if (view === null) {
      throw new DatabaseError(makeAppError('DB_CORRUPT', 'The provider row disappeared after writing.'))
    }
    return view
  }

  private encrypt(plaintext: string): {
    cipher: Uint8Array
    scheme: 'safe_storage_v1'
    backend: 'safe_storage' | 'basic_text'
  } {
    const encrypted = this.cipher.encrypt(plaintext)
    return {
      cipher: encrypted.ciphertext,
      scheme: encrypted.scheme,
      backend: encrypted.backend
    }
  }

  private cipherTextOf(id: string): {
    cipher: Uint8Array
    scheme: 'safe_storage_v1'
    backend: 'safe_storage' | 'basic_text'
  } {
    const row = this.db.raw
      .prepare('SELECT api_key_cipher, api_key_scheme, api_key_backend FROM providers WHERE id = ?')
      .get(id) as
      | { api_key_cipher: unknown; api_key_scheme: unknown; api_key_backend: unknown }
      | undefined
    if (row === undefined) {
      throw new DatabaseError(makeAppError('INVALID_ARGUMENT', 'The provider does not exist.'))
    }
    const scheme = requireString(row.api_key_scheme, 'api_key_scheme')
    if (scheme !== 'safe_storage_v1') corrupt('api_key_scheme')
    const backend = requireString(row.api_key_backend, 'api_key_backend')
    if (!BACKENDS.includes(backend as 'safe_storage' | 'basic_text')) corrupt('api_key_backend')
    return {
      cipher: requireBytes(row.api_key_cipher),
      scheme: 'safe_storage_v1',
      backend: backend as 'safe_storage' | 'basic_text'
    }
  }

  private toLaunchConfig(provider: StoredProvider): ProviderLaunchConfig {
    let apiKey: string
    try {
      apiKey = this.cipher.decrypt({
        ciphertext: provider.ciphertext,
        backend: provider.backend
      })
    } catch (error) {
      if (error instanceof SecretUnreadableError) {
        throw new DatabaseError(
          makeAppError('INVALID_ARGUMENT', 'The stored API key cannot be read on this machine.', {
            detail: 'Re-enter the API key in Settings.',
            context: { providerId: provider.id }
          }),
          { cause: error }
        )
      }
      throw error
    }
    return { ...toView(provider), apiKey }
  }
}
