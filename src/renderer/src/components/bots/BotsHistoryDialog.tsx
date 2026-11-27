import { useMemo, useState } from 'react'
import { MessageSquare, Search, X } from 'lucide-react'
import type { GroupSummaryPayload } from '../../../../shared/schemas/groups'
import { groupThreadLabel } from '../../../../shared/domain/group'
import { useT } from '../../i18n/use-i18n'

/** Every room a group has ever had, including rooms whose tabs were closed. */
export default function BotsHistoryDialog({
  groups,
  onOpenGroup,
  onClose
}: {
  groups: readonly GroupSummaryPayload[]
  onOpenGroup: (groupId: string, threadId: string) => void
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const [query, setQuery] = useState('')
  const normalized = query.trim().toLocaleLowerCase()

  const rows = useMemo(() => {
    return groups
      .flatMap((group) =>
        group.threads.map((thread) => ({
          group,
          thread,
          label: groupThreadLabel(group.name, thread, t('bots.thread.untitled'))
        }))
      )
      .filter(
        (row) =>
          normalized.length === 0 ||
          row.group.name.toLocaleLowerCase().includes(normalized) ||
          row.label.toLocaleLowerCase().includes(normalized) ||
          (row.thread.latestText ?? '').toLocaleLowerCase().includes(normalized)
      )
      .sort(
        (left, right) =>
          (right.thread.latestAt ?? 0) - (left.thread.latestAt ?? 0) ||
          left.group.name.localeCompare(right.group.name)
      )
  }, [groups, normalized, t])

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
      data-testid="bots-history-dialog"
    >
      <div
        className="flex max-h-[70vh] w-full max-w-xl flex-col rounded-lg border border-border bg-card shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label={t('bots.history.title')}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <MessageSquare size={13} className="text-accent" />
          <h2 className="min-w-0 flex-1 text-[13px] font-semibold">
            {t('bots.history.title')}
          </h2>
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onClose}
            aria-label={t('common.close')}
            title={t('common.close')}
            data-testid="bots-history-close"
          >
            <X size={12} />
          </button>
        </div>

        <div className="flex h-8 items-center gap-1.5 border-b border-border px-3">
          <Search size={11} className="shrink-0 text-muted-foreground" />
          <input
            className="min-w-0 flex-1 bg-transparent text-[11px] text-foreground outline-none placeholder:text-muted-foreground"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('bots.history.search')}
            data-testid="bots-history-search"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {rows.length === 0 ? (
            <p className="px-2 py-6 text-center text-[11px] text-muted-foreground">
              {t('bots.history.empty')}
            </p>
          ) : (
            rows.map(({ group, thread, label }) => (
              <button
                key={thread.id}
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted"
                onClick={() => {
                  onOpenGroup(group.id, thread.id)
                  onClose()
                }}
                data-testid={`bots-history-row-${thread.id}`}
              >
                <MessageSquare
                  size={10}
                  className="shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] text-foreground">
                    {label}
                  </span>
                  <span className="block truncate text-[9.5px] text-muted-foreground">
                    {group.name}
                    {thread.latestText === null ? '' : ` · ${thread.latestText}`}
                  </span>
                </span>
                {thread.unread > 0 ? (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-signal" />
                ) : null}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
