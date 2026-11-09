import type { HarnessId } from '../../shared/domain/harness'
import type { OneShotResult } from '../ai/harness-one-shot'

export type ContinuationOptions = {
  opencodeAgent: string
  resumeEnabled: boolean
}

export type SessionObserver = {
  /** Feed raw stdout; returns a newly observed native id, or null. */
  push(chunk: string): string | null
  /** Flush a final line when the process exits without a trailing newline. */
  finish(): string | null
}

export type ResumeFailureKind = 'missing' | 'unsupported' | 'other'

/**
 * Per-harness one-shot continuation contract.
 *
 * Drivers only describe argv and observe the harness's own JSONL. They never
 * spawn processes and never parse transcripts: the harness owns the
 * conversation, iCode owns only the opaque handle.
 */
export interface ContinuationDriver {
  readonly harness: HarnessId
  /** False when Phase 0 could not verify a resume path for this harness. */
  readonly resumable: boolean
  freshArgs(options: ContinuationOptions): string[]
  resumeArgs(
    nativeSessionId: string,
    options: Pick<ContinuationOptions, 'opencodeAgent'>
  ): string[] | null
  createObserver(): SessionObserver
  classifyFailure(output: OneShotResult): ResumeFailureKind
}

/** Conservative: the id is interpolated into WSL login-shell scripts. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

export function isContinuationSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value)
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Buffers JSONL and reports the latest valid id when it changes. A harness may
 * fork on resume and return a new id; the caller overwrites the stored handle.
 */
function createLineObserver(
  read: (event: Record<string, unknown>) => string | null
): SessionObserver {
  let buffer = ''
  let lastReported: string | null = null

  const consume = (line: string): string | null => {
    const trimmed = line.trim()
    if (trimmed.length === 0 || !trimmed.startsWith('{')) return null
    let value: unknown
    try {
      value = JSON.parse(trimmed)
    } catch {
      return null
    }
    const event = asObject(value)
    if (event === null) return null
    const id = read(event)
    if (id === null || id === lastReported) return null
    lastReported = id
    return id
  }

  return {
    push(chunk: string): string | null {
      buffer += chunk
      let found: string | null = null
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const id = consume(line)
        if (id !== null) found = id
        newline = buffer.indexOf('\n')
      }
      return found
    },
    finish(): string | null {
      if (buffer.trim().length === 0) {
        buffer = ''
        return null
      }
      const line = buffer
      buffer = ''
      return consume(line)
    }
  }
}

function failureText(output: OneShotResult): string {
  return `${output.stdout}\n${output.stderr}`
}

function classifyFailure(text: string, missing: RegExp): ResumeFailureKind {
  if (missing.test(text)) return 'missing'
  if (/unknown (?:option|argument|flag)|unrecognized|invalid option|unexpected argument/iu.test(text)) {
    return 'unsupported'
  }
  return 'other'
}

const CLAUDE_FRESH_ARGS = [
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
  '--permission-mode',
  'plan'
] as const

const claudeDriver: ContinuationDriver = {
  harness: 'claude',
  resumable: true,
  freshArgs: () => [...CLAUDE_FRESH_ARGS],
  resumeArgs: (nativeSessionId) => [
    '-p',
    '--resume',
    nativeSessionId,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode',
    'plan'
  ],
  createObserver: () =>
    createLineObserver((event) => {
      const id =
        event.type === 'system' && event.subtype === 'init'
          ? event.session_id
          : event.type === 'result'
            ? event.session_id
            : null
      return isContinuationSessionId(id) ? id : null
    }),
  classifyFailure: (output) =>
    classifyFailure(
      failureText(output),
      /no conversation found|session [^\n]* not found/iu
    )
}

const CODEX_FRESH_ARGS = ['exec', '--skip-git-repo-check', '-s', 'read-only'] as const
const CODEX_EPHEMERAL_ARGS = [
  'exec',
  '--ephemeral',
  '--skip-git-repo-check',
  '-s',
  'read-only'
] as const

const codexDriver: ContinuationDriver = {
  harness: 'codex',
  // Verified from codex exec --json and `codex exec resume <id>`; the
  // installed CLI is checked by the gated real-harness test.
  resumable: true,
  freshArgs: ({ resumeEnabled }) =>
    resumeEnabled ? [...CODEX_FRESH_ARGS, '--json'] : [...CODEX_EPHEMERAL_ARGS],
  resumeArgs: (nativeSessionId) => [
    // `resume` rejects --sandbox; the global config override keeps read-only.
    '-c',
    'sandbox_mode="read-only"',
    'exec',
    'resume',
    nativeSessionId,
    '--json',
    '--skip-git-repo-check'
  ],
  createObserver: () =>
    createLineObserver((event) => {
      if (event.type !== 'thread.started') return null
      return isContinuationSessionId(event.thread_id) ? event.thread_id : null
    }),
  classifyFailure: (output) =>
    classifyFailure(
      failureText(output),
      /no rollout found|thread [^\n]* not found|session [^\n]* not found/iu
    )
}

const opencodeDriver: ContinuationDriver = {
  harness: 'opencode',
  resumable: true,
  freshArgs: ({ opencodeAgent }) => [
    'run',
    '--agent',
    opencodeAgent,
    '--format',
    'json'
  ],
  resumeArgs: (nativeSessionId, { opencodeAgent }) => [
    'run',
    '--session',
    nativeSessionId,
    '--agent',
    opencodeAgent,
    '--format',
    'json'
  ],
  createObserver: () =>
    createLineObserver((event) => {
      if (isContinuationSessionId(event.sessionID)) return event.sessionID
      const session = asObject(event.session)
      if (session !== null && isContinuationSessionId(session.id)) return session.id
      const part = asObject(event.part)
      if (part !== null && isContinuationSessionId(part.sessionID)) return part.sessionID
      return null
    }),
  classifyFailure: (output) =>
    classifyFailure(
      failureText(output),
      /session not found|unknown session|no session/iu
    )
}

const DRIVERS: Record<HarnessId, ContinuationDriver | null> = {
  claude: claudeDriver,
  codex: codexDriver,
  opencode: opencodeDriver,
  shell: null
}

export function continuationDriver(harness: HarnessId): ContinuationDriver | null {
  return DRIVERS[harness]
}
