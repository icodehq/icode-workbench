import type { Database } from '../persistence/database'

export const PEER_MAIL_STATUSES = ['queued', 'delivering', 'delivered', 'failed'] as const
export type PeerMailStatus = (typeof PEER_MAIL_STATUSES)[number]

export type PeerMail = {
  id: string
  fromBotId: string
  toBotId: string
  body: string
  depth: number
  status: PeerMailStatus
  error: string | null
  messageId: string | null
  createdAt: number
  deliveredAt: number | null
}

type PeerMailRow = {
  id: string
  from_bot_id: string
  to_bot_id: string
  body: string
  depth: number
  status: string
  error: string | null
  message_id: string | null
  created_at: number
  delivered_at: number | null
}

const COLUMNS = `id, from_bot_id, to_bot_id, body, depth, status, error,
  message_id, created_at, delivered_at`

function fromRow(row: PeerMailRow): PeerMail {
  return {
    id: row.id,
    fromBotId: row.from_bot_id,
    toBotId: row.to_bot_id,
    body: row.body,
    depth: Number(row.depth),
    status: row.status as PeerMailStatus,
    error: row.error,
    messageId: row.message_id,
    createdAt: Number(row.created_at),
    deliveredAt: row.delivered_at === null ? null : Number(row.delivered_at)
  }
}

/** Durable mail between bots, drained in arrival order per recipient. */
export class PeerMailStore {
  constructor(private readonly db: Database) {}

  insert(mail: PeerMail): PeerMail {
    this.db.raw
      .prepare(
        `INSERT INTO bot_peer_mail (${COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        mail.id,
        mail.fromBotId,
        mail.toBotId,
        mail.body,
        mail.depth,
        mail.status,
        mail.error,
        mail.messageId,
        mail.createdAt,
        mail.deliveredAt
      )
    return this.findById(mail.id)!
  }

  findById(id: string): PeerMail | null {
    const row = this.db.raw
      .prepare(`SELECT ${COLUMNS} FROM bot_peer_mail WHERE id = ?`)
      .get(id) as PeerMailRow | undefined
    return row ? fromRow(row) : null
  }

  /** Oldest first, so a recipient answers in the order it was asked. */
  queuedFor(toBotId: string, limit = 10): PeerMail[] {
    return (
      this.db.raw
        .prepare(
          `SELECT ${COLUMNS} FROM bot_peer_mail
           WHERE to_bot_id = ? AND status = 'queued'
           ORDER BY created_at ASC, id ASC LIMIT ?`
        )
        .all(toBotId, limit) as PeerMailRow[]
    ).map(fromRow)
  }

  /** A delivery cut off by a restart goes back in the queue. */
  requeueDelivering(): void {
    this.db.raw
      .prepare(`UPDATE bot_peer_mail SET status = 'queued' WHERE status = 'delivering'`)
      .run()
  }

  recipientsWithQueued(): string[] {
    return (
      this.db.raw
        .prepare(
          `SELECT DISTINCT to_bot_id FROM bot_peer_mail WHERE status = 'queued'`
        )
        .all() as Array<{ to_bot_id: string }>
    ).map((row) => row.to_bot_id)
  }

  setStatus(
    id: string,
    input: {
      status: PeerMailStatus
      error?: string | null
      messageId?: string | null
      deliveredAt?: number | null
    }
  ): PeerMail | null {
    const current = this.findById(id)
    if (current === null) return null
    this.db.raw
      .prepare(
        `UPDATE bot_peer_mail
         SET status = ?, error = ?, message_id = ?, delivered_at = ?
         WHERE id = ?`
      )
      .run(
        input.status,
        input.error === undefined ? current.error : input.error,
        input.messageId === undefined ? current.messageId : input.messageId,
        input.deliveredAt === undefined ? current.deliveredAt : input.deliveredAt,
        id
      )
    return this.findById(id)
  }

  removeForBot(botId: string): void {
    this.db.raw
      .prepare(`DELETE FROM bot_peer_mail WHERE from_bot_id = ? OR to_bot_id = ?`)
      .run(botId, botId)
  }
}
