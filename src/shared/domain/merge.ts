import type { AppError } from './errors'

export const MERGE_STATES = [
  'running',
  'conflicted',
  'merged',
  'failed',
  'aborted',
  'interrupted'
] as const
export type MergeState = (typeof MERGE_STATES)[number]

/** An active record blocks another merge for the same session or target. */
export const ACTIVE_MERGE_STATES = ['running', 'conflicted'] as const

export type MergeOutcome =
  | { status: 'merged'; record: MergeRecord }
  | { status: 'conflicted'; record: MergeRecord }

export type MergeRecord = {
  id: string
  repoId: string
  sessionId: string
  taskId: string | null
  sourceBranch: string
  targetBranch: string
  sourceOidBefore: string
  targetOidBefore: string
  targetOidAfter: string | null
  resultOid: string | null
  reviewBaseOid: string | null
  state: MergeState
  commitOid: string | null
  conflictFiles: string[]
  error: AppError | null
  pushRemote: string | null
  pushedAt: number | null
  pushError: AppError | null
  createdAt: number
  updatedAt: number
  finishedAt: number | null
}
