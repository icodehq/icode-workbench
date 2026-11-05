import type { RepositoryStore } from '../persistence/repository-store'
import type { WorktreeStore } from '../persistence/worktree-store'
import type { GitWorktreeService } from '../worktrees/git-worktree-service'
import { describeWorktree } from '../worktrees/worktree-status'
import { SessionServiceError } from '../sessions/session-errors'
import { makeAppError } from '../../shared/domain/errors'
import type { SessionLifecycleState } from '../../shared/domain/session'
import {
  type ChangeListOutcome,
  type ChangeUnavailableReason
} from '../../shared/domain/changes'
import { GitReadError } from './bounded-read'
import { assertChangeBaseline, readChangeList, type ReadContext } from './change-reader'

/**
 * The session-state question this module needs. Kept structural so the Git
 * engine does not depend on the whole SessionService.
 */
export type SessionStateSource = {
  get(sessionId: string): Promise<{ state: SessionLifecycleState }>
}

export type SessionChangesDeps = {
  sessions: SessionStateSource
  repositories: RepositoryStore
  worktrees: WorktreeStore
  gitWorktrees: GitWorktreeService
}

type Target =
  | {
      status: 'available'
      worktreePath: string
      baseOid: string
      sessionId: string
      readContext: ReadContext
    }
  | { status: 'unavailable'; reason: ChangeUnavailableReason; detail: string }

/**
 * Read-only changed-file listing for one session's baseline.
 *
 * This never asks the Host anything: a stopped or exited session still has
 * changes worth reviewing. A missing worktree is reported instead of falling
 * back to the primary checkout.
 */
export async function readSessionChanges(
  deps: SessionChangesDeps,
  sessionId: string
): Promise<ChangeListOutcome> {
  const target = await resolveTarget(deps, sessionId)
  if (target.status === 'unavailable') return target
  try {
    const list = await readChangeList(target.readContext, {
      worktreePath: target.worktreePath,
      baseOid: target.baseOid,
      sessionId: target.sessionId
    })
    return { status: 'available', ...list }
  } catch (error) {
    if (error instanceof GitReadError) throw new SessionServiceError(error.appError)
    throw error
  }
}

async function resolveTarget(
  deps: SessionChangesDeps,
  sessionId: string
): Promise<Target> {
  let summary
  try {
    summary = await deps.sessions.get(sessionId)
  } catch (error) {
    if (error instanceof SessionServiceError) throw error
    throw new SessionServiceError(
      makeAppError('INTERNAL', 'The session could not be read.', {
        detail: error instanceof Error ? error.message : String(error)
      })
    )
  }

  const record = deps.worktrees.findBySession(sessionId)
  if (!record) {
    // Legacy sessions predate isolation, so the primary checkout contains work
    // that is not attributable to this session. Never invent a baseline.
    return {
      status: 'unavailable',
      reason: 'primary-checkout',
      detail: 'This session runs in the primary checkout, so it has no session baseline.'
    }
  }

  const repository = deps.repositories.findById(record.repoId)
  if (!repository) {
    return {
      status: 'unavailable',
      reason: 'worktree-inconsistent',
      detail: 'The session repository is no longer registered.'
    }
  }

  // Existence is a question about where the checkout lives. The host's
  // `statSync` answers it for a local worktree, but a WSL worktree path is a
  // guest path that never exists on Windows: asking locally would report every
  // healthy guest checkout as missing. For a distro the question is therefore
  // deferred to the target-aware inspection below, which asks the distro.
  const executionTarget = repository.executionTarget
  const isLocal = executionTarget.kind === 'local'

  const described = isLocal
    ? describeWorktree(record, summary.state, null)
    : describeWorktree(record, summary.state, null, true)
  if (described.status === 'missing') {
    return {
      status: 'unavailable',
      reason: 'worktree-missing',
      detail: 'The session worktree directory is missing. Re-create it from its branch first.'
    }
  }
  if (described.status === 'inconsistent' || described.status === 'incomplete') {
    return {
      status: 'unavailable',
      reason: 'worktree-inconsistent',
      detail: 'The session worktree does not match its records, so nothing is shown.'
    }
  }
  if (described.status === 'failed') {
    return {
      status: 'unavailable',
      reason: 'worktree-failed',
      detail: record.error?.message ?? 'Session worktree creation failed.'
    }
  }

  let inspection
  try {
    inspection = await deps.gitWorktrees.inspect({
      primaryRoot: repository.path,
      path: record.path,
      branch: record.branch,
      target: executionTarget
    })
  } catch {
    // A check that could not run is not a missing worktree. Permissions, an
    // unreachable distro and a broken repository all arrive here, and calling
    // any of them "missing" would invite the user to recreate a healthy tree.
    return {
      status: 'unavailable',
      reason: 'worktree-inconsistent',
      detail: isLocal
        ? 'The session worktree could not be inspected.'
        : 'The session worktree could not be inspected inside its distro.'
    }
  }
  if (!inspection.pathExists) {
    return {
      status: 'unavailable',
      reason: 'worktree-missing',
      detail: isLocal
        ? 'The session worktree directory is missing. Re-create it from its branch first.'
        : 'The session worktree directory is missing inside its distro. Re-create it from its branch first.'
    }
  }
  if (!inspection.registered) {
    return {
      status: 'unavailable',
      reason: 'worktree-inconsistent',
      detail: 'Git does not recognise this directory as the session worktree.'
    }
  }

  let readContext: ReadContext
  try {
    readContext = await deps.gitWorktrees.readContextFor(executionTarget)
  } catch {
    return {
      status: 'unavailable',
      reason: 'worktree-inconsistent',
      detail: isLocal
        ? 'The session worktree could not be inspected.'
        : 'The session worktree could not be inspected inside its distro.'
    }
  }

  try {
    await assertChangeBaseline(readContext, record.path, record.baseOid)
  } catch (error) {
    if (error instanceof GitReadError && error.appError.code === 'GIT_READ_FAILED') {
      return {
        status: 'unavailable',
        reason: 'invalid-baseline',
        detail: 'The commit this session started from is no longer available.'
      }
    }
    throw error
  }

  return {
    status: 'available',
    worktreePath: record.path,
    baseOid: record.baseOid,
    sessionId: record.sessionId,
    readContext
  }
}
