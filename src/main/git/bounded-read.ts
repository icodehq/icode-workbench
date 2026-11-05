import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { makeAppError, type AppError, type AppErrorCode } from '../../shared/domain/errors'
import {
  CHANGE_MAX_FILE_BYTES,
  CHANGE_MAX_STDERR_BYTES,
  CHANGE_READ_TIMEOUT_MS,
  type ChangeTruncation
} from '../../shared/domain/changes'

/**
 * Bounded, read-only Git access.
 *
 * Every command is spawn-based so output can be bounded while it is produced:
 * `execFile` only fails after buffering the whole patch, which is exactly the
 * case a large diff would hit. Only read-only subcommands are allowed, and the
 * environment disables optional locks so reading never touches `.git/index`.
 */

const ALLOWED_SUBCOMMANDS = new Set(['diff', 'status', 'ls-files', 'cat-file', 'rev-parse'])
const KILL_ESCALATION_MS = 500

export type GitReadOptions = {
  cwd: string
  args: string[]
  timeoutMs?: number
  byteBudget?: number
  stderrBudget?: number
}

export type GitReadResult = {
  stdout: string
  stderrTail: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  truncated: boolean
  truncatedReason: ChangeTruncation
}

export class GitReadError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.message)
    this.name = 'GitReadError'
  }
}

export function readError(
  code: Extract<
    AppErrorCode,
    'GIT_READ_FAILED' | 'GIT_READ_TIMEOUT' | 'INVALID_ARGUMENT' | 'CHANGE_PATH_OUTSIDE'
  >,
  message: string,
  detail?: string
): GitReadError {
  return new GitReadError(makeAppError(code, message, detail ? { detail } : {}))
}

export function assertAllowedArgs(args: string[]): void {
  const subcommand = args[0]
  if (!subcommand || !ALLOWED_SUBCOMMANDS.has(subcommand)) {
    throw readError('INVALID_ARGUMENT', 'Only read-only Git commands are allowed.', subcommand)
  }
}

/**
 * Trims a byte buffer to `maxBytes` without leaving a half-decoded UTF-8
 * sequence at the end (which would render as U+FFFD in a diff).
 */
export function truncateUtf8(buffer: Buffer, maxBytes: number): Buffer {
  if (buffer.length <= maxBytes) return buffer
  let end = maxBytes
  let continuation = 0
  while (end > 0 && continuation < 4) {
    const byte = buffer[end - 1]!
    if ((byte & 0b1000_0000) === 0) {
      // ASCII: complete.
      return buffer.subarray(0, end)
    }
    if ((byte & 0b1100_0000) === 0b1000_0000) {
      continuation += 1
      end -= 1
      continue
    }
    // Lead byte: drop it too, then the sequence is incomplete.
    return buffer.subarray(0, Math.max(0, end - 1))
  }
  return buffer.subarray(0, end)
}

/**
 * Drops a trailing partial line so a truncated patch never ends inside a hunk
 * header. Only used when truncation actually happened.
 */
export function cutToLastNewline(text: string): string {
  const index = text.lastIndexOf('\n')
  return index === -1 ? text : text.slice(0, index + 1)
}

export async function runGitRead(options: GitReadOptions): Promise<GitReadResult> {
  assertAllowedArgs(options.args)
  if (isAbsolute(options.args[0] ?? '')) {
    throw readError('INVALID_ARGUMENT', 'Invalid Git invocation.')
  }
  const timeoutMs = options.timeoutMs ?? CHANGE_READ_TIMEOUT_MS
  const byteBudget = options.byteBudget ?? CHANGE_MAX_FILE_BYTES
  const stderrBudget = options.stderrBudget ?? CHANGE_MAX_STDERR_BYTES

  return new Promise<GitReadResult>((resolvePromise, reject) => {
    let child
    try {
      child = spawn('git', ['--no-optional-locks', ...options.args], {
        cwd: options.cwd,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      reject(readError('GIT_READ_FAILED', 'Git could not be started.', String(error)))
      return
    }

    const chunks: Buffer[] = []
    let captured = 0
    let truncated: ChangeTruncation = null
    let stderrTail = ''
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | null = null
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null

    const terminate = (): void => {
      if (child.killed) return
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
      }, KILL_ESCALATION_MS)
    }

    timeoutTimer = setTimeout(() => {
      if (truncated === null) truncated = 'timeout'
      terminate()
    }, timeoutMs)

    child.stdout?.on('data', (data: Buffer) => {
      if (truncated !== null) return
      const remaining = byteBudget - captured
      if (data.length <= remaining) {
        chunks.push(data)
        captured += data.length
        return
      }
      if (remaining > 0) {
        chunks.push(truncateUtf8(data, remaining))
        captured += remaining
      }
      truncated = 'bytes'
      terminate()
    })

    child.stderr?.on('data', (data: Buffer) => {
      // Bounded diagnostic tail only; stderr never becomes change content.
      const combined = Buffer.concat([Buffer.from(stderrTail), data])
      stderrTail = truncateUtf8(combined, stderrBudget).toString('utf8')
    })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (killTimer) clearTimeout(killTimer)
      reject(readError('GIT_READ_FAILED', 'Git could not be read.', error.message))
    })

    child.on('close', (exitCode, signal) => {
      if (settled) return
      settled = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (killTimer) clearTimeout(killTimer)
      const raw = Buffer.concat(chunks).toString('utf8')
      resolvePromise({
        stdout: truncated === null ? raw : truncated === 'bytes' ? cutToLastNewline(raw) : raw,
        stderrTail,
        exitCode,
        signal,
        truncated: truncated !== null,
        truncatedReason: truncated
      })
    })
  })
}
