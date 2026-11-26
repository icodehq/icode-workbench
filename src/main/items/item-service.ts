import type { TaskRecord } from '../../shared/domain/task'
import type { RepoId } from '../../shared/domain/ids'
import {
  ITEM_GROUP_ORDER,
  ITEM_LIMITS,
  ITEM_STATUSES,
  itemIsStale,
  itemOpenQuestion,
  itemStatus,
  type ItemStatus,
  type TaskAttachment,
  type TaskComment,
  type TaskCommentAuthorKind,
  type TaskLink,
  type TaskLinkKind
} from '../../shared/domain/item'
import { makeAppError } from '../../shared/domain/errors'
import type { TaskStore } from '../tasks/task-store'
import type { ItemStore } from './item-store'

export type ItemView = {
  task: TaskRecord
  status: ItemStatus
  comments: TaskComment[]
  links: TaskLink[]
  attachments: TaskAttachment[]
  /** The newest unanswered owner question, if any. */
  openQuestion: TaskComment | null
  stale: boolean
}

export type ItemCounts = Record<ItemStatus, number>

export type ItemListFilter = {
  repoId?: string
  groupId?: string
  botId?: string
  includeArchived?: boolean
  limit?: number
}

export type ItemListResult = {
  items: ItemView[]
  counts: ItemCounts
}

export type ItemServiceDeps = {
  tasks: TaskStore
  items: ItemStore
  now: () => number
  newId: (prefix: string) => string
  onChange?: () => void
  /** Lets the runtime resume the bot that asked, when it belongs to a room. */
  onAnswer?: (notice: {
    task: TaskRecord
    question: TaskComment
    answer: TaskComment
  }) => void
}

export type ItemErrorCode =
  | 'ITEM_NOT_FOUND'
  | 'ITEM_INVALID_BODY'
  | 'ITEM_QUESTION_ANSWERED'
  | 'ITEM_INVALID_OPTION'
  | 'ITEM_INVALID_LINK'
  | 'ITEM_INVALID_ATTACHMENT'
  | 'ITEM_ATTACHMENT_LIMIT'

const ITEM_ERROR_TEXT: Record<ItemErrorCode, string> = {
  ITEM_NOT_FOUND: 'That item could not be found.',
  ITEM_INVALID_BODY: 'Write a comment first.',
  ITEM_QUESTION_ANSWERED: 'That question was already answered.',
  ITEM_INVALID_OPTION: 'That answer option is not valid.',
  ITEM_INVALID_LINK: 'That link is not valid.',
  ITEM_INVALID_ATTACHMENT: 'That attachment is not valid.',
  ITEM_ATTACHMENT_LIMIT: 'This item has too many attachments.'
}

export class ItemError extends Error {
  readonly appError
  constructor(readonly code: ItemErrorCode) {
    const message = ITEM_ERROR_TEXT[code]
    super(message)
    this.name = 'ItemError'
    this.appError = makeAppError('INVALID_ARGUMENT', message)
  }
}

const emptyCounts = (): ItemCounts => {
  const counts = {} as ItemCounts
  for (const status of ITEM_STATUSES) counts[status] = 0
  return counts
}

/**
 * Items are tasks plus owner-facing conversation. There is no separate item
 * row: status is derived from the task, its review, and unanswered questions.
 */
export class ItemService {
  constructor(private readonly deps: ItemServiceDeps) {}

  private requireTask(taskId: string): TaskRecord {
    const task = this.deps.tasks.findById(taskId)
    if (task === null) throw new ItemError('ITEM_NOT_FOUND')
    return task
  }

  private view(
    task: TaskRecord,
    comments: TaskComment[],
    links: TaskLink[],
    attachments: TaskAttachment[]
  ): ItemView {
    const openQuestion = itemOpenQuestion(comments)
    const status = itemStatus(task, { openQuestion: openQuestion !== null })
    return {
      task,
      status,
      comments,
      links,
      attachments,
      openQuestion,
      stale: itemIsStale(status, task.updatedAt, this.deps.now(), {
        snoozedUntil: task.snoozedUntil
      })
    }
  }

  list(filter: ItemListFilter = {}): ItemListResult {
    const tasks = this.deps.tasks
      .list({
        ...(filter.repoId === undefined ? {} : { repoId: filter.repoId as RepoId }),
        ...(filter.includeArchived === true ? { includeArchived: true } : {}),
        limit: filter.limit ?? 500
      })
      .filter(
        (task) =>
          (filter.groupId === undefined || task.groupId === filter.groupId) &&
          (filter.botId === undefined || task.botId === filter.botId)
      )
    const ids = tasks.map((task) => task.id)
    const comments = this.deps.items.listComments(ids)
    const links = this.deps.items.listLinks(ids)
    const attachments = this.deps.items.listAttachments(ids)
    const byTask = new Map<string, TaskComment[]>()
    for (const comment of comments) {
      const list = byTask.get(comment.taskId) ?? []
      list.push(comment)
      byTask.set(comment.taskId, list)
    }
    const attachmentsByTask = new Map<string, TaskAttachment[]>()
    for (const attachment of attachments) {
      const list = attachmentsByTask.get(attachment.taskId) ?? []
      list.push(attachment)
      attachmentsByTask.set(attachment.taskId, list)
    }
    const linksByTask = new Map<string, TaskLink[]>()
    for (const link of links) {
      const list = linksByTask.get(link.taskId) ?? []
      list.push(link)
      linksByTask.set(link.taskId, list)
    }
    const items = tasks.map((task) =>
      this.view(
        task,
        byTask.get(task.id) ?? [],
        linksByTask.get(task.id) ?? [],
        attachmentsByTask.get(task.id) ?? []
      )
    )
    items.sort((left, right) => {
      const order = ITEM_GROUP_ORDER.indexOf(left.status) - ITEM_GROUP_ORDER.indexOf(right.status)
      return order !== 0 ? order : right.task.updatedAt - left.task.updatedAt
    })
    const counts = emptyCounts()
    for (const item of items) counts[item.status] += 1
    return { items, counts }
  }

  get(taskId: string): ItemView | null {
    const task = this.deps.tasks.findById(taskId)
    if (task === null) return null
    return this.view(
      task,
      this.deps.items.listComments([taskId]),
      this.deps.items.listLinks([taskId]),
      this.deps.items.listAttachments([taskId])
    )
  }

  comment(input: {
    taskId: string
    body: string
    authorKind?: TaskCommentAuthorKind
    authorBotId?: string | null
    authorName?: string | null
    dedupeKey?: string | null
  }): TaskComment {
    this.requireTask(input.taskId)
    const body = input.body.trim()
    if (body.length === 0 || body.length > ITEM_LIMITS.maxBodyLength) {
      throw new ItemError('ITEM_INVALID_BODY')
    }
    if (input.dedupeKey !== undefined && input.dedupeKey !== null) {
      const existing = this.deps.items.findByDedupe(input.taskId, input.dedupeKey)
      if (existing !== null) return existing
    }
    const now = this.deps.now()
    const comment = this.deps.items.insertComment({
      id: this.deps.newId('comment'),
      taskId: input.taskId,
      authorKind: input.authorKind ?? 'owner',
      authorBotId: input.authorBotId ?? null,
      authorName: input.authorName ?? null,
      kind: 'comment',
      body,
      options: null,
      recommendedOption: null,
      replyToId: null,
      dedupeKey: input.dedupeKey ?? null,
      createdAt: now,
      updatedAt: now
    })
    this.deps.onChange?.()
    return comment
  }

  ask(input: {
    taskId: string
    body: string
    options?: readonly string[]
    recommendedOption?: string | null
    authorKind?: TaskCommentAuthorKind
    authorBotId?: string | null
    authorName?: string | null
    dedupeKey?: string | null
  }): TaskComment {
    this.requireTask(input.taskId)
    const body = input.body.trim()
    if (body.length === 0 || body.length > ITEM_LIMITS.maxBodyLength) {
      throw new ItemError('ITEM_INVALID_BODY')
    }
    const options = [
      ...new Set(
        (input.options ?? [])
          .map((option) => option.trim())
          .filter(
            (option) =>
              option.length > 0 && option.length <= ITEM_LIMITS.maxOptionLength
          )
      )
    ].slice(0, ITEM_LIMITS.maxOptions)
    const recommended =
      input.recommendedOption === undefined || input.recommendedOption === null
        ? null
        : input.recommendedOption.trim()
    if (recommended !== null && !options.includes(recommended)) {
      throw new ItemError('ITEM_INVALID_OPTION')
    }
    if (input.dedupeKey !== undefined && input.dedupeKey !== null) {
      const existing = this.deps.items.findByDedupe(input.taskId, input.dedupeKey)
      if (existing !== null) return existing
    }
    const now = this.deps.now()
    const question = this.deps.items.insertComment({
      id: this.deps.newId('question'),
      taskId: input.taskId,
      authorKind: input.authorKind ?? 'bot',
      authorBotId: input.authorBotId ?? null,
      authorName: input.authorName ?? null,
      kind: 'question',
      body,
      options: options.length === 0 ? null : options,
      recommendedOption: recommended,
      replyToId: null,
      dedupeKey: input.dedupeKey ?? null,
      createdAt: now,
      updatedAt: now
    })
    this.deps.onChange?.()
    return question
  }

  answer(input: {
    taskId: string
    questionId: string
    body: string
    authorKind?: TaskCommentAuthorKind
    authorBotId?: string | null
    authorName?: string | null
  }): { question: TaskComment; answer: TaskComment } {
    const task = this.requireTask(input.taskId)
    const question = this.deps.items.findComment(input.questionId)
    if (question === null || question.taskId !== input.taskId) {
      throw new ItemError('ITEM_NOT_FOUND')
    }
    if (question.kind !== 'question' || question.answeredAt !== null) {
      throw new ItemError('ITEM_QUESTION_ANSWERED')
    }
    const body = input.body.trim()
    if (body.length === 0 || body.length > ITEM_LIMITS.maxBodyLength) {
      throw new ItemError('ITEM_INVALID_BODY')
    }
    const now = this.deps.now()
    const answered = this.deps.items.answerQuestion(
      question.id,
      {
        id: this.deps.newId('answer'),
        taskId: input.taskId,
        authorKind: input.authorKind ?? 'owner',
        authorBotId: input.authorBotId ?? null,
        authorName: input.authorName ?? null,
        body,
        options: null,
        recommendedOption: null,
        dedupeKey: null,
        createdAt: now,
        updatedAt: now
      },
      now
    )
    if (answered === null) throw new ItemError('ITEM_QUESTION_ANSWERED')
    this.deps.onChange?.()
    this.deps.onAnswer?.({
      task,
      question: answered.question,
      answer: answered.answer
    })
    return answered
  }

  /**
   * A task worker's blocking question, raised by the harness's own
   * `AskUserQuestion` signal. One open question per item is enough; a second
   * wait for the same task is the same decision, not a new one.
   */
  askWorker(taskId: string, body: string, dedupeKey: string | null = null): TaskComment | null {
    const current = this.get(taskId)
    if (current === null || current.openQuestion !== null) return null
    return this.ask({
      taskId,
      body,
      authorKind: 'system',
      dedupeKey
    })
  }

  attach(input: {
    taskId: string
    name: string
    mime: string
    size: number
    dataUrl: string
  }): TaskAttachment {
    const task = this.requireTask(input.taskId)
    const name = input.name.trim()
    const mime = input.mime.trim()
    if (
      name.length === 0 ||
      name.length > 200 ||
      mime.length === 0 ||
      mime.length > 200 ||
      !Number.isInteger(input.size) ||
      input.size < 0 ||
      input.size > ITEM_LIMITS.maxAttachmentBytes ||
      !input.dataUrl.startsWith('data:') ||
      input.dataUrl.length > ITEM_LIMITS.maxAttachmentBytes * 2
    ) {
      throw new ItemError('ITEM_INVALID_ATTACHMENT')
    }
    if (
      this.deps.items.listAttachments([task.id]).length >=
      ITEM_LIMITS.maxAttachmentsPerTask
    ) {
      throw new ItemError('ITEM_ATTACHMENT_LIMIT')
    }
    const attachment = this.deps.items.insertAttachment({
      id: this.deps.newId('attachment'),
      taskId: task.id,
      name,
      mime,
      size: input.size,
      dataUrl: input.dataUrl,
      createdAt: this.deps.now()
    })
    this.deps.onChange?.()
    return attachment
  }

  removeAttachment(taskId: string, id: string): boolean {
    this.requireTask(taskId)
    const removed = this.deps.items.removeAttachment(taskId, id)
    if (removed) this.deps.onChange?.()
    return removed
  }

  setStatus(taskId: string, status: ItemStatus | null): ItemView {
    this.requireTask(taskId)
    this.deps.tasks.update(taskId, { itemStatusOverride: status }, this.deps.now())
    this.deps.onChange?.()
    return this.get(taskId)!
  }

  snooze(taskId: string, until: number | null): TaskRecord {
    this.requireTask(taskId)
    if (until !== null && until <= this.deps.now()) {
      throw new ItemError('ITEM_INVALID_OPTION')
    }
    this.deps.items.setSnoozedUntil(taskId, until)
    this.deps.onChange?.()
    return this.requireTask(taskId)
  }

  linkAdd(input: { taskId: string; kind: TaskLinkKind; ref: string }): TaskLink {
    this.requireTask(input.taskId)
    const ref = input.ref.trim()
    if (ref.length === 0 || ref.length > ITEM_LIMITS.maxRefLength) {
      throw new ItemError('ITEM_INVALID_LINK')
    }
    const link = this.deps.items.addLink(input.taskId, input.kind, ref, this.deps.now())
    this.deps.onChange?.()
    return link
  }

  linkRemove(input: { taskId: string; kind: TaskLinkKind; ref: string }): boolean {
    this.requireTask(input.taskId)
    const removed = this.deps.items.removeLink(input.taskId, input.kind, input.ref.trim())
    if (removed) this.deps.onChange?.()
    return removed
  }
}
