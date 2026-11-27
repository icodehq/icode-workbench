import type { Database } from './database'
import { assistantCardSchema } from '../../shared/schemas/assistant'
import type {
  AssistantCard,
  AssistantConversation,
  AssistantConversationHistoryMode,
  AssistantConversationResetReason,
  AssistantConversationState,
  AssistantMessageKind,
  AssistantNotificationKind,
  AssistantNotificationState,
  AssistantPriority,
  AssistantRole,
  AssistantRun,
  AssistantRunStatus,
  AssistantThread,
  AssistantTrigger
} from '../../shared/domain/assistant'
import {
  ASSISTANT_CONVERSATION_HISTORY_MODES,
  ASSISTANT_CONVERSATION_RESET_REASONS,
  ASSISTANT_CONVERSATION_STATES
} from '../../shared/domain/assistant'
import { MODEL_HARNESSES, type ModelHarness } from '../../shared/domain/harness'

const THREAD_COLUMNS = `id, kind, title, bot_id, is_home, harness, group_thread_id,
  created_at, updated_at, last_message_at, last_read_seq, active_run_id, archived_at`

const MESSAGE_COLUMNS = `id, thread_id, seq, run_id, role, kind, body, card_json,
  notification_kind, notification_priority, notification_state,
  notification_dedupe_key, notified_at, metadata_json, created_at`

const RUN_COLUMNS = `id, thread_id, trigger, status, stage, harness, target_kind,
  target_distro, round, request_message_id, response_message_id, resume_token,
  usage_json, context_chars, started_at, finished_at, error`

const CONVERSATION_COLUMNS = `id, thread_id, harness, target_kind, target_distro,
  native_session_id, state, reset_reason, history_mode, last_prompt_seq,
  start_seq, end_seq, created_at, updated_at, observed_at`

type ThreadRow = {
  id: string
  kind: string
  title: string
  bot_id: string | null
  is_home: number
  harness: string | null
  group_thread_id: string | null
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

type ConversationRow = {
  id: string
  thread_id: string
  harness: string
  target_kind: string
  target_distro: string | null
  native_session_id: string | null
  state: string
  reset_reason: string | null
  history_mode: string
  last_prompt_seq: number | null
  start_seq: number | null
  end_seq: number | null
  created_at: number
  updated_at: number
  observed_at: number | null
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
    kind:
      row.kind === 'system'
        ? 'system'
        : row.kind === 'bot'
          ? 'bot'
          : row.kind === 'room'
            ? 'room'
            : 'main',
    title: requireString(row.title, 'assistant_threads.title'),
    botId: row.bot_id === null ? null : requireString(row.bot_id, 'assistant_threads.bot_id'),
    isHome: row.is_home === 1,
    harness:
      row.harness === null
        ? null
        : requireEnum(row.harness, MODEL_HARNESSES, 'assistant_threads.harness'),
    groupThreadId:
      row.group_thread_id === null
        ? null
        : requireString(row.group_thread_id, 'assistant_threads.group_thread_id'),
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

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  column: string
): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T
  }
  throw new Error(`iCode assistant row has an invalid ${column}.`)
}

function conversationFromRow(row: ConversationRow): AssistantConversation {
  const harness = row.harness
  if (
    typeof harness !== 'string' ||
    !(MODEL_HARNESSES as readonly string[]).includes(harness)
  ) {
    throw new Error('iCode assistant row has an invalid assistant_conversations.harness.')
  }
  const assistantHarness = harness as ModelHarness
  const targetKind = row.target_kind
  if (targetKind !== 'local' && targetKind !== 'wsl') {
    throw new Error('iCode assistant row has an invalid assistant_conversations.target_kind.')
  }
  return {
    id: requireString(row.id, 'assistant_conversations.id'),
    threadId: requireString(row.thread_id, 'assistant_conversations.thread_id'),
    harness: assistantHarness,
    targetKind,
    targetDistro: row.target_distro,
    nativeSessionId: row.native_session_id,
    state: requireEnum(
      row.state,
      ASSISTANT_CONVERSATION_STATES,
      'assistant_conversations.state'
    ),
    resetReason:
      row.reset_reason === null
        ? null
        : requireEnum(
            row.reset_reason,
            ASSISTANT_CONVERSATION_RESET_REASONS,
            'assistant_conversations.reset_reason'
          ),
    historyMode: requireEnum(
      row.history_mode,
      ASSISTANT_CONVERSATION_HISTORY_MODES,
      'assistant_conversations.history_mode'
    ),
    lastPromptSeq: nullableInteger(
      row.last_prompt_seq,
      'assistant_conversations.last_prompt_seq'
    ),
    startSeq: nullableInteger(row.start_seq, 'assistant_conversations.start_seq'),
    endSeq: nullableInteger(row.end_seq, 'assistant_conversations.end_seq'),
    createdAt: requireInteger(row.created_at, 'assistant_conversations.created_at'),
    updatedAt: requireInteger(row.updated_at, 'assistant_conversations.updated_at'),
    observedAt: nullableInteger(row.observed_at, 'assistant_conversations.observed_at')
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
           id, kind, title, bot_id, is_home, harness, group_thread_id,
           created_at, updated_at, last_message_at, last_read_seq, active_run_id,
           archived_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        thread.id,
        thread.kind,
        thread.title,
        thread.botId,
        thread.isHome ? 1 : 0,
        thread.harness,
        thread.groupThreadId,
        thread.createdAt,
        thread.updatedAt,
        thread.lastMessageAt,
        thread.lastReadSeq,
        thread.activeRunId,
        thread.archivedAt
      )
    return this.findThread(thread.id)!
  }

  /** A bot's one home chat; room sessions are separate. */
  findThreadByBotId(botId: string): AssistantThread | null {
    return this.findHomeThreadByBotId(botId)
  }

  findHomeThreadByBotId(botId: string): AssistantThread | null {
    const row = this.db.raw
      .prepare(
        `SELECT ${THREAD_COLUMNS} FROM assistant_threads
         WHERE bot_id = ? AND is_home = 1
         ORDER BY created_at ASC LIMIT 1`
      )
      .get(botId) as ThreadRow | undefined
    return row ? threadFromRow(row) : null
  }

  /** A bot's home chat first, then its side chats, newest activity first. */
  listChatsForBot(botId: string): AssistantThread[] {
    const rows = this.db.raw
      .prepare(
        `SELECT ${THREAD_COLUMNS} FROM assistant_threads
         WHERE bot_id = ? AND kind = 'bot' AND archived_at IS NULL
         ORDER BY is_home DESC, COALESCE(last_message_at, created_at) DESC`
      )
      .all(botId) as ThreadRow[]
    return rows.map(threadFromRow)
  }

  /**
   * Makes `threadId` the bot's one home chat. The previous home becomes an
   * ordinary side chat instead of being archived, matching the reference's
   * "New Home Chat" flow.
   */
  setHomeThread(botId: string, threadId: string, now: number): AssistantThread | null {
    return this.db.transaction(() => {
      const target = this.findThread(threadId)
      if (
        target === null ||
        target.botId !== botId ||
        target.kind !== 'bot' ||
        target.archivedAt !== null ||
        target.groupThreadId !== null
      ) {
        return null
      }
      const previous = this.findHomeThreadByBotId(botId)
      if (previous !== null && previous.id !== threadId) {
        this.db.raw
          .prepare(
            `UPDATE assistant_threads SET is_home = 0, updated_at = ? WHERE id = ?`
          )
          .run(now, previous.id)
      }
      this.db.raw
        .prepare(`UPDATE assistant_threads SET is_home = 1, updated_at = ? WHERE id = ?`)
        .run(now, threadId)
      return this.findThread(threadId)
    })
  }

  /** The text a released home chat is named from when it becomes a side chat. */
  latestUserMessageBody(threadId: string): string | null {
    const row = this.db.raw
      .prepare(
        `SELECT body FROM assistant_messages
         WHERE thread_id = ? AND role = 'user'
         ORDER BY seq DESC LIMIT 1`
      )
      .get(threadId) as { body: string } | undefined
    return row?.body ?? null
  }

  findRoomThread(botId: string, groupThreadId: string): AssistantThread | null {
    const row = this.db.raw
      .prepare(
        `SELECT ${THREAD_COLUMNS} FROM assistant_threads
         WHERE bot_id = ? AND group_thread_id = ? AND kind = 'room'
         ORDER BY created_at ASC LIMIT 1`
      )
      .get(botId, groupThreadId) as ThreadRow | undefined
    return row ? threadFromRow(row) : null
  }

  listThreadsForBot(botId: string): AssistantThread[] {
    const rows = this.db.raw
      .prepare(
        `SELECT ${THREAD_COLUMNS} FROM assistant_threads
         WHERE bot_id = ? ORDER BY created_at ASC`
      )
      .all(botId) as ThreadRow[]
    return rows.map(threadFromRow)
  }

  archiveRoomThread(id: string, now: number): void {
    this.db.raw
      .prepare(
        `UPDATE assistant_threads SET archived_at = ?, updated_at = ?
         WHERE id = ? AND kind = 'room'`
      )
      .run(now, now, id)
  }

  /** Archive every room session attached to the given group threads. */
  archiveRoomThreadsForGroupThreads(threadIds: readonly string[], now: number): void {
    const ids = [...new Set(threadIds)]
    if (ids.length === 0) return
    const placeholders = ids.map(() => '?').join(', ')
    this.db.raw
      .prepare(
        `UPDATE assistant_threads
         SET archived_at = ?, updated_at = ?
         WHERE kind = 'room' AND archived_at IS NULL
           AND group_thread_id IN (${placeholders})`
      )
      .run(now, now, ...ids)
  }

  updateThreadTitle(id: string, title: string, now: number): void {
    this.db.raw
      .prepare(`UPDATE assistant_threads SET title = ?, updated_at = ? WHERE id = ?`)
      .run(title, now, id)
  }

  /**
   * Durable bot-chat transcript search for Session History. Room sessions are
   * skipped because their messages live in the group store.
   */
  searchBotMessages(
    query: string,
    limit: number
  ): Array<{ threadId: string; botId: string; body: string; createdAt: number }> {
    const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`
    const rows = this.db.raw
      .prepare(
        `SELECT m.thread_id AS thread_id, t.bot_id AS bot_id, m.body AS body,
                m.created_at AS created_at
         FROM assistant_messages m
         JOIN assistant_threads t ON t.id = m.thread_id
         WHERE t.kind = 'bot' AND t.group_thread_id IS NULL
           AND t.archived_at IS NULL AND m.body LIKE ? ESCAPE '\\'
         ORDER BY m.created_at DESC LIMIT ?`
      )
      .all(pattern, limit) as Array<{
      thread_id: string
      bot_id: string
      body: string
      created_at: number
    }>
    return rows.map((row) => ({
      threadId: row.thread_id,
      botId: row.bot_id,
      body: row.body,
      createdAt: row.created_at
    }))
  }

  findConversation(id: string): AssistantConversation | null {
    const row = this.db.raw
      .prepare(`SELECT ${CONVERSATION_COLUMNS} FROM assistant_conversations WHERE id = ?`)
      .get(id) as ConversationRow | undefined
    return row ? conversationFromRow(row) : null
  }

  findActiveConversation(threadId: string): AssistantConversation | null {
    const row = this.db.raw
      .prepare(
        `SELECT ${CONVERSATION_COLUMNS} FROM assistant_conversations
         WHERE thread_id = ? AND state = 'active'
         ORDER BY rowid DESC LIMIT 1`
      )
      .get(threadId) as ConversationRow | undefined
    return row ? conversationFromRow(row) : null
  }

  /** rowid, not created_at: a reset and the next send can share a millisecond. */
  findLatestConversation(threadId: string): AssistantConversation | null {
    const row = this.db.raw
      .prepare(
        `SELECT ${CONVERSATION_COLUMNS} FROM assistant_conversations
         WHERE thread_id = ?
         ORDER BY rowid DESC LIMIT 1`
      )
      .get(threadId) as ConversationRow | undefined
    return row ? conversationFromRow(row) : null
  }

  insertConversation(input: {
    id: string
    threadId: string
    harness: AssistantConversation['harness']
    targetKind: AssistantConversation['targetKind']
    targetDistro: string | null
    historyMode: AssistantConversationHistoryMode
    startSeq: number
    createdAt: number
  }): AssistantConversation {
    this.db.transaction(() => {
      // Keep the predecessor's range honest even if a caller forgot to retire it.
      this.db.raw
        .prepare(
          `UPDATE assistant_conversations
           SET end_seq = ?, updated_at = ?
           WHERE id = (
             SELECT id FROM assistant_conversations
             WHERE thread_id = ? AND start_seq IS NOT NULL
               AND start_seq < ? AND end_seq IS NULL
             ORDER BY start_seq DESC LIMIT 1
           )`
        )
        .run(input.startSeq - 1, input.createdAt, input.threadId, input.startSeq)
      this.db.raw
        .prepare(
          `INSERT INTO assistant_conversations (
             id, thread_id, harness, target_kind, target_distro, native_session_id,
             state, reset_reason, history_mode, last_prompt_seq, start_seq, end_seq,
             created_at, updated_at, observed_at
           ) VALUES (?, ?, ?, ?, ?, NULL, 'active', NULL, ?, NULL, ?, NULL, ?, ?, NULL)`
        )
        .run(
          input.id,
          input.threadId,
          input.harness,
          input.targetKind,
          input.targetDistro,
          input.historyMode,
          input.startSeq,
          input.createdAt,
          input.createdAt
        )
    })
    return this.findConversation(input.id)!
  }

  /** Persist the harness's continuation handle as soon as it is observed. */
  setConversationSession(id: string, nativeSessionId: string, now: number): void {
    this.db.raw
      .prepare(
        `UPDATE assistant_conversations
         SET native_session_id = ?, observed_at = ?, updated_at = ?
         WHERE id = ? AND state = 'active'`
      )
      .run(nativeSessionId, now, now, id)
  }

  touchConversation(
    id: string,
    input: { now: number; lastPromptSeq: number | null }
  ): void {
    this.db.raw
      .prepare(
        `UPDATE assistant_conversations
         SET last_prompt_seq = COALESCE(?, last_prompt_seq), updated_at = ?
         WHERE id = ? AND state = 'active'`
      )
      .run(input.lastPromptSeq, input.now, id)
  }

  retireConversation(
    id: string,
    input: {
      state: Extract<AssistantConversationState, 'reset' | 'invalid'>
      reason: AssistantConversationResetReason
      now: number
      endSeq?: number
    }
  ): AssistantConversation | null {
    const current = this.findConversation(id)
    if (current === null) return null
    const endSeq =
      input.endSeq !== undefined ? input.endSeq : this.latestMessageSeq(current.threadId)
    const result = this.db.raw
      .prepare(
        `UPDATE assistant_conversations
         SET state = ?, reset_reason = ?, end_seq = COALESCE(?, end_seq), updated_at = ?
         WHERE id = ? AND state = 'active'`
      )
      .run(input.state, input.reason, endSeq, input.now, id)
    return Number(result.changes) === 1 ? this.findConversation(id) : null
  }

  resetActiveConversation(
    threadId: string,
    input: { reason: AssistantConversationResetReason; now: number; endSeq?: number }
  ): AssistantConversation | null {
    return this.db.transaction(() => {
      const active = this.findActiveConversation(threadId)
      if (!active) return null
      const state: 'reset' | 'invalid' =
        input.reason === 'resume-failed' || input.reason === 'resume-unsupported'
          ? 'invalid'
          : 'reset'
      return this.retireConversation(active.id, {
        state,
        reason: input.reason,
        now: input.now,
        ...(input.endSeq === undefined ? {} : { endSeq: input.endSeq })
      })
    })
  }

  latestMessageSeq(threadId: string): number | null {
    const row = this.db.raw
      .prepare(
        'SELECT MAX(seq) AS seq FROM assistant_messages WHERE thread_id = ?'
      )
      .get(threadId) as { seq: number | null } | undefined
    return row?.seq ?? null
  }

  listConversations(threadId: string, limit = 50): AssistantConversation[] {
    const clamped = Math.max(1, Math.min(200, limit))
    const rows = this.db.raw
      .prepare(
        `SELECT ${CONVERSATION_COLUMNS} FROM assistant_conversations
         WHERE thread_id = ? AND start_seq IS NOT NULL
         ORDER BY start_seq DESC, rowid DESC LIMIT ?`
      )
      .all(threadId, clamped) as ConversationRow[]
    return rows.reverse().map(conversationFromRow)
  }

  findConversationForSeq(threadId: string, seq: number): AssistantConversation | null {
    const row = this.db.raw
      .prepare(
        `SELECT ${CONVERSATION_COLUMNS} FROM assistant_conversations
         WHERE thread_id = ? AND start_seq IS NOT NULL AND start_seq <= ?
         ORDER BY start_seq DESC LIMIT 1`
      )
      .get(threadId, seq) as ConversationRow | undefined
    return row ? conversationFromRow(row) : null
  }

  findNextConversation(threadId: string, startSeq: number): AssistantConversation | null {
    const row = this.db.raw
      .prepare(
        `SELECT ${CONVERSATION_COLUMNS} FROM assistant_conversations
         WHERE thread_id = ? AND start_seq IS NOT NULL AND start_seq > ?
         ORDER BY start_seq ASC, rowid ASC LIMIT 1`
      )
      .get(threadId, startSeq) as ConversationRow | undefined
    return row ? conversationFromRow(row) : null
  }

  listMessagesInRange(
    threadId: string,
    options: {
      startSeq: number
      endSeq: number | null
      beforeSeq?: number
      limit?: number
    }
  ): AssistantMessageRecord[] {
    const limit = Math.max(1, Math.min(200, options.limit ?? 100))
    const before = options.beforeSeq ?? Number.MAX_SAFE_INTEGER
    const end = options.endSeq ?? Number.MAX_SAFE_INTEGER
    const rows = this.db.raw
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM assistant_messages
         WHERE thread_id = ? AND seq >= ? AND seq <= ? AND seq < ?
         ORDER BY seq DESC LIMIT ?`
      )
      .all(threadId, options.startSeq, end, before, limit) as MessageRow[]
    return rows.map(messageFromRow).reverse()
  }

  listRecentNotifications(threadId: string, limit = 10): AssistantMessageRecord[] {
    const clamped = Math.max(1, Math.min(50, limit))
    const rows = this.db.raw
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM assistant_messages
         WHERE thread_id = ? AND role = 'assistant'
           AND (kind = 'notification' OR notification_kind IS NOT NULL)
         ORDER BY seq DESC LIMIT ?`
      )
      .all(threadId, clamped) as MessageRow[]
    return rows.map(messageFromRow).reverse()
  }

  /** Deterministic outcome digest for a resumed turn. */
  listDigestMessages(
    threadId: string,
    afterSeq: number,
    limit = 10
  ): AssistantMessageRecord[] {
    const clamped = Math.max(1, Math.min(50, limit))
    const rows = this.db.raw
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM assistant_messages
         WHERE thread_id = ? AND seq > ?
           AND kind IN ('notification', 'card', 'action', 'error')
         ORDER BY seq DESC LIMIT ?`
      )
      .all(threadId, afterSeq, clamped) as MessageRow[]
    return rows.map(messageFromRow).reverse()
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

  setReadSeq(threadId: string, seq: number, now: number): number {
    this.db.raw
      .prepare(
        `UPDATE assistant_threads
         SET last_read_seq = ?, updated_at = ?
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

  /** The newest run of a thread, for the prompt-size ring its composer shows. */
  latestRunForThread(threadId: string): AssistantRun | null {
    const row = this.db.raw
      .prepare(
        `SELECT ${RUN_COLUMNS} FROM assistant_runs
         WHERE thread_id = ? ORDER BY started_at DESC, id DESC LIMIT 1`
      )
      .get(threadId) as RunRow | undefined
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
      resumeToken?: string | null
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
             response_message_id = ?, resume_token = ?, usage_json = ?, context_chars = ?,
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
        patch.resumeToken !== undefined ? patch.resumeToken : current.resume_token,
        patch.usage !== undefined ? JSON.stringify(patch.usage) : current.usage_json,
        patch.contextChars !== undefined ? patch.contextChars : current.context_chars,
        patch.finishedAt !== undefined ? patch.finishedAt : current.finished_at,
        patch.error !== undefined ? patch.error : current.error,
        id
      )
  }

  failStaleRuns(now: number, threadId?: string): number {
    const result =
      threadId === undefined
        ? this.db.raw
            .prepare(
              `UPDATE assistant_runs
               SET status = 'failed', stage = NULL, finished_at = ?,
                   error = COALESCE(error, 'iCode restarted before this run finished.')
               WHERE status IN ('queued', 'running')`
            )
            .run(now)
        : this.db.raw
            .prepare(
              `UPDATE assistant_runs
               SET status = 'failed', stage = NULL, finished_at = ?,
                   error = COALESCE(error, 'iCode restarted before this run finished.')
               WHERE status IN ('queued', 'running') AND thread_id = ?`
            )
            .run(now, threadId)
    if (threadId === undefined) {
      this.db.raw
        .prepare(`UPDATE assistant_threads SET active_run_id = NULL WHERE active_run_id IS NOT NULL`)
        .run()
    } else {
      this.db.raw
        .prepare(`UPDATE assistant_threads SET active_run_id = NULL WHERE id = ? AND active_run_id IS NOT NULL`)
        .run(threadId)
    }
    return Number(result.changes)
  }

  recordAction(input: {
    threadId?: string | null
    runId?: string | null
    actor: 'mira' | 'human' | 'system'
    botId?: string | null
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
           thread_id, run_id, actor, bot_id, op, repo_id, task_id, session_id,
           outcome, detail_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.threadId ?? null,
        input.runId ?? null,
        input.actor,
        input.botId ?? null,
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
