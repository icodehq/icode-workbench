import { runKeyedSerializedOperation } from '../../shared/concurrency/keyed-serialized-operation'
import type { PeerMail, PeerMailStore } from './peer-mail-store'

export const PEER_MAIL_LIMITS = {
  maxBody: 4_000,
  maxDepth: 1,
  drainIntervalMs: 30_000
} as const

export type PeerMailBot = {
  id: string
  name: string
  paused: boolean
  archived: boolean
}

export type PeerMailServiceDeps = {
  store: PeerMailStore
  /** Null for a bot id that no longer exists. */
  botInfo: (botId: string) => PeerMailBot | null
  /** Bot ids by name, case-insensitively. */
  findBotByName: (name: string) => PeerMailBot | null
  /** Runs one mail turn in the recipient's home chat and returns its final answer. */
  deliver: (botId: string, prompt: string) => Promise<{ answer: string | null }>
  now: () => number
  newId: (prefix: string) => string
  onError?: (error: unknown) => void
  /** False in tests that drain by hand. */
  autoDrain?: boolean
}

export class PeerMailError extends Error {
  constructor(readonly code: 'PEER_NOT_FOUND' | 'PEER_SELF' | 'PEER_PAUSED' | 'PEER_BODY') {
    super(code)
  }
}

function isBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ASSISTANT_BUSY'
  )
}

/**
 * Durable mail between bots outside a group room. Each mail runs as a turn in
 * the recipient's home chat; the recipient's final reply comes back to the
 * sender as one answer, so a bot never wakes another in an endless loop.
 */
export class PeerMailService {
  private readonly queues = new Map<string, Promise<void>>()
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly deps: PeerMailServiceDeps) {}

  start(): void {
    this.deps.store.requeueDelivering()
    this.timer ??= setInterval(() => {
      for (const botId of this.deps.store.recipientsWithQueued()) {
        void this.drain(botId).catch((error: unknown) => this.deps.onError?.(error))
      }
    }, PEER_MAIL_LIMITS.drainIntervalMs)
    this.timer.unref?.()
    for (const botId of this.deps.store.recipientsWithQueued()) {
      void this.drain(botId).catch((error: unknown) => this.deps.onError?.(error))
    }
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  send(input: {
    fromBotId: string
    /** A bot id or a name, as a bot addressed it. */
    to: string
    body: string
    depth?: number
  }): PeerMail {
    const body = input.body.trim()
    if (body.length === 0 || body.length > PEER_MAIL_LIMITS.maxBody) {
      throw new PeerMailError('PEER_BODY')
    }
    const target =
      this.deps.botInfo(input.to) ?? this.deps.findBotByName(input.to.trim())
    if (target === null) throw new PeerMailError('PEER_NOT_FOUND')
    if (target.id === input.fromBotId) throw new PeerMailError('PEER_SELF')
    if (target.archived) throw new PeerMailError('PEER_NOT_FOUND')
    if (target.paused) throw new PeerMailError('PEER_PAUSED')
    const depth = input.depth ?? 0
    if (depth > PEER_MAIL_LIMITS.maxDepth) throw new PeerMailError('PEER_BODY')
    const autoDrain = this.deps.autoDrain !== false
    const mail = this.deps.store.insert({
      id: this.deps.newId('peer_mail'),
      fromBotId: input.fromBotId,
      toBotId: target.id,
      body,
      depth,
      status: 'queued',
      error: null,
      messageId: null,
      createdAt: this.deps.now(),
      deliveredAt: null
    })
    if (autoDrain) {
      void this.drain(target.id).catch((error: unknown) => this.deps.onError?.(error))
    }
    return mail
  }

  /** Delivers queued mail in order; busy recipients keep theirs queued. */
  async drain(toBotId: string): Promise<void> {
    await runKeyedSerializedOperation(this.queues, toBotId, async () => {
      for (;;) {
        const bot = this.deps.botInfo(toBotId)
        if (bot === null || bot.archived || bot.paused) return
        const [mail] = this.deps.store.queuedFor(toBotId, 1)
        if (mail === undefined) return
        this.deps.store.setStatus(mail.id, { status: 'delivering' })
        try {
          const { answer } = await this.deps.deliver(toBotId, this.prompt(mail))
          this.deps.store.setStatus(mail.id, {
            status: 'delivered',
            deliveredAt: this.deps.now()
          })
          this.answerBack(mail, bot, answer)
        } catch (error) {
          if (isBusy(error)) {
            this.deps.store.setStatus(mail.id, { status: 'queued' })
            return
          }
          this.deps.store.setStatus(mail.id, {
            status: 'failed',
            error: error instanceof Error ? error.message : String(error)
          })
          this.deps.onError?.(error)
        }
      }
    })
  }

  private prompt(mail: PeerMail): string {
    const sender = this.deps.botInfo(mail.fromBotId)
    const from = sender?.name ?? 'another bot'
    if (mail.depth > 0) {
      return [
        `[Bot mail answer from ${from}]`,
        mail.body,
        '',
        `This answer is from ${from}, another bot, not your owner. Use it to continue your work.`
      ].join('\n')
    }
    return [
      `[Bot mail from ${from}]`,
      mail.body,
      '',
      `This is a message from ${from}, another bot, not your owner. Do what it asks or answer it; your final reply is sent back to ${from} automatically.`
    ].join('\n')
  }

  private answerBack(
    mail: PeerMail,
    target: PeerMailBot,
    answer: string | null
  ): void {
    if (
      mail.depth >= PEER_MAIL_LIMITS.maxDepth ||
      answer === null ||
      answer.trim().length === 0
    ) {
      return
    }
    const sender = this.deps.botInfo(mail.fromBotId)
    if (sender === null || sender.archived) return
    try {
      this.send({
        fromBotId: target.id,
        to: mail.fromBotId,
        body: answer.trim(),
        depth: mail.depth + 1
      })
    } catch {
      // A sender that paused or left while the answer was being written keeps no answer.
    }
  }
}
