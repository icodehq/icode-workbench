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
  checkIgnore: {
    input: GIT_COMMAND_INPUTS.checkIgnore,
    run: (runtime, input: { sessionId: string; paths: string[] }) =>
      runtime.gitWorkspace.checkIgnore(input.sessionId, input.paths)
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
  blame: {
    input: GIT_COMMAND_INPUTS.blame,
    run: (runtime, input: { sessionId: string; path: string }) =>
      runtime.gitWorkspace.blame(input.sessionId, input.path)
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
        path?: string
      }
    ) =>
      runtime.gitWorkspace.log(input.sessionId, {
        limit: input.limit,
        skip: input.skip,
        ...(input.ref === undefined ? {} : { ref: input.ref }),
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
