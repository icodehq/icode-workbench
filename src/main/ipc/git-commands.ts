import type { z } from 'zod'
import type { AppRuntime } from '../app/runtime'
import { makeAppError, type AppError } from '../../shared/domain/errors'
import {
  GIT_COMMAND_INPUTS,
  type GitCommandName
} from '../../shared/ipc/git-commands'

type GitRuntime = Pick<AppRuntime, 'gitWorkspace' | 'gitStatusWatcher'>

/**
 * One runnable Git command. The input schema comes from the shared registry so
 * main and the renderer cannot disagree about a command's shape; `run` is the
 * only place that maps a command to a service call.
 */
type GitCommand = {
  input: z.ZodTypeAny
  run: (runtime: GitRuntime, input: any) => Promise<unknown>
}

class GitCommandError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.message)
    this.name = 'GitCommandError'
  }
}

const GIT_COMMANDS: Record<GitCommandName, GitCommand> = {
  status: {
    input: GIT_COMMAND_INPUTS.status,
    run: (runtime, input: { sessionId: string }) => runtime.gitWorkspace.status(input.sessionId)
  },
  changeDiff: {
    input: GIT_COMMAND_INPUTS.changeDiff,
    run: (runtime, input) => runtime.gitWorkspace.changeDiff(input)
  },
  sessionChanges: {
    input: GIT_COMMAND_INPUTS.sessionChanges,
    run: (runtime, input: { sessionId: string }) =>
      runtime.gitWorkspace.sessionChanges(input.sessionId)
  },
  operationState: {
    input: GIT_COMMAND_INPUTS.operationState,
    run: (runtime, input: { sessionId: string }) =>
      runtime.gitWorkspace.operationState(input.sessionId)
  },
  continueOperation: {
    input: GIT_COMMAND_INPUTS.continueOperation,
    run: (runtime, input: { sessionId: string }) =>
      runtime.gitWorkspace.continueOperation(input.sessionId)
  },
  abortOperation: {
    input: GIT_COMMAND_INPUTS.abortOperation,
    run: (runtime, input: { sessionId: string }) =>
      runtime.gitWorkspace.abortOperation(input.sessionId)
  },
  rangeDiff: {
    input: GIT_COMMAND_INPUTS.rangeDiff,
    run: (runtime, input: { sessionId: string; from: string; to: string }) =>
      runtime.gitWorkspace.rangeDiff(input.sessionId, input.from, input.to)
  },
  watchStatus: {
    input: GIT_COMMAND_INPUTS.watchStatus,
    run: (runtime, input: { sessionId: string; active: boolean }) =>
      runtime.gitStatusWatcher.setActive(input.sessionId, input.active)
  },
  commit: {
    input: GIT_COMMAND_INPUTS.commit,
    run: (
      runtime,
      input: {
        sessionId: string
        message: string
        all?: boolean
        signOff?: boolean
        sign?: boolean
      }
    ) =>
      runtime.gitWorkspace.commit(input.sessionId, input.message, {
        ...(input.all === undefined ? {} : { all: input.all }),
        ...(input.signOff === undefined ? {} : { signOff: input.signOff })
      })
  },
  setPathStaged: {
    input: GIT_COMMAND_INPUTS.setPathStaged,
    run: (runtime, input: { sessionId: string; path: string; staged: boolean }) =>
      runtime.gitWorkspace.setPathStaged(input.sessionId, input.path, input.staged)
  },
  setPathsStaged: {
    input: GIT_COMMAND_INPUTS.setPathsStaged,
    run: (
      runtime,
      input: {
        sessionId: string
        targets: Array<{ path: string; area: string; oldPath?: string | null; status?: string }>
        staged: boolean
      }
    ) => runtime.gitWorkspace.setPathsStaged(input.sessionId, input.targets as never, input.staged)
  },
  discardPaths: {
    input: GIT_COMMAND_INPUTS.discardPaths,
    run: (
      runtime,
      input: {
        sessionId: string
        targets: Array<{ path: string; area: string; oldPath?: string | null; status?: string }>
        expectedRevision?: string | null
      }
    ) =>
      runtime.gitWorkspace.discardPaths(
        input.sessionId,
        input.targets as never,
        input.expectedRevision ?? undefined
      )
  },
  branches: {
    input: GIT_COMMAND_INPUTS.branches,
    run: (runtime, input: { sessionId: string }) => runtime.gitWorkspace.branches(input.sessionId)
  },
  switchBranch: {
    input: GIT_COMMAND_INPUTS.switchBranch,
    run: (runtime, input: { sessionId: string; branch: string }) =>
      runtime.gitWorkspace.switchBranch(input.sessionId, input.branch)
  },
  createBranch: {
    input: GIT_COMMAND_INPUTS.createBranch,
    run: (runtime, input: { sessionId: string; branch: string; at?: string }) =>
      runtime.gitWorkspace.createBranch(input.sessionId, input.branch, input.at)
  },
  createTag: {
    input: GIT_COMMAND_INPUTS.createTag,
    run: (runtime, input: { sessionId: string; name: string; oid: string }) =>
      runtime.gitWorkspace.createTag(input.sessionId, input.name, input.oid)
  },
  deleteTag: {
    input: GIT_COMMAND_INPUTS.deleteTag,
    run: (runtime, input: { sessionId: string; name: string }) =>
      runtime.gitWorkspace.deleteTag(input.sessionId, input.name)
  },
  tags: {
    input: GIT_COMMAND_INPUTS.tags,
    run: (runtime, input: { sessionId: string }) => runtime.gitWorkspace.tags(input.sessionId)
  },
  checkoutRef: {
    input: GIT_COMMAND_INPUTS.checkoutRef,
    run: (runtime, input: { sessionId: string; ref: string }) =>
      runtime.gitWorkspace.checkoutRef(input.sessionId, input.ref)
  },
  fileAtRevision: {
    input: GIT_COMMAND_INPUTS.fileAtRevision,
    run: (runtime, input: { sessionId: string; rev: string; path: string }) =>
      runtime.gitWorkspace.fileAtRevision(input.sessionId, input.rev, input.path)
  },
  indexFile: {
    input: GIT_COMMAND_INPUTS.indexFile,
    run: (runtime, input: { sessionId: string; path: string }) =>
      runtime.gitWorkspace.indexFile(input.sessionId, input.path)
  },
  applyPatch: {
    input: GIT_COMMAND_INPUTS.applyPatch,
    run: (
      runtime,
      input: { sessionId: string; patch: string; path: string; mode: 'stage' | 'unstage' | 'discard' }
    ) => runtime.gitWorkspace.applyPatch(input.sessionId, input.patch, input.path, input.mode)
  },
  conflictFile: {
    input: GIT_COMMAND_INPUTS.conflictFile,
    run: (runtime, input: { sessionId: string; path: string }) =>
      runtime.gitWorkspace.conflictFile(input.sessionId, input.path)
  },
  resolveConflict: {
    input: GIT_COMMAND_INPUTS.resolveConflict,
    run: (runtime, input: { sessionId: string; path: string }) =>
      runtime.gitWorkspace.resolveConflict(input.sessionId, input.path)
  },
  stashList: {
    input: GIT_COMMAND_INPUTS.stashList,
    run: (runtime, input: { sessionId: string }) =>
      runtime.gitWorkspace.stashList(input.sessionId)
  },
  stashPush: {
    input: GIT_COMMAND_INPUTS.stashPush,
    run: (
      runtime,
      input: {
        sessionId: string
        message: string
        includeUntracked: boolean
        keepIndex: boolean
      }
    ) =>
      runtime.gitWorkspace.stashPush(
        input.sessionId,
        input.message,
        input.includeUntracked,
        input.keepIndex
      )
  },
  stashDiff: {
    input: GIT_COMMAND_INPUTS.stashDiff,
    run: (runtime, input: { sessionId: string; index: number }) =>
      runtime.gitWorkspace.stashDiff(input.sessionId, input.index)
  },
  stashAction: {
    input: GIT_COMMAND_INPUTS.stashAction,
    run: (
      runtime,
      input: { sessionId: string; index: number; action: 'apply' | 'pop' | 'drop' }
    ) => runtime.gitWorkspace.stashAction(input.sessionId, input.index, input.action)
  },
  worktreeList: {
    input: GIT_COMMAND_INPUTS.worktreeList,
    run: (runtime, input: { sessionId: string }) =>
      runtime.gitWorkspace.worktreeList(input.sessionId)
  },
  worktreeAction: {
    input: GIT_COMMAND_INPUTS.worktreeAction,
    run: (
      runtime,
      input: {
        sessionId: string
        action: 'lock' | 'unlock' | 'prune' | 'remove'
        path: string
        reason?: string
      }
    ) =>
      runtime.gitWorkspace.worktreeAction(
        input.sessionId,
        input.action,
        input.path,
        input.reason
      )
  },
  submoduleList: {
    input: GIT_COMMAND_INPUTS.submoduleList,
    run: (runtime, input: { sessionId: string }) =>
      runtime.gitWorkspace.submoduleStatus(input.sessionId)
  },
  submoduleAction: {
    input: GIT_COMMAND_INPUTS.submoduleAction,
    run: (
      runtime,
      input: {
        sessionId: string
        action: 'init' | 'update' | 'sync' | 'stage'
        path: string
      }
    ) => runtime.gitWorkspace.submoduleAction(input.sessionId, input.action, input.path)
  },
  blame: {
    input: GIT_COMMAND_INPUTS.blame,
    run: (runtime, input: { sessionId: string; path: string }) =>
      runtime.gitWorkspace.blame(input.sessionId, input.path)
  },
  renameBranch: {
    input: GIT_COMMAND_INPUTS.renameBranch,
    run: (runtime, input: { sessionId: string; from: string; to: string }) =>
      runtime.gitWorkspace.renameBranch(input.sessionId, input.from, input.to)
  },
  deleteBranch: {
    input: GIT_COMMAND_INPUTS.deleteBranch,
    run: (runtime, input: { sessionId: string; branch: string }) =>
      runtime.gitWorkspace.deleteBranch(input.sessionId, input.branch)
  },
  mergeBranch: {
    input: GIT_COMMAND_INPUTS.mergeBranch,
    run: (runtime, input: { sessionId: string; branch: string }) =>
      runtime.gitWorkspace.mergeBranch(input.sessionId, input.branch)
  },
  rebaseBranch: {
    input: GIT_COMMAND_INPUTS.rebaseBranch,
    run: (runtime, input: { sessionId: string; branch: string }) =>
      runtime.gitWorkspace.rebaseBranch(input.sessionId, input.branch)
  },
  cherryPick: {
    input: GIT_COMMAND_INPUTS.cherryPick,
    run: (runtime, input: { sessionId: string; oid: string }) =>
      runtime.gitWorkspace.cherryPick(input.sessionId, input.oid)
  },
  revert: {
    input: GIT_COMMAND_INPUTS.revert,
    run: (runtime, input: { sessionId: string; oid: string }) =>
      runtime.gitWorkspace.revert(input.sessionId, input.oid)
  },
  reset: {
    input: GIT_COMMAND_INPUTS.reset,
    run: (
      runtime,
      input: { sessionId: string; oid: string; mode: 'soft' | 'mixed' | 'hard' }
    ) => runtime.gitWorkspace.resetTo(input.sessionId, input.oid, input.mode)
  },
  push: {
    input: GIT_COMMAND_INPUTS.push,
    run: (runtime, input: { sessionId: string }) => runtime.gitWorkspace.push(input.sessionId)
  },
  pull: {
    input: GIT_COMMAND_INPUTS.pull,
    run: (runtime, input: { sessionId: string; rebase?: boolean }) =>
      runtime.gitWorkspace.pull(input.sessionId, input.rebase === true)
  },
  publish: {
    input: GIT_COMMAND_INPUTS.publish,
    run: (runtime, input: { sessionId: string }) =>
      runtime.gitWorkspace.publish(input.sessionId)
  },
  fetch: {
    input: GIT_COMMAND_INPUTS.fetch,
    run: (runtime, input: { sessionId: string }) => runtime.gitWorkspace.fetch(input.sessionId)
  },
  remotes: {
    input: GIT_COMMAND_INPUTS.remotes,
    run: (runtime, input: { sessionId: string }) => runtime.gitWorkspace.remotes(input.sessionId)
  },
  fetchRemote: {
    input: GIT_COMMAND_INPUTS.fetchRemote,
    run: (runtime, input: { sessionId: string; remote: string; prune?: boolean }) =>
      runtime.gitWorkspace.fetchRemote(input.sessionId, input.remote, input.prune)
  },
  addRemote: {
    input: GIT_COMMAND_INPUTS.addRemote,
    run: (runtime, input: { sessionId: string; name: string; url: string }) =>
      runtime.gitWorkspace.addRemote(input.sessionId, input.name, input.url)
  },
  removeRemote: {
    input: GIT_COMMAND_INPUTS.removeRemote,
    run: (runtime, input: { sessionId: string; name: string }) =>
      runtime.gitWorkspace.removeRemote(input.sessionId, input.name)
  },
  pushTags: {
    input: GIT_COMMAND_INPUTS.pushTags,
    run: (runtime, input: { sessionId: string }) =>
      runtime.gitWorkspace.pushTags(input.sessionId)
  },
  forcePush: {
    input: GIT_COMMAND_INPUTS.forcePush,
    run: (runtime, input: { sessionId: string }) =>
      runtime.gitWorkspace.forcePush(input.sessionId)
  },
  remoteBranches: {
    input: GIT_COMMAND_INPUTS.remoteBranches,
    run: (runtime, input: { sessionId: string }) =>
      runtime.gitWorkspace.remoteBranches(input.sessionId)
  },
  setUpstream: {
    input: GIT_COMMAND_INPUTS.setUpstream,
    run: (runtime, input: { sessionId: string; upstream: string }) =>
      runtime.gitWorkspace.setUpstream(input.sessionId, input.upstream)
  },
  amend: {
    input: GIT_COMMAND_INPUTS.amend,
    run: (runtime, input: { sessionId: string; message?: string; sign?: boolean }) =>
      runtime.gitWorkspace.amend(input.sessionId, input.message, { sign: input.sign })
  },
  log: {
    input: GIT_COMMAND_INPUTS.log,
    run: (
      runtime,
      input: {
        sessionId: string
        limit: number
        skip: number
        ref?: string
        allRefs?: boolean
        path?: string
      }
    ) =>
      runtime.gitWorkspace.log(input.sessionId, {
        limit: input.limit,
        skip: input.skip,
        ...(input.ref === undefined ? {} : { ref: input.ref }),
        ...(input.allRefs === undefined ? {} : { allRefs: input.allRefs }),
        ...(input.path === undefined ? {} : { path: input.path })
      })
  },
  commitDetail: {
    input: GIT_COMMAND_INPUTS.commitDetail,
    run: (runtime, input: { sessionId: string; oid: string; parent?: string | null }) =>
      runtime.gitWorkspace.commitDetail(input.sessionId, input.oid, input.parent ?? undefined)
  },
  revisionFileDiff: {
    input: GIT_COMMAND_INPUTS.revisionFileDiff,
    run: (
      runtime,
      input: { sessionId: string; from: string; to: string; path: string; oldPath?: string | null }
    ) =>
      runtime.gitWorkspace.revisionFileDiff(
        input.sessionId,
        input.from,
        input.to,
        input.path,
        input.oldPath ?? undefined
      )
  }
}

/**
 * Validates `{ op, input }` against the shared registry and runs the handler.
 *
 * Validation lives here rather than in the dispatcher so adding a command does
 * not require a new dispatcher case.
 */
export async function invokeGitCommand(
  runtime: GitRuntime,
  rawInput: unknown
): Promise<unknown> {
  if (rawInput === null || typeof rawInput !== 'object') {
    throw new GitCommandError(
      makeAppError('INVALID_ARGUMENT', 'A Git command must name an operation.')
    )
  }
  const { op, input } = rawInput as { op?: unknown; input?: unknown }
  if (
    typeof op !== 'string' ||
    !Object.prototype.hasOwnProperty.call(GIT_COMMANDS, op)
  ) {
    throw new GitCommandError(
      makeAppError('INVALID_ARGUMENT', 'That Git operation is not available.', {
        detail: String(op)
      })
    )
  }
  const command = GIT_COMMANDS[op as GitCommandName]
  const parsed = command.input.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new GitCommandError(
      makeAppError('INVALID_ARGUMENT', 'Invalid Git request.', {
        detail: issue?.path.join('.') || 'input'
      })
    )
  }
  return command.run(runtime, parsed.data)
}
