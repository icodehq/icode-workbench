import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { BotSummaryPayload } from '../../../../shared/schemas/bots'
import type { ItemPayload } from '../../../../shared/schemas/items'
import type { ItemStatus } from '../../../../shared/domain/item'
import type { MessageKey } from '../../../../shared/i18n'
import type { Notice } from '../../state/workspace'
import type { ItemsFilter } from '../../state/use-items'
import { useItems } from '../../state/use-items'
import ItemDetailDialog from './ItemDetailDialog'
import { useT } from '../../i18n/use-i18n'
import { itemStatusTone } from './item-status'

const ITEM_SECTIONS: Array<{ status: ItemStatus; label: MessageKey }> = [
  { status: 'needs_you', label: 'item.status.needs_you' },
  { status: 'working', label: 'item.status.working' },
  { status: 'waiting', label: 'item.status.waiting' },
  { status: 'planned', label: 'item.status.planned' },
  { status: 'done', label: 'item.status.done' }
]

/** The owner-facing Item list beside a room or a bot's home chat. */
export default function ItemsRail({
  filter,
  members,
  notify,
  onOpenTask,
  onTaskAction
}: {
  filter: ItemsFilter
  members: BotSummaryPayload[]
  notify: (notice: Notice) => void
  onOpenTask: (taskId: string) => void
  onTaskAction?: (action: 'approve' | 'reject', taskId: string) => void
}): React.JSX.Element {
  const t = useT()
  const state = useItems(filter, notify)
  const [openItemId, setOpenItemId] = useState<string | null>(null)
  const [memberId, setMemberId] = useState('')
  const visibleItems =
    memberId === ''
      ? state.items
      : state.items.filter((item) => item.task.botId === memberId)
  const openItem = state.items.find((item) => item.task.id === openItemId) ?? null
  const botName = (item: ItemPayload): string =>
    members.find((bot) => bot.id === item.task.botId)?.name ?? t('bots.fallback')

  // An empty rail is a permanent 280px column with "Nothing here"; hide it so
  // the room can use the full surface until the first Item exists.
  if (state.items.length === 0) return <></>

  return (
    <aside
      className="hidden w-[280px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-border bg-card/30 p-2 xl:flex"
      data-testid="bots-work-rail"
    >
      <div className="px-1 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {t('items.title')}
      </div>
      {members.length > 1 ? (
        <select
          className="h-6 w-full rounded border border-border bg-background px-1 text-[11px] text-foreground"
          value={memberId}
          onChange={(event) => setMemberId(event.target.value)}
          data-testid="items-member-filter"
        >
          <option value="">{t('items.allMembers')}</option>
          {members.map((bot) => (
            <option key={bot.id} value={bot.id}>
              {bot.name}
            </option>
          ))}
        </select>
      ) : null}
      {visibleItems.length === 0 && !state.loading ? (
        <p className="px-1 py-2 text-[11px] text-muted-foreground">{t('items.empty')}</p>
      ) : null}
      {ITEM_SECTIONS.map((section) => {
        const rows = visibleItems.filter((item) => item.status === section.status)
        if (rows.length === 0) return null
        return (
          <div key={section.status} className="space-y-1.5">
            <div className="px-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {t(section.label)}
              <span className="ml-1 text-muted-foreground/60">{rows.length}</span>
            </div>
            {rows.map((item) => (
              <button
                key={item.task.id}
                type="button"
                className="w-full rounded-md border border-border bg-card px-2.5 py-2 text-left hover:bg-muted/60"
                onClick={() => setOpenItemId(item.task.id)}
                data-testid={`bots-item-${item.task.id}`}
              >
                <span className="line-clamp-2 text-[12px] font-medium text-foreground">
                  {item.task.title}
                </span>
                <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="truncate">{botName(item)}</span>
                  <span className={`rounded px-1 py-0.5 ${itemStatusTone(item.status)}`}>
                    {t(section.label)}
                  </span>
                  {item.openQuestion !== null ? (
                    <span className="text-signal">?</span>
                  ) : null}
                  {item.stale ? <span className="text-signal">{t('items.stale')}</span> : null}
                </span>
              </button>
            ))}
          </div>
        )
      })}
      {state.loading ? (
        <p className="flex items-center gap-1 px-1 text-[11px] text-muted-foreground">
          <Loader2 size={9} className="animate-spin" /> {t('items.loading')}
        </p>
      ) : null}
      {openItem !== null ? (
        <ItemDetailDialog
          item={openItem}
          state={state}
          onOpenTask={(taskId) => {
            setOpenItemId(null)
            onOpenTask(taskId)
          }}
          onTaskAction={onTaskAction}
          notify={notify}
          onClose={() => setOpenItemId(null)}
        />
      ) : null}
    </aside>
  )
}
