import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, posix } from 'node:path'
import type { ExecutionTarget } from '../../shared/domain/repository'
import { LOCAL_EXECUTION_TARGET } from '../../shared/domain/repository'
import type { HarnessId } from '../../shared/domain/harness'
import type { HarnessDetectionResult } from '../harness/harness-detector'
import type { WorkspaceTrustService } from '../harness/trust/workspace-trust'
import type { WslCommandRunner } from '../wsl/exec'
import type { OneShotRunOptions, OneShotResult } from '../ai/harness-one-shot'
import { runHarnessOneShot } from '../ai/harness-one-shot'
import type { AssistantStore } from '../persistence/assistant-store'
import type { RepositoryStore } from '../persistence/repository-store'
import type { TaskService } from '../tasks/task-service'
import type { TaskStore } from '../tasks/task-store'
import type { SessionService } from '../sessions/session-service'
import type { AssistantConversation, AssistantSettings } from '../../shared/domain/assistant'
import { ASSISTANT_LIMITS } from '../../shared/domain/assistant'
import type { WslDistroListPayload } from '../../shared/schemas/ipc'
import type {
  AssistantRunEvent,
  AssistantRunInput,
  AssistantRunnerLike,
  AssistantRunnerResult
} from './assistant-service'
import { ClaudeStreamParser } from './assistant-stream'
import type { AssistantActionResult, AssistantActions } from './assistant-actions'
import type { AssistantActionPayload } from './assistant-envelope'
import { parseAssistantEnvelope } from './assistant-envelope'
import {
  buildAssistantContinuationPrompt,
  buildAssistantPrompt,
  buildAssistantSnapshot
} from './assistant-context'
import { continuationDriver } from './assistant-continuation'
import {
  resolveConversation,
  retireForResumeFailure,
  type ConversationSelection
} from './assistant-conversation'
import { parseAssistantHarnessOutput } from './assistant-harness'

const TURN_TIMEOUT_MS = 120_000

export type AssistantRunnerDeps = {
  store: AssistantStore
  actionsFor: (threadId: string, runId: string) => AssistantActions
  taskStore: TaskStore
  tasks: TaskService
  repositories: RepositoryStore
  sessions: SessionService
  settings: () => AssistantSettings
  detectHarness: (
    harness: HarnessId,
    target: ExecutionTarget
  ) => Promise<HarnessDetectionResult>
  listWslDistros: () => Promise<WslDistroListPayload>
  readGuestHome: (distro: string) => Promise<string | null>
  wslRunner: WslCommandRunner
  workspaceTrust: WorkspaceTrustService
  userDataDir: string
  runOneShot?: (options: OneShotRunOptions) => Promise<OneShotResult>
  /** Future setting seam; native resume is on by default. */
  resumeEnabled?: boolean
  newId?: (prefix: string) => string
  now: () => number
  onError?: (error: unknown) => void
}

type SelectedHarness = {
  harness: HarnessId
  detection: Extract<HarnessDetectionResult, { state: 'available' }>
  target: ExecutionTarget
}

function compactToolResult(result: AssistantActionResult): string {
  const text = JSON.stringify({
    op: result.op,
    ok: result.ok,
    message: result.message,
    value: result.value
  })
  return text.length > 8_000 ? `${text.slice(0, 8_000)}…[truncated]` : text
}

function targetLabel(target: ExecutionTarget): string {
  return target.kind === 'wsl' ? `wsl:${target.distro}` : 'local'
}

function isReadAction(action: AssistantActionPayload): boolean {
  return (
    action.op === 'state' ||
    action.op === 'projects.list' ||
    action.op === 'tasks.listAll' ||
    action.op === 'tasks.get' ||
    action.op === 'tasks.changes' ||
    action.op === 'tasks.diff' ||
    action.op === 'sessions.list'
  )
}

/**
 * One Mira turn: a bounded read/write loop over a headless harness.
 *
 * The harness is the planner. Main executes every action; the harness has no
 * project cwd and no iCode command surface.
 */
export class AssistantRunner implements AssistantRunnerLike {
  private active: AbortController | null = null
  /** Harnesses whose resume args were rejected by the installed CLI. */
  private readonly resumeDisabled = new Set<HarnessId>()

  constructor(private readonly deps: AssistantRunnerDeps) {}

  stop(): void {
    this.active?.abort()
  }

  async run(
    input: AssistantRunInput,
    onEvent?: (event: AssistantRunEvent) => void
  ): Promise<AssistantRunnerResult> {
    const controller = new AbortController()
    this.active = controller
    try {
      return await this.runInner(input, controller.signal, onEvent)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.onError?.(error)
      return {
        messages: [
          {
            role: 'system',
            kind: 'error',
            body: `Mira could not finish that request: ${message}`
          }
        ],
        status: 'error',
        error: message
      }
    } finally {
      if (this.active === controller) this.active = null
    }
  }

  private async runInner(
    input: AssistantRunInput,
    signal: AbortSignal,
    onEvent?: (event: AssistantRunEvent) => void
  ): Promise<AssistantRunnerResult> {
    const emit = (event: AssistantRunEvent): void => {
      try {
        onEvent?.(event)
      } catch {
        // A broken renderer must not abort the turn.
      }
    }
    emit({ type: 'progress', stage: 'selecting' })
    const settings = this.deps.settings()
    const selected = await this.selectHarness(settings)
    if (!selected) {
      throw new Error(
        'No agent harness is available. Install Claude Code, Codex, or OpenCode, or choose a target in Mira settings.'
      )
    }
    emit({
      type: 'progress',
      stage: 'calling',
      harness: selected.harness,
      target: targetLabel(selected.target),
      round: 0
    })
    this.deps.store.updateRun(input.runId, {
      stage: 'calling',
      harness: selected.harness,
      targetKind: selected.target.kind,
      targetDistro: selected.target.kind === 'wsl' ? selected.target.distro : null
    })
    const harness = selected.harness
    if (harness !== 'claude' && harness !== 'codex' && harness !== 'opencode') {
      throw new Error(`Unsupported assistant harness: ${harness}`)
    }
    const driver = continuationDriver(harness)
    if (driver === null) throw new Error(`Unsupported assistant harness: ${harness}`)
    const newId = this.deps.newId ?? ((prefix: string) => `${prefix}_${randomUUID()}`)
    const selection: ConversationSelection = {
      harness,
      targetKind: selected.target.kind,
      targetDistro: selected.target.kind === 'wsl' ? selected.target.distro : null
    }
    const resumeAllowed = this.deps.resumeEnabled !== false && driver.resumable
    const userSeq = this.deps.store.getMessage(input.messageId)?.seq ?? null
    if (userSeq === null) {
      throw new Error('The user message is missing; the conversation cannot be resolved.')
    }
    const sandbox = await this.prepareSandbox(selected)

    const appendBoundary = (body: string): void => {
      if (body.length === 0) return
      const message = this.deps.store.appendMessage({
        id: newId('msg'),
        threadId: input.threadId,
        role: 'system',
        kind: 'status',
        body,
        createdAt: this.deps.now()
      })
      if (message !== null) emit({ type: 'message' })
    }

    let plan = resolveConversation({
      store: this.deps.store,
      threadId: input.threadId,
      selection,
      startSeq: userSeq,
      now: this.deps.now(),
      newId
    })
    if (plan.boundaryBody !== null) appendBoundary(plan.boundaryBody)
    let conversation: AssistantConversation = plan.conversation
    if (!resumeAllowed && plan.resumeSessionId !== null) {
      const retired = retireForResumeFailure({
        store: this.deps.store,
        threadId: input.threadId,
        activeConversationId: conversation.id,
        reason: 'resume-unsupported',
        selection,
        startSeq: userSeq,
        now: this.deps.now(),
        newId
      })
      conversation = retired.conversation
      appendBoundary(retired.boundaryBody)
      plan = {
        conversation,
        resumeSessionId: null,
        includeHistory: true,
        firstPromptMode: 'full',
        boundaryBody: null
      }
    }

    const snapshot = await buildAssistantSnapshot({
      taskStore: this.deps.taskStore,
      tasks: this.deps.tasks,
      repositories: this.deps.repositories,
      sessions: this.deps.sessions,
      store: this.deps.store,
      now: this.deps.now
    })
    const history = this.deps.store
      .listMessages(input.threadId, { limit: 13 })
      .filter((message) => message.id !== input.messageId)
      .map((message) => ({ role: message.role, body: message.body }))
    const lastPromptSeq = conversation.lastPromptSeq
    const sinceLastTurn =
      plan.resumeSessionId !== null && lastPromptSeq !== null
        ? this.deps.store
            .listDigestMessages(input.threadId, lastPromptSeq, 10)
            .map((message) => ({ kind: message.kind, body: message.body }))
        : []
    const built = buildAssistantPrompt({
      personaName: settings.personaName,
      settings,
      snapshot,
      history,
      userText: input.text,
      ...(input.repoId === undefined ? {} : { repoId: input.repoId }),
      includeHistory: plan.includeHistory,
      sinceLastTurn
    })
    const fallbackPrompt = buildAssistantPrompt({
      personaName: settings.personaName,
      settings,
      snapshot,
      history,
      userText: input.text,
      ...(input.repoId === undefined ? {} : { repoId: input.repoId }),
      includeHistory: true
    }).text
    this.deps.store.updateRun(input.runId, {
      stage: 'selecting',
      harness: selected.harness,
      targetKind: selected.target.kind,
      targetDistro: selected.target.kind === 'wsl' ? selected.target.distro : null,
      contextChars: built.contextChars,
      resumeToken: plan.resumeSessionId
    })
    this.deps.store.touchConversation(conversation.id, {
      now: this.deps.now(),
      lastPromptSeq: userSeq
    })

    const actions = this.deps.actionsFor(input.threadId, input.runId)
    const target = targetLabel(selected.target)
    let resumeSessionId = plan.resumeSessionId
    let fullPrompt = built.text
    let lastContinuation: string | null = null
    let correction: string | null = null
    let fallbackUsed = false
    let reply = ''
    let calls = 0
    let round = 0
    const results: AssistantActionResult[] = []

    while (calls < ASSISTANT_LIMITS.maxHarnessCalls) {
      if (signal.aborted) throw new Error('Stopped.')
      calls += 1
      const canResumeNow = resumeAllowed && !this.resumeDisabled.has(harness)
      let useResume = canResumeNow && resumeSessionId !== null
      let args: string[] | null = null
      if (useResume && resumeSessionId !== null) {
        args = driver.resumeArgs(resumeSessionId, {
          opencodeAgent: settings.opencodeAgent
        })
      }
      if (args === null) {
        if (useResume) {
          this.resumeDisabled.add(harness)
          useResume = false
        }
        args = driver.freshArgs({
          opencodeAgent: settings.opencodeAgent,
          resumeEnabled: canResumeNow
        })
      }
      const prompt = useResume
        ? (correction ?? lastContinuation ?? fullPrompt)
        : [fullPrompt, lastContinuation, correction]
            .filter((part): part is string => part !== null)
            .join('\n\n')
      this.deps.store.updateRun(input.runId, { stage: 'calling', round })
      emit({
        type: 'progress',
        stage: 'calling',
        harness,
        target,
        round
      })
      // A read round's intent is not the final answer; clear the previous
      // draft before the next response starts writing.
      emit({ type: 'delta', text: '' })

      const parser = harness === 'claude' ? new ClaudeStreamParser() : null
      const observer = driver.createObserver()
      let streamedDraft = ''
      let streamedThinking: number | null = null
      const onStdoutChunk = (chunk: string): void => {
        const observed = observer.push(chunk)
        if (observed !== null && observed !== resumeSessionId) {
          resumeSessionId = observed
          this.deps.store.setConversationSession(
            conversation.id,
            observed,
            this.deps.now()
          )
          this.deps.store.updateRun(input.runId, { resumeToken: observed })
        }
        if (parser === null) return
        const update = parser.push(chunk)
        if (update.thinkingTokens !== null && update.thinkingTokens !== streamedThinking) {
          streamedThinking = update.thinkingTokens
          emit({
            type: 'progress',
            stage: 'thinking',
            harness,
            target,
            round,
            thinkingTokens: streamedThinking
          })
        }
        if (update.draft !== null && update.draft !== streamedDraft) {
          streamedDraft = update.draft
          emit({ type: 'delta', text: streamedDraft })
        }
      }
      const output = await this.runOneShot({
        detection: selected.detection,
        args,
        prompt,
        worktreePath: sandbox.cwd,
        target: sandbox.target,
        timeoutMs: TURN_TIMEOUT_MS,
        signal,
        onStdoutChunk
      })
      const finalObserved = observer.finish()
      if (finalObserved !== null && finalObserved !== resumeSessionId) {
        resumeSessionId = finalObserved
        this.deps.store.setConversationSession(
          conversation.id,
          finalObserved,
          this.deps.now()
        )
        this.deps.store.updateRun(input.runId, { resumeToken: finalObserved })
      }
      if (parser !== null) {
        const update = parser.finish()
        if (update.draft !== null && update.draft !== streamedDraft) {
          streamedDraft = update.draft
          emit({ type: 'delta', text: streamedDraft })
        }
      }
      if (output.cancelled) throw new Error('Stopped.')
      if (output.timedOut) {
        throw new Error(
          'The agent took too long to answer. Check the harness login and network, then try again.'
        )
      }
      let parsedText: { ok: true; text: string } | { ok: false; error: string }
      if (output.exitCode !== 0 && output.stdout.trim().length === 0) {
        const detail = output.stderr.trim().slice(0, 1_000)
        parsedText = {
          ok: false,
          error: detail.length > 0 ? detail : 'The agent exited without an answer.'
        }
      } else {
        // The parser saw every chunk as it arrived, so it still has the result
        // event when the accumulated stdout hit its safety cap.
        const streamed = parser?.result() ?? null
        parsedText =
          streamed !== null && streamed.error !== null
            ? { ok: false as const, error: streamed.error }
            : streamed !== null && streamed.text !== null
              ? { ok: true as const, text: streamed.text }
              : parseAssistantHarnessOutput(harness, output.stdout)
      }
      if (!parsedText.ok) {
        const kind = useResume ? driver.classifyFailure(output) : 'other'
        if (useResume && kind !== 'other' && !fallbackUsed) {
          fallbackUsed = true
          if (kind === 'unsupported') this.resumeDisabled.add(harness)
          const retired = retireForResumeFailure({
            store: this.deps.store,
            threadId: input.threadId,
            activeConversationId: conversation.id,
            reason: kind === 'unsupported' ? 'resume-unsupported' : 'resume-failed',
            selection,
            startSeq: userSeq,
            now: this.deps.now(),
            newId
          })
          conversation = retired.conversation
          resumeSessionId = null
          // The old conversation was touched before the loop; the fallback
          // conversation needs the same turn anchor for its next digest.
          this.deps.store.touchConversation(conversation.id, {
            now: this.deps.now(),
            lastPromptSeq: userSeq
          })
          appendBoundary(retired.boundaryBody)
          fullPrompt =
            correction === null ? fallbackPrompt : `${fallbackPrompt}\n\n${correction}`
          correction = null
          // The failed resume was not a productive call; keep the turn budget.
          calls -= 1
          continue
        }
        throw new Error(parsedText.error)
      }
      if (parsedText.text.trim().length === 0) {
        throw new Error('The agent returned an empty response.')
      }
      const envelope = parseAssistantEnvelope(parsedText.text)
      if (!envelope.ok) {
        const correctionText = `Your previous response was not a valid JSON envelope: ${envelope.error}
Return only the JSON object described above.`
        if (calls === 1) {
          if (resumeSessionId !== null) {
            correction = correctionText
            lastContinuation = null
          } else {
            fullPrompt = `${fullPrompt}\n\n${correctionText}`
            lastContinuation = null
          }
          continue
        }
        return {
          messages: [{ body: parsedText.text }],
          harness: selected.harness,
          target: sandbox.target.kind === 'wsl' ? `wsl:${sandbox.target.distro}` : 'local',
          status: 'idle'
        }
      }
      correction = null
      if (envelope.value.reply) reply = envelope.value.reply
      // The envelope's `notify` shorthand is equivalent to the notify action.
      // Execute it before the read/write split so a read round cannot drop it.
      if (envelope.value.notify) {
        results.push(await actions.execute({ op: 'notify', ...envelope.value.notify }))
      }
      const actionsInEnvelope = envelope.value.actions ?? []
      const reads = actionsInEnvelope.filter(isReadAction)
      if (reads.length > 0) {
        this.deps.store.updateRun(input.runId, { stage: 'reading', round })
        emit({
          type: 'progress',
          stage: 'reading',
          harness: selected.harness,
          target,
          round
        })
        const readResults: AssistantActionResult[] = []
        for (const action of reads) {
          readResults.push(await actions.execute(action))
        }
        const continuation = buildAssistantContinuationPrompt({
          readResults: readResults.map(compactToolResult)
        })
        if (resumeSessionId !== null) {
          lastContinuation = continuation
        } else {
          fullPrompt = `${fullPrompt}\n\n${continuation}`
          lastContinuation = null
        }
        correction = null
        round += 1
        continue
      }

      const writes = actionsInEnvelope.filter((action) => !isReadAction(action))
      if (writes.length > 0) {
        this.deps.store.updateRun(input.runId, { stage: 'acting', round })
        emit({
          type: 'progress',
          stage: 'acting',
          harness: selected.harness,
          target,
          round
        })
      }
      let creations = 0
      let messages = 0
      for (const action of writes) {
        if (action.op === 'tasks.create') {
          creations += 1
          if (creations > settings.autoDispatch.maxTasksPerRun) {
            results.push({
              op: 'tasks.create',
              ok: false,
              message: `I can create at most ${String(settings.autoDispatch.maxTasksPerRun)} tasks per turn.`,
              card: {
                type: 'error',
                message: `At most ${String(settings.autoDispatch.maxTasksPerRun)} tasks per turn.`
              }
            })
            continue
          }
        }
        if (action.op === 'sessions.message' || action.op === 'supervisor.message') {
          messages += 1
          if (messages > ASSISTANT_LIMITS.maxSessionMessagesPerRun) {
            results.push({
              op: action.op,
              ok: false,
              message: 'At most two session messages per turn.',
              card: { type: 'error', message: 'At most two session messages per turn.' }
            })
            continue
          }
        }
        results.push(await actions.execute(action))
      }
      break
    }

    this.deps.store.updateRun(input.runId, {
      stage: 'done',
      round,
      contextChars: built.contextChars
    })

    const messagesOut: AssistantRunnerResult['messages'] = []
    const text = reply.trim()
    if (text.length > 0) messagesOut.push({ body: text })
    for (const result of results) {
      if (result.card && result.card.type !== 'error') {
        messagesOut.push({
          kind: 'card',
          body: result.message,
          card: result.card
        })
      } else if (!result.ok) {
        messagesOut.push({
          kind: 'action',
          body: result.message,
          card: result.card ?? { type: 'error', message: result.message }
        })
      }
    }
    if (messagesOut.length === 0) {
      const fallback = results.map((result) => result.message).filter(Boolean).join('\n')
      messagesOut.push({ body: fallback || 'Done.' })
    }
    return {
      messages: messagesOut,
      harness: selected.harness,
      target: sandbox.target.kind === 'wsl' ? `wsl:${sandbox.target.distro}` : 'local',
      status: 'idle'
    }
  }

  private async selectHarness(settings: AssistantSettings): Promise<SelectedHarness | null> {
    const candidates = settings.harnessPriority
    const tryTarget = async (target: ExecutionTarget): Promise<SelectedHarness | null> => {
      for (const harness of candidates) {
        const detection = await this.deps
          .detectHarness(harness, target)
          .catch(() => null)
        if (detection?.state === 'available') {
          return { harness, detection, target }
        }
      }
      return null
    }

    if (settings.target.kind === 'local') {
      return tryTarget(LOCAL_EXECUTION_TARGET)
    }
    if (settings.target.kind === 'wsl') {
      return tryTarget({ kind: 'wsl', distro: settings.target.distro, distroId: null })
    }
    const local = await tryTarget(LOCAL_EXECUTION_TARGET)
    if (local) return local
    const distros = await this.deps.listWslDistros().catch(() => null)
    if (distros?.status !== 'ok') return null
    for (const distro of distros.distros) {
      const found = await tryTarget({
        kind: 'wsl',
        distro: distro.name,
        distroId: distro.registrationId
      })
      if (found) return found
    }
    return null
  }

  private async prepareSandbox(selected: SelectedHarness): Promise<{
    cwd: string
    target: ExecutionTarget
  }> {
    if (selected.target.kind === 'local') {
      const cwd = join(this.deps.userDataDir, 'assistant', 'sandbox')
      mkdirSync(cwd, { recursive: true })
      await this.deps.workspaceTrust
        .prepare({ harness: selected.harness, target: selected.target, worktreePath: cwd })
        .catch(() => ({ status: 'failed' as const, detail: 'Trust preparation failed.' }))
      return { cwd, target: selected.target }
    }
    const home = await this.deps.readGuestHome(selected.target.distro)
    if (!home) throw new Error('The WSL distro home could not be read.')
    const cwd = posix.join(home, '.icode', 'assistant', 'sandbox', 'default')
    const created = await this.deps.wslRunner.run({
      scope: 'guest',
      distro: selected.target.distro,
      argv: ['mkdir', '-p', cwd],
      timeoutMs: 20_000
    })
    if (created.status !== 'ok') throw new Error('The WSL assistant sandbox could not be created.')
    await this.deps.workspaceTrust
      .prepare({ harness: selected.harness, target: selected.target, worktreePath: cwd })
      .catch(() => ({ status: 'failed' as const, detail: 'Trust preparation failed.' }))
    return { cwd, target: selected.target }
  }

  private runOneShot(options: OneShotRunOptions): Promise<OneShotResult> {
    return this.deps.runOneShot
      ? this.deps.runOneShot(options)
      : runHarnessOneShot(options, this.deps.wslRunner)
  }
}
