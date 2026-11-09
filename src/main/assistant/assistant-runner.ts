import { mkdirSync } from 'node:fs'
import { join, posix } from 'node:path'
import type { ExecutionTarget } from '../../shared/domain/repository'
import { LOCAL_EXECUTION_TARGET } from '../../shared/domain/repository'
import type { HarnessId } from '../../shared/domain/harness'
import type { HarnessDetectionResult } from '../harness/harness-detector'
import type { WorkspaceTrustService } from '../harness/trust/workspace-trust'
import type { WslCommandRunner } from '../wsl/exec'
import type { OneShotRunOptions, OneShotResult } from '../ai/harness-one-shot'
import { runHarnessOneShot } from '../ai/harness-one-shot'
import { mainT } from '../i18n/main-i18n'
import type { AssistantStore } from '../persistence/assistant-store'
import type { RepositoryStore } from '../persistence/repository-store'
import type { TaskService } from '../tasks/task-service'
import type { TaskStore } from '../tasks/task-store'
import type { SessionService } from '../sessions/session-service'
import type { AssistantSettings } from '../../shared/domain/assistant'
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
import { buildAssistantPrompt, buildAssistantSnapshot } from './assistant-context'
import {
  assistantHarnessArgs,
  parseAssistantHarnessOutput
} from './assistant-harness'

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
            body: mainT('assistant.failed', { detail: message })
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
      throw new Error(mainT('assistant.noHarnessAvailable'))
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
    const sandbox = await this.prepareSandbox(selected)
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
    const built = buildAssistantPrompt({
      personaName: settings.personaName,
      settings,
      snapshot,
      history,
      userText: input.text,
      ...(input.repoId === undefined ? {} : { repoId: input.repoId })
    })
    this.deps.store.updateRun(input.runId, {
      stage: 'selecting',
      harness: selected.harness,
      targetKind: selected.target.kind,
      targetDistro: selected.target.kind === 'wsl' ? selected.target.distro : null,
      contextChars: built.contextChars
    })

    const actions = this.deps.actionsFor(input.threadId, input.runId)
    const target = targetLabel(selected.target)
    let prompt = built.text
    let reply = ''
    let calls = 0
    let round = 0
    const results: AssistantActionResult[] = []

    while (calls < ASSISTANT_LIMITS.maxHarnessCalls) {
      if (signal.aborted) throw new Error('Stopped.')
      calls += 1
      const args = assistantHarnessArgs(selected.harness, settings.opencodeAgent)
      if (!args)
        throw new Error(mainT('assistant.unsupportedHarness', { harness: selected.harness }))
      this.deps.store.updateRun(input.runId, { stage: 'calling', round })
      emit({
        type: 'progress',
        stage: 'calling',
        harness: selected.harness,
        target,
        round
      })
      // A read round's intent is not the final answer; clear the previous
      // draft before the next response starts writing.
      emit({ type: 'delta', text: '' })

      const parser = selected.harness === 'claude' ? new ClaudeStreamParser() : null
      let streamedDraft = ''
      let streamedThinking: number | null = null
      const onStdoutChunk = (chunk: string): void => {
        if (parser === null) return
        const update = parser.push(chunk)
        if (update.thinkingTokens !== null && update.thinkingTokens !== streamedThinking) {
          streamedThinking = update.thinkingTokens
          emit({
            type: 'progress',
            stage: 'thinking',
            harness: selected.harness,
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
      if (parser !== null) {
        const update = parser.finish()
        if (update.draft !== null && update.draft !== streamedDraft) {
          streamedDraft = update.draft
          emit({ type: 'delta', text: streamedDraft })
        }
      }
      if (output.cancelled) throw new Error('Stopped.')
      if (output.timedOut) {
        throw new Error(mainT('assistant.timeout'))
      }
      if (output.exitCode !== 0 && output.stdout.trim().length === 0) {
        const detail = output.stderr.trim().slice(0, 1_000)
        throw new Error(detail.length > 0 ? detail : mainT('assistant.emptyExit'))
      }
      // The parser saw every chunk as it arrived, so it still has the result
      // event when the accumulated stdout hit its safety cap.
      const streamed = parser?.result() ?? null
      const parsedText =
        streamed !== null && streamed.error !== null
          ? { ok: false as const, error: streamed.error }
          : streamed !== null && streamed.text !== null
            ? { ok: true as const, text: streamed.text }
            : parseAssistantHarnessOutput(selected.harness, output.stdout)
      if (!parsedText.ok) {
        throw new Error(parsedText.error)
      }
      if (parsedText.text.trim().length === 0) {
        throw new Error(mainT('assistant.emptyResponse'))
      }
      const envelope = parseAssistantEnvelope(parsedText.text)
      if (!envelope.ok) {
        if (calls === 1) {
          prompt = `${prompt}

Your previous response was not a valid JSON envelope: ${envelope.error}
Return only the JSON object described above.`
          continue
        }
        return {
          messages: [{ body: parsedText.text }],
          harness: selected.harness,
          target: sandbox.target.kind === 'wsl' ? `wsl:${sandbox.target.distro}` : 'local',
          status: 'idle'
        }
      }
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
        prompt = `${prompt}

## Tool results (this round)
${readResults.map(compactToolResult).join('\n')}

Continue. Return only the JSON object.`
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
              message: mainT('assistant.tooManyTasks', {
                count: settings.autoDispatch.maxTasksPerRun
              }),
              card: {
                type: 'error',
                message: mainT('assistant.tooManyTasks', {
                  count: settings.autoDispatch.maxTasksPerRun
                })
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
              message: mainT('assistant.tooManySessionMessages'),
              card: { type: 'error', message: mainT('assistant.tooManySessionMessages') }
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
      messagesOut.push({ body: fallback || mainT('assistant.done') })
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
        .catch(() => ({ status: 'failed' as const, detail: mainT('assistant.trustFailed') }))
      return { cwd, target: selected.target }
    }
    const home = await this.deps.readGuestHome(selected.target.distro)
    if (!home) throw new Error(mainT('assistant.wslHomeUnreadable'))
    const cwd = posix.join(home, '.icode', 'assistant', 'sandbox', 'default')
    const created = await this.deps.wslRunner.run({
      scope: 'guest',
      distro: selected.target.distro,
      argv: ['mkdir', '-p', cwd],
      timeoutMs: 20_000
    })
    if (created.status !== 'ok') throw new Error(mainT('assistant.wslSandboxFailed'))
    await this.deps.workspaceTrust
      .prepare({ harness: selected.harness, target: selected.target, worktreePath: cwd })
      .catch(() => ({ status: 'failed' as const, detail: mainT('assistant.trustFailed') }))
    return { cwd, target: selected.target }
  }

  private runOneShot(options: OneShotRunOptions): Promise<OneShotResult> {
    return this.deps.runOneShot
      ? this.deps.runOneShot(options)
      : runHarnessOneShot(options, this.deps.wslRunner)
  }
}
