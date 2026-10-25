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
  },
  {
    version: 3,
    name: 'execution-target',
    /**
     * `repos` carries the only uniqueness that has to change: `path` was
     * `UNIQUE`, which forbids the same path string on two execution targets.
     * SQLite cannot drop an inline constraint, so the table is rebuilt. The flag
     * below is what keeps the rebuild from cascading into workspaces, sessions
     * and worktrees — see the field's documentation in database.ts.
     */
    rebuildsReferencedTable: true,
    statements: [
      `CREATE TABLE repos_new (
         id TEXT PRIMARY KEY NOT NULL,
         path TEXT NOT NULL,
         display_name TEXT NOT NULL,
         added_at INTEGER NOT NULL,
         last_opened_at INTEGER NOT NULL,
         current_branch TEXT,
         availability TEXT NOT NULL CHECK (availability IN ('present', 'missing')),
         git_common_dir TEXT,
         host_kind TEXT NOT NULL DEFAULT 'local' CHECK (host_kind IN ('local', 'wsl')),
         wsl_distro TEXT NOT NULL DEFAULT '',
         wsl_distro_id TEXT,
         CHECK (length(path) > 0),
         CHECK (length(display_name) > 0),
         -- A local row cannot name a distro; a WSL row must.
         CHECK (
           (host_kind = 'local' AND wsl_distro = '' AND wsl_distro_id IS NULL)
           OR (host_kind = 'wsl' AND length(wsl_distro) > 0)
         )
       ) STRICT`,
      // Every pre-v3 row is local, and nothing about its path changes: the
      // canonicalization that produced it ran on this machine.
      `INSERT INTO repos_new (
         id, path, display_name, added_at, last_opened_at, current_branch,
         availability, git_common_dir, host_kind, wsl_distro, wsl_distro_id
       )
       SELECT id, path, display_name, added_at, last_opened_at, current_branch,
              availability, git_common_dir, 'local', '', NULL
       FROM repos`,
      `DROP TABLE repos`,
      `ALTER TABLE repos_new RENAME TO repos`,
      /**
       * Uniqueness, one rule per target kind.
       *
       * Local keeps the canonical-path semantics it has always had.
       *
       * WSL prefers the registration id: a renamed distro is the same
       * registration, so `(wsl_distro_id, path)` still deduplicates it. The name
       * is the identity only when no id could be read, and that fallback is its
       * own index so the two cases can never be conflated — a name is never
       * silently treated as an id.
       */
      `CREATE UNIQUE INDEX repos_local_path_idx ON repos (path)
         WHERE host_kind = 'local'`,
      `CREATE UNIQUE INDEX repos_wsl_registration_path_idx ON repos (wsl_distro_id, path)
         WHERE host_kind = 'wsl' AND wsl_distro_id IS NOT NULL`,
      `CREATE UNIQUE INDEX repos_wsl_name_path_idx ON repos (wsl_distro, path)
         WHERE host_kind = 'wsl' AND wsl_distro_id IS NULL`,
      `CREATE INDEX repos_host_kind_idx ON repos (host_kind)`
    ]
  }
]
