import { useCallback, useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type {
  BotAutomationPayload,
  BotSummaryPayload
} from '../../../../shared/schemas/bots'
import type { Notice } from '../../state/workspace'
import { callApi, errorNotice } from '../../lib/api'
import { useT } from '../../i18n/use-i18n'

/** Recurring prompts a bot runs in its home chat, with a simple interval. */
export default function BotAutomationsPane({
  bot,
  notify
}: {
  bot: BotSummaryPayload
  notify: (notice: Notice) => void
}): React.JSX.Element {
  const t = useT()
  const [automations, setAutomations] = useState<BotAutomationPayload[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [interval, setIntervalMinutes] = useState('60')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const result = await callApi(window.icode.bots.automations.list({ botId: bot.id }))
    if (!result.ok) {
      notify(errorNotice(result.error))
      setLoading(false)
      return
    }
    setAutomations(result.value)
    setLoading(false)
  }, [bot.id, notify])

  useEffect(() => {
    void load()
  }, [load])

  const create = async (): Promise<void> => {
    const minutes = Number(interval)
    if (busy || name.trim().length === 0 || prompt.trim().length === 0) return
    setBusy(true)
    const result = await callApi(
      window.icode.bots.automations.create({
        botId: bot.id,
        name: name.trim(),
        prompt: prompt.trim(),
        intervalMinutes: Number.isFinite(minutes) ? Math.round(minutes) : 0
      })
    )
    setBusy(false)
    if (!result.ok) {
      notify(errorNotice(result.error))
      return
    }
    setName('')
    setPrompt('')
    setCreating(false)
    await load()
  }

  const toggle = async (automation: BotAutomationPayload): Promise<void> => {
    const result = await callApi(
      window.icode.bots.automations.update({
        id: automation.id,
        enabled: !automation.enabled
      })
    )
    if (!result.ok) {
      notify(errorNotice(result.error))
      return
    }
    await load()
  }

  const remove = async (automation: BotAutomationPayload): Promise<void> => {
    if (!window.confirm(t('automations.confirmDelete'))) return
    const result = await callApi(
      window.icode.bots.automations.remove({ id: automation.id })
    )
    if (!result.ok) {
      notify(errorNotice(result.error))
      return
    }
    await load()
  }

  return (
    <div className="space-y-2" data-testid="bot-automations-pane">
      <button
        type="button"
        className="inline-flex h-6 items-center gap-1 rounded border border-border px-2 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={() => setCreating((value) => !value)}
        data-testid="automations-new"
      >
        <Plus size={10} /> {t('automations.new')}
      </button>

      {loading ? (
        <p className="px-1 text-[11px] text-muted-foreground">{t('memory.loading')}</p>
      ) : automations.length === 0 && !creating ? (
        <p className="px-1 text-[10.5px] leading-relaxed text-muted-foreground">
          {t('automations.empty')}
        </p>
      ) : (
        <div className="space-y-1" data-testid="automations-list">
          {automations.map((automation) => (
            <div
              key={automation.id}
              className="rounded-md border border-border bg-card/60 px-2 py-1.5"
              data-testid={`automation-row-${automation.id}`}
            >
              <div className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-[10.5px] text-foreground">
                  {automation.name}
                </span>
                <span className="shrink-0 text-[9px] text-muted-foreground">
                  {t('automations.every')} {automation.intervalMinutes}{' '}
                  {t('automations.minutesShort')}
                </span>
                <label className="inline-flex shrink-0 items-center gap-0.5 text-[9px] text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={automation.enabled}
                    onChange={() => void toggle(automation)}
                    data-testid={`automation-enabled-${automation.id}`}
                  />
                  {t('automations.enabled')}
                </label>
                <button
                  type="button"
                  className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive"
                  onClick={() => void remove(automation)}
                  title={t('automations.delete')}
                  aria-label={t('automations.delete')}
                  data-testid={`automation-delete-${automation.id}`}
                >
                  <Trash2 size={10} />
                </button>
              </div>
              <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-[9.5px] text-muted-foreground">
                {automation.prompt}
              </p>
            </div>
          ))}
        </div>
      )}

      {creating ? (
        <div className="space-y-1 rounded-md border border-border bg-card/60 p-2">
          <input
            className="h-6 w-full rounded border border-border bg-background px-1.5 text-[10px] text-foreground outline-none placeholder:text-muted-foreground focus:border-line-strong"
            placeholder={t('automations.namePlaceholder')}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            data-testid="automation-name"
          />
          <textarea
            className="h-20 w-full resize-y rounded border border-border bg-background px-1.5 py-1 text-[10px] text-foreground outline-none placeholder:text-muted-foreground focus:border-line-strong"
            placeholder={t('automations.promptPlaceholder')}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            maxLength={4_000}
            data-testid="automation-prompt"
          />
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] text-muted-foreground">
              {t('automations.every')}
            </span>
            <input
              type="number"
              min={1}
              max={10_080}
              className="h-6 w-20 rounded border border-border bg-background px-1.5 text-[10px] text-foreground outline-none"
              value={interval}
              onChange={(event) => setIntervalMinutes(event.target.value)}
              data-testid="automation-interval"
            />
            <span className="text-[9px] text-muted-foreground">
              {t('automations.minutesShort')}
            </span>
            <button
              type="button"
              className="ml-auto inline-flex h-5 items-center rounded bg-accent px-2 text-[9.5px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
              onClick={() => void create()}
              disabled={
                busy || name.trim().length === 0 || prompt.trim().length === 0
              }
              data-testid="automation-save"
            >
              {busy ? t('memory.saving') : t('automations.save')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
