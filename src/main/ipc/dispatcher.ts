import type { z } from 'zod'
import { appErrorSchema } from '../../shared/schemas/domain'
import {
  IPC_CHANNELS,
  addRepositoryInputSchema,
  createSessionInputSchema,
  harnessListInputSchema,
  discardSessionInputSchema,
  listBranchesInputSchema,
  listSessionsInputSchema,
  removeBranchInputSchema,
  removeRepositoryInputSchema,
  sessionTargetInputSchema,
  terminalAttachInputSchema,
  terminalResizeInputSchema,
  terminalWriteInputSchema
} from '../../shared/schemas/ipc'
import { reviewDiffInputSchema, reviewListInputSchema } from '../../shared/schemas/review'
import {
  filesListInputSchema,
  filesReadInputSchema,
  filesSearchInputSchema,
  filesWriteInputSchema,
  gitCommitInputSchema,
  gitDiscardPathInputSchema,
  gitStageAllInputSchema,
  gitStatusInputSchema,
  gitUnstageAllInputSchema
} from '../../shared/schemas/workspace'
import { clearActivityUnreadInputSchema } from '../../shared/schemas/activity'
import type { IpcResult } from '../../shared/schemas/ipc'
import { makeAppError } from '../../shared/domain/errors'
import type { AppError } from '../../shared/domain/errors'
import { DatabaseError } from '../persistence/database'
import { RepositoryPathError } from '../repositories/repository-path'
import type { ExecutionTarget } from '../../shared/domain/repository'
import { SessionServiceError } from '../sessions/session-service'

export type DispatcherServices = {
  reposList: () => Promise<unknown>
  reposAdd: (input: { path: string; target?: ExecutionTarget }) => Promise<unknown>
  reposRemove: (input: { repoId: string; acknowledgeDependentSessions?: boolean }) => Promise<unknown>
  sessionsList: (input: { repoId?: string }) => Promise<unknown>
  sessionsGet: (input: { sessionId: string }) => Promise<unknown>
  sessionsCreate: (input: z.infer<typeof createSessionInputSchema>) => Promise<unknown>
  sessionsClose: (input: { sessionId: string }) => Promise<unknown>
  sessionsRestart: (input: { sessionId: string }) => Promise<unknown>
  sessionsRemove: (input: { sessionId: string }) => Promise<unknown>
  sessionsDiscard: (input: { sessionId: string; confirmBranch: string }) => Promise<unknown>
  sessionsRecoverWorktree: (input: { sessionId: string }) => Promise<unknown>
  branchesList: (input: { repoId: string }) => Promise<unknown>
  branchesRemove: (input: { repoId: string; branch: string; confirmBranch?: string }) => Promise<unknown>
  reviewList: (input: { sessionId: string }) => Promise<unknown>
  reviewDiff: (input: { sessionId: string; path: string; oldPath?: string | null }) => Promise<unknown>
  filesList: (input: { sessionId: string; path: string }) => Promise<unknown>
  filesRead: (input: { sessionId: string; path: string }) => Promise<unknown>
  filesWrite: (input: { sessionId: string; path: string; text: string }) => Promise<unknown>
  filesSearch: (input: {
    sessionId: string
    query: string
    caseSensitive: boolean
    limit: number
  }) => Promise<unknown>
  gitStatus: (input: { sessionId: string }) => Promise<unknown>
  gitStageAll: (input: { sessionId: string }) => Promise<unknown>
  gitUnstageAll: (input: { sessionId: string }) => Promise<unknown>
  gitCommit: (input: { sessionId: string; message: string }) => Promise<unknown>
  gitDiscardPath: (input: { sessionId: string; path: string }) => Promise<unknown>
  activityList: () => Promise<unknown>
  activityClearUnread: (input: { sessionId: string }) => Promise<unknown>
  harnessList: (input: { force?: boolean; repoId?: string }) => Promise<unknown>
  wslListDistros: () => Promise<unknown>
  terminalAttach: (input: { sessionId: string }) => Promise<unknown>
  terminalWrite: (input: { sessionId: string; incarnationId: string; data: string }) => Promise<unknown>
  terminalResize: (input: {
    sessionId: string
    incarnationId: string
    cols: number
    rows: number
  }) => Promise<unknown>
}

export type Dispatcher = (channel: string, rawInput?: unknown) => Promise<IpcResult<unknown>>

function toAppError(error: unknown): AppError {
  if (error instanceof DatabaseError) return error.appError
  if (error instanceof RepositoryPathError) return error.appError
  if (error instanceof SessionServiceError) return error.appError
  const parsed = appErrorSchema.safeParse(
    error && typeof error === 'object' && 'appError' in error
      ? (error as { appError: unknown }).appError
      : null
  )
  if (parsed.success) return parsed.data
  return makeAppError('INTERNAL', 'Unexpected application error.', {
    detail: error instanceof Error ? error.message : String(error)
  })
}

function invalidInput(message: string, path: string): AppError {
  return makeAppError('INVALID_ARGUMENT', message, { detail: path })
}

function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> | AppError {
  const result = schema.safeParse(input)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  return invalidInput('Invalid request payload.', issue?.path.join('.') || 'input')
}

async function run<T>(work: () => Promise<T> | T): Promise<IpcResult<unknown>> {
  try {
    const value = await work()
    return { ok: true, value: value ?? null }
  } catch (error) {
    return { ok: false, error: toAppError(error) }
  }
}

/**
 * Validates every renderer request against the Work 2 schemas and maps failures
 * to stable app errors. IPC registration only forwards channels to this table.
 */
export function createDispatcher(services: DispatcherServices): Dispatcher {
  return async (channel, rawInput) => {
    switch (channel) {
      case IPC_CHANNELS.reposList:
        return run(() => services.reposList())

      case IPC_CHANNELS.reposAdd: {
        const input = parse(addRepositoryInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.reposAdd(input))
      }

      case IPC_CHANNELS.reposRemove: {
        const input = parse(removeRepositoryInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.reposRemove(input))
      }

      case IPC_CHANNELS.sessionsList: {
        const input = parse(listSessionsInputSchema, rawInput ?? {})
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.sessionsList(input))
      }

      case IPC_CHANNELS.sessionsGet: {
        const input = parse(sessionTargetInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.sessionsGet(input))
      }

      case IPC_CHANNELS.sessionsCreate: {
        const input = parse(createSessionInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.sessionsCreate(input))
      }

      case IPC_CHANNELS.sessionsClose: {
        const input = parse(sessionTargetInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.sessionsClose(input))
      }

      case IPC_CHANNELS.sessionsRestart: {
        const input = parse(sessionTargetInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.sessionsRestart(input))
      }

      case IPC_CHANNELS.sessionsRemove: {
        const input = parse(sessionTargetInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.sessionsRemove(input))
      }

      case IPC_CHANNELS.sessionsDiscard: {
        const input = parse(discardSessionInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.sessionsDiscard(input))
      }

      case IPC_CHANNELS.sessionsRecoverWorktree: {
        const input = parse(sessionTargetInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.sessionsRecoverWorktree(input))
      }

      case IPC_CHANNELS.branchesList: {
        const input = parse(listBranchesInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.branchesList(input))
      }

      case IPC_CHANNELS.branchesRemove: {
        const input = parse(removeBranchInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.branchesRemove(input))
      }

      case IPC_CHANNELS.reviewList: {
        const input = parse(reviewListInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.reviewList(input))
      }

      case IPC_CHANNELS.reviewDiff: {
        const input = parse(reviewDiffInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.reviewDiff(input))
      }

      case IPC_CHANNELS.filesList: {
        const input = parse(filesListInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.filesList(input))
      }

      case IPC_CHANNELS.filesRead: {
        const input = parse(filesReadInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.filesRead(input))
      }

      case IPC_CHANNELS.filesWrite: {
        const input = parse(filesWriteInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.filesWrite(input))
      }

      case IPC_CHANNELS.filesSearch: {
        const input = parse(filesSearchInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.filesSearch(input))
      }

      case IPC_CHANNELS.gitStatus: {
        const input = parse(gitStatusInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitStatus(input))
      }

      case IPC_CHANNELS.gitStageAll: {
        const input = parse(gitStageAllInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitStageAll(input))
      }

      case IPC_CHANNELS.gitUnstageAll: {
        const input = parse(gitUnstageAllInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitUnstageAll(input))
      }

      case IPC_CHANNELS.gitCommit: {
        const input = parse(gitCommitInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitCommit(input))
      }

      case IPC_CHANNELS.gitDiscardPath: {
        const input = parse(gitDiscardPathInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.gitDiscardPath(input))
      }

      case IPC_CHANNELS.activityList:
        return run(() => services.activityList())

      case IPC_CHANNELS.activityClearUnread: {
        const input = parse(clearActivityUnreadInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.activityClearUnread(input))
      }

      case IPC_CHANNELS.harnessList: {
        const input = parse(harnessListInputSchema, rawInput ?? {})
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.harnessList(input))
      }

      case IPC_CHANNELS.wslListDistros:
        // No input: discovery is machine-wide and takes no parameters.
        return run(() => services.wslListDistros())

      case IPC_CHANNELS.terminalAttach: {
        const input = parse(terminalAttachInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.terminalAttach(input))
      }

      case IPC_CHANNELS.terminalWrite: {
        const input = parse(terminalWriteInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.terminalWrite(input))
      }

      case IPC_CHANNELS.terminalResize: {
        const input = parse(terminalResizeInputSchema, rawInput)
        if ('code' in input) return { ok: false, error: input }
        return run(() => services.terminalResize(input))
      }

      default:
        return {
          ok: false,
          error: makeAppError('INVALID_ARGUMENT', 'Unknown IPC channel.', {
            context: { channel: String(channel).slice(0, 100) }
          })
        }
    }
  }
}
