import { useCallback, useEffect, useState } from 'react'
import type {
  BotMemoryEntryPayload,
  BotSummaryPayload
} from '../../../../shared/schemas/bots'
import type { RepositorySummary } from '../../../../shared/schemas/ipc'
import type { Notice } from '../../state/workspace'
import { callApi, errorNotice } from '../../lib/api'
import { useT } from '../../i18n/use-i18n'

type Scope = 'bot' | 'project' | 'team'

/**
 * Scoped memory for one bot.
 *
 * Bot memory travels with the bot; project and team memory are shared and need
 * a target. Only `active` entries are injected into prompts — a proposal has to
 * be approved here first, which is the human gate on long-term knowledge.
 */
export default function BotMemoryPane({
  bot,
  repos,
  groups = [],
  notify
}: {
  bot: BotSummaryPayload
  repos: RepositorySummary[]
  /** Groups this bot belongs to; the `team` scope is a group in the new model. */
  groups?: Array<{ id: string; name: string }>
  notify: (notice: Notice) => void
}): React.JSX.Element {
  const [scope, setScope] = useState<Scope>('bot')
  const [repoId, setRepoId] = useState<string>(repos[0]?.id ?? '')
  const [teamId, setTeamId] = useState<string>(groups[0]?.id ?? '')
  const [entries, setEntries] = useState<BotMemoryEntryPayload[]>([])
  const [showArchived, setShowArchived] = useState(false)
  const t = useT()
  const [loading, setLoading] = useState(false)
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)

  const targetReady =
    scope === 'bot' || (scope === 'project' ? repoId !== '' : teamId !== '')

  const load = useCallback(async (): Promise<void> => {
    if (!targetReady) {
      setEntries([])
      return
    }
    setLoading(true)
    try {
      const target = {
        botId: bot.id,
        scope,
        ...(scope === 'project' ? { repoId } : {}),
        ...(scope === 'team' && teamId !== '' ? { teamId } : {})
      }
      // `list` filters to one status, so each status is its own read.
      const [activeResult, proposedResult, archivedResult] = await Promise.all([
        callApi<BotMemoryEntryPayload[]>(
          window.icode.bots.memory.list({ ...target, status: 'active' })
        ),
        callApi<BotMemoryEntryPayload[]>(
          window.icode.bots.memory.list({ ...target, status: 'proposed' })
        ),
        showArchived
          ? callApi<BotMemoryEntryPayload[]>(
              window.icode.bots.memory.list({ ...target, status: 'archived' })
            )
          : Promise.resolve({ ok: true as const, value: [] })
      ])
      if (!activeResult.ok) {
        notify(errorNotice(activeResult.error))
        return
      }
      if (!proposedResult.ok) {
        notify(errorNotice(proposedResult.error))
        return
      }
      if (!archivedResult.ok) {
        notify(errorNotice(archivedResult.error))
        return
      }
      setEntries([...proposedResult.value, ...activeResult.value, ...archivedResult.value])
    } finally {
      setLoading(false)
    }
  }, [bot.id, notify, repoId, scope, showArchived, targetReady, teamId])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (): Promise<void> => {
    if (!targetReady || saving) return
    const nextKey = key.trim()
    const nextValue = value.trim()
    if (nextKey === '' || nextValue === '') return
    setSaving(true)
    try {
      const result = await callApi<BotMemoryEntryPayload>(
        window.icode.bots.memory.set({
          botId: bot.id,
          scope,
          key: nextKey,
          value: nextValue,
          ...(scope === 'project' ? { repoId } : {}),
          ...(scope === 'team' && teamId !== '' ? { teamId } : {})
        })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      setKey('')
      setValue('')
      await load()
    } finally {
      setSaving(false)
    }
  }

  const approve = async (entry: BotMemoryEntryPayload): Promise<void> => {
    const result = await callApi<BotMemoryEntryPayload | null>(
      window.icode.bots.memory.approve({ botId: bot.id, memoryId: entry.id })
    )
    if (!result.ok) {
      notify(errorNotice(result.error))
      return
    }
    await load()
  }

  const remove = async (entry: BotMemoryEntryPayload): Promise<void> => {
    const result = await callApi<boolean>(
      window.icode.bots.memory.remove({ botId: bot.id, memoryId: entry.id })
    )
    if (!result.ok) {
      notify(errorNotice(result.error))
      return
    }
    await load()
  }

  const scopes: Array<{ id: Scope; label: string; enabled: boolean }> = [
    { id: 'bot', label: t('memory.scope.bot'), enabled: true },
    { id: 'project', label: t('memory.scope.project'), enabled: repos.length > 0 },
    { id: 'team', label: t('memory.scope.team'), enabled: teamId !== '' }
  ]
  const proposed = entries.filter((entry) => entry.status === 'proposed')
  const active = entries.filter((entry) => entry.status === 'active')
  const archived = entries.filter((entry) => entry.status === 'archived')

  return (
    <div className="space-y-2" data-testid="bot-memory-pane">
      <div className="flex flex-wrap items-center gap-1">
        {scopes.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`inline-flex h-5 items-center rounded px-1.5 text-[9.5px] disabled:opacity-40 ${
              scope === entry.id
                ? 'bg-accent/15 text-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
            onClick={() => setScope(entry.id)}
            disabled={!entry.enabled}
            data-testid={`memory-scope-${entry.id}`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {scope === 'project' && repos.length > 1 ? (
        <select
          className="h-6 w-full rounded border border-border bg-background px-1 text-[10px] text-foreground"
          value={repoId}
          onChange={(event) => setRepoId(event.target.value)}
          data-testid="memory-project"
        >
          {repos.map((repo) => (
            <option key={repo.id} value={repo.id}>
              {repo.displayName}
            </option>
          ))}
        </select>
      ) : null}

      {scope === 'team' && groups.length > 1 ? (
        <select
          className="h-6 w-full rounded border border-border bg-background px-1 text-[10px] text-foreground"
          value={teamId}
          onChange={(event) => setTeamId(event.target.value)}
          data-testid="memory-group"
        >
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
      ) : null}

      {proposed.length > 0 ? (
        <div className="space-y-1">
          <p className="px-1 text-[9px] font-semibold uppercase tracking-[0.08em] text-signal">
            {t('memory.proposed')}
          </p>
          {proposed.map((entry) => (
            <div
              key={entry.id}
              className="rounded-md border border-signal/40 bg-signal-weak/40 px-2 py-1.5"
              data-testid={`memory-proposed-${entry.id}`}
            >
              <p className="text-[10.5px] font-medium text-foreground">{entry.key}</p>
              <p className="mt-0.5 whitespace-pre-wrap text-[10px] leading-relaxed text-foreground/80">
                {entry.value}
              </p>
              <div className="mt-1 flex items-center gap-2">
                <button
                  type="button"
                  className="text-[9.5px] text-signal hover:underline"
                  onClick={() => void approve(entry)}
                  data-testid={`memory-approve-${entry.id}`}
                >
                  {t('memory.approve')}
                </button>
                <button
                  type="button"
                  className="text-[9.5px] text-muted-foreground hover:text-destructive"
                  onClick={() => void remove(entry)}
                >
                  {t('memory.discard')}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {loading && entries.length === 0 ? (
        <p className="px-1 py-3 text-center text-[10px] text-muted-foreground">{t('memory.loading')}</p>
      ) : active.length === 0 && proposed.length === 0 && archived.length === 0 ? (
        <p className="px-1 py-3 text-center text-[10px] leading-relaxed text-muted-foreground">
          {targetReady
            ? t('memory.empty')
            : t('memory.unavailable')}
        </p>
      ) : (
        <div className="space-y-1">
          {active.map((entry) => (
            <div
              key={entry.id}
              className="group rounded-md border border-border bg-card px-2 py-1.5"
              data-testid={`memory-active-${entry.id}`}
            >
              <div className="flex items-start gap-1">
                <p className="min-w-0 flex-1 text-[10.5px] font-medium text-foreground">
                  {entry.key}
                </p>
                <button
                  type="button"
                  className="shrink-0 text-[9px] text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
                  onClick={() => void remove(entry)}
                  aria-label={`${t('memory.delete')} ${entry.key}`}
                >
                  {t('memory.delete')}
                </button>
              </div>
              <p className="mt-0.5 whitespace-pre-wrap text-[10px] leading-relaxed text-foreground/80">
                {entry.value}
              </p>
            </div>
          ))}
        </div>
      )}

      {showArchived && archived.length > 0 ? (
        <div className="space-y-1">
          <p className="px-1 text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            {t('memory.archived')}
          </p>
          {archived.map((entry) => (
            <div
              key={entry.id}
              className="rounded-md border border-border bg-muted/30 px-2 py-1.5"
              data-testid={`memory-archived-${entry.id}`}
            >
              <p className="text-[10.5px] font-medium text-muted-foreground">{entry.key}</p>
              <p className="mt-0.5 whitespace-pre-wrap text-[10px] leading-relaxed text-muted-foreground">
                {entry.value}
              </p>
              <div className="mt-1 flex items-center gap-2">
                <button
                  type="button"
                  className="text-[9px] text-foreground hover:underline"
                  onClick={() => void approve(entry)}
                  data-testid={`memory-restore-${entry.id}`}
                >
                  {t('memory.restore')}
                </button>
                <button
                  type="button"
                  className="text-[9px] text-muted-foreground hover:text-destructive"
                  onClick={() => void remove(entry)}
                >
                  {t('memory.delete')}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {targetReady ? (
        <button
          type="button"
          className="px-1 text-[9.5px] text-muted-foreground hover:text-foreground hover:underline"
          onClick={() => setShowArchived((current) => !current)}
          data-testid="memory-toggle-archived"
        >
          {showArchived ? t('memory.hideArchived') : t('memory.showArchived')}
        </button>
      ) : null}

      <div className="space-y-1 rounded-md border border-border bg-card/60 p-2">
        <input
          className="h-6 w-full rounded border border-border bg-background px-1.5 text-[10px] text-foreground outline-none placeholder:text-muted-foreground"
          placeholder={t('memory.keyPlaceholder')}
          value={key}
          onChange={(event) => setKey(event.target.value)}
          maxLength={120}
          data-testid="memory-key"
        />
        <textarea
          className="h-12 w-full resize-none rounded border border-border bg-background px-1.5 py-1 text-[10px] text-foreground outline-none placeholder:text-muted-foreground"
          placeholder={t('memory.valuePlaceholder')}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          maxLength={2_000}
          data-testid="memory-value"
        />
        <button
          type="button"
          className="inline-flex h-5 items-center rounded bg-accent px-2 text-[9.5px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
          onClick={() => void save()}
          disabled={!targetReady || saving || key.trim() === '' || value.trim() === ''}
          data-testid="memory-add"
        >
          {saving ? t('memory.saving') : t('memory.add')}
        </button>
      </div>
    </div>
  )
}
