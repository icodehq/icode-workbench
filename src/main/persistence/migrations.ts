import type { Migration } from './database'

/**
 * Approved schema. Keep version numbers append-only: every migration upgrades
 * exactly one version, and each runs inside one transaction with user_version.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    statements: [
      `CREATE TABLE repos (
         id TEXT PRIMARY KEY NOT NULL,
         path TEXT NOT NULL UNIQUE,
         display_name TEXT NOT NULL,
         added_at INTEGER NOT NULL,
         last_opened_at INTEGER NOT NULL,
         current_branch TEXT,
         availability TEXT NOT NULL CHECK (availability IN ('present', 'missing')),
         CHECK (length(path) > 0),
         CHECK (length(display_name) > 0)
       ) STRICT`,
      `CREATE TABLE workspaces (
         id TEXT PRIMARY KEY NOT NULL,
         repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
         path TEXT NOT NULL,
         kind TEXT NOT NULL CHECK (kind = 'primary-checkout'),
         created_at INTEGER NOT NULL,
         UNIQUE (repo_id),
         UNIQUE (repo_id, path)
       ) STRICT`,
      `CREATE TABLE sessions (
         id TEXT PRIMARY KEY NOT NULL,
         workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
         harness TEXT NOT NULL CHECK (harness IN ('claude', 'codex', 'opencode', 'shell')),
         title TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         last_active_at INTEGER NOT NULL,
         last_observed_state TEXT NOT NULL
           CHECK (last_observed_state IN ('starting', 'live', 'exited', 'failed', 'unavailable')),
         last_observed_exit_code INTEGER,
         last_observed_error_json TEXT,
         last_observed_incarnation_id TEXT,
         last_observed_at INTEGER NOT NULL,
         CHECK (length(title) > 0)
       ) STRICT`,
      `CREATE TABLE ui_state (
         key TEXT PRIMARY KEY NOT NULL,
         value TEXT NOT NULL
       ) STRICT`,
      `CREATE INDEX workspaces_repo_idx ON workspaces (repo_id)`,
      `CREATE INDEX sessions_workspace_idx ON sessions (workspace_id)`
    ]
  },
  {
    version: 2,
    name: 'session-worktrees',
    statements: [
      // Why: additive only. Existing repositories and sessions keep their
      // primary-checkout association; a session without a worktree row behaves
      // exactly as before.
      `ALTER TABLE repos ADD COLUMN git_common_dir TEXT`,
      `CREATE TABLE session_worktrees (
         session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
         repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
         path TEXT NOT NULL UNIQUE,
         branch TEXT NOT NULL UNIQUE,
         base_ref TEXT,
         base_oid TEXT NOT NULL,
         state TEXT NOT NULL CHECK (state IN ('creating', 'created', 'ready', 'failed')),
         last_error_json TEXT,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         CHECK (length(path) > 0),
         CHECK (length(branch) > 0),
         CHECK (length(base_oid) > 0)
       ) STRICT`,
      `CREATE INDEX session_worktrees_repo_idx ON session_worktrees (repo_id)`,
      // Why: branch ownership must outlive the session row so a retained branch
      // can only be deleted through ADE with the exact name the user confirms.
      `CREATE TABLE worktree_branches (
         branch TEXT PRIMARY KEY NOT NULL,
         repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
         session_id TEXT NOT NULL,
         base_oid TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         CHECK (length(branch) > 0)
       ) STRICT`,
      `CREATE INDEX worktree_branches_repo_idx ON worktree_branches (repo_id)`
    ]
  }
]
