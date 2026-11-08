import type { HarnessId } from '../../shared/domain/harness'
import { parseHarnessOutput } from '../ai/harness-output'

const ANSI = /\u001b\[[0-9;]*m/g

/**
 * Headless arguments for one Mira turn. These are one-shot, read-only modes:
 * the model never receives a project cwd or an iCode command surface.
 */
export function assistantHarnessArgs(
  harness: HarnessId,
  opencodeAgent = 'plan'
): string[] | null {
  switch (harness) {
    case 'claude':
      // stream-json is what lets a turn show text before the process exits.
      // `--verbose` is required by Claude Code for print-mode stream-json;
      // `--include-partial-messages` supplies the content_block_delta events.
      return [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--permission-mode',
        'plan'
      ]
    case 'codex':
      return ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only']
    case 'opencode':
      return ['run', '--agent', opencodeAgent, '--format', 'json']
    default:
      return null
  }
}

/** Extracts the model text from the harness's one-shot output. */
export function parseAssistantHarnessOutput(
  harness: HarnessId,
  stdout: string
): { ok: true; text: string } | { ok: false; error: string } {
  const cleaned = stdout.replace(ANSI, '')
  if (harness === 'claude') {
    // stream-json prints one JSON event per line. The final `result` event is
    // authoritative; the single-object form is kept for older outputs and tests.
    const candidates = cleaned
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('{'))
      .reverse()
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate) as {
          type?: unknown
          result?: unknown
          is_error?: unknown
        }
        if (parsed.type === 'result' || parsed.is_error !== undefined) {
          if (parsed.is_error === true) {
            const detail =
              typeof parsed.result === 'string' && parsed.result.trim().length > 0
                ? parsed.result.trim().slice(0, 1_000)
                : 'Claude reported an error.'
            return { ok: false, error: detail }
          }
          if (typeof parsed.result === 'string') return { ok: true, text: parsed.result }
        }
      } catch {
        // Not a JSON line; keep looking.
      }
    }
    // A stream-json run that never produced its result event is a failed turn,
    // not a plain-text answer. Returning the event log as a reply would show
    // raw JSONL to the user.
    if (/"type"\s*:\s*"(?:system|stream_event|result)"/u.test(cleaned)) {
      return { ok: false, error: 'Claude did not return a result event.' }
    }
    return { ok: true, text: cleaned }
  }
  if (harness === 'opencode') {
    return parseHarnessOutput('opencode', cleaned)
  }
  return { ok: true, text: cleaned }
}
