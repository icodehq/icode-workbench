import type { RepositoryStore } from '../persistence/repository-store'
import type { WorktreeStore } from '../persistence/worktree-store'
import type { GitWorktreeService } from '../worktrees/git-worktree-service'
import {
  parseAheadBehind,
  parsePorcelainZ,
  type GitCommitResult,
  type GitStatusEntry,
  type GitWorkspaceStatus
} from '../../shared/domain/git-workspace'
import type { FilesUnavailable } from '../files/workspace-files-service'

/**
 * Git answers with the same shape as files for anything about the checkout
 * itself, plus its own operation failures.
 */
export type GitUnavailable = FilesUnavailable | {
  status: 'unavailable'
  reason: 'not-a-repository' | 'nothing-to-commit' | 'commit-failed' | 'git-failed'
  detail: string
}

export type GitWorkspaceDeps = {
  repositories: RepositoryStore
  worktrees: WorktreeStore
  gitWorktrees: GitWorktreeService
}

export type GitOutcome<T> = ({ status: 'ok' } & T) | GitUnavailable

/** A commit message is one line of intent; blank messages are refused. */
const MAX_MESSAGE_LENGTH = 4000

/**
 * Git state and the common write operations, scoped to one session's checkout.
 *
 * Reads run where the checkout lives, through the same target-aware Git the rest
 * of the app uses. Nothing here rewrites history, and nothing runs on a
 * repository the user has not selected.
 */
export class GitWorkspaceService {
  constructor(private readonly deps: GitWorkspaceDeps) {}

  async status(sessionId: string): Promise<GitOutcome<{ snapshot: GitWorkspaceStatus }>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, raw, worktreePath } = resolved

    let branch: string | null = null
    let headOid: string | null = null
    let upstream: string | null = null
    let ahead = 0
    let behind = 0
    let porcelain = ''

    try {
      branch = await git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null)
      if (branch === 'HEAD') branch = null
      headOid = await git(worktreePath, ['rev-parse', 'HEAD']).catch(() => null)
      // Untrimmed: the first entry of an unstaged change begins with a space.
      const statusRead = await raw(worktreePath, ['status', '--porcelain=v1', '-z'])
      porcelain = statusRead.stdout
      upstream = await git(worktreePath, [
        'rev-parse',
        '--abbrev-ref',
        '--symbolic-full-name',
        '@{upstream}'
      ]).catch(() => null)
      if (upstream) {
        const counts = await git(worktreePath, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`]).catch(
          () => null
        )
        if (counts) {
          const parsed = parseAheadBehind(counts)
          ahead = parsed.ahead
          behind = parsed.behind
        }
      }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'worktree-unavailable',
        detail: detailOf(error, 'Git could not read this worktree.')
      }
    }

    const entries = parsePorcelainZ(porcelain)
    const byArea = (area: GitStatusEntry['area']): GitStatusEntry[] =>
      entries.filter((entry) => entry.area === area)

    return {
      status: 'ok',
      snapshot: {
        branch,
        headOid,
        upstream,
        ahead,
        behind,
        staged: byArea('staged'),
        unstaged: byArea('unstaged'),
        untracked: byArea('untracked'),
        conflicted: byArea('conflicted'),
        clean: entries.length === 0
      }
    }
  }

  /** Stages everything, the way `git add -A` does from the worktree root. */
  async stageAll(sessionId: string): Promise<GitOutcome<{ staged: number }>> {
    return this.mutate(sessionId, ['add', '-A'], (before) => {
      const status = before as GitWorkspaceStatus
      return { staged: status.staged.length + status.unstaged.length + status.untracked.length }
    })
  }

  async unstageAll(sessionId: string): Promise<GitOutcome<{ unstaged: number }>> {
    return this.mutate(sessionId, ['reset'], (before) => {
      const status = before as GitWorkspaceStatus
      return { unstaged: status.staged.length }
    })
  }

  /**
   * Commits the index as it stands.
   *
   * The message is passed as argv, never through a shell, and an empty index is
   * refused before Git runs so the user gets a sentence rather than Git's
   * "nothing to commit" exit status.
   */
  async commit(sessionId: string, message: string): Promise<GitOutcome<GitCommitResult>> {
    const trimmed = message.trim()
    if (trimmed.length === 0) {
      return { status: 'unavailable', reason: 'commit-failed', detail: 'A commit message is required.' }
    }
    if (trimmed.length > MAX_MESSAGE_LENGTH) {
      return {
        status: 'unavailable',
        reason: 'commit-failed',
        detail: `The commit message is longer than ${String(MAX_MESSAGE_LENGTH)} characters.`
      }
    }

    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, worktreePath } = resolved

    const stagedCount = await git(worktreePath, ['diff', '--cached', '--name-only'])
      .then((value) => value.split('\n').filter((line) => line.trim().length > 0).length)
      .catch(() => 0)
    if (stagedCount === 0) {
      return {
        status: 'unavailable',
        reason: 'nothing-to-commit',
        detail: 'There is nothing staged to commit. Stage the changes you want first.'
      }
    }

    try {
      await git(worktreePath, ['commit', '-m', trimmed])
    } catch (error) {
      return { status: 'unavailable', reason: 'commit-failed', detail: detailOf(error, 'Git refused the commit.') }
    }

    const oid = await git(worktreePath, ['rev-parse', 'HEAD']).catch(() => '')
    const subject = await git(worktreePath, ['log', '-1', '--pretty=%s']).catch(() => trimmed)
    return {
      status: 'ok',
      oid: oid.slice(0, 7),
      subject,
      files: stagedCount
    }
  }

  /** Discards one unstaged/untracked path, at the user's explicit request. */
  async discardPath(sessionId: string, path: string): Promise<GitOutcome<{ restored: boolean }>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, raw, worktreePath } = resolved
    const relative = path
    if (
      relative.length === 0 ||
      relative.startsWith('/') ||
      relative.split('/').some((segment) => segment === '..' || segment === '.')
    ) {
      return { status: 'unavailable', reason: 'path-outside', detail: 'That path is not inside this worktree.' }
    }

    const statusRead = await raw(worktreePath, ['status', '--porcelain=v1', '-z'])
    const entry = parsePorcelainZ(statusRead.stdout).find((candidate) => candidate.path === relative)
    if (!entry) {
      return { status: 'unavailable', reason: 'not-found', detail: 'Git does not report that path as changed.' }
    }

    try {
      if (entry.area === 'untracked') {
        // Untracked files are not restorable, so this removes the file itself.
        await git(worktreePath, ['clean', '-f', '--', relative])
      } else if (entry.area === 'staged' && entry.status === 'added') {
        await git(worktreePath, ['rm', '--cached', '--force', '--', relative])
      } else {
        await git(worktreePath, ['checkout', '--', relative])
      }
      return { status: 'ok', restored: true }
    } catch (error) {
      return { status: 'unavailable', reason: 'git-failed', detail: detailOf(error, 'Git could not discard that path.') }
    }
  }

  private async mutate<T>(
    sessionId: string,
    args: string[],
    shape: (before: GitWorkspaceStatus) => T
  ): Promise<GitOutcome<T>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const { git, raw, worktreePath } = resolved

    const before = await this.readStatus(raw, worktreePath)
    if (before === null) {
      return { status: 'unavailable', reason: 'worktree-unavailable', detail: 'Git could not read this worktree.' }
    }
    try {
      await git(worktreePath, args)
    } catch (error) {
      return { status: 'unavailable', reason: 'git-failed', detail: detailOf(error, 'Git refused that operation.') }
    }
    return { status: 'ok', ...shape(before) }
  }

  private async readStatus(
    raw: (cwd: string, args: string[]) => Promise<{ stdout: string; exitCode: number | null }>,
    worktreePath: string
  ): Promise<GitWorkspaceStatus | null> {
    try {
      const porcelain = (await raw(worktreePath, ['status', '--porcelain=v1', '-z'])).stdout
      const entries = parsePorcelainZ(porcelain)
      const byArea = (area: GitStatusEntry['area']): GitStatusEntry[] =>
        entries.filter((entry) => entry.area === area)
      return {
        branch: null,
        headOid: null,
        upstream: null,
        ahead: 0,
        behind: 0,
        staged: byArea('staged'),
        unstaged: byArea('unstaged'),
        untracked: byArea('untracked'),
        conflicted: byArea('conflicted'),
        clean: entries.length === 0
      }
    } catch {
      return null
    }
  }

  private async resolve(
    sessionId: string
  ): Promise<
    | {
        status: 'ok'
        worktreePath: string
        git: (cwd: string, args: string[]) => Promise<string>
        /** Verbatim stdout, for fixed-width output such as porcelain status. */
        raw: (cwd: string, args: string[]) => Promise<{ stdout: string; exitCode: number | null }>
      }
    | GitUnavailable
  > {
    const record = this.deps.worktrees.findBySession(sessionId)
    if (!record) {
      return {
        status: 'unavailable',
        reason: 'primary-checkout',
        detail: 'This session runs in the primary checkout, so it has no worktree Git state.'
      }
    }
    const repository = this.deps.repositories.findById(record.repoId)
    if (!repository) {
      return { status: 'unavailable', reason: 'not-found', detail: 'The session repository is no longer registered.' }
    }

    let exists: boolean
    try {
      const fs = await this.deps.gitWorktrees.hostFsFor(repository.executionTarget)
      exists = await fs.isDirectory(record.path)
    } catch {
      return {
        status: 'unavailable',
        reason: 'worktree-unavailable',
        detail:
          repository.executionTarget.kind === 'local'
            ? 'The session worktree could not be inspected.'
            : 'The session distro could not be reached, so its Git state is unavailable right now.'
      }
    }
    if (!exists) {
      return {
        status: 'unavailable',
        reason: 'worktree-missing',
        detail:
          repository.executionTarget.kind === 'local'
            ? 'The session worktree directory is missing.'
            : 'The session worktree directory is missing inside its distro.'
      }
    }

    const git = await this.deps.gitWorktrees.gitFor(repository.executionTarget)
    const raw = await this.deps.gitWorktrees.gitRawFor(repository.executionTarget)
    return { status: 'ok', worktreePath: record.path, git, raw }
  }
}

function detailOf(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message
  return fallback
}
