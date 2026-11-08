import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { makeAppError, type AppError } from '../../shared/domain/errors'

export const SCHEMA_VERSION = 10
export const BUSY_TIMEOUT_MS = 5000

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'binary')

export type PersistenceFailure = {
  error: AppError
  cause?: unknown
}

export class DatabaseError extends Error {
  constructor(
    readonly appError: AppError,
    options: { cause?: unknown } = {}
  ) {
    super(appError.message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DatabaseError'
  }
}

export type DatabaseOptions = {
  path: string
  /** Test seam: override migration steps. Production uses the approved schema. */
  migrations?: readonly Migration[]
  busyTimeoutMs?: number
}

export type Migration = {
  version: number
  name: string
  statements: readonly string[]
  /**
   * Rebuild a table that other tables reference with `REFERENCES ... ON DELETE
   * CASCADE`.
   *
   * Why this exists: with `foreign_keys = ON`, SQLite's `DROP TABLE` performs an
   * implicit `DELETE`, which fires the cascade and empties every child table.
   * Measured on this schema, rebuilding `repos` that way deleted all workspaces
   * and sessions. `PRAGMA foreign_keys` cannot be changed inside a transaction,
   * and `defer_foreign_keys` does not suppress the *actions*, so the pragma has
   * to be lifted around the transaction.
   *
   * The transaction and its rollback guarantee are unchanged; only the
   * enforcement window moves. `PRAGMA foreign_key_check` runs before COMMIT, so a
   * rebuild that orphans a row still rolls back, and the pragma is restored in a
   * `finally` so a failed migration cannot leave the connection unprotected.
   */
  rebuildsReferencedTable?: boolean
}

export type Database = {
  readonly path: string
  readonly raw: DatabaseSync
  close(): void
  isClosed(): boolean
  transaction<T>(work: () => T): T
  userVersion(): number
  pragmaValue(name: string): unknown
  assertHealthy(): void
}

const DEFAULT_PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA synchronous = NORMAL'
] as const

function corrupt(path: string, detail: string, cause?: unknown): DatabaseError {
  return new DatabaseError(
    makeAppError('DB_CORRUPT', 'The iCode database cannot be read safely.', {
      detail: `${detail} Database preserved at ${path}. Close iCode, back up this file, then remove or repair it manually.`,
      context: { path }
    }),
    { cause }
  )
}

/**
 * Opening SQLite can itself touch the file, so refuse files that do not even
 * carry the SQLite header before SQLite sees them. The file is never deleted,
 * renamed, or recreated on any failure path.
 */
function assertSqliteHeader(path: string): void {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const header = Buffer.alloc(16)
    const read = readSync(fd, header, 0, 16, 0)
    if (read < 16 || !header.equals(SQLITE_MAGIC)) {
      throw corrupt(path, 'The file does not have a SQLite header.')
    }
  } catch (error) {
    if (error instanceof DatabaseError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') {
      throw new DatabaseError(
        makeAppError('INTERNAL', 'The iCode database cannot be read with the current permissions.', {
          detail: 'Fix the file or directory permissions; the database was not modified.',
          context: { path }
        }),
        { cause: error }
      )
    }
    throw corrupt(path, 'The database file could not be read.', error)
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function openForIntegrityCheck(path: string): 'checked' | 'readonly_conflict' {
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(path, { readOnly: true })
    const result = db.prepare('PRAGMA integrity_check').get() as
      | { integrity_check?: string }
      | undefined
    if (result?.integrity_check !== 'ok') {
      throw corrupt(
        path,
        `SQLite integrity check reported ${String(result?.integrity_check ?? 'no result')}.`
      )
    }
    return 'checked'
  } catch (error) {
    if (error instanceof DatabaseError) throw error
    const message = error instanceof Error ? error.message : String(error)
    // A read-only connection cannot always inspect a WAL left by a crash. The
    // writable open below runs the same integrity check before any write.
    if (/unable to open|readonly|read-only|cantopen/i.test(message)) return 'readonly_conflict'
    throw corrupt(path, 'SQLite could not verify the database file.', error)
  } finally {
    try {
      db?.close()
    } catch {
      // a failed inspection must not mask the original failure
    }
  }
}

function openWritable(path: string, busyTimeoutMs: number): DatabaseSync {
  try {
    return new DatabaseSync(path, { timeout: busyTimeoutMs })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/not a database|malformed|corrupt/i.test(message)) {
      throw corrupt(path, 'SQLite could not open the database file.', error)
    }
    throw new DatabaseError(
      makeAppError('INTERNAL', 'The iCode database could not be opened.', {
        detail: message,
        context: { path }
      }),
      { cause: error }
    )
  }
}

function verifyPragmas(db: DatabaseSync): void {
  const journal = db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string }
  if (String(journal.journal_mode).toLowerCase() !== 'wal') {
    throw new DatabaseError(
      makeAppError('INTERNAL', 'The database could not be put in WAL mode.', {
        detail: `journal_mode=${String(journal.journal_mode)}`
      })
    )
  }
  const foreignKeys = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys?: number }
  if (Number(foreignKeys.foreign_keys) !== 1) {
    throw new DatabaseError(makeAppError('INTERNAL', 'Foreign key enforcement is not enabled.'))
  }
  const synchronous = db.prepare('PRAGMA synchronous').get() as { synchronous?: number }
  // 1 = NORMAL
  if (Number(synchronous.synchronous) !== 1) {
    throw new DatabaseError(
      makeAppError('INTERNAL', 'The database synchronous mode is not NORMAL.', {
        detail: `synchronous=${String(synchronous.synchronous)}`
      })
    )
  }
  const busy = db.prepare('PRAGMA busy_timeout').get() as { timeout?: number }
  if (Number(busy.timeout) <= 0) {
    throw new DatabaseError(makeAppError('INTERNAL', 'The database busy timeout is not set.'))
  }
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  return Number(row?.user_version ?? 0)
}

function applyTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const value = work()
    db.exec('COMMIT')
    return value
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // rollback can fail only if SQLite already rolled back; never mask the cause
    }
    throw error
  }
}

export type MigrationFailure = {
  fromVersion: number
  targetVersion: number
  migrationName: string
  cause: unknown
}

export function runMigrations(db: DatabaseSync, migrations: readonly Migration[]): number {
  const ordered = [...migrations].sort((a, b) => a.version - b.version)
  for (const migration of ordered) {
    if (!Number.isInteger(migration.version) || migration.version < 1) {
      throw new Error(`Invalid migration version: ${String(migration.version)}`)
    }
    if (migration.statements.length === 0) {
      throw new Error(`Migration ${migration.version} has no statements`)
    }
  }
  const current = readUserVersion(db)
  const pending = ordered.filter((migration) => migration.version > current)
  if (pending.length === 0) return current

  // Validate the whole chain before writing so a gap can never partially apply.
  let expected = current + 1
  for (const migration of pending) {
    if (migration.version !== expected) {
      throw new Error(`Migration gap: expected version ${expected}, found ${migration.version}`)
    }
    expected += 1
  }

  for (const migration of pending) {
    const fromVersion = readUserVersion(db)
    const rebuild = migration.rebuildsReferencedTable === true
    // Why outside the transaction: SQLite ignores this pragma inside one.
    if (rebuild) db.exec('PRAGMA foreign_keys = OFF')
    try {
      // One transaction per migration: a failed step leaves the previous
      // version fully committed and never leaves partial schema behind.
      applyTransaction(db, () => {
        for (const statement of migration.statements) db.exec(statement)
        if (rebuild) {
          // Refuse to commit a rebuild that orphaned a child row.
          const violations = db.prepare('PRAGMA foreign_key_check').all() as unknown[]
          if (violations.length > 0) {
            throw new Error(
              `Rebuild left ${violations.length} foreign-key violation(s); refusing to commit`
            )
          }
        }
        db.exec(`PRAGMA user_version = ${migration.version}`)
      })
    } catch (error) {
      throw new MigrationFailureError(
        {
          fromVersion,
          targetVersion: migration.version,
          migrationName: migration.name,
          cause: error
        },
        error
      )
    } finally {
      if (rebuild) db.exec('PRAGMA foreign_keys = ON')
    }
    const after = readUserVersion(db)
    if (after !== migration.version) {
      throw new MigrationFailureError(
        {
          fromVersion,
          targetVersion: migration.version,
          migrationName: migration.name,
          cause: new Error(`user_version is ${after} after migration`)
        },
        new Error('Migration did not commit the expected version')
      )
    }
  }
  return readUserVersion(db)
}

export class MigrationFailureError extends Error {
  constructor(
    readonly detail: MigrationFailure,
    cause: unknown
  ) {
    super(
      `Migration ${detail.migrationName} failed; database left at version ${detail.fromVersion}`,
      { cause }
    )
    this.name = 'MigrationFailureError'
  }

  toDatabaseError(path: string): DatabaseError {
    return new DatabaseError(
      makeAppError('DB_CORRUPT', 'The iCode database could not be migrated safely.', {
        detail: `Migration "${this.detail.migrationName}" failed; user_version remains ${this.detail.fromVersion}. Back up and repair the database at ${path} before retrying.`,
        context: { path, migration: this.detail.migrationName }
      }),
      { cause: this.detail.cause }
    )
  }
}

export function openDatabase(options: DatabaseOptions): Database {
  const { path, busyTimeoutMs = BUSY_TIMEOUT_MS } = options
  const exists = existsSync(path)
  if (exists) {
    const size = statSync(path).size
    // A zero-byte file is not a valid empty database: SQLite would treat it as new,
    // which could silently mask truncation. Preserve and report it instead.
    if (size === 0) {
      throw corrupt(path, 'The database file is empty.')
    }
    assertSqliteHeader(path)
    openForIntegrityCheck(path)
  } else {
    mkdirSync(dirname(path), { recursive: true })
  }

  const raw = openWritable(path, busyTimeoutMs)
  let closed = false

  try {
    for (const pragma of DEFAULT_PRAGMAS) raw.exec(pragma)
    raw.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
    verifyPragmas(raw)
    // Integrity is checked before migrations: a damaged file must never be mutated.
    const integrity = raw.prepare('PRAGMA integrity_check').get() as
      | { integrity_check?: string }
      | undefined
    if (integrity?.integrity_check !== 'ok') {
      throw corrupt(
        path,
        `SQLite integrity check reported ${String(integrity?.integrity_check ?? 'no result')}.`
      )
    }
    const version = runMigrations(raw, options.migrations ?? [])
    if (version > SCHEMA_VERSION) {
      throw new DatabaseError(
        makeAppError('DB_CORRUPT', 'The iCode database was written by a newer version.', {
          detail: `Database schema is v${version}; this build supports v${SCHEMA_VERSION}.`,
          context: { path }
        })
      )
    }
  } catch (error) {
    try {
      raw.close()
    } catch {
      // ignore close failure; preserve the original error
    }
    if (error instanceof MigrationFailureError) throw error.toDatabaseError(path)
    if (error instanceof DatabaseError) throw error
    throw new DatabaseError(
      makeAppError('INTERNAL', 'The iCode database could not be initialized.', {
        detail: error instanceof Error ? error.message : String(error),
        context: { path }
      }),
      { cause: error }
    )
  }

  const handle: Database = {
    path,
    raw,
    close: () => {
      if (closed) return
      closed = true
      try {
        raw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch {
        // checkpoint failure must not prevent closing
      }
      raw.close()
    },
    isClosed: () => closed,
    transaction: <T>(work: () => T): T => applyTransaction(raw, work),
    userVersion: () => readUserVersion(raw),
    pragmaValue: (name: string) => {
      if (!/^[a-z_]+$/.test(name)) throw new Error(`Invalid PRAGMA name: ${name}`)
      return raw.prepare(`PRAGMA ${name}`).get()
    },
    assertHealthy: () => {
      const result = raw.prepare('PRAGMA integrity_check').get() as
        | { integrity_check?: string }
        | undefined
      if (result?.integrity_check !== 'ok') {
        throw corrupt(path, `SQLite integrity check reported ${String(result?.integrity_check)}.`)
      }
    }
  }
  return handle
}
