import {
  CHANGE_MAX_FILES,
  CHANGE_MAX_FILE_BYTES,
  type ChangeDiff,
  type ChangeDiffScope,
  type ChangeFile,
  type ChangeFileStatus,
  type ChangeList,
  type ChangeArea
} from '../../shared/domain/changes'
import { readError, type GitReadOptions, type GitReadResult } from './bounded-read'
import { parseNumstatZ } from './git-helpers'
import {
  assertContained,
  assertSafeRelativePath,
  type ContainmentResolution,
  type SymlinkProbe
} from './path-safety'

/**
 * The read capabilities of one checkout: bounded Git reads, path containment in
 * the checkout's own dialect, and symlink questions asked of its own host.
 */
export type ReadContext = {
  read: (options: GitReadOptions) => Promise<GitReadResult>
  containment: ContainmentResolution
  symlinkProbe: SymlinkProbe
}

const UNTRACKED_LIST_BYTE_BUDGET = 8 * 1024 * 1024
/**
 * Untracked files have no index entry, so Git can only count them one file at a
 * time. Above this cap the list reports unknown counts instead of spawning
 * hundreds of processes; the diff still shows the exact patch.
 */
const MAX_UNTRACKED_COUNT_READS = 50
const UNTRACKED_COUNT_CONCURRENCY = 4
const SYMLINK_MODE = '120000'

// ─── NUL-safe decoders ──────────────────────────────────────────────

const STATUS_LETTERS: Record<string, ChangeFileStatus> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  T: 'modified',
  C: 'added'
}

/**
 * `git diff --raw -z --no-abbrev`: `:oldmode newmode oldsha newsha STATUS\0path\0`
 * and for renames `... R100\0old\0new\0`.
 */
export function parseRawZ(output: string): Array<{
  status: ChangeFileStatus
  oldMode: string
  newMode: string
  path: string
  oldPath: string | null
}> {
  const parts = output.split('\u0000')
  const entries: Array<{
    status: ChangeFileStatus
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
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

export type StatusEntry = {
  path: string
  oldPath: string | null
  index: string
  worktree: string
  area: ChangeArea
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
    const area: ChangeArea = CONFLICT_CODES.has(pair)
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

// ─── Baseline and changed files ─────────────────────────────────────

export function assertSafeOid(oid: string): void {
  if (!/^[0-9a-f]{7,64}$/u.test(oid)) {
    throw readError('INVALID_ARGUMENT', 'The session baseline is not a commit identifier.')
  }
}

export async function assertChangeBaseline(
  context: ReadContext,
  worktreePath: string,
  baseOid: string
): Promise<void> {
  assertSafeOid(baseOid)
  const result = await context.read({
    cwd: worktreePath,
    args: ['cat-file', '-e', `${baseOid}^{commit}`],
    byteBudget: 4096
  })
  if (result.truncated || result.exitCode !== 0) {
    throw readError('GIT_READ_FAILED', 'The session baseline commit is not available.', baseOid)
  }
}

export async function readChangeList(
  context: ReadContext,
  input: {
    worktreePath: string
    baseOid: string
    sessionId: string
  }
): Promise<ChangeList> {
  assertSafeOid(input.baseOid)
  const [raw, numstat, status, others] = await Promise.all([
    context.read({
      cwd: input.worktreePath,
      args: ['diff', '--raw', '-z', '--no-abbrev', '-M', input.baseOid, '--'],
      byteBudget: UNTRACKED_LIST_BYTE_BUDGET
    }),
    context.read({
      cwd: input.worktreePath,
      args: ['diff', '--numstat', '-z', '-M', input.baseOid, '--'],
      byteBudget: UNTRACKED_LIST_BYTE_BUDGET
    }),
    context.read({
      cwd: input.worktreePath,
      args: ['status', '--porcelain=v1', '-z'],
      byteBudget: UNTRACKED_LIST_BYTE_BUDGET
    }),
    context.read({
      cwd: input.worktreePath,
      args: ['ls-files', '--others', '--exclude-standard', '-z'],
      byteBudget: UNTRACKED_LIST_BYTE_BUDGET
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

  const files: ChangeFile[] = parseRawZ(raw.stdout).map((entry) => {
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
  const counted = await countUntracked(context, input.worktreePath, untrackedPaths)
  for (const path of untrackedPaths) {
    // Asked of the host that owns the checkout; `null` stays unknown.
    const symlink = await context.symlinkProbe(input.worktreePath, path)
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

  const truncatedList = files.length > CHANGE_MAX_FILES
  return {
    sessionId: input.sessionId,
    baselineOid: input.baseOid,
    files: truncatedList ? files.slice(0, CHANGE_MAX_FILES) : files,
    listTruncated: truncatedList
  }
}

async function countUntracked(
  context: ReadContext,
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
        const read = await context.read({
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
 * the file. This is deliberately separate from the baseline list above: the
 * baseline includes commits, while these scopes describe what the next commit
 * and the working tree actually contain.
 */
export async function readChangeDiff(
  context: ReadContext,
  input: {
    worktreePath: string
    sessionId: string
    path: string
    oldPath: string | null
    scope: ChangeDiffScope
    status: ChangeFileStatus
    binary: boolean
    symlink: boolean | null
    additions: number | null
    deletions: number | null
  }
): Promise<ChangeDiff> {
  assertContained(input.worktreePath, input.path, context.containment)
  if (input.oldPath !== null) {
    assertContained(input.worktreePath, input.oldPath, context.containment)
  }

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
          ? // `git diff` on an unmerged path emits a combined `diff --cc` that
            // the unified parser cannot read. HEAD..worktree is a normal patch
            // and still contains the conflict markers for the user to inspect.
            ['diff', 'HEAD', '--no-color', '-M', '--', ...paths]
          : ['diff', '--no-color', '-M', '--', ...paths]

  const result = await context.read({
    cwd: input.worktreePath,
    args,
    byteBudget: CHANGE_MAX_FILE_BYTES
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
