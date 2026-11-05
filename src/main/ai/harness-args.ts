import type { HarnessId } from '../../shared/domain/harness'

/**
 * Non-interactive arguments for commit-message generation.
 *
 * These are the agents' own one-shot modes: no interactive TUI, no session
 * resume, and a read-only/plan permission mode. The prompt is always supplied
 * on stdin, so no diff text enters argv.
 */
export function commitMessageArgs(harness: HarnessId): string[] | null {
  switch (harness) {
    case 'claude':
      return ['-p', '--output-format', 'text', '--permission-mode', 'plan']
    case 'codex':
      return ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only']
    case 'opencode':
      return ['run', '--agent', 'build', '--format', 'json']
    default:
      return null
  }
}

/** Some Codex builds predate `--ephemeral`; retry once without it. */
export function shouldRetryCodexWithoutEphemeral(stderr: string): boolean {
  return /unexpected argument|unrecognized|unknown option|unknown flag/i.test(stderr) &&
    /ephemeral/i.test(stderr)
}
