/**
 * Maps Git's stderr onto the error vocabulary the rest of iCode uses.
 *
 * Git reports different situations in free text. A caller that only sees
 * `git-failed` cannot tell a credential problem from a non-fast-forward or an
 * `index.lock` race, so it cannot give the user a useful next action or decide
 * whether a retry is safe. This is the one place those strings are interpreted.
 */

import type { AppError, AppErrorCode } from '../../shared/domain/errors'
import { makeAppError } from '../../shared/domain/errors'

export type GitFailureContext = {
  /** Code used when no known Git message matches. */
  fallback?: AppErrorCode
  /** User-facing fallback when stderr is empty. */
  fallbackMessage?: string
}

const INDEX_LOCK = /(?:index\.lock|another git process seems to be running|unable to create .*\.lock)/iu
const AUTH = /(?:authentication failed|could not read username|terminal prompts disabled|permission denied \(publickey\)|host key verification failed)/iu
const NON_FAST_FORWARD = /(?:non-fast-forward|updates were rejected|fetch first|tip of your current branch is behind)/iu
const DIVERGED = /(?:have diverged|need to specify how to reconcile divergent branches)/iu
const CONFLICT = /(?:conflict \(content\)|automatic merge failed|fix conflicts and then commit|needs merge)/iu
const BRANCH_IN_USE = /(?:already checked out at|is already used by worktree|branch .* is checked out)/iu

export function isIndexLockFailure(stderr: string): boolean {
  return INDEX_LOCK.test(stderr)
}

/**
 * Classifies a failed Git invocation. The result is the same `AppError` shape
 * used over IPC, so callers do not lose retryability when they add a Git code.
 */
export function classifyGitFailure(stderr: string, context: GitFailureContext = {}): AppError {
  const detail = stderr.trim()
  const fallback = context.fallback ?? 'GIT_COMMIT_FAILED'
  const fallbackMessage = context.fallbackMessage ?? 'Git refused that operation.'

  const classify = (code: AppErrorCode, message: string): AppError =>
    makeAppError(code, message, detail.length > 0 ? { detail } : {})

  if (isIndexLockFailure(stderr)) {
    return classify('GIT_INDEX_LOCKED', 'Another Git process is using this worktree. Try again in a moment.')
  }
  if (AUTH.test(stderr)) {
    return classify('GIT_AUTH_FAILED', 'Git authentication failed. Check your credential helper or SSH agent.')
  }
  if (NON_FAST_FORWARD.test(stderr)) {
    return classify('GIT_NON_FAST_FORWARD', 'The remote has commits this branch does not. Pull or sync before pushing.')
  }
  if (DIVERGED.test(stderr)) {
    return classify('GIT_DIVERGED', 'This branch and its upstream have diverged. Decide whether to pull or rebase.')
  }
  if (BRANCH_IN_USE.test(stderr)) {
    return classify('GIT_BRANCH_IN_USE', 'That branch is checked out in another worktree.')
  }
  if (CONFLICT.test(stderr)) {
    return classify('GIT_CONFLICT', 'Git stopped on conflicts. Resolve them before continuing.')
  }
  return classify(fallback, fallbackMessage)
}
