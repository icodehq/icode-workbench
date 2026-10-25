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
import { resolveRepositoryRootFor } from '../repositories/repository-path'
import type { TargetValidator } from '../wsl/repository-target'
import type { ExecutionTarget } from '../../shared/domain/repository'

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
  options: {
    now?: () => number
    /**
     * Persistence tests exercise storage, not distro discovery, so the default
     * accepts a target unchanged. Validation is covered separately, through the
     * real validator with an injected registry.
     */
    validateTarget?: TargetValidator
    /**
     * Injected guest path resolution. Absent means a WSL target has no runner and
     * is refused, which is the correct answer for a test that only stores rows.
     */
    wsl?: { runner: import('../wsl/exec').WslCommandRunner; signal?: AbortSignal }
    resolveRoot?: (path: string, target: ExecutionTarget) => Promise<{
      root: string
      currentBranch: string | null
      commonDir?: string
      registeredVia?: string | null
    }>
  } = {}
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
    resolveRoot: options.resolveRoot ?? ((path, target) => resolveRepositoryRootFor(path, target, options.wsl ? { wsl: options.wsl } : {})),
    now: options.now ?? (() => Date.now()),
    validateTarget: options.validateTarget ?? (async (target) => target),
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
