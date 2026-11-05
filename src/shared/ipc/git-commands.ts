import { z } from 'zod'
import {
  gitAddRemoteInputSchema,
  gitAmendInputSchema,
  gitApplyPatchInputSchema,
  gitBlameInputSchema,
  gitBranchesInputSchema,
  gitCheckoutRefInputSchema,
  gitCommitActionInputSchema,
  gitCommitDetailInputSchema,
  gitCommitInputSchema,
  gitConflictFileInputSchema,
  gitCreateBranchInputSchema,
  gitCreateTagInputSchema,
  gitDeleteBranchInputSchema,
  gitDeleteTagInputSchema,
  gitDiscardPathsInputSchema,
  gitFetchRemoteInputSchema,
  gitFileAtRevisionInputSchema,
  gitIndexFileInputSchema,
  gitLogInputSchema,
  gitMergeBranchInputSchema,
  gitOperationActionInputSchema,
  gitOperationStateInputSchema,
  gitPullInputSchema,
  gitRangeDiffInputSchema,
  gitRebaseBranchInputSchema,
  gitRemoteOpInputSchema,
  gitRemoveRemoteInputSchema,
  gitRenameBranchInputSchema,
  gitResetInputSchema,
  gitResolveConflictInputSchema,
  gitRevisionFileDiffInputSchema,
  gitSessionChangesInputSchema,
  gitSetPathStagedInputSchema,
  gitSetPathsStagedInputSchema,
  gitSetUpstreamInputSchema,
  gitStashActionInputSchema,
  gitStashPushInputSchema,
  gitStashTargetInputSchema,
  gitStatusInputSchema,
  gitSubmoduleActionInputSchema,
  gitSwitchBranchInputSchema,
  gitWatchStatusInputSchema,
  gitWorktreeActionInputSchema
} from '../schemas/workspace'
import { changeDiffInputSchema } from '../schemas/changes'

/**
 * One entry per Git operation.
 *
 * This map is the single list of Git commands: main builds its handler table
 * from these keys, the preload façade is generated from them, and the renderer
 * API is a mapped type over the same names. Adding an operation means adding
 * one schema here, one handler in main, and one result type.
 */
export const GIT_COMMAND_INPUTS = {
  status: gitStatusInputSchema,
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
  branches: gitBranchesInputSchema,
  switchBranch: gitSwitchBranchInputSchema,
  createBranch: gitCreateBranchInputSchema,
  createTag: gitCreateTagInputSchema,
  deleteTag: gitDeleteTagInputSchema,
  tags: gitRemoteOpInputSchema,
  checkoutRef: gitCheckoutRefInputSchema,
  fileAtRevision: gitFileAtRevisionInputSchema,
  indexFile: gitIndexFileInputSchema,
  applyPatch: gitApplyPatchInputSchema,
  conflictFile: gitConflictFileInputSchema,
  resolveConflict: gitResolveConflictInputSchema,
  stashList: gitRemoteOpInputSchema,
  stashPush: gitStashPushInputSchema,
  stashDiff: gitStashTargetInputSchema,
  stashAction: gitStashActionInputSchema,
  worktreeList: gitRemoteOpInputSchema,
  worktreeAction: gitWorktreeActionInputSchema,
  submoduleList: gitRemoteOpInputSchema,
  submoduleAction: gitSubmoduleActionInputSchema,
  blame: gitBlameInputSchema,
  renameBranch: gitRenameBranchInputSchema,
  deleteBranch: gitDeleteBranchInputSchema,
  mergeBranch: gitMergeBranchInputSchema,
  rebaseBranch: gitRebaseBranchInputSchema,
  cherryPick: gitCommitActionInputSchema,
  revert: gitCommitActionInputSchema,
  reset: gitResetInputSchema,
  push: gitRemoteOpInputSchema,
  pull: gitPullInputSchema,
  publish: gitRemoteOpInputSchema,
  fetch: gitRemoteOpInputSchema,
  remotes: gitRemoteOpInputSchema,
  fetchRemote: gitFetchRemoteInputSchema,
  addRemote: gitAddRemoteInputSchema,
  removeRemote: gitRemoveRemoteInputSchema,
  pushTags: gitRemoteOpInputSchema,
  forcePush: gitRemoteOpInputSchema,
  remoteBranches: gitRemoteOpInputSchema,
  setUpstream: gitSetUpstreamInputSchema,
  amend: gitAmendInputSchema,
  log: gitLogInputSchema,
  commitDetail: gitCommitDetailInputSchema,
  revisionFileDiff: gitRevisionFileDiffInputSchema
} as const

export type GitCommandName = keyof typeof GIT_COMMAND_INPUTS
export type GitCommandInput<K extends GitCommandName> = z.infer<
  (typeof GIT_COMMAND_INPUTS)[K]
>

/** Runtime list for the preload façade; order is irrelevant. */
export const GIT_COMMAND_NAMES = Object.keys(GIT_COMMAND_INPUTS) as GitCommandName[]
