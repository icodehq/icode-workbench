import type { HarnessId } from '../../shared/domain/harness'
import { parseHarnessOutput } from '../ai/harness-output'
import { continuationDriver } from './assistant-continuation'

const ANSI = /\u001b\[[0-9;]*m/g

/**
 * Headless arguments for one Mira turn. These are one-shot, read-only modes:
 * the model never receives a project cwd or an iCode command surface.
 *
 * This is the compatibility wrapper used by tests and callers that do not
 * resume. The runner uses the continuation driver directly with resume enabled.
 */
export function assistantHarnessArgs(
  harness: HarnessId,
  opencodeAgent = 'plan'
): string[] | null {
  const driver = continuationDriver(harness)
  return driver
    ? driver.freshArgs({ opencodeAgent, resumeEnabled: false })
    : null
}

function parseCodexOutput(
  cleaned: string
): { ok: true; text: string } | { ok: false; error: string } {
  let text: string | null = null
  let error: string | null = null
  let sawEvent = false
  for (const line of cleaned.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || !trimmed.startsWith('{')) continue
    let value: unknown
    try {
      value = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (value === null || typeof value !== 'object') continue
    const event = value as Record<string, unknown>
    if (typeof event.type === 'string') sawEvent = true
    if (event.type === 'item.completed') {
      const item = event.item
      if (item === null || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      if (record.type === 'agent_message' && typeof record.text === 'string') {
        text = record.text
      } else if (record.type === 'error' && typeof record.message === 'string') {
        error = record.message
      }
      continue
    }
    if (event.type === 'turn.failed') {
      const failure = event.error
      if (
        failure !== null &&
        typeof failure === 'object' &&
        typeof (failure as Record<string, unknown>).message === 'string'
      ) {
        error = (failure as Record<string, unknown>).message as string
      } else if (typeof event.message === 'string') {
        error = event.message
      } else {
        error = 'Codex reported a failed turn.'
      }
      continue
    }
    if (event.type === 'error' && typeof event.message === 'string') {
      error = event.message
    }
  }
  if (error !== null) return { ok: false, error }
  if (text !== null) return { ok: true, text }
  // JSONL that produced no agent message is a failed turn, not a reply.
  if (sawEvent) return { ok: false, error: 'Codex returned no agent message.' }
  // Older CLIs without --json print plain text.
  return { ok: true, text: cleaned }
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
  if (harness === 'codex') {
    return parseCodexOutput(cleaned)
  }
  if (harness === 'opencode') {
    return parseHarnessOutput('opencode', cleaned)
  }
  return { ok: true, text: cleaned }
}
