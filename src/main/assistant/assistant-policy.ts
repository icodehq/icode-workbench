import type { RepoId } from '../../shared/domain/ids'
import type { AssistantAutoDispatchSettings } from '../../shared/domain/assistant'
import type { TaskStore } from '../tasks/task-store'
import { MIRA_ACTOR_ID } from '../../shared/domain/assistant'

export type AssistantRiskDecision = {
  autoApprove: boolean
  reasons: string[]
  risk: 'low' | 'high'
}

export type AssistantPolicyDeps = {
  tasks: TaskStore
  now: () => number
}

function localDayStart(now: number): number {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * Decides whether a Mira-created task may skip the human approval gate.
 *
 * This is a conservative heuristic, not a security boundary: protected
 * keywords, protected paths and daily caps all keep the gate closed. False
 * negatives (safe tasks waiting for approval) are acceptable; false positives
 * are the risk.
 */
export class AssistantPolicy {
  constructor(private readonly deps: AssistantPolicyDeps) {}

  classify(input: {
    repoId: RepoId
    title?: string | null
    prompt: string
    settings: AssistantAutoDispatchSettings
  }): AssistantRiskDecision {
    const { settings } = input
    if (settings.mode === 'off') {
      return { autoApprove: false, reasons: ['auto-dispatch is off'], risk: 'low' }
    }
    if (settings.mode === 'all') {
      return { autoApprove: true, reasons: [], risk: 'low' }
    }
    const text = `${input.title ?? ''}\n${input.prompt}`.toLowerCase()
    const reasons: string[] = []
    for (const keyword of settings.protectedKeywords) {
      if (keyword.length > 0 && text.includes(keyword.toLowerCase())) {
        reasons.push(`protected keyword: ${keyword}`)
      }
    }
    for (const path of settings.protectedPaths) {
      if (path.length > 0 && text.includes(path.toLowerCase())) {
        reasons.push(`protected path: ${path}`)
      }
    }
    if (reasons.length > 0) {
      return { autoApprove: false, reasons, risk: 'high' }
    }
    if (settings.mode === 'low-risk') {
      const since = localDayStart(this.deps.now())
      const repoCount = this.deps.tasks.countAutoDispatchedSince(
        MIRA_ACTOR_ID,
        since,
        input.repoId
      )
      const totalCount = this.deps.tasks.countAutoDispatchedSince(MIRA_ACTOR_ID, since)
      if (repoCount >= settings.dailyCapPerProject) {
        reasons.push(`daily cap for this project reached (${String(settings.dailyCapPerProject)})`)
      }
      if (totalCount >= settings.dailyCapGlobal) {
        reasons.push(`global daily cap reached (${String(settings.dailyCapGlobal)})`)
      }
      if (reasons.length > 0) {
        return { autoApprove: false, reasons, risk: 'low' }
      }
    }
    return { autoApprove: true, reasons: [], risk: 'low' }
  }
}
