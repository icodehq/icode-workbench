/**
 * Items are a projection over tasks; the task stays the only stored work object.
 *
 * The status is derived so work state cannot drift from the task queue, review
 * decision, and open owner questions.
 */
export const ITEM_STATUSES = [
  'planned',
  'working',
  'waiting',
  'needs_you',
  'done',
  'canceled'
] as const

export type ItemStatus = (typeof ITEM_STATUSES)[number]

export const ITEM_LIMITS = {
  maxBodyLength: 4_000,
  maxOptions: 6,
  maxOptionLength: 200,
  maxRefLength: 2_048,
  maxLinksPerTask: 50,
  maxAttachmentsPerTask: 20,
  maxAttachmentBytes: 2_000_000
} as const

export const TASK_COMMENT_KINDS = ['comment', 'question', 'status', 'answer'] as const
export type TaskCommentKind = (typeof TASK_COMMENT_KINDS)[number]

export const TASK_COMMENT_AUTHOR_KINDS = ['owner', 'bot', 'system'] as const
export type TaskCommentAuthorKind = (typeof TASK_COMMENT_AUTHOR_KINDS)[number]

export type TaskComment = {
  id: string
  taskId: string
  authorKind: TaskCommentAuthorKind
  authorBotId: string | null
  authorName: string | null
  kind: TaskCommentKind
  body: string
  options: string[] | null
  recommendedOption: string | null
  replyToId: string | null
  answeredAt: number | null
  dedupeKey: string | null
  createdAt: number
  updatedAt: number
}

export const TASK_LINK_KINDS = ['url', 'file', 'pr', 'worker'] as const
export type TaskLinkKind = (typeof TASK_LINK_KINDS)[number]

export type TaskAttachment = {
  id: string
  taskId: string
  name: string
  mime: string
  size: number
  dataUrl: string
  createdAt: number
}

export type TaskLink = {
  taskId: string
  kind: TaskLinkKind
  ref: string
  addedAt: number
}

/** The order the Items panel lists groups in. */
export const ITEM_GROUP_ORDER: readonly ItemStatus[] = [
  'needs_you',
  'working',
  'waiting',
  'planned',
  'done',
  'canceled'
]

export type ItemTaskFacts = {
  status: 'queued' | 'dispatching' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'
  approval?: 'approved' | 'pending' | 'rejected'
  reviewDecision?: 'pending' | 'accepted' | 'rejected'
  changesRequestedAt?: number | null
  itemStatusOverride?: ItemStatus | null
}

export function itemStatus(
  task: ItemTaskFacts,
  options: { openQuestion?: boolean } = {}
): ItemStatus {
  if (task.itemStatusOverride) return task.itemStatusOverride
  if (task.status === 'cancelled' || task.reviewDecision === 'rejected') return 'canceled'
  if (task.status === 'failed') return 'needs_you'
  if (task.status === 'completed') {
    return task.reviewDecision === 'accepted' ? 'done' : 'needs_you'
  }
  // An owner question keeps the item in Needs you while work continues.
  if (options.openQuestion === true) return 'needs_you'
  if (task.status === 'waiting') return 'waiting'
  if (task.status === 'queued') return task.approval === 'pending' ? 'needs_you' : 'planned'
  return 'working'
}

export function itemIsOpen(status: ItemStatus): boolean {
  return status === 'planned' || status === 'working' || status === 'waiting' || status === 'needs_you'
}

/** The newest unanswered owner question, if any. */
export function itemOpenQuestion<
  T extends { kind: TaskCommentKind; answeredAt: number | null }
>(comments: readonly T[]): T | null {
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const comment = comments[index]
    if (comment !== undefined && comment.kind === 'question' && comment.answeredAt === null) {
      return comment
    }
  }
  return null
}

const DAY_MS = 24 * 60 * 60 * 1000

/** An open item that has not moved for a while; snoozing suppresses it. */
export function itemIsStale(
  status: ItemStatus,
  updatedAt: number,
  now: number,
  options: { snoozedUntil?: number | null; staleDays?: number } = {}
): boolean {
  if (!itemIsOpen(status)) return false
  if (itemIsSnoozed(options.snoozedUntil, now)) return false
  const days = options.staleDays ?? 7
  return now - updatedAt > days * DAY_MS
}

export function itemIsSnoozed(
  snoozedUntil: number | null | undefined,
  now: number
): boolean {
  return snoozedUntil !== null && snoozedUntil !== undefined && snoozedUntil > now
}
