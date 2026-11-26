import { useRef, useState } from 'react'
import { ArrowUpRight, Link2, MessageSquare, Paperclip, Trash2, X } from 'lucide-react'
import type { ItemPayload, TaskCommentPayload } from '../../../../shared/schemas/items'
import type { MessageKey } from '../../../../shared/i18n'
import type { ItemStatus } from '../../../../shared/domain/item'
import type { ItemsState } from '../../state/use-items'
import type { Notice } from '../../state/workspace'
import { useT } from '../../i18n/use-i18n'
import { itemStatusTone } from './item-status'

function authorLabel(
  comment: TaskCommentPayload,
  t: ReturnType<typeof useT>
): string {
  if (comment.authorKind === 'owner') return t('bots.you')
  if (comment.authorKind === 'system') return t('bots.system')
  return comment.authorName ?? t('bots.fallback')
}

/** One item's conversation: comments, a blocking question, and evidence links. */
export default function ItemDetailDialog({
  item,
  state,
  onOpenTask,
  onTaskAction,
  notify,
  onClose
}: {
  item: ItemPayload
  state: ItemsState
  onOpenTask: (taskId: string) => void
  onTaskAction?: (action: 'approve' | 'reject', taskId: string) => void
  notify: (notice: Notice) => void
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const [comment, setComment] = useState('')
  const [answer, setAnswer] = useState('')
  const [link, setLink] = useState('')
  const [linkKind, setLinkKind] = useState<'url' | 'file' | 'pr' | 'worker'>('url')
  const attachmentInput = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)
  const question = item.openQuestion

  const postComment = async (): Promise<void> => {
    const body = comment.trim()
    if (body.length === 0 || busy) return
    setBusy(true)
    const ok = await state.comment(item.task.id, body)
    setBusy(false)
    if (ok) setComment('')
  }

  const postAnswer = async (): Promise<void> => {
    const body = answer.trim()
    if (body.length === 0 || question === null || busy) return
    setBusy(true)
    const ok = await state.answer(item.task.id, question.id, body)
    setBusy(false)
    if (ok) setAnswer('')
  }

  const addAttachment = (file: File | undefined): void => {
    if (file === undefined) return
    if (file.size > 2_000_000) {
      notify({ tone: 'error', message: t('items.attachmentTooLarge') })
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string') return
      void state.attach({
        taskId: item.task.id,
        name: file.name,
        mime: file.type || 'application/octet-stream',
        size: file.size,
        dataUrl: reader.result
      })
    }
    reader.onerror = () => notify({ tone: 'error', message: t('items.attachmentRead') })
    reader.readAsDataURL(file)
  }

  const addLink = async (): Promise<void> => {
    const ref = link.trim()
    if (ref.length === 0 || busy) return
    setBusy(true)
    const added = await state.linkAdd({ taskId: item.task.id, kind: linkKind, ref })
    setBusy(false)
    if (added !== null) setLink('')
  }

  const snoozed =
    item.task.snoozedUntil !== null && item.task.snoozedUntil !== undefined
  const canOpenLink = (ref: string): boolean => /^https?:\/\//i.test(ref)

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      data-testid="item-detail-dialog"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="icode-modal flex max-h-[86vh] w-full max-w-2xl flex-col rounded-lg border border-border bg-card shadow-2xl">
        <div className="flex shrink-0 items-start gap-2 border-b border-border px-4 py-3">
          <MessageSquare size={15} className="mt-0.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <h2 className="min-w-0 truncate text-[14px] font-semibold">{item.task.title}</h2>
              <span className={`rounded px-1.5 py-0.5 text-[9px] font-medium ${itemStatusTone(item.status)}`}>
                {t(`item.status.${item.status}` as MessageKey)}
              </span>
              {item.stale ? (
                <span className="rounded bg-signal-weak px-1.5 py-0.5 text-[9px] text-signal">
                  {t('items.stale')}
                </span>
              ) : null}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className="truncate">{item.task.repoId} · {item.task.status}</span>
              <select
                className="h-5 rounded border border-border bg-background px-1 text-[9.5px] text-foreground"
                value={item.task.itemStatusOverride ?? 'auto'}
                onChange={(event) =>
                  void state.setStatus(
                    item.task.id,
                    event.target.value === 'auto'
                      ? null
                      : (event.target.value as ItemStatus)
                  )
                }
                data-testid="item-status-select"
                aria-label={t('items.statusOverride')}
              >
                <option value="auto">{t('items.statusAuto')}</option>
                {(['planned', 'working', 'waiting', 'needs_you', 'done', 'canceled'] as const).map(
                  (status) => (
                    <option key={status} value={status}>
                      {t(`item.status.${status}` as MessageKey)}
                    </option>
                  )
                )}
              </select>
            </div>
          </div>
          {onTaskAction !== undefined && item.task.canApprove === true ? (
            <>
              <button
                type="button"
                className="inline-flex h-6 items-center rounded bg-accent px-2 text-[10px] font-medium text-accent-ink hover:opacity-90"
                onClick={() => onTaskAction('approve', item.task.id)}
                data-testid="item-approve-task"
              >
                {t('assistant.card.approve')}
              </button>
              <button
                type="button"
                className="inline-flex h-6 items-center rounded border border-border px-2 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => onTaskAction('reject', item.task.id)}
                data-testid="item-reject-task"
              >
                {t('assistant.card.reject')}
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="inline-flex h-6 items-center gap-1 rounded border border-border px-2 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => onOpenTask(item.task.id)}
            data-testid="item-open-task"
          >
            <ArrowUpRight size={10} /> {t('items.openTask')}
          </button>
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <X size={12} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {question !== null ? (
            <div className="rounded-md border border-signal/40 bg-signal-weak/30 p-3" data-testid="item-question">
              <div className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-signal">
                {t('items.question')}
                <span className="normal-case tracking-normal text-muted-foreground">
                  {authorLabel(question, t)}
                </span>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-foreground">
                {question.body}
              </p>
              {question.options !== null ? (
                <div className="mt-2 space-y-1">
                  <p className="text-[9px] uppercase tracking-wide text-muted-foreground">
                    {t('items.options')}
                  </p>
                  {question.options.map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={`flex w-full items-center gap-1.5 rounded border px-2 py-1 text-left text-[11px] ${
                        answer === option
                          ? 'border-accent bg-accent/10 text-foreground'
                          : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'
                      }`}
                      onClick={() => setAnswer(option)}
                    >
                      <span className="min-w-0 flex-1">{option}</span>
                      {question.recommendedOption === option ? (
                        <span className="shrink-0 text-[8.5px] text-signal">
                          {t('items.recommended')}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="mt-2 flex items-end gap-1.5">
                <textarea
                  className="max-h-24 min-h-[34px] flex-1 resize-none rounded border border-border bg-background px-2 py-1.5 text-[11.5px] outline-none focus:border-line-strong"
                  value={answer}
                  onChange={(event) => setAnswer(event.target.value)}
                  placeholder={t('items.answerPlaceholder')}
                  data-testid="item-answer-input"
                />
                <button
                  type="button"
                  className="inline-flex h-7 shrink-0 items-center rounded bg-accent px-2.5 text-[10.5px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
                  onClick={() => void postAnswer()}
                  disabled={busy || answer.trim().length === 0}
                  data-testid="item-answer-submit"
                >
                  {t('items.answer')}
                </button>
              </div>
            </div>
          ) : null}

          <div className="rounded-md border border-border bg-muted/20 p-3" data-testid="item-attachments">
            <div className="flex items-center gap-1.5">
              <div className="text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {t('items.attachments')}
              </div>
              <button
                type="button"
                className="ml-auto inline-flex h-5 items-center gap-1 rounded border border-border px-1.5 text-[9.5px] hover:bg-muted"
                onClick={() => attachmentInput.current?.click()}
                data-testid="item-attach"
              >
                <Paperclip size={9} /> {t('items.attach')}
              </button>
              <input
                ref={attachmentInput}
                type="file"
                className="hidden"
                onChange={(event) => {
                  addAttachment(event.target.files?.[0])
                  event.target.value = ''
                }}
                data-testid="item-attachment-input"
              />
            </div>
            {item.attachments.length === 0 ? (
              <p className="mt-1 text-[10px] text-muted-foreground">{t('items.empty')}</p>
            ) : (
              <div className="mt-2 grid grid-cols-2 gap-2">
                {item.attachments.map((attachment) => (
                  <div
                    key={attachment.id}
                    className="min-w-0 rounded border border-border bg-background p-1.5"
                  >
                    {attachment.mime.startsWith('image/') ? (
                      <img
                        src={attachment.dataUrl}
                        alt={attachment.name}
                        className="h-20 w-full rounded object-cover"
                      />
                    ) : (
                      <a
                        href={attachment.dataUrl}
                        download={attachment.name}
                        className="block truncate text-[10px] text-accent hover:underline"
                      >
                        {attachment.name}
                      </a>
                    )}
                    <div className="mt-1 flex items-center gap-1">
                      <span className="min-w-0 flex-1 truncate text-[9px] text-muted-foreground">
                        {attachment.name}
                      </span>
                      <button
                        type="button"
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={() => void state.removeAttachment(item.task.id, attachment.id)}
                        aria-label={t('items.attachmentRemove')}
                        data-testid={`item-attachment-remove-${attachment.id}`}
                      >
                        <Trash2 size={9} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-md border border-border bg-muted/20 p-3" data-testid="item-worker-report">
            <div className="text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {t('items.workerReport')}
            </div>
            <p className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-foreground">
              {item.task.resultSummary ??
                item.task.errorDetail ??
                item.task.error ??
                t('items.workerReportEmpty')}
            </p>
            <p className="mt-1 text-[9.5px] text-muted-foreground">
              {t('items.workerReportMeta', {
                attempt: item.task.attempt,
                state: item.task.lastObservedState ?? item.task.status
              })}
            </p>
          </div>

          <div>
            <div className="mb-1 text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {t('items.conversation')}
            </div>
            {item.comments.length === 0 ? (
              <p className="py-2 text-[10.5px] text-muted-foreground">{t('items.empty')}</p>
            ) : (
              <div className="space-y-1.5">
                {item.comments.map((entry) => (
                  <div
                    key={entry.id}
                    className={`rounded-md border px-2.5 py-2 ${
                      entry.kind === 'question'
                        ? 'border-signal/40 bg-signal-weak/20'
                        : entry.kind === 'answer'
                          ? 'border-add/30 bg-add-weak/20'
                          : 'border-border bg-card'
                    }`}
                    data-testid={`item-comment-${entry.id}`}
                  >
                    <div className="flex items-center gap-1.5 text-[9px] text-muted-foreground">
                      <span className="font-medium text-foreground/80">
                        {authorLabel(entry, t)}
                      </span>
                      <span>{entry.kind}</span>
                      {entry.kind === 'question' && entry.answeredAt !== null ? (
                        <span className="text-add">· {t('items.answered')}</span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 whitespace-pre-wrap text-[11.5px] leading-relaxed text-foreground">
                      {entry.body}
                    </p>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-2 flex items-end gap-1.5">
              <textarea
                className="max-h-24 min-h-[34px] flex-1 resize-none rounded border border-border bg-background px-2 py-1.5 text-[11.5px] outline-none focus:border-line-strong"
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder={t('items.commentPlaceholder')}
                data-testid="item-comment-input"
              />
              <button
                type="button"
                className="inline-flex h-7 shrink-0 items-center rounded border border-border px-2.5 text-[10.5px] text-foreground hover:bg-muted disabled:opacity-40"
                onClick={() => void postComment()}
                disabled={busy || comment.trim().length === 0}
                data-testid="item-comment-submit"
              >
                {t('items.comment')}
              </button>
            </div>
          </div>

          <div>
            <div className="mb-1 flex items-center gap-1 text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              <Link2 size={10} /> {t('items.links')}
            </div>
            {item.links.length === 0 ? (
              <p className="py-1 text-[10.5px] text-muted-foreground">{t('items.empty')}</p>
            ) : (
              <div className="space-y-1">
                {item.links.map((entry) => (
                  <div
                    key={`${entry.kind}:${entry.ref}`}
                    className="flex items-center gap-1.5 rounded border border-border bg-card px-2 py-1 text-[10.5px]"
                  >
                    <span className="shrink-0 rounded bg-muted px-1 text-[8.5px] uppercase text-muted-foreground">
                      {entry.kind}
                    </span>
                    {canOpenLink(entry.ref) ? (
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left text-accent hover:underline"
                        onClick={() => {
                          void window.icode.window.openExternal({ url: entry.ref })
                        }}
                      >
                        {entry.ref}
                      </button>
                    ) : (
                      <span className="min-w-0 flex-1 truncate">{entry.ref}</span>
                    )}
                    <button
                      type="button"
                      className="shrink-0 text-[9px] text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        void state.linkRemove({
                          taskId: item.task.id,
                          kind: entry.kind,
                          ref: entry.ref
                        })
                      }}
                    >
                      {t('items.linkRemove')}
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-1 flex items-center gap-1">
              <select
                className="h-6 rounded border border-border bg-background px-1 text-[10px]"
                value={linkKind}
                onChange={(event) => {
                  setLinkKind(event.target.value as typeof linkKind)
                }}
                data-testid="item-link-kind"
              >
                <option value="url">url</option>
                <option value="file">file</option>
                <option value="pr">pr</option>
              </select>
              <input
                className="h-6 min-w-0 flex-1 rounded border border-border bg-background px-1.5 text-[10.5px] outline-none focus:border-line-strong"
                value={link}
                onChange={(event) => setLink(event.target.value)}
                placeholder={t('items.linkPlaceholder')}
                data-testid="item-link-input"
              />
              <button
                type="button"
                className="inline-flex h-6 shrink-0 items-center rounded border border-border px-2 text-[10px] hover:bg-muted disabled:opacity-40"
                onClick={() => void addLink()}
                disabled={busy || link.trim().length === 0}
                data-testid="item-link-add"
              >
                {t('items.linkAdd')}
              </button>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-4 py-2">
          <button
            type="button"
            className="inline-flex h-6 items-center rounded px-1.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => {
              void state.snooze(
                item.task.id,
                snoozed ? null : Date.now() + 24 * 60 * 60 * 1000
              )
            }}
            data-testid="item-snooze"
          >
            {snoozed ? t('items.unsnooze') : t('items.snooze')}
          </button>
          <button
            type="button"
            className="h-7 rounded border border-border px-3 text-[10.5px] hover:bg-muted"
            onClick={onClose}
          >
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
