/**
 * Planning and execution helpers for multi-path Git operations.
 *
 * A batch is not one all-or-nothing Git call. Each selected path gets an
 * outcome, a chunk that fails is split until the failing path is isolated, and
 * skipped paths explain why they did not participate. This is what lets the UI
 * move only the rows that actually changed when the live Agent edits the same
 * checkout.
 */

import type {
  GitBatchResult,
  GitPathOutcome,
  GitPathTarget
} from '../../shared/domain/git-workspace'

export type { GitBatchResult, GitPathOutcome, GitPathTarget } from '../../shared/domain/git-workspace'

export type GitBatchAction = 'stage' | 'unstage' | 'discard'

export type ChunkOptions = {
  /** Approximate command-line budget for paths, excluding Git's own args. */
  maxChars?: number
  maxPaths?: number
}

const DEFAULT_MAX_CHARS = 24_000
const DEFAULT_MAX_PATHS = 500

/**
 * A repo-relative Git path.
 *
 * Backslashes are refused even on Windows: Git pathspecs are forward-slash
 * based and a backslash can act as an escape. `..`, `.` and empty segments are
 * refused so a path cannot address outside the worktree.
 */
export function isValidGitPath(path: string): boolean {
  if (path.length === 0 || path.includes('\u0000')) return false
  if (path.startsWith('/') || path.startsWith('\\')) return false
  if (path.includes('\\')) return false
  if (/^[A-Za-z]:/u.test(path)) return false
  const segments = path.split('/')
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

function validTarget(target: GitPathTarget): boolean {
  return isValidGitPath(target.path) && (target.oldPath === undefined || target.oldPath === null || isValidGitPath(target.oldPath))
}

function accepts(action: GitBatchAction, target: GitPathTarget): { accepted: boolean; reason?: string } {
  if (!validTarget(target)) {
    return { accepted: false, reason: 'That path is not inside this worktree.' }
  }
  if (target.area === 'conflicted') {
    return {
      accepted: false,
      reason: action === 'discard'
        ? 'Resolve the conflict before discarding it.'
        : 'Resolve the conflict before staging it.'
    }
  }
  if (action === 'stage') {
    if (target.area === 'staged') return { accepted: false, reason: 'Already staged.' }
    return { accepted: true }
  }
  if (action === 'unstage') {
    if (target.area !== 'staged') return { accepted: false, reason: 'Nothing is staged for this path.' }
    return { accepted: true }
  }
  return { accepted: true }
}

/**
 * Deduplicates command paths while preserving the first-seen order. A rename
 * contributes both its old and new path so its deletion cannot be left behind.
 */
export function commandPathsFor(action: GitBatchAction, targets: readonly GitPathTarget[]): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const target of targets) {
    if (!accepts(action, target).accepted) continue
    const candidates =
      (action === 'stage' || action === 'unstage') && target.oldPath
        ? [target.path, target.oldPath]
        : [target.path]
    for (const path of candidates) {
      if (!seen.has(path)) {
        seen.add(path)
        paths.push(path)
      }
    }
  }
  return paths
}

export function buildStageArgs(paths: readonly string[]): string[] {
  return ['add', '-A', '--', ...paths]
}

/**
 * Unstaging on an unborn branch cannot use `git reset HEAD`: there is no HEAD.
 * `git rm --cached` removes the index entries and keeps files on disk.
 */
export function buildUnstageArgs(paths: readonly string[], options: { unborn: boolean }): string[] {
  return options.unborn
    ? ['rm', '--cached', '-r', '--force', '--', ...paths]
    : ['reset', '-q', 'HEAD', '--', ...paths]
}

export type DiscardGroup = {
  kind: 'staged' | 'unstaged' | 'added' | 'untracked'
  paths: string[]
  /** Commands run in order; a later command only runs if the previous one succeeded. */
  commands: string[][]
}

export type DiscardPlan = {
  groups: DiscardGroup[]
  skipped: GitPathOutcome[]
}

/**
 * Discard follows the row's area.
 *
 * - untracked: delete the file;
 * - staged (new file): remove it from the index and delete it;
 * - staged (tracked): reset the index and worktree to HEAD;
 * - unstaged: restore the worktree to the index, which keeps the staged side.
 *
 * Conflicts are skipped: resolving them is an explicit action, not a discard.
 */
export function planDiscard(targets: readonly GitPathTarget[]): DiscardPlan {
  const staged: string[] = []
  const unstaged: string[] = []
  const added: string[] = []
  const untracked: string[] = []
  const skipped: GitPathOutcome[] = []
  const seen = new Set<string>()

  for (const target of targets) {
    const decision = accepts('discard', target)
    if (!decision.accepted) {
      skipped.push({ path: target.path, area: target.area, status: 'skipped', reason: decision.reason })
      continue
    }
    const key = `${target.area}:${target.path}`
    if (seen.has(key)) continue
    seen.add(key)
    if (target.area === 'untracked') untracked.push(target.path)
    else if (target.area === 'staged' && target.status === 'added') added.push(target.path)
    else if (target.area === 'staged') {
      staged.push(target.path)
      if (target.oldPath) staged.push(target.oldPath)
    } else unstaged.push(target.path)
  }

  const groups: DiscardGroup[] = []
  if (staged.length > 0) {
    groups.push({
      kind: 'staged',
      paths: staged,
      commands: [['restore', '--staged', '--worktree', '--', ...staged]]
    })
  }
  if (unstaged.length > 0) {
    groups.push({
      kind: 'unstaged',
      paths: unstaged,
      commands: [['restore', '--worktree', '--', ...unstaged]]
    })
  }
  if (added.length > 0) {
    groups.push({
      kind: 'added',
      paths: added,
      commands: [
        ['rm', '--cached', '--force', '--', ...added],
        ['clean', '-f', '--', ...added]
      ]
    })
  }
  if (untracked.length > 0) {
    groups.push({
      kind: 'untracked',
      paths: untracked,
      commands: [['clean', '-f', '--', ...untracked]]
    })
  }
  return { groups, skipped }
}

/** Chunks paths so one command cannot approach the OS command-line ceiling. */
export function chunkPaths(paths: readonly string[], options: ChunkOptions = {}): string[][] {
  const maxChars = Math.max(1, options.maxChars ?? DEFAULT_MAX_CHARS)
  const maxPaths = Math.max(1, options.maxPaths ?? DEFAULT_MAX_PATHS)
  const chunks: string[][] = []
  let current: string[] = []
  let characters = 0
  for (const path of paths) {
    const cost = path.length + 1
    if (current.length > 0 && (current.length >= maxPaths || characters + cost > maxChars)) {
      chunks.push(current)
      current = []
      characters = 0
    }
    current.push(path)
    characters += cost
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

export type ExecuteBatchOptions = {
  action: 'stage' | 'unstage'
  targets: readonly GitPathTarget[]
  /** Runs one Git command with the paths already appended after `--`. */
  execute: (args: string[]) => Promise<void>
  /** True when HEAD does not exist yet; only affects unstage. */
  unborn?: boolean
  chunk?: ChunkOptions
}

async function executeChunks(
  paths: readonly string[],
  run: (chunk: readonly string[]) => Promise<void>,
  chunkOptions: ChunkOptions,
  failures: Map<string, unknown>
): Promise<void> {
  for (const chunk of chunkPaths(paths, chunkOptions)) {
    try {
      await run(chunk)
    } catch (error) {
      if (chunk.length === 1) {
        failures.set(chunk[0]!, error)
        continue
      }
      // Isolate the failing path without retrying successful paths in bulk.
      const middle = Math.ceil(chunk.length / 2)
      await executeChunks(chunk.slice(0, middle), run, chunkOptions, failures)
      await executeChunks(chunk.slice(middle), run, chunkOptions, failures)
    }
  }
}

function failReason(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message
  return 'Git refused that path.'
}

export async function executePathBatch(options: ExecuteBatchOptions): Promise<GitBatchResult> {
  const outcomes: GitPathOutcome[] = []
  const accepted: GitPathTarget[] = []
  for (const target of options.targets) {
    const decision = accepts(options.action, target)
    if (!decision.accepted) {
      outcomes.push({ path: target.path, area: target.area, status: 'skipped', reason: decision.reason })
    } else {
      accepted.push(target)
    }
  }

  const commandPaths = commandPathsFor(options.action, accepted)
  const failures = new Map<string, unknown>()
  if (commandPaths.length > 0) {
    const build = (paths: readonly string[]): string[] =>
      options.action === 'stage'
        ? buildStageArgs(paths)
        : buildUnstageArgs(paths, { unborn: options.unborn === true })
    await executeChunks(
      commandPaths,
      async (chunk) => options.execute(build(chunk)),
      options.chunk ?? {},
      failures
    )
  }

  for (const target of accepted) {
    const failure = failures.get(target.path) ?? (target.oldPath ? failures.get(target.oldPath) : undefined)
    if (failure !== undefined) {
      outcomes.push({
        path: target.path,
        area: target.area,
        status: 'failed',
        reason: failReason(failure)
      })
    } else {
      outcomes.push({ path: target.path, area: target.area, status: 'applied' })
    }
  }

  // Preserve the caller's order rather than grouping skips first.
  const byKey = new Map(outcomes.map((outcome) => [`${outcome.area}:${outcome.path}`, outcome]))
  const ordered = options.targets.map(
    (target) =>
      byKey.get(`${target.area}:${target.path}`) ?? {
        path: target.path,
        area: target.area,
        status: 'failed' as const,
        reason: 'The path had no outcome.'
      }
  )
  return summarize(ordered)
}

export type ExecuteDiscardOptions = {
  targets: readonly GitPathTarget[]
  /** Runs one command group; `commands` are already path-complete. */
  execute: (commands: readonly (readonly string[])[]) => Promise<void>
  chunk?: ChunkOptions
}

export async function executeDiscardBatch(options: ExecuteDiscardOptions): Promise<GitBatchResult> {
  const plan = planDiscard(options.targets)
  const outcomes: GitPathOutcome[] = [...plan.skipped]
  const failures = new Map<string, unknown>()

  for (const group of plan.groups) {
    const run = async (paths: readonly string[]): Promise<void> => {
      const commands = group.commands.map((command) => [
        ...command.slice(0, command.indexOf('--') + 1),
        ...paths
      ])
      await options.execute(commands)
    }
    await executeChunks(group.paths, run, options.chunk ?? {}, failures)
  }

  for (const target of options.targets) {
    if (outcomes.some((outcome) => outcome.area === target.area && outcome.path === target.path)) continue
    const failure = failures.get(target.path) ?? (target.oldPath ? failures.get(target.oldPath) : undefined)
    outcomes.push(
      failure === undefined
        ? { path: target.path, area: target.area, status: 'applied' }
        : { path: target.path, area: target.area, status: 'failed', reason: failReason(failure) }
    )
  }

  const byKey = new Map(outcomes.map((outcome) => [`${outcome.area}:${outcome.path}`, outcome]))
  const ordered = options.targets.map(
    (target) =>
      byKey.get(`${target.area}:${target.path}`) ?? {
        path: target.path,
        area: target.area,
        status: 'skipped' as const,
        reason: 'The path had no outcome.'
      }
  )
  return summarize(ordered)
}

function summarize(outcomes: GitPathOutcome[]): GitBatchResult {
  return {
    outcomes,
    applied: outcomes.filter((outcome) => outcome.status === 'applied').map((outcome) => outcome.path),
    skipped: outcomes.filter((outcome) => outcome.status === 'skipped').map((outcome) => outcome.path),
    failed: outcomes.filter((outcome) => outcome.status === 'failed').map((outcome) => outcome.path)
  }
}
