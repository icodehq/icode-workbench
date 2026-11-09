export type ContinuationPromptInput = {
  originalPrompt: string
  /** The predecessor attempt's recorded error, not the new row's. */
  previousError: string | null
  previousErrorDetail: string | null
}

/**
 * The instruction sent when a stopped task is continued.
 *
 * It is deliberately self-sufficient. Native resume may restore the whole
 * conversation (Claude `--resume`, Codex `resume --last`, OpenCode
 * `--continue`), or it may fall back to a fresh conversation when the harness
 * has nothing to restore. In both cases the agent must inspect the worktree
 * before acting, because the uncommitted work from the interrupted attempt is
 * the reason this action exists.
 *
 * The original instruction is repeated for the fallback case; a resumed
 * conversation simply sees it again, which is harmless and keeps the prompt
 * deterministic.
 */
export function buildContinuationPrompt(input: ContinuationPromptInput): string {
  const stopped =
    input.previousError?.trim() ||
    input.previousErrorDetail?.trim() ||
    'The previous attempt stopped before finishing.'
  return [
    'This continues an earlier attempt at the same task. That attempt stopped early:',
    stopped,
    '',
    'The working tree may already contain partial changes from that attempt.',
    'Inspect the current state (git status and the diff) before acting. Keep what is',
    'already correct, finish the remaining work, and do not redo completed work',
    'unless the existing changes are unusable.',
    '',
    'Original instruction:',
    input.originalPrompt
  ].join('\n')
}
