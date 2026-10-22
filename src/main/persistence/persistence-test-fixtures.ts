import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Database } from './database'
import { MIGRATIONS } from './migrations'
import { RepositoryStore } from './repository-store'
import { SessionStore } from './session-store'
import { UiStateStore } from './ui-state-store'
import { createRepositoryService } from '../repositories/repository-service'
import type { RepositoryService } from '../repositories/repository-service'
import { resolveRepositoryRoot } from '../repositories/repository-path'

export type TempRoot = { dir: string; cleanup: () => void }

export function makeTempRoot(prefix = 'ade-test-'): TempRoot {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  }
}

export function openTempDatabase(root: TempRoot): Database {
  return openDatabase({ path: join(root.dir, 'ade.sqlite'), migrations: MIGRATIONS })
}

export function makeRepositoryService(
  database: Database,
  options: { now?: () => number } = {}
): {
  service: RepositoryService
  repositories: RepositoryStore
  sessions: SessionStore
  uiState: UiStateStore
} {
  const repositories = new RepositoryStore(database)
  const sessions = new SessionStore(database)
  const uiState = new UiStateStore(database)
  const service = createRepositoryService({
    database,
    repositories,
    sessions,
    uiState,
    resolveRoot: resolveRepositoryRoot,
    now: options.now ?? (() => Date.now()),
    pathStatus: (path) => {
      try {
        return require('node:fs').statSync(path).isDirectory() ? 'present' : 'missing'
      } catch {
        return 'missing'
      }
    }
  })
  return { service, repositories, sessions, uiState }
}
