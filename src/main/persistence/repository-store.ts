import type { Database } from './database'
import { repoFromRow, workspaceFromRow, type RepoRow, type WorkspaceRow } from './rows'
import type { RepoId } from '../../shared/domain/ids'
import {
  LOCAL_EXECUTION_TARGET,
  type ExecutionTarget,
  type RepositoryRecord,
  type WorkspaceRecord
} from '../../shared/domain/repository'

export type RepositoryWithWorkspace = {
  repository: RepositoryRecord
  workspace: WorkspaceRecord
}

const REPO_COLUMNS = `id, path, display_name, added_at, last_opened_at, current_branch, availability,
  git_common_dir, host_kind, wsl_distro, wsl_distro_id`
const WORKSPACE_COLUMNS = `id, repo_id, path, kind, created_at`

/**
 * The WHERE fragment that scopes a lookup to one execution target.
 *
 * Why it mirrors the unique indexes exactly: a lookup that is looser than its
 * index would return a row the index considers a different target, and one that
 * is stricter would miss the row the index would have rejected as a duplicate.
 *
 * A WSL target with no registration id matches on the distro *name* only among
 * rows that also have no id, so an id-less row can never shadow — or be shadowed
 * by — a row that does carry one.
 */
function targetScope(target: ExecutionTarget): { sql: string; params: string[] } {
  if (target.kind === 'local') {
    return { sql: `host_kind = 'local'`, params: [] }
  }
  return target.distroId === null
    ? { sql: `host_kind = 'wsl' AND wsl_distro_id IS NULL AND wsl_distro = ?`, params: [target.distro] }
    : { sql: `host_kind = 'wsl' AND wsl_distro_id = ?`, params: [target.distroId] }
}

/**
 * Persistence only: no validation, filesystem access, or lifecycle policy.
 * The service above this store owns those decisions.
 */
export class RepositoryStore {
  constructor(private readonly db: Database) {}

  list(): RepositoryRecord[] {
    const rows = this.db.raw
      .prepare(`SELECT ${REPO_COLUMNS} FROM repos ORDER BY added_at DESC, id ASC`)
      .all() as RepoRow[]
    return rows.map(repoFromRow)
  }

  findById(id: RepoId): RepositoryRecord | null {
    const row = this.db.raw
      .prepare(`SELECT ${REPO_COLUMNS} FROM repos WHERE id = ?`)
      .get(id) as RepoRow | undefined
    return row ? repoFromRow(row) : null
  }

  /**
   * A path is only unique within its execution target: the same string can name
   * a different repository on this machine and inside a distro.
   */
  findByPath(
    path: string,
    target: ExecutionTarget = LOCAL_EXECUTION_TARGET
  ): RepositoryRecord | null {
    const scope = targetScope(target)
    const row = this.db.raw
      .prepare(`SELECT ${REPO_COLUMNS} FROM repos WHERE path = ? AND ${scope.sql}`)
      .get(path, ...scope.params) as RepoRow | undefined
    return row ? repoFromRow(row) : null
  }

  workspaceForRepo(id: RepoId): WorkspaceRecord | null {
    const row = this.db.raw
      .prepare(`SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE repo_id = ?`)
      .get(id) as WorkspaceRow | undefined
    return row ? workspaceFromRow(row) : null
  }

  findWorkspaceById(id: string): WorkspaceRecord | null {
    const row = this.db.raw
      .prepare(`SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE id = ?`)
      .get(id) as WorkspaceRow | undefined
    return row ? workspaceFromRow(row) : null
  }

  /**
   * The common Git directory identifies one repository even when a user
   * registers a linked worktree. Rows written before migration v2 are null and
   * fall back to path equality until they are re-resolved.
   */
  findByCommonDir(
    commonDir: string,
    target: ExecutionTarget = LOCAL_EXECUTION_TARGET
  ): RepositoryRecord | null {
    const scope = targetScope(target)
    const row = this.db.raw
      .prepare(`SELECT ${REPO_COLUMNS} FROM repos WHERE git_common_dir = ? AND ${scope.sql}`)
      .get(commonDir, ...scope.params) as RepoRow | undefined
    return row ? repoFromRow(row) : null
  }

  /**
   * WSL rows written before a registration id could be read.
   *
   * These are the one case where the model's weakest identity ("a name") is all a
   * row has. They are looked up explicitly — never through `findByPath`, whose
   * scoping is what keeps a name from being treated as an id.
   */
  findLegacyWslByNameAndPath(distro: string, path: string): RepositoryRecord | null {
    const row = this.db.raw
      .prepare(
        `SELECT ${REPO_COLUMNS} FROM repos
          WHERE host_kind = 'wsl' AND wsl_distro_id IS NULL AND wsl_distro = ? AND path = ?`
      )
      .get(distro, path) as RepoRow | undefined
    return row ? repoFromRow(row) : null
  }

  /**
   * Completes a legacy row's identity once the registration has been proven.
   *
   * This is not a merge: it writes one column on one existing row, keeping the
   * row id, its workspace, its worktrees and its sessions. The caller must have
   * evidence that the same registration owns the same repository — see
   * `RepositoryService.addRepository`.
   */
  adoptRegistrationId(id: RepoId, distroId: string): void {
    this.db.raw
      .prepare(`UPDATE repos SET wsl_distro_id = ? WHERE id = ? AND host_kind = 'wsl'`)
      .run(distroId, id)
  }

  updateCommonDir(id: RepoId, commonDir: string): void {
    this.db.raw.prepare('UPDATE repos SET git_common_dir = ? WHERE id = ?').run(commonDir, id)
  }

  insert(repo: RepositoryRecord): void {
    this.db.raw
      .prepare(
        `INSERT INTO repos (${REPO_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        repo.id,
        repo.path,
        repo.displayName,
        repo.addedAt,
        repo.lastOpenedAt,
        repo.currentBranch,
        repo.availability,
        repo.gitCommonDir,
        repo.executionTarget.kind,
        repo.executionTarget.kind === 'wsl' ? repo.executionTarget.distro : '',
        repo.executionTarget.kind === 'wsl' ? repo.executionTarget.distroId : null
      )
  }

  insertWorkspace(workspace: WorkspaceRecord): void {
    this.db.raw
      .prepare(
        `INSERT INTO workspaces (${WORKSPACE_COLUMNS})
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        workspace.id,
        workspace.repoId,
        workspace.path,
        workspace.kind,
        workspace.createdAt
      )
  }

  updateAvailability(id: RepoId, availability: RepositoryRecord['availability']): void {
    this.db.raw
      .prepare('UPDATE repos SET availability = ? WHERE id = ?')
      .run(availability, id)
  }

  updateBranch(id: RepoId, branch: string | null): void {
    this.db.raw.prepare('UPDATE repos SET current_branch = ? WHERE id = ?').run(branch, id)
  }

  touchLastOpened(id: RepoId, at: number): void {
    this.db.raw.prepare('UPDATE repos SET last_opened_at = ? WHERE id = ?').run(at, id)
  }

  delete(id: RepoId): number {
    const result = this.db.raw.prepare('DELETE FROM repos WHERE id = ?').run(id)
    return Number(result.changes)
  }
}
