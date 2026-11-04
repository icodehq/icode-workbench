import { spawn } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, posix as posixPath, resolve as resolvePath, sep } from 'node:path'
import { makeAppError, type AppError } from '../../shared/domain/errors'
import type { ExecutionTarget } from '../../shared/domain/repository'
import {
  REVIEW_MAX_FILE_BYTES,
  REVIEW_MAX_FILES,
  REVIEW_MAX_STDERR_BYTES,
  REVIEW_TIMEOUT_MS,
  type ReviewArea,
  type ReviewDiff,
  type ReviewFile,
  type ReviewFileStatus,
  type ReviewList,
  type ReviewTruncation
} from '../../shared/domain/review'

/**
 * Read-only Git access for review.
 *
 * Every command is spawn-based so output can be bounded while it is produced:
 * `execFile` only fails after buffering the whole patch, which is exactly the
 * case a large diff would hit. Only read-only subcommands are allowed, and the
 * environment disables optional locks so reviewing never touches `.git/index`.
 */

const ALLOWED_SUBCOMMANDS = new Set(['diff', 'status', 'ls-files', 'cat-file', 'rev-parse'])
const KILL_ESCALATION_MS = 500
/**
 * Untracked files have no index entry, so Git can only count them one file at a
 * time. Above this cap the list reports unknown counts instead of spawning
 * hundreds of processes; the diff still shows the exact patch.
 */
const MAX_UNTRACKED_COUNT_READS = 50
const UNTRACKED_COUNT_CONCURRENCY = 4

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
  truncatedReason: ReviewTruncation
}

export class ReviewReadError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.message)
    this.name = 'ReviewReadError'
  }
}

function readError(code: 'GIT_READ_FAILED' | 'GIT_READ_TIMEOUT' | 'INVALID_ARGUMENT' | 'REVIEW_PATH_OUTSIDE', message: string, detail?: string): ReviewReadError {
  return new ReviewReadError(makeAppError(code, message, detail ? { detail } : {}))
}

function assertAllowedArgs(args: string[]): void {
  const subcommand = args[0]
  if (!subcommand || !ALLOWED_SUBCOMMANDS.has(subcommand)) {
    throw readError('INVALID_ARGUMENT', 'Review only runs read-only Git commands.', subcommand)
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
  const timeoutMs = options.timeoutMs ?? REVIEW_TIMEOUT_MS
  const byteBudget = options.byteBudget ?? REVIEW_MAX_FILE_BYTES
  const stderrBudget = options.stderrBudget ?? REVIEW_MAX_STDERR_BYTES

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
    let truncated: ReviewTruncation = null
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
      // Bounded diagnostic tail only; stderr never becomes review content.
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

// ─── NUL-safe decoders ──────────────────────────────────────────────

export type RawEntry = {
  status: ReviewFileStatus
  path: string
  oldPath: string | null
  oldMode: string
  newMode: string
  additions: number | null
  deletions: number | null
  binary: boolean
}

const STATUS_LETTERS: Record<string, ReviewFileStatus> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  T: 'modified',
  C: 'added'
}

export type NumstatEntry = {
  path: string
  oldPath: string | null
  additions: number | null
  deletions: number | null
  binary: boolean
}

/**
 * `git diff --raw -z --no-abbrev`: `:oldmode newmode oldsha newsha STATUS\0path\0`
 * and for renames `... R100\0old\0new\0`.
 */
export function parseRawZ(output: string): Array<{
  status: ReviewFileStatus
  oldMode: string
  newMode: string
  path: string
  oldPath: string | null
}> {
  const parts = output.split('\u0000')
  const entries: Array<{
    status: ReviewFileStatus
    oldMode: string
    newMode: string
    path: string
    oldPath: string | null
  }> = []
  for (let index = 0; index < parts.length; index += 1) {
    const header = parts[index]
    if (!header || !header.startsWith(':')) continue
    const fields = header.slice(1).split(' ')
    const oldMode = fields[0] ?? ''
    const newMode = fields[1] ?? ''
    const code = (fields[4] ?? '').charAt(0)
    const status = STATUS_LETTERS[code]
    if (!status) continue
    if (status === 'renamed') {
      const oldPath = parts[index + 1] ?? ''
      const newPath = parts[index + 2] ?? ''
      index += 2
      if (oldPath && newPath) entries.push({ status, oldMode, newMode, path: newPath, oldPath })
      continue
    }
    const path = parts[index + 1] ?? ''
    index += 1
    if (path) entries.push({ status, oldMode, newMode, path, oldPath: null })
  }
  return entries
}

/**
 * `git diff --numstat -z`: `add\tremove\tpath\0`, and for renames
 * `add\tremove\t\0old\0new\0`. Binary files report `-` on both sides.
 */
export function parseNumstatZ(output: string): NumstatEntry[] {
  const parts = output.split('\u0000')
  const entries: NumstatEntry[] = []
  for (let index = 0; index < parts.length; index += 1) {
    const head = parts[index]
    if (!head) continue
    const first = head.indexOf('\t')
    const second = head.indexOf('\t', first + 1)
    if (first === -1 || second === -1) continue
    const additions = head.slice(0, first)
    const deletions = head.slice(first + 1, second)
    const pathPart = head.slice(second + 1)
    const binary = additions === '-' || deletions === '-'
    const toCount = (value: string): number | null => {
      if (value === '-') return null
      const parsed = Number(value)
      return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
    }
    if (pathPart === '') {
      const oldPath = parts[index + 1] ?? ''
      const newPath = parts[index + 2] ?? ''
      index += 2
      if (oldPath && newPath) {
        entries.push({
          path: newPath,
          oldPath,
          additions: toCount(additions),
          deletions: toCount(deletions),
          binary
        })
      }
      continue
    }
    entries.push({
      path: pathPart,
      oldPath: null,
      additions: toCount(additions),
      deletions: toCount(deletions),
      binary
    })
  }
  return entries
}

const CONFLICT_CODES = new Set([
  'DD',
  'AU',
  'UD',
  'UA',
  'DU',
  'AA',
  'UU'
])

export type StatusEntry = {
  path: string
  oldPath: string | null
  index: string
  worktree: string
  area: ReviewArea
}

/**
 * `git status --porcelain=v1 -z`: `XY path\0`, and for renames
 * `XY new\0old\0` — the opposite order from `diff --raw`.
 */
export function parseStatusZ(output: string): StatusEntry[] {
  const parts = output.split('\u0000')
  const entries: StatusEntry[] = []
  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index]
    if (!record || record.length < 3) continue
    const indexStatusCode = record.charAt(0)
    const worktreeCode = record.charAt(1)
    const path = record.slice(3)
    const pair = `${indexStatusCode}${worktreeCode}`
    let oldPath: string | null = null
    if (indexStatusCode === 'R' || indexStatusCode === 'C') {
      oldPath = parts[index + 1] ?? null
      index += 1
    }
    const area: ReviewArea = CONFLICT_CODES.has(pair)
      ? 'conflicted'
      : indexStatusCode === '?' || worktreeCode === '?'
        ? 'untracked'
        : indexStatusCode !== ' ' && worktreeCode !== ' '
          ? 'both'
          : indexStatusCode !== ' '
            ? 'staged'
            : 'unstaged'
    entries.push({ path, oldPath, index: indexStatusCode, worktree: worktreeCode, area })
  }
  return entries
}

export function parseOthersZ(output: string): string[] {
  return output.split('\u0000').filter((value) => value.length > 0)
}

// ─── Path validation ────────────────────────────────────────────────

export function assertSafeRelativePath(rawPath: string): void {
  const invalid = (detail: string): never => {
    throw readError('INVALID_ARGUMENT', 'That review path is not valid.', detail)
  }
  if (rawPath.length === 0 || rawPath.length > 4096) invalid('length')
  if (rawPath.includes('\u0000')) invalid('nul')
  if (rawPath.startsWith('-')) invalid('option-like')
  if (rawPath.startsWith('/')) invalid('absolute')
  if (/^[A-Za-z]:[\\/]/.test(rawPath)) invalid('drive')
  if (rawPath.startsWith('\\\\')) invalid('unc')
  if (rawPath.split(/[\\/]/u).some((segment) => segment === '..')) invalid('parent')
}

/**
 * How to reason about a path that belongs to a particular host.
 *
 * A guest path is not just unresolvable here — it is not even a path *shape*
 * this platform understands. `path.resolve('/tmp/x', 'a.txt')` on Windows
 * returns `D:\tmp\x\a.txt`, so a Windows-dialect containment test rejects every
 * guest path. The dialect therefore travels with the checkout, like the reader.
 */
export type ContainmentResolution = {
  /** Resolves symlinks where the checkout lives. */
  realpath: (path: string) => string
  resolve: (root: string, child: string) => string
  dirname: (path: string) => string
  separator: string
}

/** The controller's own filesystem: unchanged pre-W79 behaviour. */
const localContainment: ContainmentResolution = {
  realpath: realpathSync,
  resolve: (root, child) => resolvePath(root, child),
  dirname: (value) => dirname(value),
  separator: sep
}

/**
 * A distro checkout: POSIX path shape, and no local symlink resolution.
 *
 * Containment stays lexical here (`assertSafeRelativePath` plus the prefix
 * test). The read runs inside the distro, which is the only place a guest
 * symlink could be followed, and no controller path can be reached through a
 * guest path, so the boundary this protects is unchanged.
 */
export const guestContainment: ContainmentResolution = {
  realpath: (value) => value,
  resolve: (root, child) => posixPath.resolve(root, child),
  dirname: (value) => posixPath.dirname(value),
  separator: '/'
}

/**
 * Whether a path is a symlink, answered by the host that owns the checkout.
 *
 * `null` = the question could not be answered (unreachable distro, vanished
 * file). Reporting `false` there would turn "unknown" into a fact about the
 * user's tree, which is the misreport Work 82 recorded.
 */
export type SymlinkProbe = (worktreePath: string, relativePath: string) => Promise<boolean | null>

/** The controller's own filesystem. A missing path is unknown, not "not a link". */
export const localSymlinkProbe: SymlinkProbe = async (worktreePath, relativePath) => {
  try {
    // lstat never follows the link, so this cannot expose a target's content.
    return lstatSync(join(worktreePath, relativePath)).isSymbolicLink()
  } catch {
    return null
  }
}

/**
 * Confirms the requested path resolves inside the worktree, following
 * intermediate symlinks. A file that is itself a symlink is allowed: Git prints
 * the link target as content and never reads through it.
 *
 * `resolve` is a seam, not a preference: reviewing a distro checkout must not
 * call the controller's `realpathSync`, which throws ENOENT for a path that only
 * exists inside the distro.
 */
export function assertContained(
  worktreePath: string,
  rawPath: string,
  resolution: ContainmentResolution = localContainment
): void {
  assertSafeRelativePath(rawPath)
  const root = resolution.realpath(worktreePath)
  const candidate = resolution.resolve(root, rawPath)
  if (!(candidate === root || candidate.startsWith(`${root}${resolution.separator}`))) {
    throw readError('REVIEW_PATH_OUTSIDE', 'That path is outside the session worktree.')
  }

  // Resolve the nearest existing ancestor. This catches an intermediate
  // directory that is a symlink pointing outside the worktree, and works for
  // files that do not exist yet.
  let ancestor = resolution.dirname(candidate)
  for (;;) {
    try {
      const real = resolution.realpath(ancestor)
      if (!(real === root || real.startsWith(`${root}${resolution.separator}`))) {
        throw readError('REVIEW_PATH_OUTSIDE', 'That path resolves outside the session worktree.')
      }
      return
    } catch (error) {
      if (error instanceof ReviewReadError) throw error
      const parent = resolution.dirname(ancestor)
      if (parent === ancestor) {
        throw readError('REVIEW_PATH_OUTSIDE', 'That path cannot be resolved inside the worktree.')
      }
      ancestor = parent
    }
  }
}

// ─── Listing and diffs ──────────────────────────────────────────────

/**
 * Refuses a WSL read when no guest reader was wired.
 *
 * Failing loudly is the point: the alternative is a local Git invocation against
 * a guest path, which reports a misleading "not a repository".
 */
/**
 * A guest checkout's symlink state without a probe that can run in the distro.
 *
 * Refusing to guess is the point: the answer travels to the UI as unknown.
 */
const guestSymlinkUnknown: SymlinkProbe = async () => null

const guestReadUnavailable: typeof runGitRead = async () => {
  throw readError(
    'GIT_READ_FAILED',
    'This repository runs in WSL, but no distro Git reader is available.'
  )
}

export type ReviewReaderDeps = {
  /** Root used to bound every read; kept for symmetry with the service. */
  read?: typeof runGitRead
  /**
   * Guest reads, keyed by distro. Supplied by the composition root so a WSL
   * repository's patch is read by the distro's own Git, with the same byte budget
   * and truncation rules as the local reader.
   */
  readForTarget?: (target: ExecutionTarget) => typeof runGitRead | null
  /**
   * Path dialect and symlink resolution used by review containment. Absent means
   * the controller's own filesystem; a distro checkout supplies the POSIX one.
   */
  containment?: ContainmentResolution
  /**
   * Symlink probe for this checkout's host. Absent means the controller's own
   * filesystem; a distro checkout supplies a probe that runs in the distro.
   */
  symlinkProbe?: SymlinkProbe
  /** Selects a probe per execution target, mirroring `readForTarget`. */
  symlinkProbeForTarget?: (target: ExecutionTarget) => SymlinkProbe | null
}

const SYMLINK_MODE = '120000'

export class GitReviewReader {
  private current: typeof runGitRead = runGitRead

  constructor(private readonly deps: ReviewReaderDeps = {}) {
    this.current = deps.read ?? runGitRead
  }

  /**
   * Selects the reader for one repository's host.
   *
   * Kept as an explicit selection rather than a path heuristic: a review of a WSL
   * worktree must be produced by the guest's Git, and a Windows `git` pointed at
   * `/home/u/...` would either fail or read a different tree.
   */
  forTarget(target: ExecutionTarget): GitReviewReader {
    // Local is the pre-W6 path, unchanged: the reader it was constructed with.
    if (target.kind === 'local') return this
    const read = this.deps.readForTarget?.(target)
    if (read === null || read === undefined) {
      // No guest reader wired. Returning `this` would silently read a guest path
      // with Windows Git, so the caller gets a reader that refuses instead.
      return new GitReviewReader({
        ...this.deps,
        read: guestReadUnavailable,
        containment: guestContainment,
        symlinkProbe: this.deps.symlinkProbeForTarget?.(target) ?? guestSymlinkUnknown
      })
    }
    return new GitReviewReader({
      ...this.deps,
      read,
      containment: guestContainment,
      symlinkProbe: this.deps.symlinkProbeForTarget?.(target) ?? guestSymlinkUnknown
    })
  }

  private get read(): typeof runGitRead {
    return this.current
  }

  /** Test seam: proves which reader a target selected, without changing routing. */
  runReadForTest(options: Parameters<typeof runGitRead>[0]): ReturnType<typeof runGitRead> {
    return this.read(options)
  }

  async assertBaseline(worktreePath: string, baseOid: string): Promise<void> {
    assertSafeOid(baseOid)
    const result = await this.read({
      cwd: worktreePath,
      args: ['cat-file', '-e', `${baseOid}^{commit}`],
      byteBudget: 4096
    })
    if (result.truncated || result.exitCode !== 0) {
      throw new ReviewReadError(
        makeAppError('GIT_READ_FAILED', 'The session baseline commit is not available.', {
          detail: baseOid
        })
      )
    }
  }

  async list(input: {
    worktreePath: string
    baseOid: string
    sessionId: string
  }): Promise<ReviewList> {
    assertSafeOid(input.baseOid)
    const [raw, numstat, status, others] = await Promise.all([
      this.read({
        cwd: input.worktreePath,
        args: ['diff', '--raw', '-z', '--no-abbrev', '-M', input.baseOid, '--'],
        byteBudget: 8 * 1024 * 1024
      }),
      this.read({
        cwd: input.worktreePath,
        args: ['diff', '--numstat', '-z', '-M', input.baseOid, '--'],
        byteBudget: 8 * 1024 * 1024
      }),
      this.read({
        cwd: input.worktreePath,
        args: ['status', '--porcelain=v1', '-z'],
        byteBudget: 8 * 1024 * 1024
      }),
      this.read({
        cwd: input.worktreePath,
        args: ['ls-files', '--others', '--exclude-standard', '-z'],
        byteBudget: 8 * 1024 * 1024
      })
    ])

    for (const result of [raw, numstat, status, others]) {
      if (result.truncated) {
        throw readError(
          result.truncatedReason === 'timeout' ? 'GIT_READ_TIMEOUT' : 'GIT_READ_FAILED',
          'The changed-file list could not be read completely.'
        )
      }
      if (result.exitCode !== 0) {
        throw readError('GIT_READ_FAILED', 'Git could not list the session changes.', result.stderrTail)
      }
    }

    const counts = new Map(parseNumstatZ(numstat.stdout).map((entry) => [entry.path, entry]))
    const areas = new Map(parseStatusZ(status.stdout).map((entry) => [entry.path, entry.area]))

    const files: ReviewFile[] = parseRawZ(raw.stdout).map((entry) => {
      const count = counts.get(entry.path)
      return {
        path: entry.path,
        oldPath: entry.oldPath,
        status: entry.status,
        area: areas.get(entry.path) ?? 'staged',
        origin: 'tracked',
        additions: count?.additions ?? null,
        deletions: count?.deletions ?? null,
        binary: count?.binary ?? false,
        symlink: entry.newMode === SYMLINK_MODE
      }
    })

    const untrackedPaths = parseOthersZ(others.stdout)
    const counted = await this.countUntracked(input.worktreePath, untrackedPaths)
    const probeSymlink = this.deps.symlinkProbe ?? localSymlinkProbe
    for (const path of untrackedPaths) {
      // Asked of the host that owns the checkout; `null` stays unknown.
      const symlink = await probeSymlink(input.worktreePath, path)
      const count = counted.get(path)
      files.push({
        path,
        oldPath: null,
        status: 'added',
        area: 'untracked',
        origin: 'untracked',
        additions: count?.additions ?? null,
        deletions: count?.deletions ?? null,
        binary: count?.binary ?? false,
        symlink
      })
    }

    files.sort((left, right) => left.path.localeCompare(right.path))

    const truncatedList = files.length > REVIEW_MAX_FILES
    return {
      sessionId: input.sessionId,
      baselineOid: input.baseOid,
      files: truncatedList ? files.slice(0, REVIEW_MAX_FILES) : files,
      listTruncated: truncatedList
    }
  }

  private async countUntracked(
    worktreePath: string,
    paths: string[]
  ): Promise<Map<string, { additions: number | null; deletions: number | null; binary: boolean }>> {
    const result = new Map<
      string,
      { additions: number | null; deletions: number | null; binary: boolean }
    >()
    if (paths.length === 0) return result
    const targets = paths.slice(0, MAX_UNTRACKED_COUNT_READS)
    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor
        cursor += 1
        const path = targets[index]
        if (path === undefined) return
        try {
          assertSafeRelativePath(path)
          const read = await this.read({
            cwd: worktreePath,
            args: ['diff', '--no-index', '--numstat', '--', '/dev/null', path],
            byteBudget: 4096
          })
          const entry = parseNumstatZ(`${read.stdout.replace(/\n$/u, '')}`)[0]
          if (entry) {
            result.set(path, {
              additions: entry.additions,
              deletions: entry.deletions,
              binary: entry.binary
            })
          }
        } catch {
          // Counting is best effort; the diff request reports real failures.
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(UNTRACKED_COUNT_CONCURRENCY, targets.length) }, () => worker())
    )
    return result
  }

  /**
   * One side of the working tree. Staged compares HEAD to the index; unstaged
   * compares the index to the working tree; untracked compares /dev/null to
   * the file. This is deliberately separate from the baseline review above:
   * the baseline includes commits, while these scopes describe what the next
   * commit and the working tree actually contain.
   */
  async diffArea(input: {
    worktreePath: string
    sessionId: string
    path: string
    oldPath: string | null
    scope: 'staged' | 'unstaged' | 'untracked' | 'conflict'
    status: ReviewFileStatus
    binary: boolean
    symlink: boolean | null
    additions: number | null
    deletions: number | null
  }): Promise<ReviewDiff> {
    const containment = this.deps.containment ?? localContainment
    assertContained(input.worktreePath, input.path, containment)
    if (input.oldPath !== null) assertContained(input.worktreePath, input.oldPath, containment)

    if (input.binary) {
      return {
        sessionId: input.sessionId,
        path: input.path,
        oldPath: input.oldPath,
        fileStatus: input.status,
        patch: '',
        truncated: false,
        truncatedReason: null,
        binary: true,
        symlink: input.symlink,
        additions: null,
        deletions: null
      }
    }

    const paths = input.oldPath === null ? [input.path] : [input.oldPath, input.path]
    const args =
      input.scope === 'untracked'
        ? ['diff', '--no-index', '--no-color', '--', '/dev/null', input.path]
        : input.scope === 'staged'
          ? ['diff', '--cached', '--no-color', '-M', '--', ...paths]
          : input.scope === 'conflict'
            // `git diff` on an unmerged path emits a combined `diff --cc` that
            // the unified parser cannot read. HEAD..worktree is a normal patch
            // and still contains the conflict markers for the user to inspect.
            ? ['diff', 'HEAD', '--no-color', '-M', '--', ...paths]
            : ['diff', '--no-color', '-M', '--', ...paths]

    const result = await this.read({
      cwd: input.worktreePath,
      args,
      byteBudget: REVIEW_MAX_FILE_BYTES
    })
    const noIndex = input.scope === 'untracked'
    if (!result.truncated && result.exitCode !== 0 && !(noIndex && result.exitCode === 1)) {
      throw readError('GIT_READ_FAILED', 'That file diff could not be read.', result.stderrTail)
    }
    return {
      sessionId: input.sessionId,
      path: input.path,
      oldPath: input.oldPath,
      fileStatus: input.status,
      patch: result.stdout,
      truncated: result.truncated,
      truncatedReason: result.truncatedReason,
      binary: false,
      symlink: input.symlink,
      additions: input.additions,
      deletions: input.deletions
    }
  }


}

function assertSafeOid(oid: string): void {
  if (!/^[0-9a-f]{7,64}$/u.test(oid)) {
    throw readError('INVALID_ARGUMENT', 'The session baseline is not a commit identifier.')
  }
}
