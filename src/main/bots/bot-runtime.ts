import type { AssistantEvent, AssistantSettings, AssistantStatus } from '../../shared/domain/assistant'
import type { BotRecord, BotStatus } from '../../shared/domain/bot'
import type { MemoryEntry } from '../../shared/domain/memory'
import type { HarnessDetectionResult } from '../harness/harness-detector'
import type { WorkspaceTrustService } from '../harness/trust/workspace-trust'
import type { WslCommandRunner } from '../wsl/exec'
import type { WslDistroListPayload } from '../../shared/schemas/ipc'
import type { AssistantStore } from '../persistence/assistant-store'
import type { BotMemoryStore } from '../persistence/bot-memory-store'
import type { BotStore } from '../persistence/bot-store'
import type { GroupStore } from '../persistence/group-store'
import type { ItemService } from '../items/item-service'
import type { RepositoryStore } from '../persistence/repository-store'
import type { SessionService } from '../sessions/session-service'
import type { SupervisorService } from '../supervisor/supervisor-service'
import type { GitWorkspaceService } from '../git/git-workspace-service'
import type { TaskService } from '../tasks/task-service'
import type { TaskStore } from '../tasks/task-store'
import type { AssistantPolicy } from '../assistant/assistant-policy'
import type { BotService } from './bot-service'
import type { GroupTurnResult } from './group-chat-service'
import { AssistantActions } from '../assistant/assistant-actions'
import { AssistantRunner } from '../assistant/assistant-runner'
import {
  AssistantService,
  type AssistantRunCompletion
} from '../assistant/assistant-service'

export type BotRuntimeDeps = {
  bot: BotRecord
  threadId?: string
  /** Set for a room session; null/absent for a bot's home chat. */
  groupId?: string | null
  groupThreadId?: string | null
  /** Home uses the bot id; a room session uses bot id + assistant thread id. */
  sandboxKey?: string
  bots: BotStore
  botService: BotService
  memory: BotMemoryStore
  groups?: GroupStore
  /** Owner-facing task conversation; absent in legacy tests. */
  items?: ItemService
  store: AssistantStore
  tasks: TaskService
  taskStore: TaskStore
  repositories: RepositoryStore
  sessions: SessionService
  supervisors: SupervisorService
  gitWorkspace: GitWorkspaceService
  policy: AssistantPolicy
  listHarnesses: (input?: { repoId?: string }) => Promise<HarnessDetectionResult[]>
  detectHarness: (
    harness: import('../../shared/domain/harness').HarnessId,
    target: import('../../shared/domain/repository').ExecutionTarget
  ) => Promise<HarnessDetectionResult>
  listWslDistros: () => Promise<WslDistroListPayload>
  readGuestHome: (distro: string) => Promise<string | null>
  wslRunner: WslCommandRunner
  workspaceTrust: WorkspaceTrustService
  userDataDir: string
  newId: (prefix: string) => string
  now: () => number
  onEvent: (botId: string, event: AssistantEvent) => void
  onError?: (error: unknown) => void
}

function botMemory(
  botId: string,
  memory: BotMemoryStore,
  groupId: string | null,
  repoId?: string
): MemoryEntry[] {
  const entries: MemoryEntry[] = []
  entries.push(...memory.list({ scope: 'bot', botId }, { limit: 30 }))
  if (repoId !== undefined) {
    entries.push(...memory.list({ scope: 'project', repoId }, { limit: 15 }))
  }
  if (groupId !== null) {
    entries.push(...memory.list({ scope: 'team', teamId: groupId }, { limit: 15 }))
  }
  return entries.slice(0, 50)
}

/**
 * One bot's chat runtime for one assistant thread.
 *
 * Home chats and room sessions get separate instances, so their runs and
 * sandboxes never collide. The room's final assistant message is resolved back
 * to the group turn; the home chat keeps the ordinary event stream.
 */
export class BotRuntime {
  readonly service: AssistantService
  readonly runner: AssistantRunner
  private groupCompletion: {
    threadId: string
    resolve: (completion: AssistantRunCompletion) => void
  } | null = null
  private turnQueue: Promise<void> = Promise.resolve()

  constructor(private readonly deps: BotRuntimeDeps) {
    const bot = deps.bot
    const groupId = deps.groupId ?? null
    const settingsPort = {
      get: () => deps.botService.settingsFor(bot.id),
      save: (settings: AssistantSettings) => deps.botService.saveSettings(bot.id, settings)
    }
    this.runner = new AssistantRunner({
      store: deps.store,
      actionsFor: (threadId, runId) => {
        return new AssistantActions({
          store: deps.store,
          tasks: deps.tasks,
          taskStore: deps.taskStore,
          sessions: deps.sessions,
          supervisors: deps.supervisors,
          repositories: deps.repositories,
          gitWorkspace: deps.gitWorkspace,
          policy: deps.policy,
          listHarnesses: deps.listHarnesses,
          threadId,
          runId,
          now: deps.now,
          botId: bot.id,
          botName: bot.name,
          groupId,
          groupThreadId: deps.groupThreadId ?? null,
          ...(groupId === null || deps.groups === undefined
            ? {}
            : {
                group: {
                  isMember: (targetGroupId: string, targetBotId: string) =>
                    deps.groups!.listMembers(targetGroupId).some(
                      (member) => member.botId === targetBotId
                    )
                }
              }),
          ...(deps.items === undefined ? {} : { items: deps.items }),
          botSettings: (botId) => deps.botService.settingsFor(botId),
          memoryStore: deps.memory,
          canAssignOthers: groupId !== null
        })
      },
      taskStore: deps.taskStore,
      tasks: deps.tasks,
      repositories: deps.repositories,
      sessions: deps.sessions,
      settings: () => settingsPort.get(),
      botProfile: bot,
      ...(deps.sandboxKey === undefined ? {} : { sandboxKey: deps.sandboxKey }),
      botMemory: (repoId) =>
        botMemory(bot.id, deps.memory, groupId, repoId),
      detectHarness: deps.detectHarness,
      listWslDistros: deps.listWslDistros,
      readGuestHome: deps.readGuestHome,
      wslRunner: deps.wslRunner,
      workspaceTrust: deps.workspaceTrust,
      userDataDir: deps.userDataDir,
      resumeEnabled: true,
      newId: deps.newId,
      now: deps.now,
      onError: deps.onError
    })
    this.service = new AssistantService({
      store: deps.store,
      now: deps.now,
      newId: deps.newId,
      runner: this.runner,
      ...(deps.threadId === undefined ? {} : { threadId: deps.threadId }),
      threadBotId: bot.id,
      settings: settingsPort,
      onError: deps.onError,
      onRunComplete: (completion) => {
        const pending = this.groupCompletion
        if (pending !== null && pending.threadId === completion.threadId) {
          this.groupCompletion = null
          pending.resolve(completion)
        }
      }
    })
    this.service.subscribe((event) => deps.onEvent(bot.id, event))
    this.service.start()
  }

  get bot(): BotRecord {
    return this.deps.bot
  }

  get threadId(): string {
    return this.service.threadId()
  }

  state(): ReturnType<AssistantService['state']> {
    return this.service.state()
  }

  status(): AssistantStatus {
    return this.service.state().status
  }

  send(input: { text: string; repoId?: string }): ReturnType<AssistantService['send']> {
    return this.service.send(input)
  }

  /** One room turn, serialized per assistant thread. */
  sendGroupTurn(input: { prompt: string; repoId?: string }): Promise<GroupTurnResult> {
    const run = this.turnQueue.then(() => this.runGroupTurn(input))
    this.turnQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async runGroupTurn(input: {
    prompt: string
    repoId?: string
  }): Promise<GroupTurnResult> {
    let resolve!: (completion: AssistantRunCompletion) => void
    const completion = new Promise<AssistantRunCompletion>((done) => {
      resolve = done
    })
    this.groupCompletion = { threadId: this.threadId, resolve }
    try {
      await this.service.send({
        text: input.prompt,
        ...(input.repoId === undefined ? {} : { repoId: input.repoId })
      })
    } catch (error) {
      this.groupCompletion = null
      return {
        status: 'failed',
        reply: null,
        error: error instanceof Error ? error.message : String(error),
        runId: null
      }
    }
    const done = await completion
    const reply =
      [...done.messages]
        .reverse()
        .find(
          (message) =>
            message.role === 'assistant' &&
            message.kind !== 'error' &&
            message.kind !== 'status'
        )?.body ?? null
    if (done.stopped) {
      return { status: 'stopped', reply: null, error: null, runId: done.runId }
    }
    if (done.status === 'error' || reply === null) {
      return {
        status: 'failed',
        reply: null,
        error: done.error ?? 'The bot did not answer.',
        runId: done.runId
      }
    }
    return {
      status: 'completed',
      reply,
      error: null,
      runId: done.runId,
      assistantThreadId: done.threadId
    }
  }

  stop(): void {
    this.service.stop()
  }

  newConversation(): ReturnType<AssistantService['newConversation']> {
    return this.service.newConversation()
  }

  markRead(input: { threadId: string; messageId?: string }): number {
    return this.service.markRead(input)
  }

  listMessages(input: {
    threadId: string
    beforeSeq?: number
    limit?: number
    conversationId?: string
  }) {
    return this.service.listMessages(input)
  }

  listConversations() {
    return this.service.listConversations()
  }

  listNotifications(input: { limit?: number } = {}) {
    return this.service.listNotifications(input)
  }

  focus(messageId: string): void {
    this.service.focus(messageId)
  }

  settings(): AssistantSettings {
    return this.service.settings()
  }

  saveSettings(settings: AssistantSettings): AssistantSettings {
    return this.service.saveSettings(settings)
  }
}

export type BotRuntimeRegistryDeps = Omit<
  BotRuntimeDeps,
  'bot' | 'threadId' | 'onEvent' | 'groupId' | 'groupThreadId' | 'sandboxKey'
>

/**
 * Lazy per-thread runtimes. Home chats and room sessions are separate entries,
 * so one bot can talk in a room while its home chat stays available.
 */
export class BotRuntimeRegistry {
  private readonly homeRuntimes = new Map<string, BotRuntime>()
  private readonly threadRuntimes = new Map<string, BotRuntime>()
  private readonly listeners = new Set<(botId: string, event: AssistantEvent) => void>()

  constructor(private readonly deps: BotRuntimeRegistryDeps) {}

  subscribe(listener: (botId: string, event: AssistantEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(botId: string, event: AssistantEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(botId, event)
      } catch {
        // A broken renderer must not block a run.
      }
    }
  }

  /** A bot's one home chat. Kept as `ensure` for the old callers. */
  ensure(botId: string): BotRuntime {
    return this.ensureHome(botId)
  }

  ensureHome(botId: string): BotRuntime {
    const cached = this.homeRuntimes.get(botId)
    if (cached !== undefined) return cached
    const bot = this.requireBot(botId)
    const thread =
      this.deps.store.findHomeThreadByBotId(botId) ??
      (botId === 'mira' ? this.deps.store.findMainThread() : null)
    if (thread === null && botId !== 'mira') {
      throw new Error('That bot has no chat thread.')
    }
    const runtime = new BotRuntime({
      ...this.deps,
      bot,
      ...(thread === null ? {} : { threadId: thread.id }),
      sandboxKey: bot.id,
      onEvent: (id, event) => this.emit(id, event)
    })
    this.homeRuntimes.set(botId, runtime)
    this.threadRuntimes.set(runtime.threadId, runtime)
    return runtime
  }

  /** A bot's session in one group thread; created lazily and persisted. */
  ensureRoom(botId: string, groupThreadId: string): BotRuntime {
    const groups = this.deps.groups
    if (groups === undefined) throw new Error('Group storage is not available.')
    const bot = this.requireBot(botId)
    const groupThread = groups.findThread(groupThreadId)
    if (groupThread === null) throw new Error('That group thread does not exist.')
    const group = groups.findGroup(groupThread.groupId)
    if (group === null) throw new Error('That group does not exist.')
    let thread = this.deps.store.findRoomThread(botId, groupThreadId)
    if (thread === null) {
      const id = this.deps.newId('athread')
      try {
        thread = this.deps.store.insertThread({
          id,
          kind: 'room',
          title: groupThread.title,
          botId,
          groupThreadId,
          createdAt: this.deps.now(),
          updatedAt: this.deps.now(),
          lastMessageAt: null,
          lastReadSeq: 0,
          activeRunId: null,
          archivedAt: null
        })
      } catch {
        thread = this.deps.store.findRoomThread(botId, groupThreadId)
      }
    }
    if (thread === null) throw new Error('That room session could not be created.')
    const existing = this.threadRuntimes.get(thread.id)
    if (existing !== undefined) return existing
    const runtime = new BotRuntime({
      ...this.deps,
      bot,
      threadId: thread.id,
      groupId: group.id,
      groupThreadId,
      sandboxKey: `${bot.id}__${thread.id}`,
      onEvent: (id, event) => this.emit(id, event)
    })
    groups.setThreadMemberSession(groupThreadId, botId, thread.id)
    this.threadRuntimes.set(thread.id, runtime)
    return runtime
  }

  runtimeForThread(assistantThreadId: string): BotRuntime | null {
    return this.threadRuntimes.get(assistantThreadId) ?? null
  }

  get(botId: string): BotRuntime | null {
    return this.homeRuntimes.get(botId) ?? null
  }

  statusFor(botId: string): BotStatus {
    const statuses = [...this.threadRuntimes.values()]
      .filter((runtime) => runtime.bot.id === botId)
      .map((runtime) => runtime.status())
    if (statuses.includes('working')) return 'working'
    if (statuses.includes('error')) return 'error'
    if (statuses.length === 0 || statuses.every((status) => status === 'offline')) {
      return 'idle'
    }
    return 'idle'
  }

  statusForThread(assistantThreadId: string): BotStatus {
    return this.threadRuntimes.get(assistantThreadId)?.status() ?? 'idle'
  }

  stopThread(assistantThreadId: string): void {
    this.threadRuntimes.get(assistantThreadId)?.stop()
  }

  stopBot(botId: string): void {
    for (const runtime of this.threadRuntimes.values()) {
      if (runtime.bot.id === botId) runtime.stop()
    }
  }

  stopAll(): void {
    for (const runtime of this.threadRuntimes.values()) runtime.stop()
    this.threadRuntimes.clear()
    this.homeRuntimes.clear()
  }

  // GroupRuntimePort
  async ensureRoomSession(input: {
    botId: string
    groupThreadId: string
  }): Promise<{ assistantThreadId: string }> {
    return { assistantThreadId: this.ensureRoom(input.botId, input.groupThreadId).threadId }
  }

  async sendTurn(input: {
    botId: string
    groupThreadId: string
    assistantThreadId: string
    prompt: string
  }): Promise<GroupTurnResult> {
    const runtime = this.ensureRoom(input.botId, input.groupThreadId)
    return runtime.sendGroupTurn({ prompt: input.prompt })
  }

  private requireBot(botId: string): BotRecord {
    const bot = this.deps.bots.findById(botId)
    if (bot === null || bot.archivedAt !== null) throw new Error('That bot does not exist.')
    return bot
  }
}
