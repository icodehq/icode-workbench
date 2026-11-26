import type { Database } from '../persistence/database'
import type { AssistantStore } from '../persistence/assistant-store'
import type { BotStore } from '../persistence/bot-store'
import type { BotMemoryStore } from '../persistence/bot-memory-store'
import type { GroupStore } from '../persistence/group-store'
import type { TaskStore } from '../tasks/task-store'
import type { BotRecord, BotStatus, BotSummary } from '../../shared/domain/bot'
import { BUILTIN_ASSISTANT_BOT_ID } from '../../shared/domain/bot'
import type { AssistantSettings, AssistantStatus } from '../../shared/domain/assistant'
import { DEFAULT_ASSISTANT_SETTINGS } from '../../shared/domain/assistant'
import type { BotCreateInput, BotUpdateInput } from '../../shared/schemas/bots'
import { isActiveTaskStatus } from '../../shared/domain/task'

export type BotServiceDeps = {
  database: Database
  assistants: AssistantStore
  bots: BotStore
  groups: GroupStore
  memory: BotMemoryStore
  tasks: TaskStore
  newId: (prefix: string) => string
  now: () => number
  /** Filled by the runtime registry once the bot services exist. */
  statusFor?: (botId: string) => BotStatus
}

export type BotServiceEvent =
  | { type: 'changed'; botId: string }
  | { type: 'removed'; botId: string }

/**
 * Persistent bot identities.
 *
 * A bot owns an assistant thread and a profile. It does not own a runtime; the
 * BotRuntimeRegistry creates one lazily. All work still goes through tasks.
 */
export class BotService {
  private readonly listeners = new Set<(event: BotServiceEvent) => void>()

  constructor(private readonly deps: BotServiceDeps) {}

  setStatusProvider(statusFor: (botId: string) => BotStatus): void {
    this.deps.statusFor = statusFor
  }

  subscribe(listener: (event: BotServiceEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: BotServiceEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // A broken renderer must not block a write.
      }
    }
  }

  ensureMira(): BotRecord {
    const existing = this.deps.bots.findById('mira')
    if (existing) return existing
    const now = this.deps.now()
    return this.deps.bots.insert({
      id: 'mira',
      name: 'Yarcy',
      role: 'Chief of Staff',
      avatarColor: '#6f7bf7',
      avatarImage: null,
      avatarMascot: null,
      avatarOutfit: null,
      instructions: '',
      settings: null,
      archivedAt: null,
      pausedAt: null,
      createdAt: now,
      updatedAt: now
    })
  }

  getBot(botId: string): BotRecord | null {
    return this.deps.bots.findById(botId)
  }

  settingsFor(botId: string): AssistantSettings {
    if (botId === 'mira') {
      return this.deps.bots.getSettings(botId, this.deps.assistants.getSettings())
    }
    return this.deps.bots.getSettings(botId)
  }

  createBot(input: BotCreateInput): BotRecord {
    if (this.deps.bots.findByName(input.name, { excludeId: BUILTIN_ASSISTANT_BOT_ID })) {
      throw new Error('A bot with that name already exists.')
    }
    const now = this.deps.now()
    const botId = this.deps.newId('bot')
    const threadId = this.deps.newId('thread')
    const settings: AssistantSettings = {
      ...DEFAULT_ASSISTANT_SETTINGS,
      personaName: input.name,
      ...(input.harness === undefined
        ? {}
        : {
            harnessPriority: [
              input.harness,
              ...DEFAULT_ASSISTANT_SETTINGS.harnessPriority.filter(
                (harness) => harness !== input.harness
              )
            ] as AssistantSettings['harnessPriority']
          }),
      ...(input.target === undefined ? {} : { target: input.target })
    }
    this.deps.database.transaction(() => {
      this.deps.bots.insert({
        id: botId,
        name: input.name,
        role: input.role,
        avatarColor: input.avatarColor ?? '#5b8def',
        avatarImage: input.avatarImage ?? null,
        avatarMascot: input.avatarMascot ?? null,
        avatarOutfit: input.avatarOutfit ?? null,
        instructions: input.instructions ?? '',
        settings,
        archivedAt: null,
        pausedAt: null,
        createdAt: now,
        updatedAt: now
      })
      this.deps.assistants.insertThread({
        id: threadId,
        kind: 'bot',
        groupThreadId: null,
        title: input.name,
        botId,
        createdAt: now,
        updatedAt: now,
        lastMessageAt: null,
        lastReadSeq: 0,
        activeRunId: null,
        archivedAt: null
      })
    })
    const welcome = this.deps.assistants.appendMessage({
      id: this.deps.newId('msg'),
      threadId,
      role: 'assistant',
      kind: 'welcome',
      body: `I'm ${input.name}. ${input.role}. Tell me what you're working on.`,
      createdAt: now
    })
    if (welcome) this.deps.assistants.markRead(threadId, welcome.seq, now)
    if (input.seedMemory !== undefined && input.seedMemory.trim().length > 0) {
      this.deps.memory.insert({
        id: this.deps.newId('mem'),
        scope: 'bot',
        botId,
        repoId: null,
        teamId: null,
        proposedByBotId: null,
        key: 'seed',
        value: input.seedMemory.trim(),
        status: 'active',
        sourceTaskId: null,
        createdAt: now,
        updatedAt: now
      })
    }
    this.emit({ type: 'changed', botId })
    return this.deps.bots.findById(botId)!
  }

  updateBot(input: BotUpdateInput): BotRecord {
    const bot = this.deps.bots.findById(input.botId)
    if (bot === null) throw new Error('That bot no longer exists.')
    if (input.name !== undefined && input.name !== bot.name) {
      const duplicate = this.deps.bots.findByName(input.name, {
        excludeId: BUILTIN_ASSISTANT_BOT_ID
      })
      if (duplicate !== null && duplicate.id !== bot.id) {
        throw new Error('A bot with that name already exists.')
      }
    }
    const updated = this.deps.bots.update(
      bot.id,
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.role === undefined ? {} : { role: input.role }),
        ...(input.avatarColor === undefined ? {} : { avatarColor: input.avatarColor }),
        ...(input.avatarImage === undefined ? {} : { avatarImage: input.avatarImage }),
        ...(input.avatarMascot === undefined ? {} : { avatarMascot: input.avatarMascot }),
        ...(input.avatarOutfit === undefined ? {} : { avatarOutfit: input.avatarOutfit }),
        ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
        ...(input.settings === undefined ? {} : { settings: input.settings })
      },
      this.deps.now()
    )
    if (updated === null) throw new Error('That bot no longer exists.')
    const thread = this.deps.assistants.findThreadByBotId(bot.id)
    if (thread !== null && input.name !== undefined) {
      this.deps.assistants.updateThreadTitle(thread.id, input.name, this.deps.now())
    }
    // The chat header, placeholders and notifications read personaName from
    // settings; a rename here must not leave those on the old name.
    if (input.name !== undefined && input.name !== bot.name) {
      const settings = this.settingsFor(bot.id)
      if (settings.personaName !== input.name) {
        this.saveSettings(bot.id, { ...settings, personaName: input.name })
      }
    }
    this.emit({ type: 'changed', botId: bot.id })
    return updated
  }

  saveSettings(botId: string, settings: AssistantSettings): AssistantSettings {
    const bot = this.deps.bots.findById(botId)
    if (bot === null) throw new Error('That bot no longer exists.')
    const now = this.deps.now()
    let saved: AssistantSettings
    if (botId === 'mira' && bot.settings === null) {
      saved = this.deps.assistants.saveSettings(settings, now)
    } else {
      saved = this.deps.bots.saveSettings(botId, settings, now)
    }
    if (saved.personaName !== bot.name) {
      this.deps.bots.update(botId, { name: saved.personaName }, now)
      const thread = this.deps.assistants.findThreadByBotId(botId)
      if (thread !== null) {
        this.deps.assistants.updateThreadTitle(thread.id, saved.personaName, now)
      }
      this.emit({ type: 'changed', botId })
    }
    return saved
  }

  setPaused(botId: string, paused: boolean): BotRecord {
    const bot = this.deps.bots.findById(botId)
    if (bot === null) throw new Error('That bot no longer exists.')
    const updated = this.deps.bots.update(
      bot.id,
      { pausedAt: paused ? this.deps.now() : null },
      this.deps.now()
    )
    if (updated === null) throw new Error('That bot no longer exists.')
    this.emit({ type: 'changed', botId: bot.id })
    return updated
  }

  archiveBot(botId: string): boolean {
    const bot = this.deps.bots.findById(botId)
    if (bot === null) return false
    if (botId === 'mira') {
      throw new Error(`${bot.name} is the default Chief and cannot be archived.`)
    }
    const archived = this.deps.bots.archive(botId, this.deps.now())
    if (archived) this.emit({ type: 'removed', botId })
    return archived
  }

  listSummaries(): BotSummary[] {
    // The built-in assistant keeps a profile row for its settings and memory,
    // but it is not a bot the owner created: it never appears in the roster,
    // group member pickers or bot counts. Fresh installs start with no bots
    // and create the first one from a template.
    const bots = this.deps.bots.list().filter((bot) => bot.id !== BUILTIN_ASSISTANT_BOT_ID)
    const tasks = this.deps.tasks.list({ limit: 500 })
    return bots.map((bot) => {
      const botTasks = tasks.filter((task) => task.botId === bot.id)
      const thread = this.deps.assistants.findThreadByBotId(bot.id)
      const groups = this.deps.groups.groupsForBot(bot.id)
      const groupIds = groups.map((group) => group.id)
      const groupActivity = groupIds.flatMap((groupId) =>
        this.deps.groups.listThreads(groupId).map((thread) => thread.latestAt ?? 0)
      )
      const lastActivityAt = Math.max(
        0,
        thread?.lastMessageAt ?? 0,
        ...botTasks.map((task) => task.updatedAt),
        ...groupActivity
      )
      const status = this.deps.statusFor?.(bot.id) ?? ('idle' satisfies AssistantStatus)
      return {
        id: bot.id,
        name: bot.name,
        role: bot.role,
        avatarColor: bot.avatarColor,
        avatarImage: bot.avatarImage,
        avatarMascot: bot.avatarMascot,
        avatarOutfit: bot.avatarOutfit,
        instructions: bot.instructions,
        status,
        unread: thread === null ? 0 : this.deps.assistants.unreadCount(thread.id),
        activeTaskCount: botTasks.filter((task) => isActiveTaskStatus(task.status)).length,
        reviewCount: botTasks.filter(
          (task) =>
            task.status === 'completed' &&
            task.reviewDecision === 'pending' &&
            task.changesRequestedAt === null
        ).length,
        groupIds,
        threadId: thread?.id ?? null,
        harness: this.settingsFor(bot.id).harnessPriority[0] ?? null,
        archivedAt: bot.archivedAt,
        pausedAt: bot.pausedAt,
        lastActivityAt: lastActivityAt > 0 ? lastActivityAt : null,
        notificationsEnabled: this.settingsFor(bot.id).notifications.enabled
      }
    })
  }
}
