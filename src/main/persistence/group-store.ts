import type { Database } from './database'
import type { AssistantCard } from '../../shared/domain/assistant'
import type {
  BotGroupMember,
  BotGroupMessage,
  BotGroupMessageAuthorKind,
  BotGroupRecord,
  BotGroupThread,
  BotGroupThreadMember,
  BotGroupTurn,
  BotGroupTurnStatus,
  GroupReplyMode
} from '../../shared/domain/group'
import { assistantCardSchema } from '../../shared/schemas/assistant'

const GROUP_COLUMNS = `id, name, revision, default_bot_id, reply_mode,
  archived_at, muted_at, created_at, updated_at`

const THREAD_COLUMNS = `id, group_id, title, is_default, last_read_seq, last_read_at,
  last_activity_at, latest_author_name, latest_text, latest_at, created_at, updated_at`

const MESSAGE_COLUMNS = `id, group_id, thread_id, seq, author_kind, author_bot_id,
  author_name, body, card_json, dedupe_key, root_request_id, root_sequence,
  requester_bot_id, requester_name, mentioned, from_items, from_reports, task_id,
  created_at`

const TURN_COLUMNS = `operation_id, message_id, group_id, thread_id, bot_id, bot_name,
  assistant_thread_id, run_id, status, reply, error, context_json, handed_off_json,
  created_at, updated_at, delivered_at`

type GroupRow = {
  id: string
  name: string
  revision: number
  default_bot_id: string | null
  reply_mode: string
  archived_at: number | null
  muted_at: number | null
  created_at: number
  updated_at: number
}

type ThreadRow = {
  id: string
  group_id: string
  title: string
  is_default: number
  last_read_seq: number
  last_read_at: number
  last_activity_at: number
  latest_author_name: string | null
  latest_text: string | null
  latest_at: number | null
  created_at: number
  updated_at: number
}

type MessageRow = {
  id: string
  group_id: string
  thread_id: string
  seq: number
  author_kind: string
  author_bot_id: string | null
  author_name: string | null
  body: string
  card_json: string | null
  dedupe_key: string | null
  root_request_id: string | null
  root_sequence: number | null
  requester_bot_id: string | null
  requester_name: string | null
  mentioned: number
  from_items: number
  from_reports: number
  task_id: string | null
  created_at: number
}

type TurnRow = {
  operation_id: string
  message_id: string
  group_id: string
  thread_id: string
  bot_id: string
  bot_name: string
  assistant_thread_id: string | null
  run_id: string | null
  status: string
  reply: string | null
  error: string | null
  context_json: string | null
  handed_off_json: string
  created_at: number
  updated_at: number
  delivered_at: number | null
}

function requireString(value: unknown, column: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`iCode group row has an invalid ${column}.`)
  }
  return value
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function requireInteger(value: unknown, column: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`iCode group row has an invalid ${column}.`)
  }
  return value
}

function nullableInteger(value: unknown, column: string): number | null {
  if (value === null) return null
  return requireInteger(value, column)
}

function parseCard(value: unknown): AssistantCard | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new Error('iCode group message has invalid card JSON.')
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('iCode group message has malformed card JSON.')
  }
  const result = assistantCardSchema.safeParse(parsed)
  if (!result.success) throw new Error('iCode group message has an unsupported card.')
  return result.data
}

function parseHandedOff(value: unknown): string[] {
  if (typeof value !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function replyModeFromRow(row: GroupRow): GroupReplyMode {
  if (row.reply_mode === 'all') return { kind: 'all' }
  if (row.reply_mode === 'bot' && row.default_bot_id !== null) {
    return { kind: 'bot', botId: row.default_bot_id }
  }
  return { kind: 'mentions' }
}

function groupFromRow(row: GroupRow): BotGroupRecord {
  return {
    id: requireString(row.id, 'bot_groups.id'),
    name: requireString(row.name, 'bot_groups.name'),
    revision: requireInteger(row.revision, 'bot_groups.revision'),
    defaultBotId: nullableString(row.default_bot_id),
    replyMode: replyModeFromRow(row),
    archivedAt: nullableInteger(row.archived_at, 'bot_groups.archived_at'),
    mutedAt: nullableInteger(row.muted_at, 'bot_groups.muted_at'),
    createdAt: requireInteger(row.created_at, 'bot_groups.created_at'),
    updatedAt: requireInteger(row.updated_at, 'bot_groups.updated_at')
  }
}

function threadFromRow(row: ThreadRow): BotGroupThread {
  return {
    id: requireString(row.id, 'bot_group_threads.id'),
    groupId: requireString(row.group_id, 'bot_group_threads.group_id'),
    title: requireString(row.title, 'bot_group_threads.title'),
    isDefault: row.is_default === 1,
    lastReadSeq: requireInteger(row.last_read_seq, 'bot_group_threads.last_read_seq'),
    lastReadAt: requireInteger(row.last_read_at, 'bot_group_threads.last_read_at'),
    lastActivityAt: requireInteger(row.last_activity_at, 'bot_group_threads.last_activity_at'),
    latestAuthorName: nullableString(row.latest_author_name),
    latestText: nullableString(row.latest_text),
    latestAt: nullableInteger(row.latest_at, 'bot_group_threads.latest_at'),
    createdAt: requireInteger(row.created_at, 'bot_group_threads.created_at'),
    updatedAt: requireInteger(row.updated_at, 'bot_group_threads.updated_at')
  }
}

function messageFromRow(row: MessageRow): BotGroupMessage {
  return {
    id: requireString(row.id, 'bot_group_messages.id'),
    groupId: requireString(row.group_id, 'bot_group_messages.group_id'),
    threadId: requireString(row.thread_id, 'bot_group_messages.thread_id'),
    seq: requireInteger(row.seq, 'bot_group_messages.seq'),
    authorKind: row.author_kind as BotGroupMessageAuthorKind,
    authorBotId: nullableString(row.author_bot_id),
    authorName: nullableString(row.author_name),
    body: requireString(row.body, 'bot_group_messages.body'),
    card: parseCard(row.card_json),
    dedupeKey: nullableString(row.dedupe_key),
    rootRequestId: nullableString(row.root_request_id),
    rootSequence: nullableInteger(row.root_sequence, 'bot_group_messages.root_sequence'),
    requesterBotId: nullableString(row.requester_bot_id),
    requesterName: nullableString(row.requester_name),
    mentioned: row.mentioned === 1,
    fromItems: row.from_items === 1,
    fromReports: row.from_reports === 1,
    taskId: nullableString(row.task_id),
    createdAt: requireInteger(row.created_at, 'bot_group_messages.created_at')
  }
}

function turnFromRow(row: TurnRow): BotGroupTurn {
  return {
    operationId: requireString(row.operation_id, 'bot_group_turns.operation_id'),
    messageId: requireString(row.message_id, 'bot_group_turns.message_id'),
    groupId: requireString(row.group_id, 'bot_group_turns.group_id'),
    threadId: requireString(row.thread_id, 'bot_group_turns.thread_id'),
    botId: requireString(row.bot_id, 'bot_group_turns.bot_id'),
    botName: requireString(row.bot_name, 'bot_group_turns.bot_name'),
    assistantThreadId: nullableString(row.assistant_thread_id),
    runId: nullableString(row.run_id),
    status: row.status as BotGroupTurnStatus,
    reply: row.reply,
    error: row.error,
    context: row.context_json,
    handedOff: parseHandedOff(row.handed_off_json),
    createdAt: requireInteger(row.created_at, 'bot_group_turns.created_at'),
    updatedAt: requireInteger(row.updated_at, 'bot_group_turns.updated_at'),
    deliveredAt: nullableInteger(row.delivered_at, 'bot_group_turns.delivered_at')
  }
}

export type AppendGroupMessageInput = {
  id: string
  groupId: string
  threadId: string
  authorKind: BotGroupMessageAuthorKind
  authorBotId: string | null
  authorName: string | null
  body: string
  card?: AssistantCard | null
  dedupeKey?: string | null
  /** The message starts its own root request; its own id/seq become the root. */
  rootSelf?: boolean
  rootRequestId?: string | null
  rootSequence?: number | null
  requesterBotId?: string | null
  requesterName?: string | null
  mentioned?: boolean
  fromItems?: boolean
  fromReports?: boolean
  taskId?: string | null
  createdAt: number
}

export type TurnPatch = {
  status?: BotGroupTurnStatus
  reply?: string | null
  error?: string | null
  assistantThreadId?: string | null
  runId?: string | null
  handedOff?: string[]
  deliveredAt?: number | null
}

export class GroupStore {
  constructor(private readonly db: Database) {}

  insertGroup(group: BotGroupRecord): BotGroupRecord {
    this.db.raw
      .prepare(
        `INSERT INTO bot_groups (
           id, name, revision, default_bot_id, reply_mode, archived_at, muted_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        group.id,
        group.name,
        group.revision,
        group.defaultBotId,
        group.replyMode.kind,
        group.archivedAt,
        group.mutedAt,
        group.createdAt,
        group.updatedAt
      )
    return this.findGroup(group.id)!
  }

  findGroup(id: string): BotGroupRecord | null {
    const row = this.db.raw
      .prepare(`SELECT ${GROUP_COLUMNS} FROM bot_groups WHERE id = ?`)
      .get(id) as GroupRow | undefined
    return row ? groupFromRow(row) : null
  }

  listGroups(options: { includeArchived?: boolean } = {}): BotGroupRecord[] {
    const rows = (
      options.includeArchived === true
        ? this.db.raw.prepare(`SELECT ${GROUP_COLUMNS} FROM bot_groups ORDER BY created_at ASC`).all()
        : this.db.raw
            .prepare(
              `SELECT ${GROUP_COLUMNS} FROM bot_groups
               WHERE archived_at IS NULL ORDER BY created_at ASC`
            )
            .all()
    ) as GroupRow[]
    return rows.map(groupFromRow)
  }

  /** Compare-and-set; null when the group is missing or its revision moved. */
  updateGroup(
    id: string,
    expectedRevision: number,
    patch: {
      name?: string
      defaultBotId?: string | null
      replyMode?: GroupReplyMode
      archivedAt?: number | null
      mutedAt?: number | null
    },
    now: number
  ): BotGroupRecord | null {
    const sets: string[] = ['revision = revision + 1', 'updated_at = ?']
    const params: Array<string | number | null> = [now]
    if (patch.name !== undefined) {
      sets.push('name = ?')
      params.push(patch.name)
    }
    if (patch.defaultBotId !== undefined) {
      sets.push('default_bot_id = ?')
      params.push(patch.defaultBotId)
    }
    if (patch.replyMode !== undefined) {
      sets.push('reply_mode = ?')
      params.push(patch.replyMode.kind)
      if (patch.replyMode.kind === 'bot') {
        sets.push('default_bot_id = ?')
        params.push(patch.replyMode.botId)
      }
    }
    if (patch.archivedAt !== undefined) {
      sets.push('archived_at = ?')
      params.push(patch.archivedAt)
    }
    if (patch.mutedAt !== undefined) {
      sets.push('muted_at = ?')
      params.push(patch.mutedAt)
    }
    const result = this.db.raw
      .prepare(
        `UPDATE bot_groups SET ${sets.join(', ')} WHERE id = ? AND revision = ?`
      )
      .run(...params, id, expectedRevision)
    return Number(result.changes) === 1 ? this.findGroup(id) : null
  }

  deleteGroup(id: string): boolean {
    const result = this.db.raw.prepare(`DELETE FROM bot_groups WHERE id = ?`).run(id)
    return Number(result.changes) === 1
  }

  addMember(groupId: string, botId: string, now: number): void {
    this.db.raw
      .prepare(
        `INSERT INTO bot_group_members (group_id, bot_id, joined_at)
         VALUES (?, ?, ?) ON CONFLICT (group_id, bot_id) DO NOTHING`
      )
      .run(groupId, botId, now)
  }

  removeMember(groupId: string, botId: string): boolean {
    const result = this.db.raw
      .prepare(`DELETE FROM bot_group_members WHERE group_id = ? AND bot_id = ?`)
      .run(groupId, botId)
    return Number(result.changes) === 1
  }

  listMembers(groupId: string): BotGroupMember[] {
    const rows = this.db.raw
      .prepare(
        `SELECT group_id, bot_id, joined_at FROM bot_group_members
         WHERE group_id = ? ORDER BY joined_at ASC, rowid ASC`
      )
      .all(groupId) as Array<{ group_id: string; bot_id: string; joined_at: number }>
    return rows.map((row) => ({
      groupId: requireString(row.group_id, 'bot_group_members.group_id'),
      botId: requireString(row.bot_id, 'bot_group_members.bot_id'),
      joinedAt: requireInteger(row.joined_at, 'bot_group_members.joined_at')
    }))
  }

  groupsForBot(botId: string): BotGroupRecord[] {
    const rows = this.db.raw
      .prepare(
        `SELECT g.id, g.name, g.revision, g.default_bot_id, g.reply_mode,
                g.archived_at, g.muted_at, g.created_at, g.updated_at
         FROM bot_groups g
         JOIN bot_group_members m ON m.group_id = g.id
         WHERE m.bot_id = ? AND g.archived_at IS NULL
         ORDER BY g.created_at ASC`
      )
      .all(botId) as GroupRow[]
    return rows.map(groupFromRow)
  }

  insertThread(thread: BotGroupThread): BotGroupThread {
    this.db.raw
      .prepare(
        `INSERT INTO bot_group_threads (
           id, group_id, title, is_default, last_read_seq, last_read_at,
           last_activity_at, latest_author_name, latest_text, latest_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        thread.id,
        thread.groupId,
        thread.title,
        thread.isDefault ? 1 : 0,
        thread.lastReadSeq,
        thread.lastReadAt,
        thread.lastActivityAt,
        thread.latestAuthorName,
        thread.latestText,
        thread.latestAt,
        thread.createdAt,
        thread.updatedAt
      )
    return this.findThread(thread.id)!
  }

  findThread(id: string): BotGroupThread | null {
    const row = this.db.raw
      .prepare(`SELECT ${THREAD_COLUMNS} FROM bot_group_threads WHERE id = ?`)
      .get(id) as ThreadRow | undefined
    return row ? threadFromRow(row) : null
  }

  listThreads(groupId: string): BotGroupThread[] {
    const rows = this.db.raw
      .prepare(
        `SELECT ${THREAD_COLUMNS} FROM bot_group_threads
         WHERE group_id = ? ORDER BY is_default DESC, created_at ASC`
      )
      .all(groupId) as ThreadRow[]
    return rows.map(threadFromRow)
  }

  updateThreadLatest(
    threadId: string,
    authorName: string | null,
    text: string,
    at: number
  ): void {
    this.db.raw
      .prepare(
        `UPDATE bot_group_threads
         SET latest_author_name = ?, latest_text = ?, latest_at = ?,
             last_activity_at = MAX(last_activity_at, ?), updated_at = ?
         WHERE id = ?`
      )
      .run(authorName, text, at, at, at, threadId)
  }

  updateThreadTitle(id: string, title: string, now: number): void {
    this.db.raw
      .prepare(`UPDATE bot_group_threads SET title = ?, updated_at = ? WHERE id = ?`)
      .run(title, now, id)
  }

  markRead(threadId: string, seq: number, now: number): number {
    this.db.raw
      .prepare(
        `UPDATE bot_group_threads
         SET last_read_seq = MAX(last_read_seq, ?), last_read_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(seq, now, now, threadId)
    return this.unreadCount(threadId)
  }

  setReadSeq(threadId: string, seq: number, now: number): number {
    this.db.raw
      .prepare(
        `UPDATE bot_group_threads
         SET last_read_seq = ?, last_read_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(seq, now, now, threadId)
    return this.unreadCount(threadId)
  }

  latestSequence(threadId: string): number {
    const row = this.db.raw
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) AS seq FROM bot_group_messages WHERE thread_id = ?`
      )
      .get(threadId) as { seq: number }
    return Number(row.seq)
  }

  bumpRevision(groupId: string, now: number): BotGroupRecord | null {
    this.db.raw
      .prepare(
        `UPDATE bot_groups SET revision = revision + 1, updated_at = ? WHERE id = ?`
      )
      .run(now, groupId)
    return this.findGroup(groupId)
  }

  /** Cancel queued/working turns at or before the cutoff. Their sessions are stopped by the caller. */
  cancelTurnsThrough(
    threadId: string,
    cutoff: number,
    botId: string | null,
    now: number
  ): BotGroupTurn[] {
    const rows = (
      botId === null
        ? this.db.raw
            .prepare(
              `SELECT t.* FROM bot_group_turns t
               JOIN bot_group_messages m ON m.id = t.message_id
               WHERE t.thread_id = ? AND t.status IN ('queued', 'working')
                 AND COALESCE(m.root_sequence, 0) <= ?`
            )
            .all(threadId, cutoff)
        : this.db.raw
            .prepare(
              `SELECT t.* FROM bot_group_turns t
               JOIN bot_group_messages m ON m.id = t.message_id
               WHERE t.thread_id = ? AND t.bot_id = ? AND t.status IN ('queued', 'working')
                 AND COALESCE(m.root_sequence, 0) <= ?`
            )
            .all(threadId, botId, cutoff)
    ) as TurnRow[]
    const turns = rows.map(turnFromRow)
    const update = this.db.raw.prepare(
      `UPDATE bot_group_turns SET status = 'cancelled', updated_at = ?
       WHERE operation_id = ?`
    )
    this.db.transaction(() => {
      for (const turn of turns) update.run(now, turn.operationId)
    })
    return turns
  }

  /** Durable room transcript search for Session History. */
  searchMessages(
    query: string,
    limit: number
  ): Array<{
    groupId: string
    threadId: string
    body: string
    createdAt: number
  }> {
    const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`
    const rows = this.db.raw
      .prepare(
        `SELECT group_id, thread_id, body, created_at
         FROM bot_group_messages
         WHERE body LIKE ? ESCAPE '\\'
         ORDER BY created_at DESC LIMIT ?`
      )
      .all(pattern, limit) as Array<{
      group_id: string
      thread_id: string
      body: string
      created_at: number
    }>
    return rows.map((row) => ({
      groupId: row.group_id,
      threadId: row.thread_id,
      body: row.body,
      createdAt: row.created_at
    }))
  }

  unreadCount(threadId: string): number {
    const row = this.db.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM bot_group_messages
         WHERE thread_id = ? AND seq > (
           SELECT last_read_seq FROM bot_group_threads WHERE id = ?
         )`
      )
      .get(threadId, threadId) as { n: number }
    return Number(row.n)
  }

  /**
   * A member's finished turn updates the thread's latest line but adds no
   * message row. It is unread until the thread is read after that line.
   */
  hasUnreadActivity(threadId: string): boolean {
    const row = this.db.raw
      .prepare(
        `SELECT CASE WHEN latest_at IS NOT NULL AND latest_at > last_read_at
                THEN 1 ELSE 0 END AS unread
         FROM bot_group_threads WHERE id = ?`
      )
      .get(threadId) as { unread: number } | undefined
    return row !== undefined && Number(row.unread) === 1
  }

  ensureThreadMembers(threadId: string, botIds: readonly string[], now: number): void {
    const insert = this.db.raw.prepare(
      `INSERT INTO bot_group_thread_members (
         thread_id, bot_id, assistant_thread_id, stopped_through_sequence, joined_at
       ) VALUES (?, ?, NULL, 0, ?) ON CONFLICT (thread_id, bot_id) DO NOTHING`
    )
    this.db.transaction(() => {
      for (const botId of botIds) insert.run(threadId, botId, now)
    })
  }

  findThreadMember(threadId: string, botId: string): BotGroupThreadMember | null {
    const row = this.db.raw
      .prepare(
        `SELECT thread_id, bot_id, assistant_thread_id, stopped_through_sequence, joined_at
         FROM bot_group_thread_members WHERE thread_id = ? AND bot_id = ?`
      )
      .get(threadId, botId) as
      | {
          thread_id: string
          bot_id: string
          assistant_thread_id: string | null
          stopped_through_sequence: number
          joined_at: number
        }
      | undefined
    if (!row) return null
    return {
      threadId: row.thread_id,
      botId: row.bot_id,
      assistantThreadId: row.assistant_thread_id,
      stoppedThroughSequence: row.stopped_through_sequence,
      joinedAt: row.joined_at
    }
  }

  listThreadMembers(threadId: string): BotGroupThreadMember[] {
    const rows = this.db.raw
      .prepare(
        `SELECT thread_id, bot_id, assistant_thread_id, stopped_through_sequence, joined_at
         FROM bot_group_thread_members WHERE thread_id = ?
         ORDER BY joined_at ASC, rowid ASC`
      )
      .all(threadId) as Array<{
      thread_id: string
      bot_id: string
      assistant_thread_id: string | null
      stopped_through_sequence: number
      joined_at: number
    }>
    return rows.map((row) => ({
      threadId: row.thread_id,
      botId: row.bot_id,
      assistantThreadId: row.assistant_thread_id,
      stoppedThroughSequence: row.stopped_through_sequence,
      joinedAt: row.joined_at
    }))
  }

  removeThreadMember(threadId: string, botId: string): boolean {
    const result = this.db.raw
      .prepare(
        `DELETE FROM bot_group_thread_members WHERE thread_id = ? AND bot_id = ?`
      )
      .run(threadId, botId)
    return Number(result.changes) === 1
  }

  setThreadMemberSession(threadId: string, botId: string, assistantThreadId: string): void {
    this.db.raw
      .prepare(
        `UPDATE bot_group_thread_members SET assistant_thread_id = ?
         WHERE thread_id = ? AND bot_id = ?`
      )
      .run(assistantThreadId, threadId, botId)
  }

  stopThreadMember(threadId: string, botId: string | null, throughSequence: number): void {
    if (botId === null) {
      this.db.raw
        .prepare(
          `UPDATE bot_group_thread_members
           SET stopped_through_sequence = MAX(stopped_through_sequence, ?)
           WHERE thread_id = ?`
        )
        .run(throughSequence, threadId)
      return
    }
    this.db.raw
      .prepare(
        `UPDATE bot_group_thread_members
         SET stopped_through_sequence = MAX(stopped_through_sequence, ?)
         WHERE thread_id = ? AND bot_id = ?`
      )
      .run(throughSequence, threadId, botId)
  }

  findMessageByDedupe(threadId: string, dedupeKey: string): BotGroupMessage | null {
    const row = this.db.raw
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM bot_group_messages
         WHERE thread_id = ? AND dedupe_key = ?`
      )
      .get(threadId, dedupeKey) as MessageRow | undefined
    return row === undefined ? null : messageFromRow(row)
  }

  /**
   * Bot hand-offs already posted under one owner request. The cap is per root,
   * not per turn, so two bots cannot each add a full batch.
   */
  countHandoffs(rootRequestId: string): number {
    const row = this.db.raw
      .prepare(
        `SELECT COUNT(*) AS count FROM bot_group_messages
         WHERE root_request_id = ? AND requester_bot_id IS NOT NULL AND author_kind = 'bot'`
      )
      .get(rootRequestId) as { count: number }
    return Number(row.count)
  }

  appendMessage(input: AppendGroupMessageInput): BotGroupMessage {
    if (input.dedupeKey !== null && input.dedupeKey !== undefined) {
      const existing = this.db.raw
        .prepare(
          `SELECT ${MESSAGE_COLUMNS} FROM bot_group_messages
           WHERE thread_id = ? AND dedupe_key = ?`
        )
        .get(input.threadId, input.dedupeKey) as MessageRow | undefined
      if (existing) return messageFromRow(existing)
    }
    const row = this.db.transaction(() => {
      const next = this.db.raw
        .prepare(
          `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM bot_group_messages
           WHERE thread_id = ?`
        )
        .get(input.threadId) as { next: number }
      this.db.raw
        .prepare(
          `INSERT INTO bot_group_messages (
             id, group_id, thread_id, seq, author_kind, author_bot_id, author_name,
             body, card_json, dedupe_key, root_request_id, root_sequence,
             requester_bot_id, requester_name, mentioned, from_items, from_reports,
             task_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.id,
          input.groupId,
          input.threadId,
          next.next,
          input.authorKind,
          input.authorBotId,
          input.authorName,
          input.body,
          input.card === undefined || input.card === null ? null : JSON.stringify(input.card),
          input.dedupeKey ?? null,
          input.rootSelf === true ? input.id : (input.rootRequestId ?? null),
          input.rootSelf === true ? next.next : (input.rootSequence ?? null),
          input.requesterBotId ?? null,
          input.requesterName ?? null,
          input.mentioned === true ? 1 : 0,
          input.fromItems === true ? 1 : 0,
          input.fromReports === true ? 1 : 0,
          input.taskId ?? null,
          input.createdAt
        )
      this.db.raw
        .prepare(
          `UPDATE bot_group_threads
           SET last_activity_at = MAX(last_activity_at, ?),
               latest_author_name = ?, latest_text = ?, latest_at = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          input.createdAt,
          input.authorName,
          input.body,
          input.createdAt,
          input.createdAt,
          input.threadId
        )
      this.db.raw
        .prepare(`UPDATE bot_groups SET updated_at = ? WHERE id = ?`)
        .run(input.createdAt, input.groupId)
      return this.db.raw
        .prepare(`SELECT ${MESSAGE_COLUMNS} FROM bot_group_messages WHERE id = ?`)
        .get(input.id) as MessageRow
    })
    return messageFromRow(row)
  }

  message(id: string): BotGroupMessage | null {
    const row = this.db.raw
      .prepare(`SELECT ${MESSAGE_COLUMNS} FROM bot_group_messages WHERE id = ?`)
      .get(id) as MessageRow | undefined
    return row ? messageFromRow(row) : null
  }

  listMessages(
    threadId: string,
    options: { beforeSeq?: number; limit?: number } = {}
  ): BotGroupMessage[] {
    const limit = Math.max(1, Math.min(options.limit ?? 40, 200))
    const rows = (
      options.beforeSeq === undefined
        ? this.db.raw
            .prepare(
              `SELECT ${MESSAGE_COLUMNS} FROM bot_group_messages
               WHERE thread_id = ? ORDER BY seq DESC LIMIT ?`
            )
            .all(threadId, limit)
        : this.db.raw
            .prepare(
              `SELECT ${MESSAGE_COLUMNS} FROM bot_group_messages
               WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`
            )
            .all(threadId, options.beforeSeq, limit)
    ) as MessageRow[]
    return rows.reverse().map(messageFromRow)
  }

  insertTurn(turn: BotGroupTurn): BotGroupTurn {
    this.db.raw
      .prepare(
        `INSERT INTO bot_group_turns (
           operation_id, message_id, group_id, thread_id, bot_id, bot_name,
           assistant_thread_id, run_id, status, reply, error, context_json,
           handed_off_json, created_at, updated_at, delivered_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        turn.operationId,
        turn.messageId,
        turn.groupId,
        turn.threadId,
        turn.botId,
        turn.botName,
        turn.assistantThreadId,
        turn.runId,
        turn.status,
        turn.reply,
        turn.error,
        turn.context,
        JSON.stringify(turn.handedOff),
        turn.createdAt,
        turn.updatedAt,
        turn.deliveredAt
      )
    return this.turn(turn.operationId)!
  }

  turn(operationId: string): BotGroupTurn | null {
    const row = this.db.raw
      .prepare(`SELECT ${TURN_COLUMNS} FROM bot_group_turns WHERE operation_id = ?`)
      .get(operationId) as TurnRow | undefined
    return row ? turnFromRow(row) : null
  }

  turnsForMessage(messageId: string): BotGroupTurn[] {
    const rows = this.db.raw
      .prepare(
        `SELECT ${TURN_COLUMNS} FROM bot_group_turns
         WHERE message_id = ? ORDER BY created_at ASC, rowid ASC`
      )
      .all(messageId) as TurnRow[]
    return rows.map(turnFromRow)
  }

  turnsForThread(threadId: string): BotGroupTurn[] {
    const rows = this.db.raw
      .prepare(
        `SELECT ${TURN_COLUMNS} FROM bot_group_turns
         WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC`
      )
      .all(threadId) as TurnRow[]
    return rows.map(turnFromRow)
  }

  pendingTurns(): BotGroupTurn[] {
    const rows = this.db.raw
      .prepare(
        `SELECT ${TURN_COLUMNS} FROM bot_group_turns
         WHERE status IN ('queued', 'working') ORDER BY created_at ASC`
      )
      .all() as TurnRow[]
    return rows.map(turnFromRow)
  }

  updateTurn(operationId: string, patch: TurnPatch, now: number): BotGroupTurn | null {
    const sets: string[] = ['updated_at = ?']
    const params: Array<string | number | null> = [now]
    const assign = (column: string, value: string | number | null): void => {
      sets.push(`${column} = ?`)
      params.push(value)
    }
    if (patch.status !== undefined) assign('status', patch.status)
    if (patch.reply !== undefined) assign('reply', patch.reply)
    if (patch.error !== undefined) assign('error', patch.error)
    if (patch.assistantThreadId !== undefined) {
      assign('assistant_thread_id', patch.assistantThreadId)
    }
    if (patch.runId !== undefined) assign('run_id', patch.runId)
    if (patch.deliveredAt !== undefined) assign('delivered_at', patch.deliveredAt)
    if (patch.handedOff !== undefined) {
      assign('handed_off_json', JSON.stringify(patch.handedOff))
    }
    const result = this.db.raw
      .prepare(
        `UPDATE bot_group_turns SET ${sets.join(', ')} WHERE operation_id = ?`
      )
      .run(...params, operationId)
    return Number(result.changes) === 1 ? this.turn(operationId) : null
  }
}
