import type { HarnessId } from './harness'
import { resumePlan } from './harness'
import { DEFAULT_LOCALE, t, type Locale } from '../i18n'

/**
 * What Wake does for each harness.
 *
 * Sleep is a user-facing hibernate, not a suspended process: the PTY is stopped
 * and memory is released. Agents with a captured conversation identity get their
 * own CLI's resume argv; agents whose CLI has no known resume recipe wake fresh
 * instead of claiming a conversation was restored. Shell has no conversation
 * state, so Wake is explicitly a fresh shell in the same worktree.
 */
export type WakePlan = {
  args: string[]
  resumesConversation: boolean
}

export function wakePlan(harness: HarnessId, resumeToken: string | null): WakePlan {
  return resumePlan(harness, resumeToken)
}

export function wakeDescription(harness: HarnessId, locale: Locale = DEFAULT_LOCALE): string {
  return wakePlan(harness, null).resumesConversation
    ? t(locale, 'session.wake.resumes')
    : t(locale, 'session.wake.fresh')
}
