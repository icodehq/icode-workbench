import { makeAppError, type AppError } from '../../shared/domain/errors'
import type {
  AssistantActiveRun,
  AssistantCard,
  AssistantEvent,
  AssistantMessageKind,
  AssistantPriority,
  AssistantRunStage,
  AssistantSettings,
  AssistantState,
  AssistantStatus,
  AssistantThread
} from '../../shared/domain/assistant'
import {
  ASSISTANT_SIDE_CHAT_TITLE,
  assistantThreadTitleFromText,
  DEFAULT_ASSISTANT_SETTINGS
} from '../../shared/domain/assistant'
import type { AssistantConversationPayload } from '../../shared/schemas/assistant'
import { mainT } from '../i18n/main-i18n'
import type {
  AssistantMessageRecord,
  AssistantStore
} from '../persistence/assistant-store'
import { resetConversationForUser } from './assistant-conversation'

export type AssistantReply = {
  role?: 'assistant' | 'system'
  kind?: AssistantMessageKind
  body: string
  card?: AssistantCard | null
  priority?: AssistantPriority | null
}

export type AssistantRunInput = {
  threadId: string
  runId: string
  messageId: string
  text: string
  startedAt: number
  repoId?: string
}

/**
 * Live run signals from the runner. They are deliberately not persisted as
 * messages: only the completed reply/cards are durable. A renderer reload loses
 * the draft but keeps the run's stage and start time.
 */
export type AssistantRunEvent =
  | {
      type: 'progress'
      stage: AssistantRunStage
      harness?: string | null
      target?: string | null
      round?: number
      thinkingTokens?: number | null
    }
  | { type: 'delta'; text: string }
  /** A message was persisted mid-run (a conversation boundary). */
  | { type: 'message' }

export type AssistantRunnerResult = {
  messages: AssistantReply[]
  status?: Extract<AssistantStatus, 'idle' | 'error'>
  error?: string
  harness?: string | null
  target?: string | null
}

export interface AssistantRunnerLike {
  run(
    input: AssistantRunInput,
    onEvent?: (event: AssistantRunEvent) => void
  ): Promise<AssistantRunnerResult>
  stop(): void
}

export type AssistantSettingsPort = {
  get: () => AssistantSettings
  save: (settings: AssistantSettings, now: number) => AssistantSettings
}

/** Fired once for every run, before the thread is released for the next send. */
export type AssistantRunCompletion = {
  threadId: string
  runId: string
  status: AssistantStatus
  error: string | null
  stopped: boolean
  messages: AssistantMessageRecord[]
}

export type AssistantServiceDeps = {
  store: AssistantStore
  now: () => number
  newId: (prefix: string) => string
  /** Optional until the headless runner is wired. */
  runner?: AssistantRunnerLike
  /** The bot thread this service owns. */
  threadId: string
  /** Per-bot settings. */
  settings: AssistantSettingsPort
  onError?: (error: unknown) => void
  onRunComplete?: (completion: AssistantRunCompletion) => void
}

class AssistantServiceError extends Error {
  readonly appError: AppError
  readonly code: AppError['code']

  constructor(code: AppError['code'], message: string) {
    super(message)
    this.name = 'AssistantServiceError'
    this.appError = makeAppError(code, message)
    this.code = code
  }
}

function runStage(value: string | null): AssistantRunStage {
  if (value === 'planning' || value === 'harness') return 'selecting'
  if (value === 'calling') return 'calling'
  if (value === 'thinking' || value === 'reading' || value === 'acting' || value === 'done') {
    return value
  }
  if (value === 'error' || value === 'cancelled') return 'done'
  return 'calling'
}

function runTarget(run: { targetKind: 'local' | 'wsl' | null; targetDistro: string | null }): string | null {
  if (run.targetKind === 'local') return 'local'
  if (run.targetKind === 'wsl') return run.targetDistro ? `wsl:${run.targetDistro}` : 'wsl'
  return null
}

/**
 * One bot thread's chat service.
 *
 * The service owns persistence, one active run, unread state and the event
 * stream. It deliberately knows nothing about harnesses or task actions; those
 * live behind AssistantRunner and AssistantActions.
 */
export class AssistantService {
  private status: AssistantStatus = 'offline'
  private harness: string | null = null
  private target: string | null = null
  private readonly listeners = new Set<(event: AssistantEvent) => void>()
  private running: { runId: string; controller: AbortController } | null = null

  constructor(private readonly deps: AssistantServiceDeps) {}

  private settingsPort(): AssistantSettingsPort {
    return this.deps.settings
  }

  threadId(): string {
    return this.ensureThread().id
  }

  /** The configured display name; never a hardcoded persona. */
  private personaName(): string {
    return this.settingsPort().get().personaName
  }

  start(): void {
    const thread = this.ensureThread()
    const interrupted = this.deps.store.failStaleRuns(this.deps.now(), thread.id)
    if (interrupted > 0) {
      this.deps.store.appendMessage({
        id: this.deps.newId('msg'),
        threadId: thread.id,
        role: 'system',
        kind: 'error',
        body: mainT('assistant.restarted', { name: this.personaName() }),
        createdAt: this.deps.now()
      })
    }
    this.status = this.deps.runner ? 'idle' : 'offline'
    this.emit({ type: 'status', status: this.status })
  }

  stop(): void {
    this.running?.controller.abort()
    this.running = null
    this.deps.runner?.stop()
    this.status = this.deps.runner ? 'idle' : 'offline'
    this.emit({ type: 'status', status: this.status })
  }

  /**
   * Start a fresh native conversation without deleting the visible thread.
   *
   * The next send resolves a clean conversation; the boundary message explains
   * why the prior turns no longer count as model context.
   */
  newConversation(): { message: AssistantMessageRecord | null } {
    const thread = this.ensureThread()
    if (this.running !== null) {
      throw new AssistantServiceError(
        'ASSISTANT_BUSY',
        mainT('assistant.busy', { name: this.personaName() })
      )
    }
    const result = resetConversationForUser({
      store: this.deps.store,
      threadId: thread.id,
      personaName: this.personaName(),
      now: this.deps.now(),
      newId: this.deps.newId
    })
    if (result !== null) this.emit({ type: 'changed' })
    return { message: result?.message ?? null }
  }

  subscribe(listener: (event: AssistantEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  ensureThread(): AssistantThread {
    const thread = this.deps.store.findThread(this.deps.threadId)
    if (thread === null) {
      throw new AssistantServiceError(
        'INTERNAL',
        'That conversation thread no longer exists.'
      )
    }
    return thread
  }

  state(): AssistantState {
    const thread = this.ensureThread()
    const settings = this.settingsPort().get()
    const active = thread.activeRunId ? this.deps.store.findRun(thread.activeRunId) : null
    const latest = this.deps.store.latestRunForThread(thread.id)
    const activeRun: AssistantActiveRun | null =
      active && active.status === 'running'
        ? {
            id: active.id,
            stage: runStage(active.stage),
            harness: active.harness,
            target: runTarget(active),
            round: active.round,
            thinkingTokens: null,
            startedAt: active.startedAt
          }
        : null
    return {
      threadId: thread.id,
      personaName: settings.personaName,
      unread: this.deps.store.unreadCount(thread.id),
      status: this.status,
      harness: this.harness,
      target: this.target,
      contextChars: latest?.contextChars ?? null,
      activeRun,
      settings
    }
  }

  settings(): AssistantSettings {
    return this.settingsPort().get()
  }

  saveSettings(settings: AssistantSettings): AssistantSettings {
    const saved = this.settingsPort().save(settings, this.deps.now())
    this.emit({ type: 'changed' })
    return saved
  }

  /** A proactive bot message, written by the notifier rather than the model. */
  postNotification(input: {
    body: string
    card?: AssistantCard | null
    kind: Extract<AssistantMessageKind, 'notification'>
    notificationKind: import('../../shared/domain/assistant').AssistantNotificationKind
    priority: AssistantPriority
    dedupeKey: string
  }): AssistantMessageRecord | null {
    const thread = this.ensureThread()
    const message = this.deps.store.appendMessage({
      id: this.deps.newId('msg'),
      threadId: thread.id,
      role: 'assistant',
      kind: input.kind,
      body: input.body,
      card: input.card ?? null,
      notificationKind: input.notificationKind,
      notificationPriority: input.priority,
      notificationState: 'pending',
      notificationDedupeKey: input.dedupeKey,
      createdAt: this.deps.now()
    })
    if (message) this.emit({ type: 'changed' })
    return message
  }

  markNotificationDelivered(messageId: string): void {
    this.deps.store.markNotificationDelivered(messageId, this.deps.now())
  }

  /**
   * Acknowledge one notification without asking the renderer to open the chat.
   *
   * Used when a toast click lands on a task or session instead of the card.
   * A missing message is a no-op: the click still navigates.
   */
  markNotificationRead(messageId: string): void {
    const thread = this.ensureThread()
    const message = this.deps.store.getMessage(messageId)
    if (message === null || message.threadId !== thread.id) return
    this.markRead({ threadId: thread.id, messageId })
  }

  /** Ask the renderer to open one message (used by OS notification clicks). */
  focus(messageId: string): void {
    const thread = this.ensureThread()
    const message = this.deps.store.getMessage(messageId)
    const conversation =
      message === null
        ? null
        : this.deps.store.findConversationForSeq(thread.id, message.seq)
    this.emit({
      type: 'focus',
      threadId: thread.id,
      messageId,
      conversationId: conversation?.id ?? null,
      seq: message?.seq ?? null
    })
  }

  listMessages(input: {
    threadId: string
    beforeSeq?: number
    limit?: number
    conversationId?: string
  }): AssistantMessageRecord[] {
    const thread = this.ensureThread()
    if (input.conversationId !== undefined) {
      const conversation = this.deps.store.findConversation(input.conversationId)
      if (
        conversation === null ||
        conversation.threadId !== thread.id ||
        conversation.startSeq === null
      ) {
        throw new AssistantServiceError(
          'INVALID_ARGUMENT',
          'That conversation is not part of this thread.'
        )
      }
      const next = this.deps.store.findNextConversation(thread.id, conversation.startSeq)
      return this.deps.store.listMessagesInRange(thread.id, {
        startSeq: conversation.startSeq,
        endSeq:
          next !== null && next.startSeq !== null ? next.startSeq - 1 : null,
        ...(input.beforeSeq === undefined ? {} : { beforeSeq: input.beforeSeq }),
        ...(input.limit === undefined ? {} : { limit: input.limit })
      })
    }
    return this.deps.store.listMessages(thread.id, {
      ...(input.beforeSeq === undefined ? {} : { beforeSeq: input.beforeSeq }),
      ...(input.limit === undefined ? {} : { limit: input.limit })
    })
  }

  listConversations(): AssistantConversationPayload[] {
    const thread = this.ensureThread()
    const conversations = this.deps.store.listConversations(thread.id)
    return conversations.map((conversation, index) => {
      const next = conversations[index + 1]
      return {
        id: conversation.id,
        threadId: conversation.threadId,
        harness: conversation.harness,
        targetKind: conversation.targetKind,
        targetDistro: conversation.targetDistro,
        state: conversation.state,
        resetReason: conversation.resetReason,
        startSeq: conversation.startSeq ?? 1,
        endSeq:
          next !== undefined && next.startSeq !== null ? next.startSeq - 1 : null,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt
      }
    })
  }

  listNotifications(input: { limit?: number } = {}): AssistantMessageRecord[] {
    const thread = this.ensureThread()
    return this.deps.store.listRecentNotifications(thread.id, input.limit ?? 10)
  }

  markRead(input: { threadId: string; messageId?: string; read?: boolean }): number {
    const thread = this.ensureThread()
    let seq: number
    if (input.messageId) {
      const message = this.deps.store.getMessage(input.messageId)
      if (!message || message.threadId !== thread.id) {
        throw new AssistantServiceError(
          'INVALID_ARGUMENT',
          mainT('assistant.notYourMessage')
        )
      }
      seq = message.seq
    } else {
      const messages = this.deps.store.listMessages(thread.id, { limit: 1 })
      seq = messages.at(-1)?.seq ?? 0
    }
    const before = this.deps.store.unreadCount(thread.id)
    const unread =
      input.read === false
        ? this.deps.store.setReadSeq(thread.id, Math.max(0, seq - 1), this.deps.now())
        : this.deps.store.markRead(thread.id, seq, this.deps.now())
    // Only a real watermark change is an event. The page marks read whenever it
    // sees messages; emitting unconditionally would make reload → markRead →
    // reload an infinite loop.
    if (unread !== before) this.emit({ type: 'changed' })
    return unread
  }

  /** The first owner message names a side chat; a later message never retitles it. */
  private maybeTitleSideChat(
    thread: AssistantThread,
    text: string,
    role: 'user' | 'system',
    now: number
  ): void {
    if (
      role !== 'user' ||
      thread.kind !== 'bot' ||
      thread.isHome ||
      thread.title !== ASSISTANT_SIDE_CHAT_TITLE
    ) {
      return
    }
    const title = assistantThreadTitleFromText(text)
    if (title !== null) this.deps.store.updateThreadTitle(thread.id, title, now)
  }

  async send(input: { text: string; repoId?: string; role?: 'user' | 'system' }): Promise<{
    message: AssistantMessageRecord
    runId: string
  }> {
    const thread = this.ensureThread()
    const runId = this.deps.newId('run')
    if (!this.deps.store.claimRun(thread.id, runId)) {
      throw new AssistantServiceError(
        'ASSISTANT_BUSY',
        mainT('assistant.busy', { name: this.personaName() })
      )
    }

    const now = this.deps.now()
    const userMessage = this.deps.store.appendMessage({
      id: this.deps.newId('msg'),
      threadId: thread.id,
      runId,
      role: input.role ?? 'user',
      kind: 'text',
      body: input.text,
      createdAt: now
    })
    if (!userMessage) {
      this.deps.store.releaseRun(thread.id, runId)
      throw new AssistantServiceError('INTERNAL', mainT('assistant.messageNotRecorded'))
    }
    this.maybeTitleSideChat(thread, input.text, input.role ?? 'user', now)

    const runner = this.deps.runner
    this.deps.store.createRun({
      id: runId,
      threadId: thread.id,
      trigger: 'user',
      // The runner records the harness it actually selected before planning.
      // This is only the NOT NULL placeholder while the run is being claimed.
      harness: 'claude',
      startedAt: now
    })
    this.status = runner ? 'working' : 'offline'
    this.emit({ type: 'status', status: this.status })
    this.emit({ type: 'changed' })
    if (runner) {
      this.emit({
        type: 'run',
        runId,
        stage: 'selecting',
        harness: null,
        target: null,
        round: 0,
        thinkingTokens: null,
        startedAt: now
      })
    }

    if (!runner) {
      this.deps.store.appendMessage({
        id: this.deps.newId('msg'),
        threadId: thread.id,
        runId,
        role: 'assistant',
        kind: 'error',
        body: mainT('assistant.noHarnessBody'),
        createdAt: this.deps.now()
      })
      this.deps.store.updateRun(runId, {
        status: 'failed',
        stage: 'harness',
        finishedAt: this.deps.now(),
        error: mainT('assistant.noHarnessError')
      })
      this.deps.store.releaseRun(thread.id, runId)
      this.emit({ type: 'changed' })
      this.emit({ type: 'status', status: this.status })
      this.deps.onRunComplete?.({
        threadId: thread.id,
        runId,
        status: this.status,
        error: mainT('assistant.noHarnessError'),
        stopped: false,
        messages: []
      })
      return { message: userMessage, runId }
    }

    const controller = new AbortController()
    this.running = { runId, controller }
    void this.run(runner, {
      threadId: thread.id,
      runId,
      messageId: userMessage.id,
      text: input.text,
      startedAt: now,
      ...(input.repoId === undefined ? {} : { repoId: input.repoId })
    }).finally(() => {
      this.running = null
    })

    return { message: userMessage, runId }
  }

  private async run(runner: AssistantRunnerLike, input: AssistantRunInput): Promise<void> {
    const completion: AssistantRunCompletion = {
      threadId: input.threadId,
      runId: input.runId,
      status: 'idle',
      error: null,
      stopped: false,
      messages: []
    }
    const onEvent = (event: AssistantRunEvent): void => {
      if (event.type === 'message') {
        this.emit({ type: 'changed' })
        return
      }
      if (event.type === 'delta') {
        this.emit({ type: 'delta', runId: input.runId, text: event.text })
        return
      }
      this.emit({
        type: 'run',
        runId: input.runId,
        stage: event.stage,
        harness: event.harness !== undefined ? event.harness : this.harness,
        target: event.target !== undefined ? event.target : this.target,
        round: event.round ?? 0,
        thinkingTokens: event.thinkingTokens ?? null,
        startedAt: input.startedAt
      })
    }
    try {
      this.emit({ type: 'status', status: 'working' })
      const result = await runner.run(input, onEvent)
      for (const reply of result.messages) {
        const message = this.deps.store.appendMessage({
          id: this.deps.newId('msg'),
          threadId: input.threadId,
          runId: input.runId,
          role: reply.role ?? 'assistant',
          kind: reply.kind ?? 'text',
          body: reply.body,
          card: reply.card ?? null,
          notificationPriority: reply.priority ?? null,
          createdAt: this.deps.now()
        })
        if (message !== null) completion.messages.push(message)
      }
      this.deps.store.updateRun(input.runId, {
        status: result.status === 'error' ? 'failed' : 'completed',
        stage: 'done',
        finishedAt: this.deps.now(),
        error: result.error ?? null
      })
      this.harness = result.harness ?? this.harness
      this.target = result.target ?? this.target
      this.status = result.status ?? 'idle'
      completion.status = this.status
      completion.error = result.error ?? null
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const stopped = message === 'Stopped.'
      this.deps.store.appendMessage({
        id: this.deps.newId('msg'),
        threadId: input.threadId,
        runId: input.runId,
        role: 'system',
        kind: stopped ? 'status' : 'error',
        body: stopped
          ? mainT('assistant.stopped')
          : mainT('assistant.failed', { name: this.personaName(), detail: message }),
        createdAt: this.deps.now()
      })
      this.deps.store.updateRun(input.runId, {
        status: stopped ? 'cancelled' : 'failed',
        stage: stopped ? 'cancelled' : 'error',
        finishedAt: this.deps.now(),
        error: stopped ? null : message
      })
      this.status = stopped ? 'idle' : 'error'
      completion.status = this.status
      completion.error = stopped ? null : message
      completion.stopped = stopped
      if (!stopped) this.deps.onError?.(error)
    } finally {
      this.deps.store.releaseRun(input.threadId, input.runId)
      this.emit({ type: 'changed' })
      this.emit({ type: 'status', status: this.status })
      try {
        this.deps.onRunComplete?.(completion)
      } catch {
        // A room listener must not break the assistant's run bookkeeping.
      }
    }
  }

  private emit(event: AssistantEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // A dead window must not stop the assistant.
      }
    }
  }
}

export { DEFAULT_ASSISTANT_SETTINGS }
