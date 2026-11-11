/**
 * Git clone progress.
 *
 * `git clone --progress` writes its progress to stderr using `\r` for in-place
 * updates, and chunks arrive split at arbitrary byte boundaries. The reader
 * therefore owns a small line assembler and a UTF-8 decoder; the parser only
 * interprets complete lines.
 *
 * Lines are diagnostic text, not user content, but they can contain the remote
 * URL (and therefore a token), so every detail is redacted before it is emitted.
 */

import { StringDecoder } from 'node:string_decoder'
import { redactRemoteUrlCredentials } from '../../shared/domain/remote-url'

export type ClonePhase =
  | 'starting'
  | 'enumerating'
  | 'counting'
  | 'compressing'
  | 'receiving'
  | 'resolving'
  | 'checking-out'
  | 'done'

export type CloneProgress = {
  phase: ClonePhase
  /** null while a phase has no reported percentage. */
  percent: number | null
  detail: string
  objectsDone?: number
  objectsTotal?: number
}

const MAX_LINE = 4_096
const MAX_PENDING = 8_192
const MAX_DETAIL = 300

function percentOf(line: string): number | null {
  const match = /(\d{1,3})%/u.exec(line)
  if (match?.[1] === undefined) return null
  const value = Number(match[1])
  return Number.isInteger(value) && value >= 0 && value <= 100 ? value : null
}

function objectCounts(line: string): { done: number; total: number } | null {
  const match = /\((\d+)\/(\d+)\)/u.exec(line)
  if (match?.[1] === undefined || match[2] === undefined) return null
  const done = Number(match[1])
  const total = Number(match[2])
  return Number.isSafeInteger(done) && Number.isSafeInteger(total) && total > 0
    ? { done, total }
    : null
}

/**
 * Interprets one complete stderr line. Unrecognized lines return null: Git and
 * a login shell both print banners, and none of them are progress.
 */
export function parseCloneProgressLine(rawLine: string): CloneProgress | null {
  const line = rawLine.trim()
  if (line.length === 0) return null
  const detail = redactRemoteUrlCredentials(line).slice(0, MAX_DETAIL)

  if (/^Cloning into /u.test(line)) {
    return { phase: 'starting', percent: null, detail }
  }
  if (/^remote: Enumerating objects:/u.test(line)) {
    const counts = objectCounts(line)
    return {
      phase: 'enumerating',
      percent: null,
      detail,
      ...(counts === null ? {} : { objectsDone: counts.done, objectsTotal: counts.total })
    }
  }
  if (/^remote: Counting objects:/u.test(line)) {
    return { phase: 'counting', percent: percentOf(line), detail }
  }
  if (/^remote: Compressing objects:/u.test(line)) {
    return { phase: 'compressing', percent: percentOf(line), detail }
  }
  if (/^Receiving objects:/u.test(line)) {
    const counts = objectCounts(line)
    return {
      phase: 'receiving',
      percent: percentOf(line),
      detail,
      ...(counts === null ? {} : { objectsDone: counts.done, objectsTotal: counts.total })
    }
  }
  if (/^Resolving deltas:/u.test(line)) {
    return { phase: 'resolving', percent: percentOf(line), detail }
  }
  if (/^(Updating files|Checking out files):/u.test(line)) {
    return { phase: 'checking-out', percent: percentOf(line), detail }
  }
  return null
}

export type CloneProgressReader = {
  push(chunk: Buffer): void
  flush(): void
}

/**
 * Assembles stderr into lines and reports recognized progress.
 *
 * The pending buffer is bounded: a malicious or broken server must not make a
 * clone grow memory without limit. An overlong line is discarded up to its next
 * terminator, never emitted.
 */
export function createCloneProgressReader(
  onProgress: (progress: CloneProgress) => void
): CloneProgressReader {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let discarding = false

  const emitLine = (line: string): void => {
    if (line.length > MAX_LINE) return
    const progress = parseCloneProgressLine(line)
    if (progress !== null) onProgress(progress)
  }

  const drain = (text: string): void => {
    pending += text
    if (pending.length > MAX_PENDING) {
      // Keep the tail bounded; the beginning of an unbounded line is not useful.
      pending = pending.slice(-MAX_PENDING)
      discarding = true
    }
    for (;;) {
      const cr = pending.indexOf('\r')
      const lf = pending.indexOf('\n')
      let index = -1
      if (cr === -1) index = lf
      else if (lf === -1) index = cr
      else index = Math.min(cr, lf)
      if (index === -1) break
      const line = pending.slice(0, index)
      // A CRLF is one terminator, not two lines.
      const next = pending[index] === '\r' && pending[index + 1] === '\n' ? index + 2 : index + 1
      pending = pending.slice(next)
      if (discarding) {
        discarding = false
        continue
      }
      emitLine(line)
    }
  }

  return {
    push(chunk) {
      drain(decoder.write(chunk))
    },
    flush() {
      drain(decoder.end())
      if (pending.length > 0 && !discarding) emitLine(pending)
      pending = ''
      discarding = false
    }
  }
}
