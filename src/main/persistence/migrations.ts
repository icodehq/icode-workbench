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
      // can only be deleted through iCode with the exact name the user confirms.
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
  },
  {
    version: 4,
    name: 'tasks-and-schedules',
    /**
     * Durable work, not conversation.
     *
     * `tasks` is deliberately a separate table from `sessions`: a task exists
     * before any terminal does and outlives it. Two constraints carry the
     * reliability guarantees rather than convention:
     *  - `tasks.dedupe_key` unique — a schedule occurrence (or a retried
     *    duplicate submit) cannot create a second task row.
     *  - `task_occurrences (schedule_id, occurrence_at)` unique — the durable
     *    receipt Ceza keeps per occurrence, so a re-armed timer, a restart, or a
     *    second window cannot launch the same occurrence twice.
     *
     * `next_run_at` is stored rather than recomputed so a restart resumes the
     * same cadence instead of drifting forward from boot time.
     */
    statements: [
      `CREATE TABLE tasks (
         id TEXT PRIMARY KEY NOT NULL,
         workspace_id TEXT NOT NULL,
         repo_id TEXT NOT NULL,
         title TEXT NOT NULL,
         prompt TEXT NOT NULL,
         harness TEXT NOT NULL,
         status TEXT NOT NULL CHECK (
           status IN ('queued', 'dispatching', 'running', 'waiting', 'completed', 'failed', 'cancelled')
         ),
         session_id TEXT,
         worktree_path TEXT,
         attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
         previous_task_id TEXT,
         schedule_id TEXT,
         occurrence_at INTEGER,
         -- NULLs are distinct in SQLite, so only real keys deduplicate.
         dedupe_key TEXT UNIQUE,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         started_at INTEGER,
         finished_at INTEGER,
         result_summary TEXT,
         error TEXT,
         error_detail TEXT,
         failure_reason TEXT,
         last_observed_state TEXT,
         exit_code INTEGER,
         CHECK (length(title) > 0),
         CHECK (length(prompt) > 0)
       )`,
      // Dispatch reads "the oldest queued task" on every tick.
      `CREATE INDEX tasks_status_created_idx ON tasks (status, created_at)`,
      `CREATE INDEX tasks_repo_created_idx ON tasks (repo_id, created_at)`,
      `CREATE INDEX tasks_previous_idx ON tasks (previous_task_id)`,
      `CREATE INDEX tasks_schedule_idx ON tasks (schedule_id, occurrence_at)`,

      `CREATE TABLE task_schedules (
         id TEXT PRIMARY KEY NOT NULL,
         repo_id TEXT NOT NULL,
         title TEXT NOT NULL,
         prompt TEXT NOT NULL,
         harness TEXT NOT NULL,
         shape_json TEXT NOT NULL,
         overlap TEXT NOT NULL DEFAULT 'queue' CHECK (overlap IN ('queue', 'skip')),
         enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         next_run_at INTEGER,
         last_run_at INTEGER,
         consecutive_failures INTEGER NOT NULL DEFAULT 0,
         last_note TEXT,
         CHECK (length(title) > 0),
         CHECK (length(prompt) > 0)
       )`,
      `CREATE INDEX task_schedules_enabled_idx ON task_schedules (enabled, next_run_at)`,

      `CREATE TABLE task_occurrences (
         id TEXT PRIMARY KEY NOT NULL,
         schedule_id TEXT NOT NULL,
         occurrence_at INTEGER NOT NULL,
         task_id TEXT,
         status TEXT NOT NULL CHECK (status IN ('reserved', 'created', 'skipped', 'error')),
         note TEXT,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         UNIQUE (schedule_id, occurrence_at)
       )`,
      `CREATE INDEX task_occurrences_schedule_idx ON task_occurrences (schedule_id, occurrence_at)`,

      // One row: the queue is a property of this installation, not of a repo.
      `CREATE TABLE task_settings (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         max_concurrent INTEGER NOT NULL DEFAULT 1 CHECK (max_concurrent BETWEEN 1 AND 4)
       )`,
      `INSERT INTO task_settings (id, max_concurrent) VALUES (1, 1)`
    ]
  },
  {
    version: 5,
    name: 'task-review-decision',
    /**
     * The review decision is a *product* fact about a task's result, deliberately
     * separate from its execution status.
     *
     * A process exiting 0 says the harness stopped; it says nothing about whether
     * the work is wanted. Keeping the decision in its own columns is what stops
     * the UI from implying "completed = accepted", and it is why acceptance here
     * records a judgement rather than performing a merge: nothing in this schema
     * can move code between branches.
     *
     * `pending` is the default so every pre-existing task reads honestly as
     * unreviewed rather than being silently accepted by the migration.
     */
    statements: [
      `ALTER TABLE tasks ADD COLUMN review_decision TEXT NOT NULL DEFAULT 'pending'
         CHECK (review_decision IN ('pending', 'accepted', 'rejected'))`,
      `ALTER TABLE tasks ADD COLUMN reviewed_at INTEGER`,
      `ALTER TABLE tasks ADD COLUMN review_note TEXT`,
      // Review state is read per queue view and per retry chain.
      `CREATE INDEX tasks_review_idx ON tasks (review_decision, reviewed_at)`
    ]
  },
  {
    version: 6,
    name: 'repository-preparation',
    /**
     * Add project registers the folder before its first commit exists. This
     * column is the durable state of that background work: the dialog must not
     * wait for it, but a restart must not lose it or leave a project stuck in
     * "preparing" forever.
     *
     * Null means "no preparation was ever needed" (the ordinary existing
     * checkout), not "ready". The JSON shape is validated by the row parser.
     */
    statements: [`ALTER TABLE repos ADD COLUMN preparation_json TEXT`]
  },
  {
    version: 7,
    name: 'session-sleep',
    /**
     * Sleep is a durable intent, not a lifecycle state: the process is stopped,
     * but the session and worktree stay. `sleeping_at` survives an app restart;
     * `resume_token` is the harness conversation identity captured while the
     * process was alive (Claude hooks today; a wake adapter may add others).
     *
     * Both nullable: an awake pre-v7 session is exactly the old row.
     */
    statements: [
      `ALTER TABLE sessions ADD COLUMN sleeping_at INTEGER`,
      `ALTER TABLE sessions ADD COLUMN resume_token TEXT`
    ]
  },
  {
    version: 8,
    name: 'supervisor',
    /**
     * A supervisor proposes work; it does not create authorized work.
     *
     * `origin` records who asked for the task, and `approval` is the human gate
     * that keeps a proposal out of the dispatcher until someone approves it.
     * Keeping approval as a column rather than a status avoids rewriting the
     * task status CHECK constraint and preserves the queue's one meaning:
     * "queued" still means waiting for a slot, not waiting for a person.
     *
     * `review_recommendation` is deliberately separate from `review_decision`:
     * a supervisor may present evidence, but only a person settles the result.
     */
    statements: [
      `ALTER TABLE tasks ADD COLUMN origin TEXT NOT NULL DEFAULT 'human'
         CHECK (origin IN ('human', 'schedule', 'supervisor'))`,
      `ALTER TABLE tasks ADD COLUMN created_by_session_id TEXT`,
      `ALTER TABLE tasks ADD COLUMN approval TEXT NOT NULL DEFAULT 'approved'
         CHECK (approval IN ('approved', 'pending', 'rejected'))`,
      `ALTER TABLE tasks ADD COLUMN approved_at INTEGER`,
      `ALTER TABLE tasks ADD COLUMN approved_by TEXT`,
      `ALTER TABLE tasks ADD COLUMN review_recommendation TEXT
         CHECK (review_recommendation IS NULL OR review_recommendation IN ('accept', 'reject'))`,
      `ALTER TABLE tasks ADD COLUMN review_recommendation_note TEXT`,
      `ALTER TABLE tasks ADD COLUMN review_recommended_at INTEGER`,
      `ALTER TABLE tasks ADD COLUMN review_recommended_by_session_id TEXT`,
      `UPDATE tasks SET origin = 'schedule' WHERE schedule_id IS NOT NULL`,
      `CREATE INDEX tasks_approval_status_created_idx ON tasks (approval, status, created_at)`,
      `ALTER TABLE sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'interactive'
         CHECK (role IN ('interactive', 'supervisor'))`,
      `CREATE TABLE supervisor_bindings (
         repo_id TEXT PRIMARY KEY,
         session_id TEXT NOT NULL UNIQUE,
         control_token TEXT NOT NULL UNIQUE,
         initialized_at INTEGER,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
      `CREATE TABLE supervisor_actions (
         id INTEGER PRIMARY KEY,
         repo_id TEXT NOT NULL,
         session_id TEXT NOT NULL,
         op TEXT NOT NULL,
         task_id TEXT,
         outcome TEXT NOT NULL,
         detail_json TEXT,
         created_at INTEGER NOT NULL
       )`,
      `CREATE INDEX supervisor_actions_repo_created_idx ON supervisor_actions (repo_id, created_at)`
    ]
  },
  {
    version: 9,
    name: 'assistant',
    /**
     * Mira is a global assistant: a durable thread, runs, memory, settings, and
     * an audit trail. The thread is deliberately not owned by a repository, so
     * deleting a project cannot delete a conversation.
     *
     * Tasks gain an accurate non-session actor instead of a synthetic session
     * id. `origin` remains the queue/approval class; `created_by_actor = 'mira'`
     * is the provenance the UI and ownership checks use.
     *
     * `seq` is a per-thread message sequence, and `last_read_seq` is a
     * watermark: marking read is a monotonic conditional update, so a stale
     * window cannot move the watermark backwards.
     */
    statements: [
      `ALTER TABLE tasks ADD COLUMN created_by_actor TEXT`,
      `ALTER TABLE tasks ADD COLUMN assistant_run_id TEXT`,
      `ALTER TABLE tasks ADD COLUMN approval_policy TEXT`,
      `CREATE INDEX tasks_session_idx ON tasks (session_id)`,
      `CREATE INDEX tasks_actor_created_idx ON tasks (created_by_actor, created_at)`,

      `CREATE TABLE assistant_threads (
         id TEXT PRIMARY KEY NOT NULL,
         kind TEXT NOT NULL DEFAULT 'main' CHECK (kind IN ('main', 'system')),
         title TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         last_message_at INTEGER,
         last_read_seq INTEGER NOT NULL DEFAULT 0,
         active_run_id TEXT,
         archived_at INTEGER,
         CHECK (length(title) > 0)
       ) STRICT`,
      `CREATE UNIQUE INDEX assistant_threads_main_idx
         ON assistant_threads (kind) WHERE kind = 'main'`,
      `CREATE INDEX assistant_threads_updated_idx ON assistant_threads (updated_at)`,

      `CREATE TABLE assistant_messages (
         id TEXT PRIMARY KEY NOT NULL,
         thread_id TEXT NOT NULL REFERENCES assistant_threads(id) ON DELETE CASCADE,
         seq INTEGER NOT NULL,
         run_id TEXT,
         role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
         kind TEXT NOT NULL
           CHECK (kind IN ('text', 'card', 'status', 'notification', 'digest', 'welcome', 'error', 'action')),
         body TEXT NOT NULL,
         card_json TEXT,
         notification_kind TEXT,
         notification_priority TEXT
           CHECK (notification_priority IS NULL OR notification_priority IN ('high', 'normal', 'low')),
         notification_state TEXT
           CHECK (notification_state IS NULL OR notification_state IN ('pending', 'delivered', 'suppressed')),
         notification_dedupe_key TEXT,
         notified_at INTEGER,
         metadata_json TEXT,
         created_at INTEGER NOT NULL,
         CHECK (length(body) > 0)
       ) STRICT`,
      `CREATE UNIQUE INDEX assistant_messages_thread_seq_idx
         ON assistant_messages (thread_id, seq)`,
      `CREATE INDEX assistant_messages_thread_created_idx
         ON assistant_messages (thread_id, created_at)`,
      `CREATE UNIQUE INDEX assistant_messages_dedupe_idx
         ON assistant_messages (notification_dedupe_key)
         WHERE notification_dedupe_key IS NOT NULL`,

      `CREATE TABLE assistant_runs (
         id TEXT PRIMARY KEY NOT NULL,
         thread_id TEXT NOT NULL REFERENCES assistant_threads(id) ON DELETE CASCADE,
         trigger TEXT NOT NULL CHECK (trigger IN ('user', 'retry', 'proactive')),
         status TEXT NOT NULL
           CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
         stage TEXT,
         harness TEXT NOT NULL,
         target_kind TEXT,
         target_distro TEXT,
         round INTEGER NOT NULL DEFAULT 0,
         request_message_id TEXT,
         response_message_id TEXT,
         resume_token TEXT,
         usage_json TEXT,
         context_chars INTEGER,
         started_at INTEGER NOT NULL,
         finished_at INTEGER,
         error TEXT
       ) STRICT`,
      `CREATE INDEX assistant_runs_thread_started_idx ON assistant_runs (thread_id, started_at)`,
      `CREATE INDEX assistant_runs_status_idx ON assistant_runs (status)`,

      `CREATE TABLE assistant_memory (
         id TEXT PRIMARY KEY NOT NULL,
         key TEXT NOT NULL UNIQUE,
         value TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         CHECK (length(key) > 0 AND length(value) > 0)
       ) STRICT`,

      `CREATE TABLE assistant_actions (
         id INTEGER PRIMARY KEY NOT NULL,
         thread_id TEXT,
         run_id TEXT,
         actor TEXT NOT NULL CHECK (actor IN ('mira', 'human', 'system')),
         op TEXT NOT NULL,
         repo_id TEXT,
         task_id TEXT,
         session_id TEXT,
         outcome TEXT NOT NULL,
         detail_json TEXT,
         created_at INTEGER NOT NULL
       ) STRICT`,
      `CREATE INDEX assistant_actions_repo_created_idx
         ON assistant_actions (repo_id, created_at)`,
      `CREATE INDEX assistant_actions_run_idx ON assistant_actions (run_id)`,

      `CREATE TABLE assistant_settings (
         id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
         settings_json TEXT NOT NULL,
         updated_at INTEGER NOT NULL
       ) STRICT`
    ]
  },
  {
    version: 10,
    name: 'task-archive',
    /**
     * Finished tasks leave the working list without losing their history.
     *
     * Archive is a reversible visibility flag, not delete: review decisions,
     * retry chains, sessions and worktrees stay intact. Archived rows are
     * excluded from the default task list, attention counts and Mira's context;
     * History can still read them.
     */
    statements: [
      `ALTER TABLE tasks ADD COLUMN archived_at INTEGER`,
      `CREATE INDEX tasks_archived_updated_idx ON tasks (archived_at, updated_at)`
    ]
  },
  {
    version: 11,
    name: 'assistant-conversations',
    /**
     * One native harness conversation per Mira thread at a time.
     *
     * The thread is durable and user-visible; the native conversation is a
     * rotating resource. Retired rows stay for audit and explain why Mira
     * started over. `history_mode` is only read before the native id exists:
     * `bridge` replays recent messages on the first turn, `clean` does not.
     */
    statements: [
      `CREATE TABLE assistant_conversations (
         id TEXT PRIMARY KEY NOT NULL,
         thread_id TEXT NOT NULL REFERENCES assistant_threads(id) ON DELETE CASCADE,
         harness TEXT NOT NULL CHECK (harness IN ('claude', 'codex', 'opencode')),
         target_kind TEXT NOT NULL CHECK (target_kind IN ('local', 'wsl')),
         target_distro TEXT,
         native_session_id TEXT
           CHECK (native_session_id IS NULL OR length(native_session_id) BETWEEN 1 AND 128),
         state TEXT NOT NULL CHECK (state IN ('active', 'reset', 'invalid')),
         reset_reason TEXT
           CHECK (reset_reason IS NULL OR reset_reason IN
             ('user', 'harness-changed', 'target-changed', 'resume-failed', 'resume-unsupported')),
         history_mode TEXT NOT NULL DEFAULT 'bridge'
           CHECK (history_mode IN ('bridge', 'clean')),
         last_prompt_seq INTEGER,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         observed_at INTEGER,
         CHECK ((target_kind = 'local' AND target_distro IS NULL)
             OR (target_kind = 'wsl' AND target_distro IS NOT NULL)),
         CHECK ((state = 'active' AND reset_reason IS NULL)
             OR (state <> 'active' AND reset_reason IS NOT NULL))
       ) STRICT`,
      `CREATE UNIQUE INDEX assistant_conversations_active_idx
         ON assistant_conversations (thread_id) WHERE state = 'active'`,
      `CREATE INDEX assistant_conversations_thread_created_idx
         ON assistant_conversations (thread_id, created_at)`
    ]
  },
  {
    version: 12,
    name: 'assistant-conversation-segments',
    /**
     * Transcript segments for Mira's global thread.
     *
     * `start_seq` anchors a conversation to the user message that started it
     * (1 for the first-ever segment, so the welcome is included). The visible
     * range of a segment is [start_seq, next.start_seq - 1]; `end_seq` records
     * retirement for audit and is not used as the display boundary.
     *
     * Pre-v12 rows have no message↔conversation link, so segmentation is not
     * invented: the newest row per thread becomes one legacy segment covering
     * the whole transcript. Older rows stay NULL and are hidden from the
     * selector but retained as audit.
     */
    statements: [
      `ALTER TABLE assistant_conversations ADD COLUMN start_seq INTEGER`,
      `ALTER TABLE assistant_conversations ADD COLUMN end_seq INTEGER`,
      `CREATE INDEX assistant_conversations_thread_seq_idx
         ON assistant_conversations (thread_id, start_seq)`,
      `UPDATE assistant_conversations
       SET start_seq = 1
       WHERE rowid IN (
         SELECT MAX(rowid) FROM assistant_conversations GROUP BY thread_id
       )`
    ]
  },
  {
    version: 13,
    name: 'task-attempt-mode',
    /**
     * How an execution episode started.
     *
     * `fresh` is a new session and worktree; `resume` continues the
     * predecessor's session and worktree so uncommitted work survives a quota,
     * auth, network or interruption failure. Existing rows are all fresh by
     * construction, which is what the column default records.
     */
    statements: [
      `ALTER TABLE tasks ADD COLUMN attempt_mode TEXT NOT NULL DEFAULT 'fresh'
         CHECK (attempt_mode IN ('fresh', 'resume'))`
    ]
  },
  {
    version: 14,
    name: 'providers',
    /**
     * Provider configurations for coding-agent harnesses.
     *
     * One row is one endpoint for one harness: model names and auth conventions
     * differ per tool, so a provider is not shared across harnesses (cc-switch
     * reached the same conclusion with its per-app provider rows).
     *
     * The API key is never stored in plaintext. `api_key_cipher` is the
     * Electron safeStorage output (or its `basic_text` fallback, marked by
     * `api_key_backend`), and `api_key_scheme` versions the envelope.
     *
     * `harness_provider_selection` is machine-level. It records which provider a
     * harness should launch with; a missing row or a NULL provider means "use
     * the harness's own native configuration". `ON DELETE RESTRICT` is a second
     * line of defence behind the store's explicit "switch away first" check.
     */
    statements: [
      `CREATE TABLE providers (
         id TEXT PRIMARY KEY NOT NULL,
         harness TEXT NOT NULL CHECK (harness IN ('claude', 'codex', 'opencode')),
         name TEXT NOT NULL,
         base_url TEXT NOT NULL,
         model TEXT NOT NULL,
         auth_style TEXT CHECK (
           (harness = 'claude' AND auth_style IN ('auth_token', 'api_key'))
           OR (harness <> 'claude' AND auth_style IS NULL)
         ),
         api_key_cipher BLOB NOT NULL,
         api_key_scheme TEXT NOT NULL CHECK (api_key_scheme IN ('safe_storage_v1')),
         api_key_backend TEXT NOT NULL CHECK (api_key_backend IN ('safe_storage', 'basic_text')),
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         UNIQUE (harness, name),
         CHECK (length(name) > 0 AND length(base_url) > 0 AND length(model) > 0),
         CHECK (length(api_key_cipher) > 0)
       ) STRICT`,
      `CREATE INDEX providers_harness_idx ON providers (harness, created_at)`,
      `CREATE TABLE harness_provider_selection (
         harness TEXT PRIMARY KEY NOT NULL
           CHECK (harness IN ('claude', 'codex', 'opencode')),
         provider_id TEXT REFERENCES providers(id) ON DELETE RESTRICT,
         updated_at INTEGER NOT NULL
       ) STRICT`
    ]
  },
  {
    version: 15,
    name: 'task-dependencies-and-project-cap',
    /**
     * Task ordering edges and the per-project admission cap.
     *
     * A dependency is an AND constraint: a task may not be dispatched until
     * every blocker is `completed`. `hold_dependents` is a property of the
     * blocker, not the edge: when set, completion alone is not enough — the
     * blocker must also have been accepted by a person. That is the only gate,
     * and it is deliberately stored on the task because it describes the result,
     * not one particular consumer of it.
     *
     * The task family keeps its repo/session relationships by application rule
     * instead of foreign keys (see the v4 comment), and task rows are never
     * deleted, so the edge table follows the same convention. The primary key
     * indexes "blockers of a task"; the secondary index indexes "dependents of a
     * task", which readiness and successor re-pointing both read.
     */
    statements: [
      `ALTER TABLE tasks ADD COLUMN hold_dependents INTEGER NOT NULL DEFAULT 0
         CHECK (hold_dependents IN (0, 1))`,
      `CREATE TABLE task_dependencies (
         task_id TEXT NOT NULL,
         depends_on_task_id TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         PRIMARY KEY (task_id, depends_on_task_id),
         CHECK (task_id <> depends_on_task_id)
       )`,
      `CREATE INDEX task_dependencies_depends_on_idx
         ON task_dependencies (depends_on_task_id)`,
      `ALTER TABLE task_settings ADD COLUMN max_concurrent_per_project INTEGER NOT NULL DEFAULT 1
         CHECK (max_concurrent_per_project BETWEEN 1 AND 4)`
    ]
  },
  {
    version: 16,
    name: 'session-integration-and-task-chains',
    /**
     * The session-first integration workflow.
     *
     * A dependency chain shares one chain branch. Membership is derived from the
     * existing `task_dependencies` component, so no chain/plan row is needed; the
     * chosen branch name is copied onto every task in the component.
     *
     * Existing dependency chains were written before merge gating existed. They
     * are marked `legacy` so their queued dependents keep the old completion
     * readiness instead of being stranded behind a merge that can never happen.
     * New tasks default to `merge`.
     *
     * `merge_records` is both the audit trail and the durable exactly-once claim:
     * the partial unique indexes allow at most one active merge per session and
     * per target branch, even across windows or a restart.
     *
     * `worktree_branches` gains chain ownership. Branch ownership has to outlive
     * the session (and now the task), so the table is rebuilt to allow a nullable
     * session_id and an owning task id.
     */
    statements: [
      `ALTER TABLE tasks ADD COLUMN chain_branch TEXT`,
      `ALTER TABLE tasks ADD COLUMN start_from TEXT`,
      `ALTER TABLE tasks ADD COLUMN chain_gate TEXT NOT NULL DEFAULT 'merge'
         CHECK (chain_gate IN ('merge', 'legacy'))`,
      `UPDATE tasks SET chain_gate = 'legacy'`,
      `CREATE INDEX tasks_chain_branch_idx ON tasks (repo_id, chain_branch)`,

      `CREATE TABLE merge_records (
         id TEXT PRIMARY KEY NOT NULL,
         repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
         session_id TEXT NOT NULL,
         task_id TEXT,
         source_branch TEXT NOT NULL,
         target_branch TEXT NOT NULL,
         source_oid_before TEXT NOT NULL,
         target_oid_before TEXT NOT NULL,
         target_oid_after TEXT,
         result_oid TEXT,
         review_base_oid TEXT,
         state TEXT NOT NULL CHECK (
           state IN ('running', 'conflicted', 'merged', 'failed', 'aborted', 'interrupted')
         ),
         commit_oid TEXT,
         conflict_files_json TEXT,
         error_json TEXT,
         push_remote TEXT,
         pushed_at INTEGER,
         push_error_json TEXT,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         finished_at INTEGER,
         CHECK (length(source_branch) > 0),
         CHECK (length(target_branch) > 0)
       ) STRICT`,
      `CREATE INDEX merge_records_session_idx ON merge_records (session_id, created_at)`,
      `CREATE INDEX merge_records_target_idx ON merge_records (repo_id, target_branch, state)`,
      `CREATE UNIQUE INDEX merge_records_active_session_idx
         ON merge_records (session_id)
         WHERE state IN ('running', 'conflicted')`,
      `CREATE UNIQUE INDEX merge_records_active_target_idx
         ON merge_records (repo_id, target_branch)
         WHERE state IN ('running', 'conflicted')`,

      `CREATE TABLE worktree_branches_new (
         branch TEXT PRIMARY KEY NOT NULL,
         repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
         session_id TEXT,
         task_id TEXT,
         kind TEXT NOT NULL DEFAULT 'session'
           CHECK (kind IN ('session', 'chain')),
         base_oid TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         CHECK (length(branch) > 0),
         CHECK (
           (kind = 'session' AND session_id IS NOT NULL)
           OR (kind = 'chain' AND task_id IS NOT NULL)
         )
       ) STRICT`,
      `INSERT INTO worktree_branches_new
         (branch, repo_id, session_id, task_id, kind, base_oid, created_at)
       SELECT branch, repo_id, session_id, NULL, 'session', base_oid, created_at
       FROM worktree_branches`,
      `DROP TABLE worktree_branches`,
      `ALTER TABLE worktree_branches_new RENAME TO worktree_branches`,
      `CREATE INDEX worktree_branches_repo_idx ON worktree_branches (repo_id)`,
      `CREATE INDEX worktree_branches_task_idx ON worktree_branches (task_id)
         WHERE task_id IS NOT NULL`
    ]
  },
  {
    version: 17,
    name: 'repository-removal',
    /**
     * Removing a project is now a durable background job.
     *
     * `repos.removing_at` is a tombstone: the project disappears from lists as
     * soon as the removal starts, but the row (and its FK cascades) remains
     * available until sessions and merges are settled. `repo_removal_jobs`
     * deliberately has no FK so the manifest survives the row deletion.
     *
     * Task rows are normally archived, never deleted. Repository removal is the
     * one deliberate exception: a task cannot outlive the project it belongs to,
     * and the FK-less task/schedule/audit tables would otherwise be impossible
     * to clean. The removal job store documents and performs that purge.
     */
    statements: [
      `ALTER TABLE repos ADD COLUMN removing_at INTEGER`,
      `CREATE TABLE repo_removal_jobs (
         id TEXT PRIMARY KEY NOT NULL,
         repo_id TEXT NOT NULL,
         repo_name TEXT NOT NULL,
         repo_path TEXT NOT NULL,
         target_json TEXT NOT NULL,
         status TEXT NOT NULL CHECK (
           status IN ('queued', 'running', 'waiting_host', 'failed', 'completed')
         ),
         stage TEXT NOT NULL CHECK (
           stage IN ('abort_merges', 'stop_sessions', 'snapshot_worktrees',
                     'remove_worktrees', 'prune_worktrees', 'remove_repository',
                     'cleanup', 'done')
         ),
         manifest_json TEXT NOT NULL,
         attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
         next_attempt_at INTEGER,
         last_error_json TEXT,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         completed_at INTEGER,
         CHECK (length(id) > 0 AND length(repo_id) > 0
                AND length(repo_name) > 0 AND length(repo_path) > 0)
       ) STRICT`,
      `CREATE UNIQUE INDEX repo_removal_jobs_repo_idx
         ON repo_removal_jobs (repo_id)`,
      `CREATE INDEX repo_removal_jobs_status_next_idx
         ON repo_removal_jobs (status, next_attempt_at)`
    ]
  },
  {
    version: 18,
    name: 'shared-worktrees',
    /**
     * A worktree stops being session state and becomes a repo-owned entity.
     *
     * `session_worktrees` was keyed by `session_id`, so a checkout could never
     * outlive — or be shared by — more than one session. The new `worktrees`
     * table carries the checkout, and `session_worktree_links` attaches the
     * sessions that run in it. Existing rows migrate one-to-one: the worktree
     * id is derived from the old session id (`ses_<uuid>` → `wt_<uuid>`), so
     * every current session keeps the same path, branch, and behavior.
     *
     * Branch ownership follows the worktree. Chain branches keep a NULL
     * `worktree_id`; their `task_id` ownership is unchanged.
     */
    statements: [
      `CREATE TABLE worktrees (
         id TEXT PRIMARY KEY NOT NULL,
         repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
         path TEXT NOT NULL UNIQUE,
         branch TEXT NOT NULL UNIQUE,
         base_ref TEXT,
         base_oid TEXT NOT NULL,
         state TEXT NOT NULL CHECK (state IN ('creating', 'created', 'ready', 'failed')),
         last_error_json TEXT,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         CHECK (length(id) > 0),
         CHECK (length(path) > 0),
         CHECK (length(branch) > 0),
         CHECK (length(base_oid) > 0)
       ) STRICT`,
      `CREATE INDEX worktrees_repo_idx ON worktrees (repo_id)`,
      // Why the substr: session IDs are `ses_<uuid>`, so `wt_` + the suffix is
      // a stable `wt_<uuid>` identity derived in SQL without a generator.
      `INSERT INTO worktrees (
         id, repo_id, path, branch, base_ref, base_oid, state,
         last_error_json, created_at, updated_at
       )
       SELECT 'wt_' || substr(session_id, 5), repo_id, path, branch, base_ref,
              base_oid, state, last_error_json, created_at, updated_at
       FROM session_worktrees`,
      `CREATE TABLE session_worktree_links (
         session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
         worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE
       ) STRICT`,
      `CREATE INDEX session_worktree_links_worktree_idx
         ON session_worktree_links (worktree_id)`,
      `INSERT INTO session_worktree_links (session_id, worktree_id)
       SELECT session_id, 'wt_' || substr(session_id, 5) FROM session_worktrees`,
      `DROP TABLE session_worktrees`,
      `ALTER TABLE worktree_branches ADD COLUMN worktree_id TEXT`,
      `UPDATE worktree_branches
       SET worktree_id = 'wt_' || substr(session_id, 5)
       WHERE kind = 'session' AND session_id IS NOT NULL`,
      `CREATE INDEX worktree_branches_worktree_idx
         ON worktree_branches (worktree_id)
         WHERE worktree_id IS NOT NULL`
    ]
  },
  {
    version: 19,
    name: 'harness-catalog',
    /**
     * Harness IDs stop being an inline four-value `CHECK`.
     *
     * The launch catalog now carries 45 CLIs plus the terminal. Enumerating
     * them in `sessions.harness` would force a table rebuild for every future
     * agent, so the allowed set moves to a small `harnesses` table and the
     * session column becomes a foreign key. A new catalog entry is then one
     * INSERT (plus its app data), not a migration that drops and recreates a
     * table referenced by `session_worktree_links`.
     *
     * This migration seeds the current catalog exactly. The app rejects an id
     * missing here before it reaches SQLite; the FK is the second line of
     * defence. `providers` and `assistant_conversations` keep their narrower
     * three-harness CHECKs on purpose: endpoint injection and Mira are
     * capability subsets, not the full launch catalog.
     */
    rebuildsReferencedTable: true,
    statements: [
      `CREATE TABLE harnesses (
         id TEXT PRIMARY KEY NOT NULL,
         CHECK (length(id) > 0)
       ) STRICT`,
      `INSERT INTO harnesses (id) VALUES
         ('claude'),
         ('openclaude'),
         ('codex'),
         ('grok'),
         ('copilot'),
         ('opencode2'),
         ('opencode'),
         ('mimo-code'),
         ('ante'),
         ('trae'),
         ('muse'),
         ('dsh'),
         ('qoder'),
         ('qoder-cn'),
         ('zcode'),
         ('pi'),
         ('omp'),
         ('prime-agent'),
         ('gemini'),
         ('antigravity'),
         ('aider'),
         ('goose'),
         ('amp'),
         ('kilo'),
         ('kiro'),
         ('crush'),
         ('aug'),
         ('autohand'),
         ('cline'),
         ('codebuff'),
         ('freebuff'),
         ('command-code'),
         ('continue'),
         ('cursor'),
         ('droid'),
         ('kimi'),
         ('mistral-vibe'),
         ('qwen-code'),
         ('rovo'),
         ('hermes'),
         ('devin'),
         ('openclaw'),
         ('codebuddy'),
         ('jcode'),
         ('shell')`,
      `CREATE TABLE sessions_new (
         id TEXT PRIMARY KEY NOT NULL,
         workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
         harness TEXT NOT NULL REFERENCES harnesses(id) ON DELETE RESTRICT,
         title TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         last_active_at INTEGER NOT NULL,
         last_observed_state TEXT NOT NULL
           CHECK (last_observed_state IN ('starting', 'live', 'exited', 'failed', 'unavailable')),
         last_observed_exit_code INTEGER,
         last_observed_error_json TEXT,
         last_observed_incarnation_id TEXT,
         last_observed_at INTEGER NOT NULL,
         sleeping_at INTEGER,
         resume_token TEXT,
         role TEXT NOT NULL DEFAULT 'interactive'
           CHECK (role IN ('interactive', 'supervisor')),
         CHECK (length(title) > 0)
       ) STRICT`,
      `INSERT INTO sessions_new (
         id, workspace_id, harness, title, created_at, last_active_at,
         last_observed_state, last_observed_exit_code, last_observed_error_json,
         last_observed_incarnation_id, last_observed_at, sleeping_at, resume_token, role
       )
       SELECT
         id, workspace_id, harness, title, created_at, last_active_at,
         last_observed_state, last_observed_exit_code, last_observed_error_json,
         last_observed_incarnation_id, last_observed_at, sleeping_at, resume_token, role
       FROM sessions`,
      `DROP TABLE sessions`,
      `ALTER TABLE sessions_new RENAME TO sessions`,
      `CREATE INDEX sessions_workspace_idx ON sessions (workspace_id)`
    ]
  },
  {
    version: 20,
    name: 'provider-harnesses',
    /**
     * Provider endpoint injection widens from three harnesses to the
     * documented launch-time set.
     *
     * The list is frozen here on purpose: a migration is a schema snapshot and
     * must not follow the live `PROVIDER_HARNESSES` list, or an old database
     * would accept whatever a future app happens to support. SQLite cannot
     * alter a CHECK, so both provider tables are rebuilt; `providers` is
     * referenced by the selection table, hence `rebuildsReferencedTable`.
     *
     * Only Claude and openclaude accept the two Anthropic auth styles. Every
     * other provider harness derives auth from its own generated config and
     * stores no style.
     */
    rebuildsReferencedTable: true,
    statements: [
      `ALTER TABLE harness_provider_selection RENAME TO harness_provider_selection_old`,
      `ALTER TABLE providers RENAME TO providers_old`,
      `DROP INDEX providers_harness_idx`,
      `CREATE TABLE providers (
         id TEXT PRIMARY KEY NOT NULL,
         harness TEXT NOT NULL CHECK (harness IN (
           'claude',
           'codex',
           'opencode',
           'openclaude',
           'codebuddy',
           'kimi',
           'zcode',
           'qwen-code',
           'kilo',
           'continue',
           'pi',
           'omp',
           'ante',
           'copilot',
           'gemini',
           'aider',
           'goose',
           'grok',
           'mistral-vibe'
         )),
         name TEXT NOT NULL,
         base_url TEXT NOT NULL,
         model TEXT NOT NULL,
         auth_style TEXT CHECK (
           (harness IN ('claude', 'openclaude')
             AND auth_style IN ('auth_token', 'api_key'))
           OR (harness NOT IN ('claude', 'openclaude')
             AND auth_style IS NULL)
         ),
         api_key_cipher BLOB NOT NULL,
         api_key_scheme TEXT NOT NULL CHECK (api_key_scheme IN ('safe_storage_v1')),
         api_key_backend TEXT NOT NULL CHECK (api_key_backend IN ('safe_storage', 'basic_text')),
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         UNIQUE (harness, name),
         CHECK (length(name) > 0 AND length(base_url) > 0 AND length(model) > 0),
         CHECK (length(api_key_cipher) > 0)
       ) STRICT`,
      `INSERT INTO providers (
         id, harness, name, base_url, model, auth_style,
         api_key_cipher, api_key_scheme, api_key_backend, created_at, updated_at
       )
       SELECT
         id, harness, name, base_url, model, auth_style,
         api_key_cipher, api_key_scheme, api_key_backend, created_at, updated_at
       FROM providers_old`,
      `CREATE INDEX providers_harness_idx ON providers (harness, created_at)`,
      `CREATE TABLE harness_provider_selection (
         harness TEXT PRIMARY KEY NOT NULL CHECK (harness IN (
           'claude',
           'codex',
           'opencode',
           'openclaude',
           'codebuddy',
           'kimi',
           'zcode',
           'qwen-code',
           'kilo',
           'continue',
           'pi',
           'omp',
           'ante',
           'copilot',
           'gemini',
           'aider',
           'goose',
           'grok',
           'mistral-vibe'
         )),
         provider_id TEXT REFERENCES providers(id) ON DELETE RESTRICT,
         updated_at INTEGER NOT NULL
       ) STRICT`,
      `INSERT INTO harness_provider_selection (harness, provider_id, updated_at)
       SELECT harness, provider_id, updated_at FROM harness_provider_selection_old`,
      `DROP TABLE harness_provider_selection_old`,
      `DROP TABLE providers_old`
    ]
  },
  {
    version: 21,
    name: 'sidebar-order',
    statements: [
      // Why: one document holds the whole manual order, so a drag writes one
      // row atomically and a removed project/session cannot orphan a row.
      `CREATE TABLE sidebar_order (
         id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
         document TEXT NOT NULL,
         updated_at INTEGER NOT NULL
       ) STRICT`
    ]
  },
  {
    version: 22,
    name: 'bots-teams-and-memory',
    /**
     * Bots are persistent teammates, not a session role.
     *
     * A bot owns one assistant thread. Mira is backfilled as the default bot
     * and keeps the existing main thread; its old assistant_memory rows move
     * into the scoped bot_memory table. Teams and team messages are new.
     * Tasks gain an optional assignee/team and acceptance criteria, while the
     * derived changes_requested state uses a timestamp instead of widening the
     * review_decision CHECK (which would require rebuilding the tasks table).
     *
     * assistant_threads is rebuilt with create-new/drop-old/rename-new, so the
     * child tables' foreign keys still resolve to the table name. The migration
     * runner disables FKs for the rebuild and checks them before COMMIT.
     */
    rebuildsReferencedTable: true,
    statements: [
      `CREATE TABLE bots (
         id TEXT PRIMARY KEY NOT NULL,
         name TEXT NOT NULL,
         role TEXT NOT NULL,
         avatar_color TEXT NOT NULL,
         instructions TEXT NOT NULL DEFAULT '',
         settings_json TEXT,
         archived_at INTEGER,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         CHECK (length(id) > 0 AND length(name) > 0 AND length(role) > 0
                AND length(avatar_color) > 0)
       ) STRICT`,
      `CREATE UNIQUE INDEX bots_name_idx ON bots (name COLLATE NOCASE)`,
      `CREATE INDEX bots_updated_idx ON bots (updated_at)`,

      `CREATE TABLE teams (
         id TEXT PRIMARY KEY NOT NULL,
         name TEXT NOT NULL,
         chief_bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
         last_read_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_read_seq >= 0),
         archived_at INTEGER,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         CHECK (length(id) > 0 AND length(name) > 0)
       ) STRICT`,
      `CREATE INDEX teams_updated_idx ON teams (updated_at)`,

      `CREATE TABLE team_members (
         team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
         bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
         joined_at INTEGER NOT NULL,
         PRIMARY KEY (team_id, bot_id)
       ) STRICT`,
      `CREATE INDEX team_members_bot_idx ON team_members (bot_id)`,

      `CREATE TABLE team_messages (
         id TEXT PRIMARY KEY NOT NULL,
         team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
         seq INTEGER NOT NULL,
         author_kind TEXT NOT NULL CHECK (author_kind IN ('human', 'bot', 'system')),
         author_bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
         body TEXT NOT NULL,
         card_json TEXT,
         dedupe_key TEXT,
         created_at INTEGER NOT NULL,
         UNIQUE (team_id, seq),
         CHECK (length(id) > 0 AND length(body) > 0),
         CHECK ((author_kind = 'bot' AND author_bot_id IS NOT NULL)
             OR (author_kind <> 'bot'))
       ) STRICT`,
      `CREATE INDEX team_messages_team_created_idx ON team_messages (team_id, created_at)`,
      `CREATE UNIQUE INDEX team_messages_dedupe_idx
         ON team_messages (team_id, dedupe_key)
         WHERE dedupe_key IS NOT NULL`,

      `CREATE TABLE bot_memory (
         id TEXT PRIMARY KEY NOT NULL,
         scope TEXT NOT NULL CHECK (scope IN ('bot', 'project', 'team')),
         bot_id TEXT REFERENCES bots(id) ON DELETE CASCADE,
         repo_id TEXT REFERENCES repos(id) ON DELETE CASCADE,
         team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
         proposed_by_bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
         key TEXT NOT NULL,
         value TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT 'active'
           CHECK (status IN ('proposed', 'active', 'archived')),
         source_task_id TEXT,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         CHECK (length(key) > 0 AND length(value) > 0),
         CHECK (
           (scope = 'bot' AND bot_id IS NOT NULL AND repo_id IS NULL AND team_id IS NULL)
           OR (scope = 'project' AND bot_id IS NULL AND repo_id IS NOT NULL AND team_id IS NULL)
           OR (scope = 'team' AND bot_id IS NULL AND repo_id IS NULL AND team_id IS NOT NULL)
         )
       ) STRICT`,
      `CREATE UNIQUE INDEX bot_memory_bot_idx
         ON bot_memory (bot_id, key)
         WHERE scope = 'bot' AND status = 'active'`,
      `CREATE UNIQUE INDEX bot_memory_project_idx
         ON bot_memory (repo_id, key)
         WHERE scope = 'project' AND status = 'active'`,
      `CREATE UNIQUE INDEX bot_memory_team_idx
         ON bot_memory (team_id, key)
         WHERE scope = 'team' AND status = 'active'`,

      `INSERT INTO bots (
         id, name, role, avatar_color, instructions, settings_json,
         archived_at, created_at, updated_at
       ) VALUES (
         'mira', 'Mira', 'Chief of Staff', '#6f7bf7', '', NULL, NULL,
         CAST(strftime('%s', 'now') AS INTEGER) * 1000,
         CAST(strftime('%s', 'now') AS INTEGER) * 1000
       )`,

      `CREATE TABLE assistant_threads_new (
         id TEXT PRIMARY KEY NOT NULL,
         kind TEXT NOT NULL DEFAULT 'main' CHECK (kind IN ('main', 'system', 'bot')),
         title TEXT NOT NULL,
         bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         last_message_at INTEGER,
         last_read_seq INTEGER NOT NULL DEFAULT 0,
         active_run_id TEXT,
         archived_at INTEGER,
         CHECK (length(title) > 0)
       ) STRICT`,
      `INSERT INTO assistant_threads_new (
         id, kind, title, bot_id, created_at, updated_at, last_message_at,
         last_read_seq, active_run_id, archived_at
       )
       SELECT id, kind, title, NULL, created_at, updated_at, last_message_at,
              last_read_seq, active_run_id, archived_at
       FROM assistant_threads`,
      `DROP TABLE assistant_threads`,
      `ALTER TABLE assistant_threads_new RENAME TO assistant_threads`,
      `UPDATE assistant_threads SET bot_id = 'mira' WHERE kind = 'main'`,
      `CREATE UNIQUE INDEX assistant_threads_main_idx
         ON assistant_threads (kind) WHERE kind = 'main'`,
      `CREATE INDEX assistant_threads_updated_idx ON assistant_threads (updated_at)`,
      `CREATE UNIQUE INDEX assistant_threads_bot_idx
         ON assistant_threads (bot_id) WHERE bot_id IS NOT NULL`,

      `ALTER TABLE tasks ADD COLUMN bot_id TEXT`,
      `ALTER TABLE tasks ADD COLUMN team_id TEXT`,
      `ALTER TABLE tasks ADD COLUMN acceptance_criteria TEXT`,
      `ALTER TABLE tasks ADD COLUMN changes_requested_at INTEGER`,
      `CREATE INDEX tasks_bot_status_idx ON tasks (bot_id, status)`,

      `ALTER TABLE assistant_actions ADD COLUMN bot_id TEXT`,

      `INSERT INTO bot_memory (
         id, scope, bot_id, repo_id, team_id, proposed_by_bot_id,
         key, value, status, source_task_id, created_at, updated_at
       )
       SELECT 'mem_mira_' || key, 'bot', 'mira', NULL, NULL, 'mira',
              key, value, 'active', NULL, created_at, updated_at
       FROM assistant_memory`,
      `DROP TABLE assistant_memory`
    ]
  },
  {
    version: 23,
    name: 'default-chief-yarcy',
    /**
     * The default Chief is now called Yarcy, not Mira.
     *
     * Only the untouched defaults are renamed: a bot, thread title or persona
     * name the user already changed is left alone. A conflicting bot named
     * Yarcy also blocks the rename, because bot names are unique NOCASE; the
     * stable id `mira` stays internal so no foreign keys are rebuilt.
     */
    statements: [
      `UPDATE bots
       SET name = 'Yarcy',
           updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
       WHERE id = 'mira'
         AND name = 'Mira'
         AND NOT EXISTS (
           SELECT 1 FROM bots
           WHERE id <> 'mira' AND lower(name) = lower('Yarcy')
         )`,
      `UPDATE assistant_threads
       SET title = (SELECT name FROM bots WHERE id = 'mira')
       WHERE bot_id = 'mira'
         AND title = 'Mira'
         AND EXISTS (SELECT 1 FROM bots WHERE id = 'mira' AND name <> 'Mira')`,
      `UPDATE bots
       SET settings_json = json_set(
         settings_json,
         '$.personaName',
         (SELECT name FROM bots WHERE id = 'mira')
       )
       WHERE id = 'mira'
         AND settings_json IS NOT NULL
         AND json_extract(settings_json, '$.personaName') = 'Mira'
         AND EXISTS (SELECT 1 FROM bots WHERE id = 'mira' AND name <> 'Mira')`,
      `UPDATE assistant_settings
       SET settings_json = json_set(
             settings_json,
             '$.personaName',
             (SELECT name FROM bots WHERE id = 'mira')
           ),
           updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
       WHERE json_extract(settings_json, '$.personaName') = 'Mira'
         AND EXISTS (SELECT 1 FROM bots WHERE id = 'mira' AND name <> 'Mira')`,
      // The greeting is generated by iCode, not typed by the user, so it is
      // safe to keep it in step with the configured name.
      `UPDATE assistant_messages
       SET body = replace(
         body,
         'Mira',
         (SELECT name FROM bots WHERE id = 'mira')
       )
       WHERE kind = 'welcome'
         AND body LIKE '%Mira%'
         AND thread_id IN (SELECT id FROM assistant_threads WHERE bot_id = 'mira')
         AND EXISTS (SELECT 1 FROM bots WHERE id = 'mira' AND name <> 'Mira')`
    ]
  },
  {
    version: 24,
    name: 'bot-groups-and-threads',
    /**
     * A bot group is a room with threads; each member has a session per thread.
     *
     * Teams are copied into groups and their messages move into one default
     * thread, while the legacy team tables stay readable until the Bots UI
     * cutover. Bots keep their existing home thread. Do not rely on RENAME to
     * update foreign keys because the runner disables them around rebuilds.
     */
    rebuildsReferencedTable: true,
    statements: [
      `CREATE TABLE bot_groups (
         id TEXT PRIMARY KEY NOT NULL,
         name TEXT NOT NULL,
         revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
         default_bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
         reply_mode TEXT NOT NULL DEFAULT 'mentions'
           CHECK (reply_mode IN ('bot', 'all', 'mentions')),
         archived_at INTEGER,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         CHECK (length(id) > 0 AND length(name) > 0)
       ) STRICT`,
      `CREATE INDEX bot_groups_updated_idx ON bot_groups (updated_at)`,

      `CREATE TABLE bot_group_members (
         group_id TEXT NOT NULL REFERENCES bot_groups(id) ON DELETE CASCADE,
         bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
         joined_at INTEGER NOT NULL,
         PRIMARY KEY (group_id, bot_id)
       ) STRICT`,
      `CREATE INDEX bot_group_members_bot_idx ON bot_group_members (bot_id)`,

      `CREATE TABLE bot_group_threads (
         id TEXT PRIMARY KEY NOT NULL,
         group_id TEXT NOT NULL REFERENCES bot_groups(id) ON DELETE CASCADE,
         title TEXT NOT NULL,
         is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
         last_read_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_read_seq >= 0),
         last_read_at INTEGER NOT NULL DEFAULT 0 CHECK (last_read_at >= 0),
         last_activity_at INTEGER NOT NULL DEFAULT 0 CHECK (last_activity_at >= 0),
         latest_author_name TEXT,
         latest_text TEXT,
         latest_at INTEGER,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         CHECK (length(id) > 0 AND length(title) > 0)
       ) STRICT`,
      `CREATE INDEX bot_group_threads_group_idx ON bot_group_threads (group_id, created_at)`,
      `CREATE UNIQUE INDEX bot_group_threads_default_idx
         ON bot_group_threads (group_id) WHERE is_default = 1`,

      `INSERT INTO bot_groups (
         id, name, revision, default_bot_id, reply_mode,
         archived_at, created_at, updated_at
       )
       SELECT t.id, t.name, 1,
         CASE WHEN EXISTS (
           SELECT 1 FROM team_members m
           WHERE m.team_id = t.id AND m.bot_id = t.chief_bot_id
         ) THEN t.chief_bot_id ELSE NULL END,
         CASE WHEN EXISTS (
           SELECT 1 FROM team_members m
           WHERE m.team_id = t.id AND m.bot_id = t.chief_bot_id
         ) THEN 'bot' ELSE 'mentions' END,
         t.archived_at, t.created_at, t.updated_at
       FROM teams t`,
      `INSERT INTO bot_group_members (group_id, bot_id, joined_at)
       SELECT team_id, bot_id, joined_at FROM team_members`,

      `INSERT INTO bot_group_threads (
         id, group_id, title, is_default, last_read_seq, last_read_at,
         last_activity_at, latest_author_name, latest_text, latest_at,
         created_at, updated_at
       )
       SELECT
         'gthread_' || t.id,
         t.id,
         t.name,
         1,
         t.last_read_seq,
         CASE WHEN t.last_read_seq >= COALESCE((
           SELECT MAX(m.seq) FROM team_messages m WHERE m.team_id = t.id
         ), 0)
           THEN COALESCE((
             SELECT MAX(m.created_at) FROM team_messages m WHERE m.team_id = t.id
           ), t.updated_at)
           ELSE 0
         END,
         COALESCE((
           SELECT MAX(m.created_at) FROM team_messages m WHERE m.team_id = t.id
         ), t.updated_at),
         (
           SELECT CASE
             WHEN m.author_kind = 'bot' THEN (SELECT b.name FROM bots b WHERE b.id = m.author_bot_id)
             WHEN m.author_kind = 'human' THEN NULL
             ELSE 'System'
           END
           FROM team_messages m
           WHERE m.team_id = t.id
           ORDER BY m.seq DESC LIMIT 1
         ),
         (
           SELECT m.body FROM team_messages m
           WHERE m.team_id = t.id
           ORDER BY m.seq DESC LIMIT 1
         ),
         (
           SELECT m.created_at FROM team_messages m
           WHERE m.team_id = t.id
           ORDER BY m.seq DESC LIMIT 1
         ),
         t.created_at,
         t.updated_at
       FROM teams t`,

      `CREATE TABLE assistant_threads_new (
         id TEXT PRIMARY KEY NOT NULL,
         kind TEXT NOT NULL DEFAULT 'main'
           CHECK (kind IN ('main', 'system', 'bot', 'room')),
         title TEXT NOT NULL,
         bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
         group_thread_id TEXT REFERENCES bot_group_threads(id) ON DELETE SET NULL,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         last_message_at INTEGER,
         last_read_seq INTEGER NOT NULL DEFAULT 0,
         active_run_id TEXT,
         archived_at INTEGER,
         CHECK (length(title) > 0),
         CHECK (group_thread_id IS NULL OR (kind = 'room' AND bot_id IS NOT NULL))
       ) STRICT`,
      `INSERT INTO assistant_threads_new (
         id, kind, title, bot_id, group_thread_id, created_at, updated_at,
         last_message_at, last_read_seq, active_run_id, archived_at
       )
       SELECT id, kind, title, bot_id, NULL, created_at, updated_at,
              last_message_at, last_read_seq, active_run_id, archived_at
       FROM assistant_threads`,
      `DROP TABLE assistant_threads`,
      `ALTER TABLE assistant_threads_new RENAME TO assistant_threads`,
      `CREATE UNIQUE INDEX assistant_threads_main_idx
         ON assistant_threads (kind) WHERE kind = 'main'`,
      `CREATE INDEX assistant_threads_updated_idx ON assistant_threads (updated_at)`,
      `CREATE UNIQUE INDEX assistant_threads_home_idx
         ON assistant_threads (bot_id)
         WHERE bot_id IS NOT NULL AND group_thread_id IS NULL`,
      `CREATE UNIQUE INDEX assistant_threads_room_idx
         ON assistant_threads (bot_id, group_thread_id)
         WHERE group_thread_id IS NOT NULL`,

      `CREATE TABLE bot_group_thread_members (
         thread_id TEXT NOT NULL REFERENCES bot_group_threads(id) ON DELETE CASCADE,
         bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
         assistant_thread_id TEXT REFERENCES assistant_threads(id) ON DELETE SET NULL,
         stopped_through_sequence INTEGER NOT NULL DEFAULT 0
           CHECK (stopped_through_sequence >= 0),
         joined_at INTEGER NOT NULL,
         PRIMARY KEY (thread_id, bot_id)
       ) STRICT`,
      `CREATE INDEX bot_group_thread_members_bot_idx
         ON bot_group_thread_members (bot_id)`,
      `CREATE UNIQUE INDEX bot_group_thread_members_session_idx
         ON bot_group_thread_members (assistant_thread_id)
         WHERE assistant_thread_id IS NOT NULL`,
      `INSERT INTO bot_group_thread_members (
         thread_id, bot_id, assistant_thread_id, stopped_through_sequence, joined_at
       )
       SELECT 'gthread_' || m.team_id, m.bot_id, NULL, 0, m.joined_at
       FROM team_members m`,

      `CREATE TABLE bot_group_messages (
         id TEXT PRIMARY KEY NOT NULL,
         group_id TEXT NOT NULL REFERENCES bot_groups(id) ON DELETE CASCADE,
         thread_id TEXT NOT NULL REFERENCES bot_group_threads(id) ON DELETE CASCADE,
         seq INTEGER NOT NULL CHECK (seq >= 1),
         author_kind TEXT NOT NULL CHECK (author_kind IN ('human', 'bot', 'system')),
         author_bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
         author_name TEXT,
         body TEXT NOT NULL,
         card_json TEXT,
         dedupe_key TEXT,
         root_request_id TEXT,
         root_sequence INTEGER,
         requester_bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
         requester_name TEXT,
         mentioned INTEGER NOT NULL DEFAULT 0 CHECK (mentioned IN (0, 1)),
         from_items INTEGER NOT NULL DEFAULT 0 CHECK (from_items IN (0, 1)),
         from_reports INTEGER NOT NULL DEFAULT 0 CHECK (from_reports IN (0, 1)),
         task_id TEXT,
         created_at INTEGER NOT NULL,
         UNIQUE (thread_id, seq),
         CHECK (length(id) > 0 AND length(body) > 0),
         CHECK ((author_kind = 'bot' AND author_bot_id IS NOT NULL)
             OR (author_kind <> 'bot'))
       ) STRICT`,
      `CREATE INDEX bot_group_messages_thread_created_idx
         ON bot_group_messages (thread_id, created_at)`,
      `CREATE INDEX bot_group_messages_group_created_idx
         ON bot_group_messages (group_id, created_at)`,
      `CREATE UNIQUE INDEX bot_group_messages_dedupe_idx
         ON bot_group_messages (thread_id, dedupe_key)
         WHERE dedupe_key IS NOT NULL`,
      `CREATE INDEX bot_group_messages_root_idx
         ON bot_group_messages (root_request_id)
         WHERE root_request_id IS NOT NULL`,
      `INSERT INTO bot_group_messages (
         id, group_id, thread_id, seq, author_kind, author_bot_id, author_name,
         body, card_json, dedupe_key, root_request_id, root_sequence,
         requester_bot_id, requester_name, mentioned, from_items, from_reports,
         task_id, created_at
       )
       SELECT
         m.id, m.team_id, 'gthread_' || m.team_id, m.seq, m.author_kind,
         m.author_bot_id,
         CASE
           WHEN m.author_kind = 'bot' THEN (SELECT b.name FROM bots b WHERE b.id = m.author_bot_id)
           WHEN m.author_kind = 'human' THEN NULL
           ELSE 'System'
         END,
         m.body, m.card_json, m.dedupe_key, m.id, m.seq,
         NULL, NULL, 0, 0, 0, NULL, m.created_at
       FROM team_messages m`,

      `CREATE TABLE bot_group_turns (
         operation_id TEXT PRIMARY KEY NOT NULL,
         message_id TEXT NOT NULL REFERENCES bot_group_messages(id) ON DELETE CASCADE,
         group_id TEXT NOT NULL,
         thread_id TEXT NOT NULL,
         bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
         bot_name TEXT NOT NULL,
         assistant_thread_id TEXT,
         run_id TEXT,
         status TEXT NOT NULL DEFAULT 'queued'
           CHECK (status IN ('queued', 'working', 'completed', 'failed', 'cancelled', 'inactive')),
         reply TEXT,
         error TEXT,
         context_json TEXT,
         handed_off_json TEXT NOT NULL DEFAULT '[]',
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         delivered_at INTEGER,
         UNIQUE (message_id, bot_id)
       ) STRICT`,
      `CREATE INDEX bot_group_turns_message_idx ON bot_group_turns (message_id)`,
      `CREATE INDEX bot_group_turns_thread_idx
         ON bot_group_turns (thread_id, created_at)`,
      `CREATE INDEX bot_group_turns_session_idx
         ON bot_group_turns (assistant_thread_id)
         WHERE assistant_thread_id IS NOT NULL`,

      `CREATE TABLE bot_memory_new (
         id TEXT PRIMARY KEY NOT NULL,
         scope TEXT NOT NULL CHECK (scope IN ('bot', 'project', 'team')),
         bot_id TEXT REFERENCES bots(id) ON DELETE CASCADE,
         repo_id TEXT REFERENCES repos(id) ON DELETE CASCADE,
         -- Group id. The FK moves to bot_groups once the legacy team tables are
         -- dropped at the Bots UI cutover; keeping it loose lets the old team
         -- tests keep creating their fixture teams during the transition.
         team_id TEXT,
         proposed_by_bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
         key TEXT NOT NULL,
         value TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT 'active'
           CHECK (status IN ('proposed', 'active', 'archived')),
         source_task_id TEXT,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         CHECK (length(key) > 0 AND length(value) > 0),
         CHECK (
           (scope = 'bot' AND bot_id IS NOT NULL AND repo_id IS NULL AND team_id IS NULL)
           OR (scope = 'project' AND bot_id IS NULL AND repo_id IS NOT NULL AND team_id IS NULL)
           OR (scope = 'team' AND bot_id IS NULL AND repo_id IS NULL AND team_id IS NOT NULL)
         )
       ) STRICT`,
      `INSERT INTO bot_memory_new (
         id, scope, bot_id, repo_id, team_id, proposed_by_bot_id,
         key, value, status, source_task_id, created_at, updated_at
       )
       SELECT id, scope, bot_id, repo_id, team_id, proposed_by_bot_id,
              key, value, status, source_task_id, created_at, updated_at
       FROM bot_memory`,
      `DROP TABLE bot_memory`,
      `ALTER TABLE bot_memory_new RENAME TO bot_memory`,
      `CREATE UNIQUE INDEX bot_memory_bot_idx
         ON bot_memory (bot_id, key)
         WHERE scope = 'bot' AND status = 'active'`,
      `CREATE UNIQUE INDEX bot_memory_project_idx
         ON bot_memory (repo_id, key)
         WHERE scope = 'project' AND status = 'active'`,
      `CREATE UNIQUE INDEX bot_memory_team_idx
         ON bot_memory (team_id, key)
         WHERE scope = 'team' AND status = 'active'`,

      `ALTER TABLE bots ADD COLUMN paused_at INTEGER`,
      `ALTER TABLE tasks ADD COLUMN group_thread_id TEXT`,
      `UPDATE tasks
       SET group_thread_id = (
         SELECT t.id FROM bot_group_threads t
         WHERE t.group_id = tasks.team_id AND t.is_default = 1
       )
       WHERE team_id IS NOT NULL`,
      `CREATE INDEX tasks_group_thread_idx
         ON tasks (group_thread_id, updated_at)
         WHERE group_thread_id IS NOT NULL`
    ]
  },
  {
    version: 25,
    name: 'task-items',
    /**
     * Items are tasks with owner-facing conversation. Comments and questions
     * live in their own table; the derived item status (shared/domain/item.ts)
     * never duplicates the task's queue or review state.
     */
    statements: [
      `ALTER TABLE tasks ADD COLUMN snoozed_until INTEGER`,
      `CREATE TABLE task_comments (
         id TEXT PRIMARY KEY,
         task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
         author_kind TEXT NOT NULL CHECK (author_kind IN ('owner', 'bot', 'system')),
         author_bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
         author_name TEXT,
         kind TEXT NOT NULL CHECK (kind IN ('comment', 'question', 'status', 'answer')),
         body TEXT NOT NULL,
         options_json TEXT,
         recommended_option TEXT,
         reply_to_id TEXT REFERENCES task_comments(id) ON DELETE SET NULL,
         answered_at INTEGER,
         dedupe_key TEXT,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         CHECK (length(body) > 0)
       ) STRICT`,
      `CREATE INDEX task_comments_task_created_idx
         ON task_comments (task_id, created_at)`,
      `CREATE INDEX task_comments_open_question_idx
         ON task_comments (task_id)
         WHERE kind = 'question' AND answered_at IS NULL`,
      `CREATE UNIQUE INDEX task_comments_dedupe_idx
         ON task_comments (task_id, dedupe_key)
         WHERE dedupe_key IS NOT NULL`,
      `CREATE TABLE task_links (
         task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
         kind TEXT NOT NULL CHECK (kind IN ('url', 'file', 'pr')),
         ref TEXT NOT NULL,
         added_at INTEGER NOT NULL,
         PRIMARY KEY (task_id, kind, ref),
         CHECK (length(ref) > 0)
       ) STRICT`,
      `CREATE INDEX task_links_task_idx ON task_links (task_id, added_at)`
    ]
  },
  {
    version: 26,
    name: 'drop-legacy-teams',
    /**
     * The Bots UI now reads groups only. Point memory at bot_groups, rename the
     * task routing column to its real meaning, and delete the legacy team
     * tables. `bot_memory.scope = 'team'` stays the storage alias for a group.
     */
    statements: [
      `CREATE TABLE bot_memory_new (
         id TEXT PRIMARY KEY NOT NULL,
         scope TEXT NOT NULL CHECK (scope IN ('bot', 'project', 'team')),
         bot_id TEXT REFERENCES bots(id) ON DELETE CASCADE,
         repo_id TEXT REFERENCES repos(id) ON DELETE CASCADE,
         team_id TEXT REFERENCES bot_groups(id) ON DELETE CASCADE,
         proposed_by_bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
         key TEXT NOT NULL,
         value TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT 'active'
           CHECK (status IN ('proposed', 'active', 'archived')),
         source_task_id TEXT,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         CHECK (length(key) > 0 AND length(value) > 0),
         CHECK (
           (scope = 'bot' AND bot_id IS NOT NULL AND repo_id IS NULL AND team_id IS NULL)
           OR (scope = 'project' AND bot_id IS NULL AND repo_id IS NOT NULL AND team_id IS NULL)
           OR (scope = 'team' AND bot_id IS NULL AND repo_id IS NULL AND team_id IS NOT NULL)
         )
       ) STRICT`,
      `INSERT INTO bot_memory_new (
         id, scope, bot_id, repo_id, team_id, proposed_by_bot_id,
         key, value, status, source_task_id, created_at, updated_at
       )
       SELECT id, scope, bot_id, repo_id, team_id, proposed_by_bot_id,
              key, value, status, source_task_id, created_at, updated_at
       FROM bot_memory`,
      `DROP TABLE bot_memory`,
      `ALTER TABLE bot_memory_new RENAME TO bot_memory`,
      `CREATE UNIQUE INDEX bot_memory_bot_idx
         ON bot_memory (bot_id, key)
         WHERE scope = 'bot' AND status = 'active'`,
      `CREATE UNIQUE INDEX bot_memory_project_idx
         ON bot_memory (repo_id, key)
         WHERE scope = 'project' AND status = 'active'`,
      `CREATE UNIQUE INDEX bot_memory_team_idx
         ON bot_memory (team_id, key)
         WHERE scope = 'team' AND status = 'active'`,
      `ALTER TABLE tasks RENAME COLUMN team_id TO group_id`,
      `DROP TABLE team_messages`,
      `DROP TABLE team_members`,
      `DROP TABLE teams`
    ]
  },
  {
    version: 27,
    name: 'group-mute',
    /** A muted group keeps its unread state but sends no system notifications. */
    statements: [`ALTER TABLE bot_groups ADD COLUMN muted_at INTEGER`]
  },
  {
    version: 28,
    name: 'bot-avatar-image',
    /** One uploaded picture per bot; null keeps the color-and-initial avatar. */
    statements: [`ALTER TABLE bots ADD COLUMN avatar_image TEXT`]
  },
  {
    version: 29,
    name: 'item-status-override',
    /** A manual owner-facing item status; null keeps the derived status. */
    statements: [`ALTER TABLE tasks ADD COLUMN item_status_override TEXT`]
  },
  {
    version: 30,
    name: 'worker-item-links',
    /** Item evidence can point at a worker as well as a URL, file, or PR. */
    statements: [
      `CREATE TABLE task_links_new (
         task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
         kind TEXT NOT NULL CHECK (kind IN ('url', 'file', 'pr', 'worker')),
         ref TEXT NOT NULL,
         added_at INTEGER NOT NULL,
         PRIMARY KEY (task_id, kind, ref),
         CHECK (length(ref) > 0)
       ) STRICT`,
      `INSERT INTO task_links_new (task_id, kind, ref, added_at)
       SELECT task_id, kind, ref, added_at FROM task_links`,
      `DROP TABLE task_links`,
      `ALTER TABLE task_links_new RENAME TO task_links`,
      `CREATE INDEX task_links_task_idx ON task_links (task_id, added_at)`
    ]
  },
  {
    version: 31,
    name: 'bot-avatar-mascot-outfit',
    /** A mascot glyph and an outfit ring are the non-picture avatar variants. */
    statements: [
      `ALTER TABLE bots ADD COLUMN avatar_mascot TEXT`,
      `ALTER TABLE bots ADD COLUMN avatar_outfit TEXT`
    ]
  },
  {
    version: 32,
    name: 'item-attachments',
    /** Owner-visible files attached to a task/item, stored inline as data URLs. */
    statements: [
      `CREATE TABLE task_attachments (
         id TEXT PRIMARY KEY,
         task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
         name TEXT NOT NULL,
         mime TEXT NOT NULL,
         size INTEGER NOT NULL,
         data_url TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         CHECK (length(name) > 0 AND size >= 0 AND size <= 2000000)
       ) STRICT`,
      `CREATE INDEX task_attachments_task_idx ON task_attachments (task_id, created_at)`
    ]
  },
  {
    version: 33,
    name: 'builtin-assistant-bot-name',
    /**
     * The built-in assistant keeps an internal profile, but its name must not
     * reserve a name in the owner's bot namespace: a bot the owner creates may
     * use it. Owners still cannot create two bots with the same name.
     */
    statements: [
      `DROP INDEX bots_name_idx`,
      `CREATE UNIQUE INDEX bots_name_idx ON bots (name COLLATE NOCASE)
         WHERE id <> 'mira'`
    ]
  },
  {
    version: 34,
    name: 'assistant-profile-name',
    /**
     * "Yarcy" is now an ordinary Chief of Staff template, not the built-in
     * assistant's persona. Rename only the untouched defaults; a customized
     * assistant name, role or thread title is left alone.
     */
    statements: [
      `UPDATE bots
         SET name = 'Assistant',
             role = 'Workspace assistant',
             updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
       WHERE id = 'mira' AND name IN ('Yarcy', 'Mira') AND role = 'Chief of Staff'`,
      `UPDATE bots
         SET name = 'Assistant',
             updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
       WHERE id = 'mira' AND name IN ('Yarcy', 'Mira')`,
      `UPDATE assistant_threads
         SET title = 'Assistant',
             updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
       WHERE bot_id = 'mira' AND title IN ('Yarcy', 'Mira')`,
      `UPDATE assistant_settings
         SET settings_json = json_set(settings_json, '$.personaName', 'Assistant'),
             updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
       WHERE json_extract(settings_json, '$.personaName') IN ('Yarcy', 'Mira')`,
      `UPDATE bots
         SET settings_json = json_set(settings_json, '$.personaName', 'Assistant')
       WHERE id = 'mira' AND settings_json IS NOT NULL
         AND json_extract(settings_json, '$.personaName') IN ('Yarcy', 'Mira')`,
      `UPDATE assistant_messages
         SET body = replace(replace(body, 'Yarcy', 'Assistant'), 'Mira', 'Assistant')
       WHERE kind = 'welcome'
         AND thread_id IN (SELECT id FROM assistant_threads WHERE bot_id = 'mira')`
    ]
  },
  {
    version: 35,
    name: 'retire-global-assistant',
    /**
     * Bots own chat now. The global main thread and its internal profile stay
     * in the database for history, but are archived so no surface or runtime
     * resolves them.
     */
    statements: [
      `DELETE FROM bot_group_thread_members WHERE bot_id = 'mira'`,
      `DELETE FROM bot_group_members WHERE bot_id = 'mira'`,
      `UPDATE bot_groups SET default_bot_id = NULL WHERE default_bot_id = 'mira'`,
      `UPDATE bot_groups SET reply_mode = 'mentions'
       WHERE reply_mode = 'bot' AND default_bot_id IS NULL`,
      `UPDATE bots
         SET archived_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
             updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
       WHERE id = 'mira' AND archived_at IS NULL`,
      `UPDATE assistant_threads
         SET archived_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
             updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
       WHERE kind = 'main' AND archived_at IS NULL`
    ]
  },
  {
    version: 36,
    name: 'bot-peer-mail',
    /**
     * One bot asking another a question outside a group room. The queue is
     * durable so a restart, or a target that is mid-turn, does not lose it.
     */
    statements: [
      `CREATE TABLE bot_peer_mail (
         id TEXT PRIMARY KEY,
         from_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
         to_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
         body TEXT NOT NULL CHECK (length(body) > 0 AND length(body) <= 4000),
         depth INTEGER NOT NULL DEFAULT 0 CHECK (depth >= 0 AND depth <= 2),
         status TEXT NOT NULL DEFAULT 'queued'
           CHECK (status IN ('queued', 'delivering', 'delivered', 'failed')),
         error TEXT,
         message_id TEXT,
         created_at INTEGER NOT NULL,
         delivered_at INTEGER
       ) STRICT`,
      `CREATE INDEX bot_peer_mail_to_idx
         ON bot_peer_mail (to_bot_id, status, created_at)`
    ]
  },
  {
    version: 37,
    name: 'bot-automations',
    /**
     * A recurring prompt a bot runs in its home chat. The next run is stored
     * so a restart does not fire a backlog and a busy bot retries later.
     */
    statements: [
      `CREATE TABLE bot_automations (
         id TEXT PRIMARY KEY,
         bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
         name TEXT NOT NULL CHECK (length(name) > 0 AND length(name) <= 120),
         prompt TEXT NOT NULL CHECK (length(prompt) > 0 AND length(prompt) <= 4000),
         interval_minutes INTEGER NOT NULL
           CHECK (interval_minutes >= 1 AND interval_minutes <= 10080),
         enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
         last_run_at INTEGER,
         next_run_at INTEGER NOT NULL,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       ) STRICT`,
      `CREATE INDEX bot_automations_due_idx
         ON bot_automations (enabled, next_run_at)`,
      `CREATE INDEX bot_automations_bot_idx
         ON bot_automations (bot_id, created_at)`
    ]
  }
]
