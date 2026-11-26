import { useCallback, useEffect, useState } from 'react'
import { Pencil, Trash2, Undo2 } from 'lucide-react'
import type { BotSummaryPayload } from '../../../../shared/schemas/bots'
import type {
  MemoryFactPayload,
  MemoryHistoryRowPayload,
  MemoryReadResultPayload
} from '../../../../shared/schemas/memory'
import type { IpcResult } from '../../../../shared/schemas/ipc'
import type { Notice } from '../../state/workspace'
import { callApi, errorNotice } from '../../lib/api'
import { useT } from '../../i18n/use-i18n'

type Tab = 'facts' | 'history'

function historyAuthor(
  row: MemoryHistoryRowPayload,
  t: ReturnType<typeof useT>
): string {
  if (row.by.kind === 'owner') return t('memory.history.byOwner')
  if (row.by.kind === 'undo') return t('memory.history.undo')
  if (row.by.kind === 'tidy-up') return t('memory.history.byTidyUp')
  return t('memory.history.byBot', { name: row.by.name })
}

function changeText(row: MemoryHistoryRowPayload, t: ReturnType<typeof useT>): string {
  const added = row.change.added.length
  const removed = row.change.removed.length
  if (added > 0 && removed > 0) {
    return `${t('memory.history.added')} ${added} · ${t('memory.history.removed')} ${removed}`
  }
  if (added > 0) return `${t('memory.history.added')} ${added}`
  return `${t('memory.history.removed')} ${removed}`
}

function changeLines(row: MemoryHistoryRowPayload): string[] {
  return [
    ...row.change.added.map((line) => `+ ${line.line.trim()}`),
    ...row.change.removed.map((line) => `- ${line.line.trim()}`)
  ].slice(0, 6)
}

/**
 * A bot's memory in Settings: the facts in its MEMORY.md, and every change to
 * them with Undo. The file is the source of truth; there is no approval step.
 */
export default function BotMemoryPane({
  bot,
  notify
}: {
  bot: BotSummaryPayload
  notify: (notice: Notice) => void
}): React.JSX.Element {
  const t = useT()
  const [tab, setTab] = useState<Tab>('facts')
  const [read, setRead] = useState<MemoryReadResultPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<{ fact: MemoryFactPayload; text: string } | null>(null)
  const [openTopic, setOpenTopic] = useState<{ name: string; text: string } | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const result = await callApi<MemoryReadResultPayload>(
      window.icode.bots.memory.read({ botId: bot.id })
    )
    if (!result.ok) {
      notify(errorNotice(result.error))
      setLoading(false)
      return
    }
    setRead(result.value)
    setLoading(false)
  }, [bot.id, notify])

  useEffect(() => {
    void load()
  }, [load])

  const apply = async (request: Promise<IpcResult<MemoryReadResultPayload>>): Promise<void> => {
    if (busy) return
    setBusy(true)
    const result = await request
    setBusy(false)
    if (!result.ok) {
      notify(errorNotice(result.error))
      return
    }
    setRead(result.value)
  }

  const add = async (): Promise<void> => {
    const text = draft.trim()
    if (text.length === 0) return
    await apply(window.icode.bots.memory.add({ botId: bot.id, text }))
    setDraft('')
  }

  const saveEdit = async (): Promise<void> => {
    if (editing === null) return
    await apply(
      window.icode.bots.memory.edit({
        botId: bot.id,
        fact: editing.fact,
        text: editing.text.trim()
      })
    )
    setEditing(null)
  }

  const forget = async (fact: MemoryFactPayload): Promise<void> => {
    await apply(window.icode.bots.memory.forget({ botId: bot.id, fact }))
  }

  const undo = async (rowId: string): Promise<void> => {
    await apply(window.icode.bots.memory.undo({ botId: bot.id, rowId }))
  }

  const tidyUp = async (): Promise<void> => {
    await apply(window.icode.bots.memory.tidyUp({ botId: bot.id }))
  }

  const openHome = async (): Promise<void> => {
    const result = await callApi(window.icode.bots.home({ botId: bot.id }))
    if (!result.ok) {
      notify(errorNotice(result.error))
      return
    }
    if (!result.value.opened) {
      notify({ tone: 'error', message: t('memory.openFolderFailed') })
    }
  }

  const toggleTopic = async (name: string): Promise<void> => {
    if (openTopic?.name === name) {
      setOpenTopic(null)
      return
    }
    const result = await callApi(
      window.icode.bots.memory.topic({ botId: bot.id, name })
    )
    if (!result.ok) {
      notify(errorNotice(result.error))
      return
    }
    setOpenTopic(result.value)
  }

  const facts = read?.facts ?? []
  const history = read?.history ?? []
  const undone = new Set(
    history.flatMap((row) => (row.by.kind === 'undo' ? [row.by.of] : []))
  )

  return (
    <div className="space-y-2" data-testid="bot-memory-pane">
      <div className="flex items-center gap-1 border-b border-border">
        {(
          [
            ['facts', t('memory.tabs.facts')],
            ['history', t('memory.tabs.history')]
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`-mb-px border-b-2 px-2 py-1 text-[10px] ${
              tab === id
                ? 'border-accent text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setTab(id)}
            data-testid={`memory-tab-${id}`}
          >
            {label}
            {id === 'facts' && facts.length > 0 ? (
              <span className="ml-1 rounded-full bg-foreground/[0.08] px-1.5 py-px text-[8.5px] tabular-nums text-muted-foreground">
                {facts.length}
              </span>
            ) : null}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className="inline-flex h-5 items-center rounded border border-border px-1.5 text-[9px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
            onClick={() => void tidyUp()}
            disabled={busy}
            data-testid="memory-tidy-up"
          >
            {t('memory.tidyUp')}
          </button>
          <button
            type="button"
            className="inline-flex h-5 items-center rounded border border-border px-1.5 text-[9px] text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => void openHome()}
            data-testid="memory-open-folder"
          >
            {t('memory.openFolder')}
          </button>
        </div>
      </div>

      {loading ? (
        <p className="px-1 text-[11px] text-muted-foreground">{t('memory.loading')}</p>
      ) : tab === 'facts' ? (
        <>
          {facts.length === 0 ? (
            <p className="px-1 text-[10.5px] leading-relaxed text-muted-foreground">
              {t('memory.empty')}
            </p>
          ) : (
            <div className="space-y-1" data-testid="memory-facts">
              {facts.map((fact) => (
                <div
                  key={`${fact.line}:${fact.text}`}
                  className="group rounded-md border border-border bg-card/60 px-2 py-1.5"
                  data-testid={`memory-fact-${fact.line}`}
                >
                  {editing?.fact.line === fact.line ? (
                    <div className="space-y-1">
                      <textarea
                        className="h-12 w-full resize-none rounded border border-border bg-background px-1.5 py-1 text-[10.5px] text-foreground outline-none focus:border-line-strong"
                        value={editing.text}
                        onChange={(event) =>
                          setEditing({ fact: editing.fact, text: event.target.value })
                        }
                        maxLength={2_000}
                        data-testid="memory-edit-input"
                      />
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          className="inline-flex h-5 items-center rounded bg-accent px-2 text-[9px] font-medium text-accent-ink disabled:opacity-40"
                          onClick={() => void saveEdit()}
                          disabled={busy || editing.text.trim().length === 0}
                          data-testid="memory-edit-save"
                        >
                          {t('memory.save')}
                        </button>
                        <button
                          type="button"
                          className="inline-flex h-5 items-center rounded border border-border px-2 text-[9px] text-muted-foreground hover:text-foreground"
                          onClick={() => setEditing(null)}
                        >
                          {t('common.cancel')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start gap-1.5">
                      <div className="min-w-0 flex-1">
                        <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-foreground">
                          {fact.text}
                        </p>
                        {fact.date !== null || fact.source !== null ? (
                          <p className="mt-0.5 text-[9px] text-muted-foreground">
                            {[fact.date, fact.source].filter((part) => part !== null).join(' · ')}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
                        <button
                          type="button"
                          className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                          onClick={() => setEditing({ fact, text: fact.text })}
                          title={t('memory.edit')}
                          aria-label={t('memory.edit')}
                          data-testid={`memory-edit-${fact.line}`}
                        >
                          <Pencil size={10} />
                        </button>
                        <button
                          type="button"
                          className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive"
                          onClick={() => void forget(fact)}
                          title={t('memory.forget')}
                          aria-label={t('memory.forget')}
                          data-testid={`memory-forget-${fact.line}`}
                        >
                          <Trash2 size={10} />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {(read?.topics.length ?? 0) > 0 ? (
            <div className="rounded-md border border-border bg-muted/20 px-2 py-1.5">
              <div className="text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {t('memory.topics')}
              </div>
              <ul className="mt-1 space-y-0.5">
                {read!.topics.map((topic) => (
                  <li key={topic.name}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between rounded px-0.5 text-left text-[10px] hover:bg-muted"
                      onClick={() => void toggleTopic(topic.name)}
                      data-testid={`memory-topic-${topic.name}`}
                    >
                      <span className="truncate text-foreground">{topic.name}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {t('memory.topicLines', { count: String(topic.lines) })}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {openTopic !== null ? (
                <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded border border-border bg-background p-1.5 text-[9.5px] leading-relaxed text-muted-foreground">
                  {openTopic.text}
                </pre>
              ) : null}
            </div>
          ) : null}

          {read !== null && read.omitted > 0 ? (
            <p className="px-1 text-[9.5px] text-muted-foreground">
              {t('memory.omitted', { count: String(read.omitted) })}
            </p>
          ) : null}

          <div className="space-y-1 rounded-md border border-border bg-card/60 p-2">
            <textarea
              className="h-12 w-full resize-none rounded border border-border bg-background px-1.5 py-1 text-[10.5px] text-foreground outline-none placeholder:text-muted-foreground focus:border-line-strong"
              placeholder={t('memory.addPlaceholder')}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={2_000}
              data-testid="memory-value"
            />
            <button
              type="button"
              className="inline-flex h-5 items-center rounded bg-accent px-2 text-[9.5px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
              onClick={() => void add()}
              disabled={busy || draft.trim().length === 0}
              data-testid="memory-add"
            >
              {busy ? t('memory.saving') : t('memory.add')}
            </button>
          </div>
        </>
      ) : history.length === 0 ? (
        <p className="px-1 text-[10.5px] text-muted-foreground">{t('memory.history.empty')}</p>
      ) : (
        <div className="space-y-1" data-testid="memory-history">
          {history.map((row) => {
            const isUndone = undone.has(row.id)
            return (
              <div
                key={row.id}
                className="rounded-md border border-border bg-card/60 px-2 py-1.5"
                data-testid={`memory-history-${row.id}`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-medium text-foreground">
                    {historyAuthor(row, t)}
                  </span>
                  <span className="truncate text-[9px] text-muted-foreground">
                    {new Date(row.at).toLocaleString()}
                  </span>
                  <span className="ml-auto shrink-0 text-[9px] text-muted-foreground">
                    {changeText(row, t)}
                  </span>
                  {row.by.kind !== 'undo' && !isUndone && row.undoable ? (
                    <button
                      type="button"
                      className="inline-flex h-5 shrink-0 items-center gap-0.5 rounded border border-border px-1.5 text-[9px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                      onClick={() => void undo(row.id)}
                      disabled={busy}
                      data-testid={`memory-undo-${row.id}`}
                    >
                      <Undo2 size={9} /> {t('memory.history.undo')}
                    </button>
                  ) : isUndone ? (
                    <span className="shrink-0 text-[9px] text-muted-foreground">
                      {t('memory.history.undone')}
                    </span>
                  ) : null}
                </div>
                {changeLines(row).length > 0 ? (
                  <pre className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-[9.5px] leading-relaxed text-muted-foreground">
                    {changeLines(row).join('\n')}
                  </pre>
                ) : null}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
