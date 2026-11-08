/**
 * Incremental Claude stream-json reading.
 *
 * The model's visible answer is a JSON envelope. We never execute the actions
 * until the whole envelope has been parsed and validated; this module only
 * extracts the `reply` string so the user can watch it being written.
 */

export type ClaudeStreamUpdate = {
  /** The decoded `reply` prefix, when the model has started writing it. */
  draft: string | null
  /** Highest thinking-token estimate seen in this response. */
  thinkingTokens: number | null
  /** A tool/action started, which the UI can show as a stage change. */
  acting: boolean
}

function parseLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (trimmed.length === 0 || !trimmed.startsWith('{')) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * Decodes a possibly incomplete JSON string body. An incomplete escape is
 * dropped, not replaced; the next chunk re-extracts from the same raw text.
 */
export function decodeJsonStringPrefix(value: string): string {
  let out = ''
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char === '"') break
    if (char !== '\\') {
      out += char
      continue
    }
    const next = value[index + 1]
    if (next === undefined) break
    if (next === 'u') {
      const hex = value.slice(index + 2, index + 6)
      if (hex.length < 4 || !/^[0-9a-f]{4}$/iu.test(hex)) break
      const code = Number.parseInt(hex, 16)
      if (code >= 0xd800 && code <= 0xdbff) {
        // A surrogate pair can be split across deltas. Wait for the low half
        // rather than briefly rendering a replacement character.
        if (value[index + 6] !== '\\' || value[index + 7] !== 'u') break
        const lowHex = value.slice(index + 8, index + 12)
        if (lowHex.length < 4 || !/^[0-9a-f]{4}$/iu.test(lowHex)) break
        const low = Number.parseInt(lowHex, 16)
        if (low < 0xdc00 || low > 0xdfff) break
        out += String.fromCharCode(code, low)
        index += 11
        continue
      }
      out += String.fromCharCode(code)
      index += 5
      continue
    }
    const escapes: Record<string, string> = {
      '"': '"',
      '\\': '\\',
      '/': '/',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t'
    }
    out += escapes[next] ?? next
    index += 1
  }
  return out
}

/** Finds the reply value in the model's partial JSON object. */
export function extractReplyDraft(raw: string): string | null {
  const match = /"reply"\s*:\s*"/u.exec(raw)
  if (!match) return null
  return decodeJsonStringPrefix(raw.slice(match.index + match[0].length))
}

export class ClaudeStreamParser {
  private buffer = ''
  private rawText = ''
  private draft: string | null = null
  private thinkingTokens: number | null = null
  private acting = false
  private resultText: string | null = null
  private resultError: string | null = null

  push(chunk: string): ClaudeStreamUpdate {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      this.consume(line)
      newline = this.buffer.indexOf('\n')
    }
    return this.snapshot()
  }

  /** Process the final line when the process exits without a trailing newline. */
  finish(): ClaudeStreamUpdate {
    if (this.buffer.trim().length > 0) {
      this.consume(this.buffer)
      this.buffer = ''
    }
    return this.snapshot()
  }

  /** The authoritative final event, captured even if stdout is later capped. */
  result(): { text: string | null; error: string | null } {
    return { text: this.resultText, error: this.resultError }
  }

  private snapshot(): ClaudeStreamUpdate {
    return {
      draft: this.draft,
      thinkingTokens: this.thinkingTokens,
      acting: this.acting
    }
  }

  private consume(line: string): void {
    const event = parseLine(line)
    if (event === null) return
    if (event.type === 'result') {
      if (event.is_error === true) {
        this.resultError =
          typeof event.result === 'string' && event.result.trim().length > 0
            ? event.result.trim().slice(0, 1_000)
            : 'Claude reported an error.'
      } else if (typeof event.result === 'string') {
        this.resultText = event.result
      }
      return
    }
    if (event.type === 'system' && event.subtype === 'thinking_tokens') {
      const tokens = event.estimated_tokens
      if (typeof tokens === 'number' && Number.isFinite(tokens)) {
        this.thinkingTokens = Math.max(this.thinkingTokens ?? 0, Math.trunc(tokens))
      }
      return
    }
    if (event.type !== 'stream_event') return
    const streamEvent = event.event
    if (streamEvent === null || typeof streamEvent !== 'object') return
    const inner = streamEvent as Record<string, unknown>
    if (inner.type === 'content_block_start') {
      const block = inner.content_block
      if (block !== null && typeof block === 'object') {
        const type = (block as Record<string, unknown>).type
        if (type === 'tool_use' || type === 'tool_result') this.acting = true
      }
      return
    }
    if (inner.type !== 'content_block_delta') return
    const delta = inner.delta
    if (delta === null || typeof delta !== 'object') return
    const record = delta as Record<string, unknown>
    if (record.type !== 'text_delta' || typeof record.text !== 'string') return
    this.rawText += record.text
    const next = extractReplyDraft(this.rawText)
    if (next !== null) this.draft = next
  }
}
