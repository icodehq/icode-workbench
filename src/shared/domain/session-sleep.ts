import type { HarnessId } from './harness'

/**
 * What Wake does for each harness.
 *
 * Sleep is a user-facing hibernate, not a suspended process: the PTY is stopped
 * and memory is released. Agents that persist conversations get their resume
 * CLI; Shell has no conversation state, so Wake is explicitly a fresh shell in
 * the same worktree.
 */
export type WakePlan = {
  args: string[]
  resumesConversation: boolean
}

export function wakePlan(harness: HarnessId, resumeToken: string | null): WakePlan {
  switch (harness) {
    case 'claude':
      return {
        args:
          resumeToken !== null && resumeToken.length > 0
            ? ['--resume', resumeToken]
            : ['--continue'],
        resumesConversation: true
      }
    case 'codex':
      // Codex filters --last by the current working directory unless --all is
      // passed; iCode sessions have their own worktree, so this is the right scope.
      return { args: ['resume', '--last'], resumesConversation: true }
    case 'opencode':
      return { args: ['--continue'], resumesConversation: true }
    case 'shell':
      return { args: [], resumesConversation: false }
  }
}

export function wakeDescription(harness: HarnessId): string {
  return wakePlan(harness, null).resumesConversation
    ? 'Wake resumes the most recent conversation in this worktree.'
    : 'Wake starts a new shell in this worktree; running commands and environment are not restored.'
}
