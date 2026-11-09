import type { RepositoryStore } from '../persistence/repository-store'
import type { TaskStore } from '../tasks/task-store'
import type { SessionService } from '../sessions/session-service'
import type { AssistantStore } from '../persistence/assistant-store'
import type { TaskService } from '../tasks/task-service'
import type { AssistantSettings } from '../../shared/domain/assistant'
import { ASSISTANT_LIMITS } from '../../shared/domain/assistant'

export type AssistantSnapshot = {
  now: number
  maxConcurrent: number
  projects: Array<Record<string, unknown>>
  tasks: Array<Record<string, unknown>>
  sessions: Array<Record<string, unknown>>
  needs: {
    pendingApproval: number
    waiting: number
    failed: number
    reviewReady: number
  }
  memory: Array<{ key: string; value: string }>
}

export type AssistantContextDeps = {
  taskStore: TaskStore
  tasks: TaskService
  repositories: RepositoryStore
  sessions: SessionService
  store: AssistantStore
  now: () => number
}

export async function buildAssistantSnapshot(
  deps: AssistantContextDeps
): Promise<AssistantSnapshot> {
  const tasks = deps.taskStore.list({ limit: 200 })
  const view = await deps.sessions.list()
  const repositories = deps.repositories.list()
  const needs = { pendingApproval: 0, waiting: 0, failed: 0, reviewReady: 0 }
  for (const task of tasks) {
    if (task.approval === 'pending' && task.status === 'queued') needs.pendingApproval += 1
    if (task.status === 'waiting') needs.waiting += 1
    if (task.status === 'failed') needs.failed += 1
    if (task.status === 'completed' && task.reviewDecision === 'pending') needs.reviewReady += 1
  }
  return {
    now: deps.now(),
    maxConcurrent: deps.tasks.maxConcurrent(),
    projects: repositories.slice(0, 64).map((repo) => ({
      id: repo.id,
      name: repo.displayName,
      target: repo.executionTarget,
      branch: repo.currentBranch,
      preparation: repo.preparation?.state ?? null,
      availability: repo.availability
    })),
    tasks: tasks.slice(0, 30).map((task) => ({
      id: task.id,
      repoId: task.repoId,
      title: task.title,
      status: task.status,
      approval: task.approval,
      origin: task.origin,
      createdByActor: task.createdByActor,
      attempt: task.attempt,
      sessionId: task.sessionId,
      error: task.error,
      reviewDecision: task.reviewDecision,
      updatedAt: task.updatedAt
    })),
    sessions: view.sessions.slice(0, 20).map((session) => ({
      id: session.id,
      repoId: session.repoId,
      title: session.title,
      harness: session.harness,
      state: session.state,
      role: session.role,
      activity: session.activity?.state ?? null
    })),
    needs,
    memory: deps.store.listMemory()
  }
}

export type AssistantPromptInput = {
  personaName: string
  settings: AssistantSettings
  snapshot: AssistantSnapshot
  history: Array<{ role: string; body: string }>
  userText: string
  repoId?: string
  /** False when a native conversation already holds the prior turns. */
  includeHistory?: boolean
  /** Messages written outside the harness since the previous turn. */
  sinceLastTurn?: Array<{ kind: string; body: string }>
}

const ACTION_HELP = `Actions you may return (JSON objects with an "op"):
- {"op":"state"}
- {"op":"projects.list"}
- {"op":"tasks.listAll","statuses":["failed"],"approvals":["pending"],"includeArchived":false,"limit":20}
- {"op":"tasks.get","taskId":"..."}
- {"op":"tasks.changes","taskId":"..."}
- {"op":"tasks.diff","taskId":"...","path":"..."}
- {"op":"sessions.list","repoId":"..."}
- {"op":"tasks.create","repoId":"...","title":"...","prompt":"...","harness":"claude"|"codex"|"opencode"}
- {"op":"tasks.cancel","taskId":"..."}
- {"op":"tasks.retry","taskId":"..."}
- {"op":"tasks.archive","taskId":"..."}
- {"op":"sessions.message","taskId":"...","text":"..."}
- {"op":"supervisor.message","repoId":"...","text":"..."}
- {"op":"review.recommend","taskId":"...","decision":"accept"|"reject","note":"..."}
- {"op":"notify","text":"...","kind":"approval-needed"|"task-failed"|"plan-ready"|"custom","priority":"high"|"normal"|"low"}
- {"op":"memory.set","key":"...","value":"..."}
- {"op":"memory.forget","key":"..."}

You may return read actions in one round. Their results will come back to you.
Do not return reads and writes in the same round. When you have enough
information, return only writes with a short intent reply.`

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n…[truncated]`
}

export function buildAssistantPrompt(input: AssistantPromptInput): {
  text: string
  contextChars: number
  truncated: boolean
} {
  const { personaName, settings, snapshot } = input
  const protectedText = settings.autoDispatch.mode === 'low-risk'
    ? `Auto-dispatch is low-risk: protected keywords ${settings.autoDispatch.protectedKeywords.join(', ')}; protected paths ${settings.autoDispatch.protectedPaths.join(', ')}. Tasks that do not match may be queued automatically. Everything else needs approval.`
    : settings.autoDispatch.mode === 'all'
      ? 'Auto-dispatch is set to all: your tasks are approved automatically, but review and merge are still human.'
      : 'Auto-dispatch is off: every task you create needs human approval.'

  const header = `You are ${personaName}, the user's cross-project personal assistant inside iCode.
You can see every project, task, session, review and diff. You can act only through the typed actions below.
You cannot run shell commands, edit files, merge, push, or decide a review. You must never claim an action happened unless its result says so.
You are not a supervisor who owns the project; you work for the user. Be concise, direct, and honest. Reply in the user's language.

${ACTION_HELP}

${protectedText}
Use memory.set only for durable, useful preferences. Never store secrets.
For proactive messages, use notify only when the user needs to know now.`

  const context = JSON.stringify(
    {
      now: new Date(snapshot.now).toISOString(),
      maxConcurrent: snapshot.maxConcurrent,
      needs: snapshot.needs,
      projects: snapshot.projects,
      tasks: snapshot.tasks,
      sessions: snapshot.sessions,
      memory: snapshot.memory,
      currentProject: input.repoId ?? null
    },
    null,
    2
  )

  const includeHistory = input.includeHistory !== false
  const history = includeHistory
    ? input.history
        .slice(-12)
        .map((message) => `${message.role.toUpperCase()}: ${truncate(message.body, 1_000)}`)
        .join('\n')
    : ''
  const sinceLastTurn = (input.sinceLastTurn ?? [])
    .slice(-10)
    .map((message) => `- [${message.kind}] ${truncate(message.body, 300)}`)
    .join('\n')
  const priorTurns = [
    includeHistory ? `## Recent conversation\n${history || '(none)'}` : null,
    sinceLastTurn.length > 0 ? `## Since your last turn\n${sinceLastTurn}` : null
  ]
    .filter((block): block is string => block !== null)
    .join('\n\n')

  const raw = `${header}

## Current state
${context}
${priorTurns.length > 0 ? `\n${priorTurns}\n` : ''}
## User
${input.userText}

Return exactly one JSON object:
{"reply":"what to say to the user","actions":[...]}
Do not wrap it in Markdown fences or add prose outside it.`

  const text = raw.length > ASSISTANT_LIMITS.maxPromptChars
    ? `${raw.slice(0, ASSISTANT_LIMITS.maxPromptChars)}\n…[context truncated]`
    : raw
  return { text, contextChars: text.length, truncated: text.length < raw.length }
}

/**
 * The message for a read round on an already-running native conversation.
 *
 * The harness already holds the prior prompt and envelope, so only the new
 * tool results are sent. `corrective` replaces them when the previous response
 * could not be parsed as an envelope.
 */
export function buildAssistantContinuationPrompt(input: {
  readResults: string[]
  corrective?: string | null
}): string {
  if (input.corrective) return input.corrective
  const results = input.readResults
    .map((result) => result.trim())
    .filter((result) => result.length > 0)
    .join('\n')
  return `## Tool results (this round)
${results || '(none)'}

Continue. Return only the JSON object.`
}
