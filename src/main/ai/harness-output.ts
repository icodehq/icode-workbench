import { z } from 'zod'
import type { HarnessId } from '../../shared/domain/harness'

const openCodeEventSchema = z.object({
  type: z.string(),
  part: z
    .object({
      id: z.string().optional(),
      text: z.string().optional()
    })
    .optional(),
  error: z
    .object({
      name: z.string().optional(),
      message: z.string().optional(),
      data: z.object({ message: z.string().optional() }).optional()
    })
    .optional()
})

/**
 * Extracts the answer from an agent's stdout.
 *
 * Claude and Codex print text. OpenCode's `--format json` emits JSON events;
 * the last step's text parts are joined, and a reported error is surfaced
 * instead of being mistaken for a message.
 */
export function parseHarnessOutput(
  harness: HarnessId,
  stdout: string
): { ok: true; text: string } | { ok: false; error: string } {
  if (harness !== 'opencode') return { ok: true, text: stdout }

  const parts = new Map<string, string>()
  let anonymous = 0
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      return { ok: false, error: 'OpenCode returned invalid JSON events.' }
    }
    const parsed = openCodeEventSchema.safeParse(value)
    if (!parsed.success) {
      return { ok: false, error: 'OpenCode returned invalid JSON events.' }
    }
    const event = parsed.data
    if (event.type === 'step_start') parts.clear()
    if (event.type === 'error') {
      return {
        ok: false,
        error:
          event.error?.data?.message ??
          event.error?.message ??
          event.error?.name ??
          'OpenCode reported an error.'
      }
    }
    if (event.type === 'text' && event.part?.text !== undefined) {
      parts.set(event.part.id ?? `anonymous-${String(anonymous)}`, event.part.text)
      anonymous += 1
    }
  }
  return { ok: true, text: [...parts.values()].join('\n') }
}
