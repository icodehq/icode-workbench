import { z } from 'zod'
import {
  gitAmendInputSchema,
  gitApplyPatchInputSchema,
  gitBlameInputSchema,
  gitCheckIgnoreInputSchema,
  gitCommitActionInputSchema,
  gitCommitDetailInputSchema,
  gitCommitInputSchema,
  gitConflictFileInputSchema,
  gitDiscardPathsInputSchema,
  gitFileAtRevisionInputSchema,
  gitIndexFileInputSchema,
  gitLogInputSchema,
  gitOperationActionInputSchema,
  gitOperationStateInputSchema,
  gitPullInputSchema,
  gitRangeDiffInputSchema,
  gitRemoteOpInputSchema,
  gitResetInputSchema,
  gitResolveConflictInputSchema,
  gitRevisionFileDiffInputSchema,
  gitSessionChangesInputSchema,
  gitSetPathStagedInputSchema,
  gitSetPathsStagedInputSchema,
  gitStatusInputSchema,
  gitWatchStatusInputSchema
} from '../schemas/workspace'
import { changeDiffInputSchema } from '../schemas/changes'

/**
 * One entry per Git operation.
 *
 * This map is the single list of Git commands: main builds its handler table
 * from these keys, the preload facade is generated from them, and the renderer
 * API is a mapped type over the same names. Adding an operation means adding
 * one schema here, one handler in main, and one result type.
 */
export const GIT_COMMAND_INPUTS = {
  status: gitStatusInputSchema,
  checkIgnore: gitCheckIgnoreInputSchema,
  changeDiff: changeDiffInputSchema,
  sessionChanges: gitSessionChangesInputSchema,
  operationState: gitOperationStateInputSchema,
  continueOperation: gitOperationActionInputSchema,
  abortOperation: gitOperationActionInputSchema,
  rangeDiff: gitRangeDiffInputSchema,
  watchStatus: gitWatchStatusInputSchema,
  commit: gitCommitInputSchema,
  setPathStaged: gitSetPathStagedInputSchema,
  setPathsStaged: gitSetPathsStagedInputSchema,
  discardPaths: gitDiscardPathsInputSchema,
  fileAtRevision: gitFileAtRevisionInputSchema,
  indexFile: gitIndexFileInputSchema,
  applyPatch: gitApplyPatchInputSchema,
  conflictFile: gitConflictFileInputSchema,
  resolveConflict: gitResolveConflictInputSchema,
  blame: gitBlameInputSchema,
  cherryPick: gitCommitActionInputSchema,
  revert: gitCommitActionInputSchema,
  reset: gitResetInputSchema,
  push: gitRemoteOpInputSchema,
  pull: gitPullInputSchema,
  publish: gitRemoteOpInputSchema,
  amend: gitAmendInputSchema,
  log: gitLogInputSchema,
  commitDetail: gitCommitDetailInputSchema,
  revisionFileDiff: gitRevisionFileDiffInputSchema
} as const

export type GitCommandName = keyof typeof GIT_COMMAND_INPUTS
export type GitCommandInput<K extends GitCommandName> = z.infer<
  (typeof GIT_COMMAND_INPUTS)[K]
>

/** Runtime list for the preload facade; order is irrelevant. */
export const GIT_COMMAND_NAMES = Object.keys(GIT_COMMAND_INPUTS) as GitCommandName[]
