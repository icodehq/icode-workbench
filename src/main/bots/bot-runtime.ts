import type {
  AssistantEvent,
  AssistantSettings,
  AssistantStatus,
  AssistantThread
} from '../../shared/domain/assistant'
import {
  ASSISTANT_PREVIOUS_HOME_TITLE,
  ASSISTANT_SIDE_CHAT_TITLE,
  assistantThreadTitleFromText
} from '../../shared/domain/assistant'
import type { BotRecord, BotStatus } from '../../shared/domain/bot'
import type { HarnessDetectionResult } from '../harness/harness-detector'
import type { ModelHarness } from '../../shared/domain/harness'
import type { WorkspaceTrustService } from '../harness/trust/workspace-trust'
import type { WslCommandRunner } from '../wsl/exec'
import type { WslDistroListPayload } from '../../shared/schemas/ipc'
import type { AssistantStore } from '../persistence/assistant-store'
import type { MemoryService } from '../memory/memory-service'
import type { PeerMailService } from './peer-mail-service'
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
  threadId: string
  /** Set for a room session; null/absent for a bot's home chat. */
  groupId?: string | null
  groupThreadId?: string | null
  /** Home uses the bot id; a room session uses bot id + assistant thread id. */
  sandboxKey?: string
  /** A side chat's chosen agent; overrides the bot's own priority for this chat. */
  harnessOverride?: ModelHarness
  bots: BotStore
  botService: BotService
  memoryFiles: MemoryService
  peerMail?: Pick<PeerMailService, 'send'>
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
  private readonly runWaiters = new Map<
    string,
    (completion: AssistantRunCompletion) => void
  >()
  private lastCompletion: AssistantRunCompletion | null = null
  private turnQueue: Promise<void> = Promise.resolve()

  constructor(private readonly deps: BotRuntimeDeps) {
    const bot = deps.bot
    const groupId = deps.groupId ?? null
    const botSettings = (): AssistantSettings => deps.botService.settingsFor(bot.id)
    const chatSettings = (): AssistantSettings => {
      const settings = botSettings()
      const override = deps.harnessOverride
      if (override === undefined) return settings
      return {
        ...settings,
        harnessPriority: [
          override,
          ...settings.harnessPriority.filter((harness) => harness !== override)
        ] as AssistantSettings['harnessPriority']
      }
    }
    const settingsPort = {
      get: chatSettings,
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
          memoryFiles: deps.memoryFiles,
          ...(deps.peerMail === undefined ? {} : { peerMail: deps.peerMail }),
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
      botMemory: () => deps.memoryFiles.promptMemory(bot.id),
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
      threadId: deps.threadId,
      settings: settingsPort,
      onError: deps.onError,
      onRunComplete: (completion) => {
        this.lastCompletion = completion
        const waiter = this.runWaiters.get(completion.runId)
        if (waiter !== undefined) {
          this.runWaiters.delete(completion.runId)
          waiter(completion)
        }
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

  /** The finished messages of one run; a run that already ended answers at once. */
  waitForRun(runId: string): Promise<AssistantRunCompletion> {
    if (this.lastCompletion?.runId === runId) {
      return Promise.resolve(this.lastCompletion)
    }
    return new Promise((resolve) => {
      this.runWaiters.set(runId, resolve)
    })
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
  private readonly listeners = new Set<
    (botId: string, threadId: string, event: AssistantEvent) => void
  >()

  constructor(private readonly deps: BotRuntimeRegistryDeps) {}

  subscribe(
    listener: (botId: string, threadId: string, event: AssistantEvent) => void
  ): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(botId: string, threadId: string, event: AssistantEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(botId, threadId, event)
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
    const thread = this.deps.store.findHomeThreadByBotId(botId)
    if (thread === null) throw new Error('That bot has no chat thread.')
    const runtime = new BotRuntime({
      ...this.deps,
      bot,
      threadId: thread.id,
      sandboxKey: bot.id,
      onEvent: (id, event) => this.emit(id, thread.id, event)
    })
    this.homeRuntimes.set(botId, runtime)
    this.threadRuntimes.set(runtime.threadId, runtime)
    return runtime
  }

  /** A bot's home chat, or one of its side chats, chosen by assistant thread id. */
  ensureChat(botId: string, threadId?: string | null): BotRuntime {
    if (threadId === undefined || threadId === null) return this.ensureHome(botId)
    const thread = this.deps.store.findThread(threadId)
    // A caller may pass the home thread's id (the state payload always names
    // it); that is still the home runtime, not a side chat.
    if (thread !== null && thread.botId === botId && thread.isHome) {
      return this.ensureHome(botId)
    }
    return this.ensureSideChat(botId, threadId)
  }

  /** A side chat shares the bot's home workspace but has its own transcript and run. */
  ensureSideChat(botId: string, threadId: string): BotRuntime {
    const cached = this.threadRuntimes.get(threadId)
    if (cached !== undefined) return cached
    const bot = this.requireBot(botId)
    const thread = this.deps.store.findThread(threadId)
    if (
      thread === null ||
      thread.botId !== botId ||
      thread.kind !== 'bot' ||
      thread.isHome ||
      thread.groupThreadId !== null ||
      thread.archivedAt !== null
    ) {
      throw new Error('That side chat does not exist.')
    }
    const runtime = new BotRuntime({
      ...this.deps,
      bot,
      threadId: thread.id,
      sandboxKey: `${bot.id}__${thread.id}`,
      ...(thread.harness === null ? {} : { harnessOverride: thread.harness }),
      onEvent: (id, event) => this.emit(id, thread.id, event)
    })
    this.threadRuntimes.set(thread.id, runtime)
    return runtime
  }

  /** Starts an empty side chat; its first owner message names it. */
  createSideChat(botId: string, harness?: ModelHarness): AssistantThread {
    const bot = this.requireBot(botId)
    const now = this.deps.now()
    const thread = this.deps.store.insertThread({
      id: this.deps.newId('athread'),
      kind: 'bot',
      title: ASSISTANT_SIDE_CHAT_TITLE,
      botId: bot.id,
      isHome: false,
      harness: harness ?? null,
      groupThreadId: null,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: null,
      lastReadSeq: 0,
      activeRunId: null,
      archivedAt: null
    })
    this.deps.botService.notifyChanged(botId)
    return thread
  }

  /** Search durable bot-chat and room transcripts for global history. */
  searchHistory(
    query: string,
    limit: number
  ): {
    chats: Array<{
      threadId: string
      botId: string
      snippet: string
      createdAt: number
    }>
    rooms: Array<{
      groupId: string
      threadId: string
      snippet: string
      createdAt: number
    }>
  } {
    const chats = this.deps.store.searchBotMessages(query, limit)
    const rooms =
      this.deps.groups === undefined
        ? []
        : this.deps.groups.searchMessages(query, limit)
    return {
      chats: chats.map((hit) => ({
        threadId: hit.threadId,
        botId: hit.botId,
        snippet: hit.body,
        createdAt: hit.createdAt
      })),
      rooms: rooms.map((hit) => ({
        groupId: hit.groupId,
        threadId: hit.threadId,
        snippet: hit.body,
        createdAt: hit.createdAt
      }))
    }
  }

  /** A bot's home chat plus every side chat, home first. */
  listChats(botId: string): Array<AssistantThread & { unread: number }> {
    this.requireBot(botId)
    return this.deps.store
      .listChatsForBot(botId)
      .map((thread) => ({ ...thread, unread: this.deps.store.unreadCount(thread.id) }))
  }

  /**
   * Starts a fresh Home Chat. The old home keeps its transcript as an
   * ordinary side chat, so nothing is lost and its tab can be reopened.
   */
  newHomeChat(botId: string): {
    thread: AssistantThread
    replacedThreadId: string | null
  } {
    const bot = this.requireBot(botId)
    if (this.homeRuntimes.get(botId)?.status() === 'working') {
      throw new Error('That bot is still answering. Stop it before starting a new home chat.')
    }
    const previous = this.deps.store.findHomeThreadByBotId(botId)
    const now = this.deps.now()
    const created = this.deps.store.insertThread({
      id: this.deps.newId('athread'),
      kind: 'bot',
      title: bot.name,
      botId: bot.id,
      isHome: false,
      harness: null,
      groupThreadId: null,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: null,
      lastReadSeq: 0,
      activeRunId: null,
      archivedAt: null
    })
    const thread = this.deps.store.setHomeThread(botId, created.id, now)
    if (thread === null) throw new Error('The new home chat could not be created.')
    if (previous !== null) {
      const latest = this.deps.store.latestUserMessageBody(previous.id)
      const title =
        (latest === null ? null : assistantThreadTitleFromText(latest)) ??
        ASSISTANT_PREVIOUS_HOME_TITLE
      this.deps.store.updateThreadTitle(previous.id, title, now)
      const runtime = this.homeRuntimes.get(botId)
      runtime?.stop()
      this.homeRuntimes.delete(botId)
      this.threadRuntimes.delete(previous.id)
    }
    this.deps.botService.notifyChanged(botId)
    return { thread, replacedThreadId: previous?.id ?? null }
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
          isHome: false,
          harness: null,
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
      onEvent: (id, event) => this.emit(id, thread.id, event)
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
