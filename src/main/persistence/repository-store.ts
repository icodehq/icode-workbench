import type { Database } from './database'
import { repoFromRow, workspaceFromRow, type RepoRow, type WorkspaceRow } from './rows'
import type { RepoId } from '../../shared/domain/ids'
import type { RepositoryRecord, WorkspaceRecord } from '../../shared/domain/repository'

export type RepositoryWithWorkspace = {
  repository: RepositoryRecord
  workspace: WorkspaceRecord
}

const REPO_COLUMNS = `id, path, display_name, added_at, last_opened_at, current_branch, availability,
  git_common_dir`
const WORKSPACE_COLUMNS = `id, repo_id, path, kind, created_at`

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

  findByPath(path: string): RepositoryRecord | null {
    const row = this.db.raw
      .prepare(`SELECT ${REPO_COLUMNS} FROM repos WHERE path = ?`)
      .get(path) as RepoRow | undefined
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
  findByCommonDir(commonDir: string): RepositoryRecord | null {
    const row = this.db.raw
      .prepare(`SELECT ${REPO_COLUMNS} FROM repos WHERE git_common_dir = ?`)
      .get(commonDir) as RepoRow | undefined
    return row ? repoFromRow(row) : null
  }

  updateCommonDir(id: RepoId, commonDir: string): void {
    this.db.raw.prepare('UPDATE repos SET git_common_dir = ? WHERE id = ?').run(commonDir, id)
  }

  insert(repo: RepositoryRecord): void {
    this.db.raw
      .prepare(
        `INSERT INTO repos (${REPO_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        repo.id,
        repo.path,
        repo.displayName,
        repo.addedAt,
        repo.lastOpenedAt,
        repo.currentBranch,
        repo.availability,
        repo.gitCommonDir
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
