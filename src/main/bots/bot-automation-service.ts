import type { BotAutomation, BotAutomationStore } from './bot-automation-store'

export const BOT_AUTOMATION_LIMITS = {
  maxName: 120,
  maxPrompt: 4_000,
  minIntervalMinutes: 1,
  maxIntervalMinutes: 10_080,
  tickMs: 60_000,
  retryMs: 60_000
} as const

export type BotAutomationBot = { id: string; paused: boolean; archived: boolean }

export type BotAutomationServiceDeps = {
  store: BotAutomationStore
  botInfo: (botId: string) => BotAutomationBot | null
  /** Runs one prompt in the bot's home chat; a busy bot rejects with ASSISTANT_BUSY. */
  deliver: (botId: string, prompt: string) => Promise<void>
  now: () => number
  newId: (prefix: string) => string
  onError?: (error: unknown) => void
}

function isBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ASSISTANT_BUSY'
  )
}

/**
 * Recurring prompts a bot runs in its home chat. A due run advances its next
 * time first, so a restart cannot fire a backlog; a busy bot retries in a
 * minute instead of losing the run.
 */
export class BotAutomationService {
  private timer: NodeJS.Timeout | null = null
  private ticking = false

  constructor(private readonly deps: BotAutomationServiceDeps) {}

  start(): void {
    this.timer ??= setInterval(() => void this.tick(), BOT_AUTOMATION_LIMITS.tickMs)
    this.timer.unref?.()
    void this.tick()
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  list(botId: string): BotAutomation[] {
    return this.deps.store.listForBot(botId)
  }

  create(input: {
    botId: string
    name: string
    prompt: string
    intervalMinutes: number
    enabled?: boolean
  }): BotAutomation {
    const bot = this.deps.botInfo(input.botId)
    if (bot === null || bot.archived) throw new Error('That bot does not exist.')
    const name = input.name.trim()
    const prompt = input.prompt.trim()
    if (name.length === 0 || name.length > BOT_AUTOMATION_LIMITS.maxName) {
      throw new Error('The automation needs a name.')
    }
    if (prompt.length === 0 || prompt.length > BOT_AUTOMATION_LIMITS.maxPrompt) {
      throw new Error('The automation needs a prompt.')
    }
    if (
      !Number.isInteger(input.intervalMinutes) ||
      input.intervalMinutes < BOT_AUTOMATION_LIMITS.minIntervalMinutes ||
      input.intervalMinutes > BOT_AUTOMATION_LIMITS.maxIntervalMinutes
    ) {
      throw new Error('The interval is out of range.')
    }
    const now = this.deps.now()
    return this.deps.store.insert({
      id: this.deps.newId('automation'),
      botId: input.botId,
      name,
      prompt,
      intervalMinutes: input.intervalMinutes,
      enabled: input.enabled ?? true,
      lastRunAt: null,
      nextRunAt: now + input.intervalMinutes * 60_000,
      createdAt: now,
      updatedAt: now
    })
  }

  update(
    id: string,
    input: {
      name?: string
      prompt?: string
      intervalMinutes?: number
      enabled?: boolean
    }
  ): BotAutomation | null {
    const current = this.deps.store.findById(id)
    if (current === null) return null
    const now = this.deps.now()
    const interval = input.intervalMinutes ?? current.intervalMinutes
    if (
      !Number.isInteger(interval) ||
      interval < BOT_AUTOMATION_LIMITS.minIntervalMinutes ||
      interval > BOT_AUTOMATION_LIMITS.maxIntervalMinutes
    ) {
      throw new Error('The interval is out of range.')
    }
    const name = input.name === undefined ? current.name : input.name.trim()
    const prompt = input.prompt === undefined ? current.prompt : input.prompt.trim()
    if (name.length === 0 || name.length > BOT_AUTOMATION_LIMITS.maxName) {
      throw new Error('The automation needs a name.')
    }
    if (prompt.length === 0 || prompt.length > BOT_AUTOMATION_LIMITS.maxPrompt) {
      throw new Error('The automation needs a prompt.')
    }
    const enabled = input.enabled ?? current.enabled
    const reschedule =
      (input.intervalMinutes !== undefined && interval !== current.intervalMinutes) ||
      (enabled && !current.enabled)
    return this.deps.store.update(id, {
      name,
      prompt,
      intervalMinutes: interval,
      enabled,
      ...(reschedule ? { nextRunAt: now + interval * 60_000 } : {}),
      updatedAt: now
    })
  }

  remove(id: string): boolean {
    return this.deps.store.remove(id)
  }

  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      for (const automation of this.deps.store.due(this.deps.now())) {
        const bot = this.deps.botInfo(automation.botId)
        const now = this.deps.now()
        if (bot === null || bot.archived) {
          this.deps.store.update(automation.id, {
            enabled: false,
            updatedAt: now
          })
          continue
        }
        if (bot.paused) continue
        // Advance first: a crash after delivery must not replay the same run.
        this.deps.store.update(automation.id, {
          lastRunAt: now,
          nextRunAt: now + automation.intervalMinutes * 60_000,
          updatedAt: now
        })
        try {
          await this.deps.deliver(automation.botId, automation.prompt)
        } catch (error) {
          if (isBusy(error)) {
            this.deps.store.update(automation.id, {
              nextRunAt: now + BOT_AUTOMATION_LIMITS.retryMs,
              updatedAt: now
            })
          } else {
            this.deps.onError?.(error)
          }
        }
      }
    } finally {
      this.ticking = false
    }
  }
}
