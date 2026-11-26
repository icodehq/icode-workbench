import type { Database } from '../persistence/database'
import type {
  TaskAttachment,
  TaskComment,
  TaskCommentAuthorKind,
  TaskCommentKind,
  TaskLink,
  TaskLinkKind
} from '../../shared/domain/item'

const COMMENT_COLUMNS = `id, task_id, author_kind, author_bot_id, author_name, kind,
  body, options_json, recommended_option, reply_to_id, answered_at, dedupe_key,
  created_at, updated_at`

const LINK_COLUMNS = `task_id, kind, ref, added_at`
const ATTACHMENT_COLUMNS = `id, task_id, name, mime, size, data_url, created_at`

type CommentRow = {
  id: string
  task_id: string
  author_kind: string
  author_bot_id: string | null
  author_name: string | null
  kind: string
  body: string
  options_json: string | null
  recommended_option: string | null
  reply_to_id: string | null
  answered_at: number | null
  dedupe_key: string | null
  created_at: number
  updated_at: number
}

type AttachmentRow = {
  id: string
  task_id: string
  name: string
  mime: string
  size: number
  data_url: string
  created_at: number
}

type LinkRow = {
  task_id: string
  kind: string
  ref: string
  added_at: number
}

function optionsFromRow(value: string | null): string[] | null {
  if (value === null || value.length === 0) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return null
    const options = parsed.filter((entry): entry is string => typeof entry === 'string')
    return options.length === 0 ? null : options
  } catch {
    return null
  }
}

function commentFromRow(row: CommentRow): TaskComment {
  return {
    id: row.id,
    taskId: row.task_id,
    authorKind: row.author_kind as TaskCommentAuthorKind,
    authorBotId: row.author_bot_id,
    authorName: row.author_name,
    kind: row.kind as TaskCommentKind,
    body: row.body,
    options: optionsFromRow(row.options_json),
    recommendedOption: row.recommended_option,
    replyToId: row.reply_to_id,
    answeredAt: row.answered_at,
    dedupeKey: row.dedupe_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function attachmentFromRow(row: AttachmentRow): TaskAttachment {
  return {
    id: row.id,
    taskId: row.task_id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    dataUrl: row.data_url,
    createdAt: row.created_at
  }
}

function linkFromRow(row: LinkRow): TaskLink {
  return {
    taskId: row.task_id,
    kind: row.kind as TaskLinkKind,
    ref: row.ref,
    addedAt: row.added_at
  }
}

export type InsertTaskCommentInput = {
  id: string
  taskId: string
  authorKind: TaskCommentAuthorKind
  authorBotId: string | null
  authorName: string | null
  kind: TaskCommentKind
  body: string
  options: string[] | null
  recommendedOption: string | null
  replyToId: string | null
  dedupeKey: string | null
  createdAt: number
  updatedAt: number
}

const placeholders = (values: readonly unknown[]): string =>
  values.map(() => '?').join(', ')

/** Owner-facing conversation and links attached to tasks. */
export class ItemStore {
  constructor(private readonly db: Database) {}

  listComments(taskIds: readonly string[]): TaskComment[] {
    const ids = [...new Set(taskIds)]
    if (ids.length === 0) return []
    const rows = this.db.raw
      .prepare(
        `SELECT ${COMMENT_COLUMNS} FROM task_comments
         WHERE task_id IN (${placeholders(ids)})
         ORDER BY created_at, rowid`
      )
      .all(...ids) as CommentRow[]
    return rows.map(commentFromRow)
  }

  findComment(id: string): TaskComment | null {
    const row = this.db.raw
      .prepare(`SELECT ${COMMENT_COLUMNS} FROM task_comments WHERE id = ?`)
      .get(id) as CommentRow | undefined
    return row === undefined ? null : commentFromRow(row)
  }

  findByDedupe(taskId: string, dedupeKey: string): TaskComment | null {
    const row = this.db.raw
      .prepare(
        `SELECT ${COMMENT_COLUMNS} FROM task_comments
         WHERE task_id = ? AND dedupe_key = ?`
      )
      .get(taskId, dedupeKey) as CommentRow | undefined
    return row === undefined ? null : commentFromRow(row)
  }

  insertComment(input: InsertTaskCommentInput): TaskComment {
    this.db.raw
      .prepare(
        `INSERT INTO task_comments (
           id, task_id, author_kind, author_bot_id, author_name, kind,
           body, options_json, recommended_option, reply_to_id, answered_at,
           dedupe_key, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
      )
      .run(
        input.id,
        input.taskId,
        input.authorKind,
        input.authorBotId,
        input.authorName,
        input.kind,
        input.body,
        input.options === null ? null : JSON.stringify(input.options),
        input.recommendedOption,
        input.replyToId,
        input.dedupeKey,
        input.createdAt,
        input.updatedAt
      )
    return this.findComment(input.id)!
  }

  /**
   * Marks the question answered and stores the owner's answer atomically.
   * Returns null when another answer already claimed the question.
   */
  answerQuestion(
    questionId: string,
    answer: Omit<InsertTaskCommentInput, 'replyToId' | 'kind'>,
    now: number
  ): { question: TaskComment; answer: TaskComment } | null {
    return this.db.transaction(() => {
      const result = this.db.raw
        .prepare(
          `UPDATE task_comments
           SET answered_at = ?, updated_at = ?
           WHERE id = ? AND kind = 'question' AND answered_at IS NULL`
        )
        .run(now, now, questionId)
      if (Number(result.changes) === 0) return null
      const question = this.findComment(questionId)
      if (question === null) return null
      const created = this.insertComment({
        ...answer,
        kind: 'answer',
        replyToId: questionId
      })
      return { question, answer: created }
    })
  }

  setSnoozedUntil(taskId: string, until: number | null): boolean {
    const result = this.db.raw
      .prepare('UPDATE tasks SET snoozed_until = ? WHERE id = ?')
      .run(until, taskId)
    return Number(result.changes) > 0
  }

  listLinks(taskIds: readonly string[]): TaskLink[] {
    const ids = [...new Set(taskIds)]
    if (ids.length === 0) return []
    const rows = this.db.raw
      .prepare(
        `SELECT ${LINK_COLUMNS} FROM task_links
         WHERE task_id IN (${placeholders(ids)})
         ORDER BY added_at, kind, ref`
      )
      .all(...ids) as LinkRow[]
    return rows.map(linkFromRow)
  }

  addLink(taskId: string, kind: TaskLinkKind, ref: string, now: number): TaskLink {
    this.db.raw
      .prepare(
        `INSERT INTO task_links (task_id, kind, ref, added_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (task_id, kind, ref) DO NOTHING`
      )
      .run(taskId, kind, ref, now)
    return { taskId, kind, ref, addedAt: now }
  }

  listAttachments(taskIds: readonly string[]): TaskAttachment[] {
    const ids = [...new Set(taskIds)]
    if (ids.length === 0) return []
    const rows = this.db.raw
      .prepare(
        `SELECT ${ATTACHMENT_COLUMNS} FROM task_attachments
         WHERE task_id IN (${placeholders(ids)})
         ORDER BY created_at, rowid`
      )
      .all(...ids) as AttachmentRow[]
    return rows.map(attachmentFromRow)
  }

  insertAttachment(input: TaskAttachment): TaskAttachment {
    this.db.raw
      .prepare(
        `INSERT INTO task_attachments (
           id, task_id, name, mime, size, data_url, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.taskId,
        input.name,
        input.mime,
        input.size,
        input.dataUrl,
        input.createdAt
      )
    return this.listAttachments([input.taskId]).find((entry) => entry.id === input.id)!
  }

  removeAttachment(taskId: string, id: string): boolean {
    return (
      this.db.raw
        .prepare('DELETE FROM task_attachments WHERE task_id = ? AND id = ?')
        .run(taskId, id).changes > 0
    )
  }

  removeLink(taskId: string, kind: TaskLinkKind, ref: string): boolean {
    const result = this.db.raw
      .prepare('DELETE FROM task_links WHERE task_id = ? AND kind = ? AND ref = ?')
      .run(taskId, kind, ref)
    return Number(result.changes) > 0
  }
}
