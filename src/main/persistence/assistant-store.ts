import type { Database } from './database'
import {
  assistantCardSchema,
  assistantSettingsSchema
} from '../../shared/schemas/assistant'
import type {
  AssistantCard,
  AssistantMessageKind,
  AssistantNotificationKind,
  AssistantNotificationState,
  AssistantPriority,
  AssistantRole,
  AssistantRun,
  AssistantRunStatus,
  AssistantSettings,
  AssistantThread,
  AssistantTrigger
} from '../../shared/domain/assistant'
import { DEFAULT_ASSISTANT_SETTINGS } from '../../shared/domain/assistant'

const THREAD_COLUMNS = `id, kind, title, created_at, updated_at, last_message_at,
  last_read_seq, active_run_id, archived_at`

const MESSAGE_COLUMNS = `id, thread_id, seq, run_id, role, kind, body, card_json,
  notification_kind, notification_priority, notification_state,
  notification_dedupe_key, notified_at, metadata_json, created_at`

const RUN_COLUMNS = `id, thread_id, trigger, status, stage, harness, target_kind,
  target_distro, round, request_message_id, response_message_id, resume_token,
  usage_json, context_chars, started_at, finished_at, error`

type ThreadRow = {
  id: string
  kind: string
  title: string
  created_at: number
  updated_at: number
  last_message_at: number | null
  last_read_seq: number
  active_run_id: string | null
  archived_at: number | null
}

type MessageRow = {
  id: string
  thread_id: string
  seq: number
  run_id: string | null
  role: string
  kind: string
  body: string
  card_json: string | null
  notification_kind: string | null
  notification_priority: string | null
  notification_state: string | null
  notification_dedupe_key: string | null
  notified_at: number | null
  metadata_json: string | null
  created_at: number
}

type RunRow = {
  id: string
  thread_id: string
  trigger: string
  status: string
  stage: string | null
  harness: string | null
  target_kind: string | null
  target_distro: string | null
  round: number
  request_message_id: string | null
  response_message_id: string | null
  resume_token: string | null
  usage_json: string | null
  context_chars: number | null
  started_at: number
  finished_at: number | null
  error: string | null
}

function requireString(value: unknown, column: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`iCode assistant row has an invalid ${column}.`)
  }
  return value
}

function requireInteger(value: unknown, column: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`iCode assistant row has an invalid ${column}.`)
  }
  return value
}

function nullableInteger(value: unknown, column: string): number | null {
  if (value === null) return null
  return requireInteger(value, column)
}

function parseCard(value: unknown): AssistantCard | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new Error('iCode assistant row has an invalid card.')
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('iCode assistant row has malformed card JSON.')
  }
  const result = assistantCardSchema.safeParse(parsed)
  if (!result.success) throw new Error('iCode assistant row has an unsupported card.')
  return result.data
}

function threadFromRow(row: ThreadRow): AssistantThread {
  return {
    id: requireString(row.id, 'assistant_threads.id'),
    kind: row.kind === 'system' ? 'system' : 'main',
    title: requireString(row.title, 'assistant_threads.title'),
    createdAt: requireInteger(row.created_at, 'assistant_threads.created_at'),
    updatedAt: requireInteger(row.updated_at, 'assistant_threads.updated_at'),
    lastMessageAt: nullableInteger(row.last_message_at, 'assistant_threads.last_message_at'),
    lastReadSeq: requireInteger(row.last_read_seq, 'assistant_threads.last_read_seq'),
    activeRunId: row.active_run_id,
    archivedAt: nullableInteger(row.archived_at, 'assistant_threads.archived_at')
  }
}

export type AssistantMessageRecord = {
  id: string
  threadId: string
  seq: number
  runId: string | null
  role: AssistantRole
  kind: AssistantMessageKind
  body: string
  card: AssistantCard | null
  notificationKind: AssistantNotificationKind | null
  notificationPriority: AssistantPriority | null
  notificationState: AssistantNotificationState | null
  createdAt: number
}

function messageFromRow(row: MessageRow): AssistantMessageRecord {
  return {
    id: requireString(row.id, 'assistant_messages.id'),
    threadId: requireString(row.thread_id, 'assistant_messages.thread_id'),
    seq: requireInteger(row.seq, 'assistant_messages.seq'),
    runId: row.run_id,
    role: row.role as AssistantRole,
    kind: row.kind as AssistantMessageKind,
    body: requireString(row.body, 'assistant_messages.body'),
    card: parseCard(row.card_json),
    notificationKind: (row.notification_kind as AssistantNotificationKind | null) ?? null,
    notificationPriority: (row.notification_priority as AssistantPriority | null) ?? null,
    notificationState:
      (row.notification_state as AssistantNotificationState | null) ?? null,
    createdAt: requireInteger(row.created_at, 'assistant_messages.created_at')
  }
}

function runFromRow(row: RunRow): AssistantRun {
  return {
    id: requireString(row.id, 'assistant_runs.id'),
    threadId: requireString(row.thread_id, 'assistant_runs.thread_id'),
    trigger: row.trigger as AssistantTrigger,
    status: row.status as AssistantRunStatus,
    stage: row.stage,
    harness: row.harness as AssistantRun['harness'],
    targetKind: row.target_kind as AssistantRun['targetKind'],
    targetDistro: row.target_distro,
    round: requireInteger(row.round, 'assistant_runs.round'),
    contextChars: nullableInteger(row.context_chars, 'assistant_runs.context_chars'),
    startedAt: requireInteger(row.started_at, 'assistant_runs.started_at'),
    finishedAt: nullableInteger(row.finished_at, 'assistant_runs.finished_at'),
    error: row.error
  }
}

export type AppendAssistantMessageInput = {
  id: string
  threadId: string
  runId?: string | null
  role: AssistantRole
  kind: AssistantMessageKind
  body: string
  card?: AssistantCard | null
  notificationKind?: AssistantNotificationKind | null
  notificationPriority?: AssistantPriority | null
  notificationState?: AssistantNotificationState | null
  notificationDedupeKey?: string | null
  metadata?: unknown
  createdAt: number
}

export class AssistantStore {
  constructor(private readonly db: Database) {}

  findMainThread(): AssistantThread | null {
    const row = this.db.raw
      .prepare(
        `SELECT ${THREAD_COLUMNS} FROM assistant_threads
         WHERE kind = 'main' AND archived_at IS NULL
         ORDER BY created_at ASC LIMIT 1`
      )
      .get() as ThreadRow | undefined
    return row ? threadFromRow(row) : null
  }

  findThread(id: string): AssistantThread | null {
    const row = this.db.raw
      .prepare(`SELECT ${THREAD_COLUMNS} FROM assistant_threads WHERE id = ?`)
      .get(id) as ThreadRow | undefined
    return row ? threadFromRow(row) : null
  }

  insertThread(thread: AssistantThread): AssistantThread {
    this.db.raw
      .prepare(
        `INSERT INTO assistant_threads (
           id, kind, title, created_at, updated_at, last_message_at,
           last_read_seq, active_run_id, archived_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        thread.id,
        thread.kind,
        thread.title,
        thread.createdAt,
        thread.updatedAt,
        thread.lastMessageAt,
        thread.lastReadSeq,
        thread.activeRunId,
        thread.archivedAt
      )
    return this.findThread(thread.id)!
  }

  listMessages(
    threadId: string,
    options: { beforeSeq?: number; limit?: number } = {}
  ): AssistantMessageRecord[] {
    const limit = Math.max(1, Math.min(200, options.limit ?? 100))
    const before = options.beforeSeq ?? Number.MAX_SAFE_INTEGER
    const rows = this.db.raw
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM assistant_messages
         WHERE thread_id = ? AND seq < ?
         ORDER BY seq DESC LIMIT ?`
      )
      .all(threadId, before, limit) as MessageRow[]
    return rows.map(messageFromRow).reverse()
  }

  getMessage(id: string): AssistantMessageRecord | null {
    const row = this.db.raw
      .prepare(`SELECT ${MESSAGE_COLUMNS} FROM assistant_messages WHERE id = ?`)
      .get(id) as MessageRow | undefined
    return row ? messageFromRow(row) : null
  }

  /**
   * Appends a message with a per-thread sequence. A duplicate notification
   * dedupe key returns null and changes nothing.
   */
  appendMessage(input: AppendAssistantMessageInput): AssistantMessageRecord | null {
    return this.db.transaction(() => {
      const next = this.db.raw
        .prepare(
          `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM assistant_messages WHERE thread_id = ?`
        )
        .get(input.threadId) as { next: number }
      const result = this.db.raw
        .prepare(
          `INSERT OR IGNORE INTO assistant_messages (
             id, thread_id, seq, run_id, role, kind, body, card_json,
             notification_kind, notification_priority, notification_state,
             notification_dedupe_key, notified_at, metadata_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.id,
          input.threadId,
          next.next,
          input.runId ?? null,
          input.role,
          input.kind,
          input.body,
          input.card ? JSON.stringify(input.card) : null,
          input.notificationKind ?? null,
          input.notificationPriority ?? null,
          input.notificationState ?? null,
          input.notificationDedupeKey ?? null,
          input.notificationState === 'delivered' ? input.createdAt : null,
          input.metadata === undefined ? null : JSON.stringify(input.metadata),
          input.createdAt
        )
      if (Number(result.changes) === 0) return null
      this.db.raw
        .prepare(
          `UPDATE assistant_threads
           SET last_message_at = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(input.createdAt, input.createdAt, input.threadId)
      return this.getMessage(input.id)
    })
  }

  unreadCount(threadId: string): number {
    const thread = this.findThread(threadId)
    if (!thread) return 0
    const row = this.db.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM assistant_messages
         WHERE thread_id = ? AND seq > ? AND role <> 'user'`
      )
      .get(threadId, thread.lastReadSeq) as { n: number }
    return Number(row.n)
  }

  markRead(threadId: string, seq: number, now: number): number {
    this.db.raw
      .prepare(
        `UPDATE assistant_threads
         SET last_read_seq = MAX(last_read_seq, ?), updated_at = ?
         WHERE id = ?`
      )
      .run(seq, now, threadId)
    return this.unreadCount(threadId)
  }

  markNotificationDelivered(messageId: string, now: number): void {
    this.db.raw
      .prepare(
        `UPDATE assistant_messages
         SET notification_state = 'delivered', notified_at = ?
         WHERE id = ?`
      )
      .run(now, messageId)
  }

  claimRun(threadId: string, runId: string): boolean {
    const result = this.db.raw
      .prepare(
        `UPDATE assistant_threads SET active_run_id = ?, updated_at = ?
         WHERE id = ? AND active_run_id IS NULL`
      )
      .run(runId, Date.now(), threadId)
    return Number(result.changes) === 1
  }

  releaseRun(threadId: string, runId: string): void {
    this.db.raw
      .prepare(
        `UPDATE assistant_threads SET active_run_id = NULL, updated_at = ?
         WHERE id = ? AND active_run_id = ?`
      )
      .run(Date.now(), threadId, runId)
  }

  createRun(input: {
    id: string
    threadId: string
    trigger: AssistantTrigger
    harness: string
    startedAt: number
  }): AssistantRun {
    this.db.raw
      .prepare(
        `INSERT INTO assistant_runs (
           id, thread_id, trigger, status, stage, harness, target_kind,
           target_distro, round, request_message_id, response_message_id,
           resume_token, usage_json, context_chars, started_at, finished_at, error
         ) VALUES (?, ?, ?, 'running', 'planning', ?, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL)`
      )
      .run(input.id, input.threadId, input.trigger, input.harness, input.startedAt)
    return this.findRun(input.id)!
  }

  findRun(id: string): AssistantRun | null {
    const row = this.db.raw
      .prepare(`SELECT ${RUN_COLUMNS} FROM assistant_runs WHERE id = ?`)
      .get(id) as RunRow | undefined
    return row ? runFromRow(row) : null
  }

  updateRun(
    id: string,
    patch: {
      status?: AssistantRunStatus
      stage?: string | null
      harness?: string | null
      targetKind?: 'local' | 'wsl' | null
      targetDistro?: string | null
      round?: number
      responseMessageId?: string | null
      usage?: unknown
      contextChars?: number | null
      finishedAt?: number | null
      error?: string | null
    }
  ): void {
    const current = this.db.raw
      .prepare(`SELECT ${RUN_COLUMNS} FROM assistant_runs WHERE id = ?`)
      .get(id) as RunRow | undefined
    if (!current) return
    this.db.raw
      .prepare(
        `UPDATE assistant_runs
         SET status = ?, stage = ?, harness = ?, target_kind = ?, target_distro = ?, round = ?,
             response_message_id = ?, usage_json = ?, context_chars = ?,
             finished_at = ?, error = ?
         WHERE id = ?`
      )
      .run(
        patch.status ?? current.status,
        patch.stage !== undefined ? patch.stage : current.stage,
        patch.harness !== undefined ? patch.harness : current.harness,
        patch.targetKind !== undefined ? patch.targetKind : current.target_kind,
        patch.targetDistro !== undefined ? patch.targetDistro : current.target_distro,
        patch.round ?? current.round,
        patch.responseMessageId !== undefined
          ? patch.responseMessageId
          : current.response_message_id,
        patch.usage !== undefined ? JSON.stringify(patch.usage) : current.usage_json,
        patch.contextChars !== undefined ? patch.contextChars : current.context_chars,
        patch.finishedAt !== undefined ? patch.finishedAt : current.finished_at,
        patch.error !== undefined ? patch.error : current.error,
        id
      )
  }

  failStaleRuns(now: number): number {
    const result = this.db.raw
      .prepare(
        `UPDATE assistant_runs
         SET status = 'failed', stage = NULL, finished_at = ?,
             error = COALESCE(error, 'iCode restarted before this run finished.')
         WHERE status IN ('queued', 'running')`
      )
      .run(now)
    this.db.raw
      .prepare(`UPDATE assistant_threads SET active_run_id = NULL WHERE active_run_id IS NOT NULL`)
      .run()
    return Number(result.changes)
  }

  getSettings(): AssistantSettings {
    const row = this.db.raw
      .prepare(`SELECT settings_json FROM assistant_settings WHERE id = 1`)
      .get() as { settings_json: string } | undefined
    if (!row) return DEFAULT_ASSISTANT_SETTINGS
    try {
      const parsed = assistantSettingsSchema.safeParse(JSON.parse(row.settings_json))
      return parsed.success ? parsed.data : DEFAULT_ASSISTANT_SETTINGS
    } catch {
      return DEFAULT_ASSISTANT_SETTINGS
    }
  }

  saveSettings(settings: AssistantSettings, now: number): AssistantSettings {
    this.db.raw
      .prepare(
        `INSERT INTO assistant_settings (id, settings_json, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET settings_json = excluded.settings_json,
           updated_at = excluded.updated_at`
      )
      .run(JSON.stringify(settings), now)
    return settings
  }

  listMemory(): Array<{ key: string; value: string }> {
    const rows = this.db.raw
      .prepare(`SELECT key, value FROM assistant_memory ORDER BY updated_at DESC LIMIT 50`)
      .all() as Array<{ key: string; value: string }>
    return rows
  }

  setMemory(key: string, value: string, now: number): void {
    this.db.raw
      .prepare(
        `INSERT INTO assistant_memory (id, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(`mem_${now}_${key.slice(0, 40)}`, key, value, now, now)
  }

  forgetMemory(key: string): boolean {
    const result = this.db.raw
      .prepare(`DELETE FROM assistant_memory WHERE key = ?`)
      .run(key)
    return Number(result.changes) === 1
  }

  recordAction(input: {
    threadId?: string | null
    runId?: string | null
    actor: 'mira' | 'human' | 'system'
    op: string
    repoId?: string | null
    taskId?: string | null
    sessionId?: string | null
    outcome: string
    detail?: unknown
    now: number
  }): void {
    this.db.raw
      .prepare(
        `INSERT INTO assistant_actions (
           thread_id, run_id, actor, op, repo_id, task_id, session_id,
           outcome, detail_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.threadId ?? null,
        input.runId ?? null,
        input.actor,
        input.op,
        input.repoId ?? null,
        input.taskId ?? null,
        input.sessionId ?? null,
        input.outcome,
        input.detail === undefined ? null : JSON.stringify(input.detail),
        input.now
      )
  }
}
