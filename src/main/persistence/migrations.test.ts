import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { openDatabase, type Database } from './database'
import { MIGRATIONS } from './migrations'
import { makeTempRoot, type TempRoot } from './persistence-test-fixtures'
import { newProviderRowId } from '../../shared/schemas/provider'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function tempPath(): { root: TempRoot; path: string } {
  const root = makeTempRoot('icode-migrations-')
  cleanups.push(root.cleanup)
  return { root, path: join(root.dir, 'icode.sqlite') }
}

function closeAfter(db: Database): void {
  cleanups.push(() => {
    if (!db.isClosed()) db.close()
  })
}

const PROVIDER_ID = 'prv_00000000-0000-4000-8000-000000000001'

function seedV19(path: string): void {
  const db = openDatabase({
    path,
    migrations: MIGRATIONS.filter((migration) => migration.version <= 19)
  })
  closeAfter(db)
  db.raw
    .prepare(
      `INSERT INTO providers (
         id, harness, name, base_url, model, auth_style,
         api_key_cipher, api_key_scheme, api_key_backend, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      PROVIDER_ID,
      'claude',
      'Relay',
      'https://relay.example.com',
      'claude-sonnet-5',
      'auth_token',
      new Uint8Array([1, 2, 3]),
      'safe_storage_v1',
      'safe_storage',
      10,
      20
    )
  db.raw
    .prepare(
      `INSERT INTO harness_provider_selection (harness, provider_id, updated_at)
       VALUES (?, ?, ?)`
    )
    .run('claude', PROVIDER_ID, 30)
  db.close()
}

describe('migration 20: provider harnesses', () => {
  it('preserves provider and selection rows while widening the harness list', () => {
    const { path } = tempPath()
    seedV19(path)

    const db = openDatabase({
      path,
      migrations: MIGRATIONS.filter((migration) => migration.version <= 20)
    })
    closeAfter(db)
    expect(db.userVersion()).toBe(20)

    const provider = db.raw
      .prepare(
        `SELECT harness, name, base_url, model, auth_style, created_at, updated_at
         FROM providers WHERE id = ?`
      )
      .get(PROVIDER_ID) as Record<string, unknown>
    expect(provider).toMatchObject({
      harness: 'claude',
      name: 'Relay',
      base_url: 'https://relay.example.com',
      model: 'claude-sonnet-5',
      auth_style: 'auth_token',
      created_at: 10,
      updated_at: 20
    })

    expect(
      db.raw
        .prepare(
          'SELECT harness, provider_id, updated_at FROM harness_provider_selection'
        )
        .all()
    ).toEqual([{ harness: 'claude', provider_id: PROVIDER_ID, updated_at: 30 }])

    const providerSql = (
      db.raw
        .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'providers'")
        .get() as { sql: string }
    ).sql
    expect(providerSql).toContain("'codebuddy'")
    expect(providerSql).toContain('STRICT')
    expect(
      db.raw
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'providers_harness_idx'"
        )
        .get()
    ).toBeDefined()
  })

  it('accepts a new provider harness and rejects an unknown one', () => {
    const { path } = tempPath()
    seedV19(path)
    const db = openDatabase({ path, migrations: MIGRATIONS })
    closeAfter(db)

    const insert = (harness: string, authStyle: string | null): void => {
      db.raw
        .prepare(
          `INSERT INTO providers (
             id, harness, name, base_url, model, auth_style,
             api_key_cipher, api_key_scheme, api_key_backend, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          newProviderRowId(),
          harness,
          `Provider ${harness}`,
          'https://relay.example.com',
          'model',
          authStyle,
          new Uint8Array([4]),
          'safe_storage_v1',
          'safe_storage',
          1,
          1
        )
    }

    expect(() => insert('codebuddy', null)).not.toThrow()
    expect(() => insert('not-a-harness', null)).toThrow()
    expect(() => insert('codebuddy', 'auth_token')).toThrow()
    expect(() => insert('openclaude', 'api_key')).not.toThrow()
  })

  it('keeps the selection foreign key restrictive', () => {
    const { path } = tempPath()
    seedV19(path)
    const db = openDatabase({ path, migrations: MIGRATIONS })
    closeAfter(db)

    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO harness_provider_selection (harness, provider_id, updated_at)
           VALUES (?, ?, ?)`
        )
        .run('codex', 'prv_00000000-0000-4000-8000-000000000099', 1)
    ).toThrow()

    expect(() =>
      db.raw.prepare('DELETE FROM providers WHERE id = ?').run(PROVIDER_ID)
    ).toThrow()
  })
})

describe('migration 21: sidebar order', () => {
  it('adds a single-row order document table', () => {
    const { path } = tempPath()
    const v20 = openDatabase({
      path,
      migrations: MIGRATIONS.filter((migration) => migration.version <= 20)
    })
    v20.close()

    const db = openDatabase({ path, migrations: MIGRATIONS })
    closeAfter(db)
    expect(db.userVersion()).toBe(21)

    const document = '{"projects":["repo_1"],"worktrees":{},"sessions":{}}'
    db.raw
      .prepare('INSERT INTO sidebar_order (id, document, updated_at) VALUES (1, ?, 5)')
      .run(document)
    expect(
      db.raw.prepare('SELECT document FROM sidebar_order WHERE id = 1').get()
    ).toEqual({ document })
    expect(() =>
      db.raw
        .prepare('INSERT INTO sidebar_order (id, document, updated_at) VALUES (2, ?, 5)')
        .run('{}')
    ).toThrow()
  })
})
