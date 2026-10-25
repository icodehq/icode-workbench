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
import { resolveRepositoryRootFor } from '../repositories/repository-path'
import { WslCommandRunner } from '../wsl/exec'
import { createTargetValidator } from '../wsl/repository-target'

export type AppPersistence = {
  database: Database
  repositories: RepositoryStore
  sessions: SessionStore
  uiState: UiStateStore
  repositoryService: RepositoryService
}

let instance: AppPersistence | null = null

/**
 * Lazily created so a local-only run never resolves `wsl.exe`, and so importing
 * this module in a test does not touch the OS.
 */
let wslRunner: WslCommandRunner | null = null
function sharedWslRunner(): WslCommandRunner {
  wslRunner ??= new WslCommandRunner()
  return wslRunner
}

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
      // One runner for the whole process: it holds no per-distro state, so there is
      // nothing to invalidate when a distro restarts.
      resolveRoot: (path, target) =>
        resolveRepositoryRootFor(path, target, { wsl: { runner: sharedWslRunner() } }),
      now: Date.now,
      pathStatus: defaultPathStatus,
      // The production WSL authority: real registry, real wsl.exe, real discovery.
      validateTarget: createTargetValidator()
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
