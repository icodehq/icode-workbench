import { posix, win32 } from 'node:path'
import type { ExecutionTarget } from '../../shared/domain/repository'
import type { RemovalSnapshot } from '../../shared/schemas/repo-removal'
import type { HostFileSystem } from '../git/executor'
import type { GitWorktreeService } from '../worktrees/git-worktree-service'

const STATUS_TIMEOUT_MS = 60_000
const SNAPSHOT_TIMEOUT_MS = 5 * 60 * 1000

export type WorktreeSnapshotOutcome =
  | { state: 'clean'; files: number; snapshot: null }
  | { state: 'saved'; files: number; snapshot: RemovalSnapshot }

export type WorktreeSnapshotInput = {
  worktreePath: string
  worktreeRoot: string
  jobId: string
  sessionId: string
  branch: string
  target: ExecutionTarget
}

export type WorktreeSnapshotDeps = {
  gitWorktrees: Pick<GitWorktreeService, 'gitResultFor'>
  hostFs: Pick<HostFileSystem, 'exists' | 'ensureParentDirectory' | 'removeTree'>
  now: () => number
}

export class WorktreeSnapshotError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message)
    this.name = 'WorktreeSnapshotError'
  }
}

function pathApi(target: ExecutionTarget): typeof posix | typeof win32 {
  return target.kind === 'wsl' || process.platform !== 'win32' ? posix : win32
}

function snapshotRef(jobId: string, sessionId: string): string {
  return `refs/icode/removed/${jobId}/${sessionId}`
}

/**
 * Saves the index and working tree (tracked + untracked; ignored excluded) to
 * a private ref. Staged-only work is preserved as a second parent commit.
 *
 * This runs **before** the worktree is removed and **in place**: a linked
 * worktree's Git admin files point at its registered path, so moving the tree
 * first would make `git add` unreliable. Ignored files are deliberately not
 * captured; the UI says so. The user's index is never touched because every
 * command uses a temporary `GIT_INDEX_FILE`.
 */
export async function snapshotWorktree(
  deps: WorktreeSnapshotDeps,
  input: WorktreeSnapshotInput
): Promise<WorktreeSnapshotOutcome> {
  const git = await deps.gitWorktrees.gitResultFor(input.target)
  const run = async (
    args: string[],
    options: { env?: Readonly<Record<string, string>>; timeoutMs?: number } = {}
  ): Promise<string> => {
    const result = await git(input.worktreePath, args, options.timeoutMs ?? STATUS_TIMEOUT_MS, {
      ...(options.env !== undefined ? { env: options.env } : {})
    })
    if (result.timedOut) {
      throw new WorktreeSnapshotError('Git timed out while saving the worktree.', args[0])
    }
    if (result.spawnFailure !== undefined) {
      throw new WorktreeSnapshotError('Git could not run on the host that owns the worktree.')
    }
    if (result.exitCode !== 0) {
      throw new WorktreeSnapshotError(
        'Git failed while saving the worktree.',
        result.stderr.toString('utf8').trim().slice(0, 1000)
      )
    }
    return result.stdout.toString('utf8')
  }

  let status: string
  try {
    status = await run(['status', '--porcelain', '-uall'], { timeoutMs: STATUS_TIMEOUT_MS })
  } catch (error) {
    if (error instanceof WorktreeSnapshotError) throw error
    throw new WorktreeSnapshotError(
      'The worktree could not be inspected before removal.',
      error instanceof Error ? error.message : String(error)
    )
  }
  const dirtyLines = status.split(/\r?\n/u).filter((line) => line.length > 0)
  if (dirtyLines.length === 0) {
    return { state: 'clean', files: 0, snapshot: null }
  }

  const api = pathApi(input.target)
  const tempDir = api.join(input.worktreeRoot, '.icode-removal', input.jobId, input.sessionId)
  const indexPath = api.join(tempDir, 'index')
  const env = { GIT_INDEX_FILE: indexPath }
  try {
    if (await deps.hostFs.exists(tempDir)) await deps.hostFs.removeTree(tempDir)
    await deps.hostFs.ensureParentDirectory(indexPath)

    const head = await git(input.worktreePath, ['rev-parse', '--verify', 'HEAD'], STATUS_TIMEOUT_MS)
    if (head.timedOut || head.spawnFailure !== undefined) {
      throw new WorktreeSnapshotError('Git could not read the worktree HEAD.')
    }
    const hasHead = head.exitCode === 0
    const headOid = hasHead ? head.stdout.toString('utf8').trim() : null
    if (hasHead && headOid === null) {
      throw new WorktreeSnapshotError('The worktree HEAD could not be read.')
    }
    const headTree = hasHead ? (await run(['rev-parse', 'HEAD^{tree}'])).trim() : null

    /**
     * Capture the real index first. A staged file whose working copy was later
     * reverted is uncommitted work that a working-tree-only add would lose.
     * `write-tree` reads the index without mutating it.
     */
    const indexTree = hasHead ? (await run(['write-tree'])).trim() : null
    if (indexTree !== null && indexTree.length === 0) {
      throw new WorktreeSnapshotError('Git did not produce an index snapshot tree.')
    }
    const indexChanged = indexTree !== null && indexTree !== headTree
    const identity = [
      '-c',
      'user.name=iCode',
      '-c',
      'user.email=icode@localhost',
      '-c',
      'commit.gpgsign=false'
    ]
    const commitTree = async (tree: string, parents: readonly string[], message: string): Promise<string> => {
      const commit = (
        await run(
          [
            ...identity,
            'commit-tree',
            tree,
            ...parents.flatMap((parent) => ['-p', parent]),
            '-m',
            message
          ],
          { env, timeoutMs: SNAPSHOT_TIMEOUT_MS }
        )
      ).trim()
      if (commit.length === 0) {
        throw new WorktreeSnapshotError('Git did not produce a snapshot commit.')
      }
      return commit
    }

    const indexCommit =
      indexChanged && indexTree !== null
        ? await commitTree(
            indexTree,
            hasHead ? [headOid!] : [],
            `iCode removal index snapshot ${input.sessionId}`
          )
        : null

    // The working tree is staged into a temp index starting from HEAD so the
    // user's real index is never modified.
    await run(hasHead ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], { env })
    await run(['add', '-A'], { env, timeoutMs: SNAPSHOT_TIMEOUT_MS })
    const tree = (await run(['write-tree'], { env, timeoutMs: SNAPSHOT_TIMEOUT_MS })).trim()
    if (tree.length === 0) {
      throw new WorktreeSnapshotError('Git did not produce a snapshot tree.')
    }
    const workingChanged = !hasHead || tree !== headTree

    let commit: string
    if (workingChanged) {
      commit = await commitTree(
        tree,
        [...(hasHead ? [headOid!] : []), ...(indexCommit !== null ? [indexCommit] : [])],
        `iCode removal snapshot ${input.sessionId}`
      )
    } else if (indexCommit !== null) {
      // Staged-only work: the index commit is the snapshot.
      commit = indexCommit
    } else {
      return { state: 'clean', files: dirtyLines.length, snapshot: null }
    }
    const ref = snapshotRef(input.jobId, input.sessionId)
    await run(['update-ref', ref, commit], { env })
    return {
      state: 'saved',
      files: dirtyLines.length,
      snapshot: {
        sessionId: input.sessionId,
        ref,
        branch: input.branch,
        commit,
        files: dirtyLines.length
      }
    }
  } finally {
    await deps.hostFs.removeTree(tempDir).catch(() => undefined)
  }
}
