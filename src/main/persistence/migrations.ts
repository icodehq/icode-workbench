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
  }
]
