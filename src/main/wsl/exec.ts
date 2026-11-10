/**
 * The one place iCode invokes `wsl.exe`.
 *
 * Two rules hold every caller:
 *
 *   1. Arguments are an argv array. Nothing here concatenates a shell string, so
 *      a distro name or path can never become an operator, a redirect or a
 *      second command. A guest *script* is allowed, but only as a constant the
 *      caller declares — untrusted data never reaches one.
 *   2. Failure is typed. "The distro is gone", "the command failed", "it timed
 *      out" and "the caller cancelled" are different answers, and a caller that
 *      needs to tell them apart must not have to grep stderr for them.
 *
 * `WSL_UTF8=1` is set because `wsl.exe` otherwise writes its own diagnostics as
 * UTF-16LE, which turns a readable error into an unparseable one.
 */

import { execFile } from 'node:child_process'
import { constants as fsConstants, accessSync } from 'node:fs'
import { join } from 'node:path'

/** Default ceiling for a guest command. Generous: a cold distro boot costs seconds. */
export const WSL_DEFAULT_TIMEOUT_MS = 20_000

/**
 * Multiplier for every guest-command budget.
 *
 * Why a knob exists at all: each guest call pays for a `wsl.exe` process start.
 * Normally that is a few hundred milliseconds, but on a heavily loaded or
 * antivirus-scanned Windows machine it is not bounded by iCode — measured here at
 * ~370 ms typical with stalls of ~30 s, which no fixed "reasonable" constant can
 * cover without also making a genuinely hung distro take a minute to report.
 *
 * Defaults to 1: production behaviour is unchanged unless someone opts in with
 * `ICODE_WSL_TIMEOUT_SCALE` (e.g. `4` on a slow machine).
 */
export const WSL_TIMEOUT_SCALE_ENV = 'ICODE_WSL_TIMEOUT_SCALE'

/** Reads and validates the scale; anything that is not a positive number is 1. */
export function resolveWslTimeoutScale(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[WSL_TIMEOUT_SCALE_ENV]
  if (raw === undefined) return 1
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : 1
}

/**
 * Opt-in per-spawn diagnostics.
 *
 * Every guest call is a fresh `wsl.exe` process, and the create path is dominated
 * by their count. `ICODE_DEBUG_WSL_SPAWNS=1` logs one line per actual spawn so a
 * run can be attributed label-by-label instead of guessed from wall time. The
 * default check is a single boolean and formats nothing.
 */
export const WSL_DEBUG_SPAWNS_ENV = 'ICODE_DEBUG_WSL_SPAWNS'

function resolveDebugSpawns(
  env: NodeJS.ProcessEnv,
  override: boolean | undefined
): boolean {
  if (override !== undefined) return override
  const raw = env[WSL_DEBUG_SPAWNS_ENV]?.trim().toLowerCase()
  return raw === '1' || raw === 'true'
}

/**
 * Two scopes, because `wsl.exe` has two of them and confusing them fails quietly.
 *
 * `host` runs a `wsl.exe` option (`--list`, `--status`, `--version`): argv goes
 * straight to `wsl.exe`, with no `--exec`, because `--list` is not a program
 * inside the distro and `wsl --exec --list` would try to execute a file named
 * `--list` in the guest.
 *
 * `guest` runs a program inside a distro, so argv follows `-d <distro> --exec`.
 */
export type WslHostCommand = {
  scope: 'host'
  /** Diagnostic label for `ICODE_DEBUG_WSL_SPAWNS`; never part of argv. */
  label?: string
  argv: readonly string[]
  timeoutMs?: number
  signal?: AbortSignal
}

export type WslGuestCommand = {
  scope: 'guest'
  /** Diagnostic label for `ICODE_DEBUG_WSL_SPAWNS`; never part of argv. */
  label?: string
  /** The distro to enter. Required: a guest command never silently picks one. */
  distro: string
  /**
   * Guest argv, placed after `--exec`. The first element is the program.
   * A constant script belongs here as `['sh', '-c', SCRIPT]`.
   */
  argv: readonly string[]
  /** Payload for the guest program's stdin, closed after writing. */
  stdin?: Buffer | string
  /** File piped to the guest program's stdin; preferred for large uploads. */
  stdinFile?: string
  /** Ceiling for uploads, which are legitimately slower than a probe. */
  timeoutMs?: number
  signal?: AbortSignal
}

export type WslExecRequest = WslHostCommand | WslGuestCommand

/** What a `wsl.exe` invocation produced, before any interpretation. */
export type WslProcessResult = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** Why a call did not produce a usable answer. */
export type WslExecFailureStatus =
  | 'wsl_missing'
  | 'exit_failure'
  | 'timed_out'
  | 'cancelled'

/**
 * Byte-exact result. Text-decoding is deliberately absent: `decodeWslOutput`
 * picks UTF-16LE when it sees a NUL byte, which is correct for `wsl.exe` distro
 * listings and destructive for Git output that legitimately contains NULs
 * (`-z` listings, binary patches). Callers of this variant own the bytes.
 */
export type WslByteResult = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: Buffer
  stderr: Buffer
  timedOut: boolean
}

export type WslExecOutcome =
  | { status: 'ok'; stdout: string; stderr: string }
  | {
      status: 'exit_failure'
      code: number | null
      signal: NodeJS.Signals | null
      stdout: string
      stderr: string
    }
  | { status: 'timed_out' }
  | { status: 'cancelled' }
  | { status: 'wsl_missing'; detail: string }

/**
 * Decodes `wsl.exe` output.
 *
 * `WSL_UTF8=1` is honoured for guest stdout, but distro listings still come back
 * as UTF-16LE on current builds — verified here: `--list --quiet` yields
 * `U\0b\0u\0n\0t\0u\0…`. Decoding that as UTF-8 keeps ASCII names readable
 * but destroys any non-ASCII one, so the encoding is detected on the raw bytes
 * *before* a lossy decode can happen. There is no second chance after that.
 */
export function decodeWslOutput(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le')
  }
  // A NUL byte is the signal: UTF-8 text from a shell command does not contain
  // one, while UTF-16LE always does. Parity is *not* usable here — a CJK code
  // unit such as U+5F00 is `00 5F` on the wire and puts a NUL at an even offset.
  if (!buffer.includes(0)) return buffer.toString('utf8')
  const asUtf16 = buffer.toString('utf16le')
  // If the UTF-16 reading produces replacement characters it was not UTF-16.
  if (!asUtf16.includes('\uFFFD')) return asUtf16
  return buffer.toString('utf8')
}

/** Test seam: everything the runner needs from the OS. */
export type WslProcessLauncher = (spec: {
  program: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  signal?: AbortSignal
  /**
   * Written to the child's stdin, then closed. Artifact upload needs it: a
   * 121 MB runtime cannot be passed as an argument.
   */
  stdin?: Buffer | string
  /** Streamed from disk instead of held in memory; used for the large runtime. */
  stdinFile?: string
}) => Promise<WslProcessResult>

/** Resolves `System32\wsl.exe`; the bare name is the fallback, not the preference. */
export function resolveWslExecutablePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform !== 'win32') return 'wsl.exe'
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows'
  const candidate = join(root, 'System32', 'wsl.exe')
  try {
    // An absolute path is only returned when the binary is really there; the
    // bare name still lets Windows resolve it if this guess is wrong.
    accessSync(candidate, fsConstants.X_OK)
    return candidate
  } catch {
    return 'wsl.exe'
  }
}

/**
 * A working directory that exists on every Windows host.
 *
 * Not optional: if the controller inherited a cwd that has since been deleted,
 * every spawn fails `ENOENT` and the failure reads as "WSL is not installed".
 */
export function resolveWslInteropCwd(env: NodeJS.ProcessEnv): string {
  return env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows'
}

const defaultLauncher: WslProcessLauncher = (spec) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      spec.program,
      [...spec.args],
      {
        cwd: spec.cwd,
        env: spec.env,
        timeout: spec.timeoutMs,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        // Buffer, not text: the encoding is decided in `decodeWslOutput`, before
        // a UTF-8 decode would silently replace UTF-16LE code units.
        encoding: 'buffer',
        ...(spec.signal ? { signal: spec.signal } : {})
      },
      (error, stdout, stderr) => {
        const out = decodeWslOutput(stdout as unknown as Buffer)
        const err = decodeWslOutput(stderr as unknown as Buffer)
        if (!error) {
          resolve({ code: 0, signal: null, stdout: out, stderr: err, timedOut: false })
          return
        }
        const failure = error as NodeJS.ErrnoException & {
          code?: string | number
          killed?: boolean
          signal?: NodeJS.Signals
        }
        // Spawn failure: the binary itself is not runnable.
        if (typeof failure.code === 'string' && failure.code.startsWith('E')) {
          reject(failure)
          return
        }
        resolve({
          code: typeof failure.code === 'number' ? failure.code : null,
          signal: failure.signal ?? null,
          stdout: out,
          stderr: err,
          timedOut: failure.killed === true && (failure.signal ?? null) !== null
        })
      }
    )
    child.once('error', reject)
    if (spec.stdinFile !== undefined) {
      const { createReadStream } = require('node:fs') as typeof import('node:fs')
      const stream = createReadStream(spec.stdinFile)
      stream.on('error', () => {
        // The guest side sees end-of-input and reports a short write; the caller
        // then fails verification rather than trusting a partial file.
        child.stdin?.destroy()
      })
      stream.pipe(child.stdin!)
    } else if (spec.stdin !== undefined) {
      // `execFile` leaves stdin as a pipe; without this write the guest `cat`
      // waits until the timeout rather than seeing end-of-input.
      child.stdin?.on('error', () => {
        // A guest that exits early closes the pipe; the exit code carries the cause.
      })
      child.stdin?.end(spec.stdin)
    } else {
      child.stdin?.end()
    }
  })

/** Test seam for `runBytes`: same spec, raw bytes out. */
export type WslByteLauncher = (spec: {
  program: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  signal?: AbortSignal
  /** Payload piped to the guest program's stdin, then closed. */
  stdin?: Buffer | string
}) => Promise<WslByteResult>

const defaultByteLauncher: WslByteLauncher = (spec) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      spec.program,
      [...spec.args],
      {
        cwd: spec.cwd,
        env: spec.env,
        timeout: spec.timeoutMs,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        // `execFile` defaults to `encoding: 'utf8'`, so omitting this does NOT give
        // Buffers — it silently decodes and replaces every invalid byte with
        // U+FFFD. Measured: a 7-byte blob with 0xFF came back as a 7-character
        // String with the byte destroyed. 'buffer' is required, not stylistic.
        encoding: 'buffer',
        ...(spec.signal ? { signal: spec.signal } : {})
      },
      (error, stdout, stderr) => {
        const out = stdout as unknown as Buffer
        const err = stderr as unknown as Buffer
        if (!error) {
          resolve({ code: 0, signal: null, stdout: out, stderr: err, timedOut: false })
          return
        }
        const failure = error as NodeJS.ErrnoException & {
          code?: string | number
          killed?: boolean
          signal?: NodeJS.Signals
        }
        if (typeof failure.code === 'string' && failure.code.startsWith('E')) {
          reject(failure)
          return
        }
        resolve({
          code: typeof failure.code === 'number' ? failure.code : null,
          signal: failure.signal ?? null,
          stdout: out,
          stderr: err,
          timedOut: failure.killed === true && (failure.signal ?? null) !== null
        })
      }
    )
    child.once('error', reject)
    if (spec.stdin !== undefined) {
      child.stdin?.on('error', () => {
        // A guest that exits early closes the pipe; the exit code carries the cause.
      })
      child.stdin?.end(spec.stdin)
    } else {
      child.stdin?.end()
    }
  })

export type WslCommandRunnerOptions = {
  launcher?: WslProcessLauncher
  byteLauncher?: WslByteLauncher
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  program?: string
  /** Overrides `ICODE_WSL_TIMEOUT_SCALE`; mainly for tests. */
  timeoutScale?: number
  /** Overrides `ICODE_DEBUG_WSL_SPAWNS`; mainly for tests. */
  debugSpawns?: boolean
  /** Sink for spawn diagnostics; defaults to stderr. */
  logSpawn?: (line: string) => void
}

/** Small helper: a diagnostic value must never break the line format. */
function diagnosticToken(value: string): string {
  const token = value.replace(/\s+/gu, '_')
  return token.length > 0 ? token : '-'
}

/**
 * Runs guest commands. One instance is enough for a whole app: it holds no
 * per-distro state, so there is nothing to invalidate when a distro restarts.
 */
export class WslCommandRunner {
  private readonly launcher: WslProcessLauncher
  private readonly byteLauncher: WslByteLauncher
  private readonly env: NodeJS.ProcessEnv
  private readonly program: string
  private readonly timeoutScale: number
  private readonly debugSpawns: boolean
  private readonly logSpawn: (line: string) => void

  constructor(options: WslCommandRunnerOptions = {}) {
    this.launcher = options.launcher ?? defaultLauncher
    this.byteLauncher = options.byteLauncher ?? defaultByteLauncher
    this.env = options.env ?? process.env
    this.program =
      options.program ?? resolveWslExecutablePath(this.env, options.platform ?? process.platform)
    this.timeoutScale = options.timeoutScale ?? resolveWslTimeoutScale(this.env)
    this.debugSpawns = resolveDebugSpawns(this.env, options.debugSpawns)
    this.logSpawn =
      options.logSpawn ??
      ((line) => {
        process.stderr.write(`${line}\n`)
      })
  }

  /** The budget actually applied to one guest call. */
  private budget(requested: number): number {
    return Math.round(requested * this.timeoutScale)
  }

  /** One line per actual `wsl.exe` launch; disabled by default. */
  private logSpawnLine(
    request: WslExecRequest,
    status: string,
    startedAt: number
  ): void {
    if (!this.debugSpawns) return
    const distro = request.scope === 'guest' ? request.distro : '-'
    const program = request.argv[0] ?? '-'
    const elapsedMs = startedAt === 0 ? 0 : Date.now() - startedAt
    this.logSpawn(
      `[icode:wsl-spawn] label=${diagnosticToken(request.label ?? '-')} ` +
        `distro=${diagnosticToken(distro)} program=${diagnosticToken(program)} ` +
        `status=${diagnosticToken(status)} elapsedMs=${String(elapsedMs)}`
    )
  }

  /** Status label for a completed launch, used only when diagnostics are on. */
  private static resultStatus(result: WslProcessResult | WslByteResult): string {
    if (result.timedOut) return 'timed_out'
    return result.code === 0 ? 'ok' : `exit_${result.code === null ? 'null' : String(result.code)}`
  }

  /** The Windows-side argv this runner would use, for tests and diagnostics. */
  buildArgs(request: WslExecRequest): string[] {
    if (request.scope === 'host') return [...request.argv]
    const distro = request.distro.trim()
    if (distro.length === 0) {
      throw new Error('wsl.exec: a guest command must name a distro')
    }
    return ['-d', distro, '--exec', ...request.argv]
  }

  async run(request: WslExecRequest): Promise<WslExecOutcome> {
    if (request.signal?.aborted) return { status: 'cancelled' }
    if (request.argv.length === 0) {
      throw new Error('wsl.exec: argv must name a program')
    }
    // Validate the shape before spawning, so a caller cannot silently get the
    // default distro by forgetting `distro`, nor run a `wsl.exe` option in a guest.
    const args = this.buildArgs(request)
    const startedAt = this.debugSpawns ? Date.now() : 0

    let result: WslProcessResult
    try {
      result = await this.launcher({
        program: this.program,
        args,
        cwd: resolveWslInteropCwd(this.env),
        env: { ...this.env, WSL_UTF8: '1' },
        timeoutMs: this.budget(request.timeoutMs ?? WSL_DEFAULT_TIMEOUT_MS),
        ...(request.scope === 'guest' && request.stdin !== undefined
          ? { stdin: request.stdin }
          : {}),
        ...(request.scope === 'guest' && request.stdinFile !== undefined
          ? { stdinFile: request.stdinFile }
          : {}),
        ...(request.signal ? { signal: request.signal } : {})
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      // An abort surfaces from the launcher as a rejected promise on some Node
      // versions; it is a cancellation, not a missing binary.
      if (request.signal?.aborted) {
        this.logSpawnLine(request, 'cancelled', startedAt)
        return { status: 'cancelled' }
      }
      if (typeof error === 'object' && error !== null && 'code' in error) {
        const code = (error as { code?: unknown }).code
        if (code === 'ABORT_ERR') {
          this.logSpawnLine(request, 'cancelled', startedAt)
          return { status: 'cancelled' }
        }
        if (code === 'ENOENT') {
          this.logSpawnLine(request, 'wsl_missing', startedAt)
          return { status: 'wsl_missing', detail }
        }
      }
      this.logSpawnLine(request, 'error', startedAt)
      throw error
    }

    this.logSpawnLine(
      request,
      request.signal?.aborted ? 'cancelled' : WslCommandRunner.resultStatus(result),
      startedAt
    )

    // An abort that lands while the process runs resolves as a non-zero exit on
    // some Node versions; the caller's intent wins over that shape.
    if (request.signal?.aborted) return { status: 'cancelled' }
    if (result.timedOut) return { status: 'timed_out' }
    if (result.code === 0) {
      return { status: 'ok', stdout: result.stdout, stderr: result.stderr }
    }
    return {
      status: 'exit_failure',
      code: result.code,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr
    }
  }

  /**
   * Runs a guest command and returns its bytes untouched.
   *
   * Same argv construction, same distro targeting, same cancellation and timeout
   * as `run`; only the output handling differs. Use this whenever the payload is
   * not known to be text.
   */
  async runBytes(request: WslGuestCommand): Promise<WslByteResult | { status: 'wsl_missing' }> {
    const args = this.buildArgs(request)
    if (request.signal?.aborted) {
      return { code: null, signal: 'SIGTERM', stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: false }
    }
    const startedAt = this.debugSpawns ? Date.now() : 0
    try {
      const result = await this.byteLauncher({
        program: this.program,
        args,
        cwd: resolveWslInteropCwd(this.env),
        env: { ...this.env, WSL_UTF8: '1' },
        timeoutMs: this.budget(request.timeoutMs ?? WSL_DEFAULT_TIMEOUT_MS),
        ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
        ...(request.signal ? { signal: request.signal } : {})
      })
      this.logSpawnLine(
        request,
        request.signal?.aborted ? 'cancelled' : WslCommandRunner.resultStatus(result),
        startedAt
      )
      if (request.signal?.aborted && result.code !== 0) {
        return { ...result, timedOut: false }
      }
      return result
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error) {
        if ((error as { code?: unknown }).code === 'ENOENT') {
          this.logSpawnLine(request, 'wsl_missing', startedAt)
          return { status: 'wsl_missing' }
        }
      }
      this.logSpawnLine(request, 'error', startedAt)
      throw error
    }
  }
}
