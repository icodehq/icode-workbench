import { join } from 'node:path'
import { app } from 'electron'
import { openDatabase, type Database } from './database'
import { MIGRATIONS } from './migrations'
import { RepositoryStore } from './repository-store'
import { SessionStore } from './session-store'
import { UiStateStore } from './ui-state-store'
import {
  createRepositoryService,
  defaultPathStatus,
  type RepositoryService
} from '../repositories/repository-service'
import { resolveRepositoryRoot } from '../repositories/repository-path'

export type AppPersistence = {
  database: Database
  repositories: RepositoryStore
  sessions: SessionStore
  uiState: UiStateStore
  repositoryService: RepositoryService
}

let instance: AppPersistence | null = null

export function databasePath(): string {
  return join(app.getPath('userData'), 'ade.sqlite')
}

/**
 * Main-process single writer. Opened lazily so compatibility modes and unit
 * tests never touch the user's database.
 */
export function getAppPersistence(): AppPersistence {
  if (instance) return instance
  const database = openDatabase({ path: databasePath(), migrations: MIGRATIONS })
  const repositories = new RepositoryStore(database)
  const sessions = new SessionStore(database)
  const uiState = new UiStateStore(database)
  instance = {
    database,
    repositories,
    sessions,
    uiState,
    repositoryService: createRepositoryService({
      database,
      repositories,
      sessions,
      uiState,
      resolveRoot: resolveRepositoryRoot,
      now: Date.now,
      pathStatus: defaultPathStatus
    })
  }
  return instance
}

/** Deterministic shutdown: idempotent, and never blocks quit on failure. */
export function closeAppPersistence(): void {
  if (!instance) return
  try {
    instance.database.close()
  } finally {
    instance = null
  }
}

export function isAppPersistenceOpen(): boolean {
  return instance !== null && !instance.database.isClosed()
}
